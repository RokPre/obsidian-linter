import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import { build } from 'esbuild';
import initSqlJs from 'sql.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const TEMP_ROOT = tmpdir();
let workRoot;
let indexer;
let rulesConfig;
let workerBundlePath;
let workerSelf;
let savedSelf;
let savedPostMessage;
let SQL;

before(async () => {
  workRoot = await mkdtemp(join(TEMP_ROOT, 'run-checks-tests-'));
  const indexerPath = join(workRoot, 'indexer.cjs');
  const configPath = join(workRoot, 'rules-config.mjs');
  workerBundlePath = join(workRoot, 'worker.cjs');
  await Promise.all([
    build({ entryPoints: [join(PLUGIN_DIR, 'src', 'indexer.ts')], bundle: true, platform: 'node', format: 'cjs', loader: { '.wasm': 'binary' }, outfile: indexerPath, logLevel: 'silent' }),
    build({ entryPoints: [join(PLUGIN_DIR, 'src', 'rules-config.ts')], bundle: true, platform: 'node', format: 'esm', outfile: configPath, logLevel: 'silent' }),
    build({ entryPoints: [join(PLUGIN_DIR, 'src', 'indexer-worker.ts')], bundle: true, platform: 'node', format: 'cjs', loader: { '.wasm': 'binary' }, outfile: workerBundlePath, logLevel: 'silent' }),
  ]);
  [indexer, rulesConfig] = await Promise.all([
    import(pathToFileURL(indexerPath).href), import(pathToFileURL(configPath).href),
  ]);
  SQL = await initSqlJs();
});

after(async () => {
  if (savedSelf === undefined) delete globalThis.self;
  else globalThis.self = savedSelf;
  if (savedPostMessage === undefined) delete globalThis.postMessage;
  else globalThis.postMessage = savedPostMessage;
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

const configText = JSON.stringify({ version: 1, rules: [
  { id: 'required', check: 'requiredFrontmatterProperty', enabled: true, severity: 'error', scope: { fileKinds: ['markdown'], include: ['**/*.md', '*.md'] }, options: { properties: ['title'], caseSensitive: true } },
  { id: 'required-copy', check: 'requiredFrontmatterProperty', enabled: true, severity: 'warning', scope: { fileKinds: ['markdown'], include: ['**/*.md', '*.md'] }, options: { properties: ['title'], caseSensitive: true } },
  { id: 'filename', check: 'filenameCase', enabled: true, severity: 'warning', scope: { fileKinds: ['markdown'], include: ['**/*.md', '*.md'] }, options: { case: 'camelCase' } },
  { id: 'disabled', check: 'filenameCase', enabled: false, severity: 'error', scope: { fileKinds: ['markdown'], include: ['**/*.md', '*.md'] }, options: { case: 'PascalCase' } },
] });

function database({ stateTable = true, state = 0, indexed = true, vaultPath = '/vault' } = {}) {
  const db = new SQL.Database();
  db.run('CREATE TABLE vault_files (id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL)');
  if (stateTable) {
    db.run('CREATE TABLE vault_index_state (id INTEGER PRIMARY KEY, derived_data_dirty INTEGER NOT NULL)');
    if (state !== null) db.run('INSERT INTO vault_index_state VALUES (1, ?)', [state]);
  }
  db.run('CREATE TABLE frontmatter_errors (id INTEGER PRIMARY KEY, file_id INTEGER, error_output TEXT NOT NULL, line INTEGER)');
  db.run('CREATE TABLE frontmatter_nodes (id INTEGER PRIMARY KEY, file_id INTEGER, parent_id INTEGER, ordinal INTEGER, key TEXT, start_line INTEGER)');
  db.run('CREATE TABLE markdown_nodes (id INTEGER PRIMARY KEY, start_line INTEGER)');
  db.run('CREATE TABLE vault_links (id INTEGER PRIMARY KEY, source_file_id INTEGER, source_markdown_node_id INTEGER, source_frontmatter_node_id INTEGER, raw_target TEXT, resolution_status TEXT, is_embed INTEGER, link_syntax TEXT)');
  if (indexed) {
    db.run('INSERT INTO vault_files VALUES (1, ?, ?)', [join(vaultPath, 'bad_name.md'), 'markdown']);
    db.run('INSERT INTO frontmatter_nodes VALUES (1, 1, NULL, 0, ?, 1), (2, 1, 1, 0, ?, 2)', ['root', 'nestedOnly']);
  }
  return db;
}

async function writeDatabase(vaultPath, db) {
  const configPath = join(vaultPath, '.obsidian');
  await mkdir(configPath, { recursive: true });
  await writeFile(join(configPath, 'vaultHelper.db'), db.export());
}

async function makeVault() {
  const vault = join(workRoot, `vault-${Math.random().toString(16).slice(2)}`);
  await mkdir(vault, { recursive: true });
  return vault;
}

test('run checks rejects absent, legacy, missing-state, and dirty indexes without creating or mutating them', async () => {
  const config = rulesConfig.parseRulesConfig(configText);
  const absentVault = await makeVault();
  const absentPath = join(absentVault, '.obsidian', 'vaultHelper.db');
  await assert.rejects(indexer.runChecksForVault(absentVault, '.obsidian', config), /Index vault/);
  await assert.rejects(readFile(absentPath), { code: 'ENOENT' });

  for (const options of [{ stateTable: false }, { state: null }, { state: 1 }]) {
    const vault = await makeVault();
    const db = database({ ...options, vaultPath: vault });
    await writeDatabase(vault, db);
    const dbPath = join(vault, '.obsidian', 'vaultHelper.db');
    const before = await readFile(dbPath);
    await assert.rejects(indexer.runChecksForVault(vault, '.obsidian', config), /Index vault/);
    assert.deepEqual(await readFile(dbPath), before);
    db.close();
  }
});

test('run checks evaluates only persisted files and returns JCE-1 structured diagnostics', async () => {
  const vault = await makeVault();
  const db = database({ state: 0, vaultPath: vault });
  await writeDatabase(vault, db);
  await writeFile(join(vault, 'not-indexed.md'), 'This file is not in the persisted index.');
  const result = await indexer.runChecksForVault(vault, '.obsidian', rulesConfig.parseRulesConfig(configText));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.diagnostics.map(({ ruleId, check, severity, path, line }) => ({ ruleId, check, severity, path, line })), [
    { ruleId: 'required', check: 'requiredFrontmatterProperty', severity: 'error', path: 'bad_name.md', line: undefined },
    { ruleId: 'required-copy', check: 'requiredFrontmatterProperty', severity: 'warning', path: 'bad_name.md', line: undefined },
    { ruleId: 'filename', check: 'filenameCase', severity: 'warning', path: 'bad_name.md', line: undefined },
  ]);
  assert.ok(result.diagnostics.every(diagnostic => typeof diagnostic.message === 'string'));
  assert.ok(result.diagnostics.every(diagnostic => !Object.hasOwn(diagnostic, 'line')));
  const config = rulesConfig.parseRulesConfig(configText);
  const reversed = rulesConfig.parseRulesConfig(JSON.stringify({ ...config, rules: [...config.rules].reverse() }));
  const reversedResult = await indexer.runChecksForVault(vault, '.obsidian', reversed);
  assert.deepEqual(
    reversedResult.diagnostics.map(({ ruleId, check, severity, path, message }) => [ruleId, check, severity, path, message]).sort(),
    result.diagnostics.map(({ ruleId, check, severity, path, message }) => [ruleId, check, severity, path, message]).sort(),
  );
  assert.ok(!result.diagnostics.some(({ ruleId }) => ruleId === 'disabled'));
  db.close();
});

test('run checks reports unresolved links without source-node references', async () => {
  const vault = await makeVault();
  const db = database({ state: 0, vaultPath: vault });
  db.run(`INSERT INTO vault_links
    (id, source_file_id, source_markdown_node_id, source_frontmatter_node_id, raw_target, resolution_status, is_embed)
    VALUES (1, 1, NULL, NULL, '[[lost target]]', 'missing', 0)`);
  await writeDatabase(vault, db);
  const config = rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [{
    id: 'missing-links', check: 'unresolvedInternalLinks', enabled: true, severity: 'error',
    scope: { fileKinds: ['markdown'], include: ['*.md'] },
    options: { statuses: ['missing'], includeEmbeds: false },
  }] }));

  const result = await indexer.runChecksForVault(vault, '.obsidian', config);

  assert.deepEqual(result.failures, []);
  assert.equal(result.diagnostics.length, 1);
  assert.deepEqual(result.diagnostics[0], {
    ruleId: 'missing-links',
    check: 'unresolvedInternalLinks',
    severity: 'error',
    path: 'bad_name.md',
    message: 'Internal link `[[lost target]]` could not be resolved in the indexed vault.',
  });
  assert.equal(Object.hasOwn(result.diagnostics[0], 'line'), false);
  db.close();
});

test('run checks aggregates 250,000 persisted link occurrences and continues to later rules', async () => {
  const vault = await makeVault();
  const db = database({ state: 0, vaultPath: vault });
  db.run('INSERT INTO markdown_nodes VALUES (1, 7)');
  db.run('BEGIN');
  const insertLink = db.prepare(`INSERT INTO vault_links
    (id, source_file_id, source_markdown_node_id, raw_target, resolution_status, is_embed)
    VALUES (?, 1, 1, ?, 'missing', 0)`);
  for (let id = 1; id <= 250_000; id++) {
    insertLink.run([id, 'same-missing-target']);
  }
  insertLink.free();
  db.run('COMMIT');
  await writeDatabase(vault, db);

  const config = rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [
    {
      id: 'links', check: 'unresolvedInternalLinks', enabled: true, severity: 'error',
      scope: { fileKinds: ['markdown'], include: ['*.md'] },
      options: { statuses: ['missing'], includeEmbeds: false },
    },
    {
      id: 'filename-later', check: 'filenameCase', enabled: true, severity: 'warning',
      scope: { fileKinds: ['markdown'], include: ['*.md'] },
      options: { case: 'camelCase' },
    },
  ] }));
  const result = await indexer.runChecksForVault(vault, '.obsidian', config);

  assert.deepEqual(result.failures, []);
  assert.equal(result.diagnostics.length, 250_001);
  const linkDiagnostics = result.diagnostics.filter(({ ruleId }) => ruleId === 'links');
  assert.equal(linkDiagnostics.length, 250_000);
  assert.ok(linkDiagnostics.every(({ check, severity, path, line, message }) =>
    check === 'unresolvedInternalLinks'
    && severity === 'error'
    && path === 'bad_name.md'
    && line === 7
    && message === 'Internal link `same-missing-target` could not be resolved in the indexed vault.'));
  const filenameDiagnostics = result.diagnostics.filter(({ ruleId }) => ruleId === 'filename-later');
  assert.deepEqual(filenameDiagnostics, [{
    ruleId: 'filename-later',
    check: 'filenameCase',
    severity: 'warning',
    path: 'bad_name.md',
    message: 'Filename `bad_name.md` does not match `camelCase`.',
  }]);
  db.close();
});

test('execution applies existing file scope to indexed sources only', async () => {
  const vault = await makeVault();
  const db = database({ state: 0, vaultPath: vault });
  db.run('INSERT INTO vault_files VALUES (2, ?, ?)', [join(vault, 'excluded_bad_name.md'), 'markdown']);
  await writeDatabase(vault, db);
  await writeFile(join(vault, 'not-indexed_bad_name.md'), 'not indexed');
  const config = rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [{
    id: 'scope', check: 'filenameCase', enabled: true, severity: 'warning',
    scope: { fileKinds: ['markdown'], include: ['*.md'], exclude: ['excluded_bad_name.md'] },
    options: { case: 'camelCase' },
  }] }));
  const result = await indexer.runChecksForVault(vault, '.obsidian', config);
  assert.deepEqual(result.diagnostics.map(({ path }) => path), ['bad_name.md']);
  db.close();
});

test('one rule failure is separated from diagnostics and does not stop later rules', async () => {
  const vault = await makeVault();
  const db = database({ state: 0, vaultPath: vault });
  await writeDatabase(vault, db);
  const config = rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [
    { id: 'fails', check: 'requiredFrontmatterProperty', enabled: true, severity: 'error', scope: { fileKinds: ['markdown'], include: ['*.md'] }, options: { properties: ['title'], caseSensitive: true } },
    { id: 'continues', check: 'filenameCase', enabled: true, severity: 'warning', scope: { fileKinds: ['markdown'], include: ['*.md'] }, options: { case: 'camelCase' } },
  ] }));
  Object.defineProperty(config.rules[0], 'options', { get() { throw new Error('controlled rule failure'); } });
  const result = await indexer.runChecksForVault(vault, '.obsidian', config);
  assert.deepEqual(result.failures.map(({ ruleId, check }) => [ruleId, check]), [['fails', 'requiredFrontmatterProperty']]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].ruleId, 'continues');
  assert.match(result.failures[0].message, /controlled rule failure/);
  db.close();
});

test('worker routes typed run-checks and indexed-file requests without starting indexing', async () => {
  savedSelf = globalThis.self;
  savedPostMessage = globalThis.postMessage;
  let resolveReply;
  workerSelf = {
    onmessage: null,
    postMessage(message) { resolveReply(message); },
  };
  globalThis.self = workerSelf;
  await import(pathToFileURL(workerBundlePath).href);
  async function send(message) {
    const response = new Promise(resolve => { resolveReply = resolve; });
    workerSelf.onmessage({ data: message });
    return response;
  }

  const config = rulesConfig.parseRulesConfig(configText);
  const vault = await makeVault();
  const db = database({ state: 0, vaultPath: vault });
  await writeDatabase(vault, db);
  const runReply = await send({ id: 7, type: 'run-checks', vaultPath: vault, configDir: '.obsidian', config });
  assert.equal(runReply.id, 7);
  assert.equal(runReply.type, 'run-checks-result');
  assert.deepEqual(runReply.result.failures, []);
  assert.ok(runReply.result.diagnostics.every(({ path }) => path === 'bad_name.md'));
  const filesReply = await send({ id: 8, type: 'get-indexed-files', vaultPath: vault, configDir: '.obsidian' });
  assert.deepEqual(filesReply, { id: 8, type: 'indexed-files-result', files: [{ path: 'bad_name.md', kind: 'markdown' }] });
  const missingVault = await makeVault();
  const failureReply = await send({ id: 9, type: 'run-checks', vaultPath: missingVault, configDir: '.obsidian', config });
  assert.equal(failureReply.id, 9);
  assert.match(failureReply.error, /Index vault/);
  const partialConfig = rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [
    { id: 'broken', check: 'requiredFrontmatterProperty', enabled: true, severity: 'error', scope: { fileKinds: ['markdown'], include: ['*.md'] }, options: { properties: ['title'], caseSensitive: true } },
    { id: 'later', check: 'filenameCase', enabled: true, severity: 'warning', scope: { fileKinds: ['markdown'], include: ['*.md'] }, options: { case: 'camelCase' } },
  ] }));
  Object.defineProperty(partialConfig.rules[0], 'options', { get() { throw new Error('controlled worker rule failure'); } });
  const partialReply = await send({ id: 10, type: 'run-checks', vaultPath: vault, configDir: '.obsidian', config: partialConfig });
  assert.deepEqual(partialReply.result.failures.map(({ ruleId }) => ruleId), ['broken']);
  assert.deepEqual(partialReply.result.diagnostics.map(({ ruleId }) => ruleId), ['later']);
  const malformedVault = await makeVault();
  const malformedDb = database({ state: 0, vaultPath: malformedVault });
  malformedDb.run('INSERT INTO frontmatter_errors VALUES (1, 1, ?, NULL)', ['stored parser issue']);
  malformedDb.run('INSERT INTO vault_files VALUES (2, ?, ?)', [join(malformedVault, 'bad_parse.md'), 'markdown']);
  malformedDb.run('INSERT INTO frontmatter_errors VALUES (2, 2, ?, 4)', ['line-specific parser issue']);
  await writeDatabase(malformedVault, malformedDb);
  const requiredOnly = rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [
    { id: 'parse-a', check: 'requiredFrontmatterProperty', enabled: true, severity: 'error', scope: { fileKinds: ['markdown'], include: ['*.md'] }, options: { properties: ['title', 'aliases'], caseSensitive: true } },
    { id: 'parse-b', check: 'requiredFrontmatterProperty', enabled: true, severity: 'warning', scope: { fileKinds: ['markdown'], include: ['*.md'] }, options: { properties: ['title'], caseSensitive: true } },
  ] }));
  const malformedReply = await send({ id: 11, type: 'run-checks', vaultPath: malformedVault, configDir: '.obsidian', config: requiredOnly });
  assert.equal(malformedReply.result.diagnostics.length, 4);
  assert.ok(malformedReply.result.diagnostics.every(({ message }) => message.startsWith('Frontmatter could not be parsed')));
  assert.deepEqual(malformedReply.result.diagnostics.filter(({ path }) => path === 'bad_name.md').map(({ line }) => line), [undefined, undefined]);
  assert.deepEqual(malformedReply.result.diagnostics.filter(({ path }) => path === 'bad_parse.md').map(({ line }) => line), [4, 4]);
  malformedDb.close();

  const linksVault = await makeVault();
  const linksDb = database({ state: 0, vaultPath: linksVault });
  linksDb.run('INSERT INTO frontmatter_nodes VALUES (3, 1, NULL, 2, ?, 4)', ['links']);
  linksDb.run('INSERT INTO markdown_nodes VALUES (10, 7), (11, NULL)');
  linksDb.run(`INSERT INTO vault_links (id, source_file_id, source_markdown_node_id, source_frontmatter_node_id, raw_target, resolution_status, is_embed, link_syntax) VALUES
    (1, 1, 10, NULL, 'missingNote', 'missing', 0, 'wikilink'),
    (2, 1, 11, NULL, 'image.png', 'missing', 1, 'image'),
    (3, 1, NULL, 3, 'note#missing', 'missing_fragment', 0, 'wikilink'),
    (4, 1, NULL, 3, 'duplicateName', 'ambiguous', 0, 'wikilink'),
    (5, 1, 10, NULL, 'resolved', 'resolved', 0, 'wikilink'),
    (6, 1, 10, NULL, 'external', 'external', 0, 'link'),
    (7, 1, 10, NULL, 'ignored', 'ignored', 0, 'wikilink'),
    (8, 1, 10, NULL, 'ambiguousIgnored', 'ambiguous_ignored', 0, 'wikilink')`);
  await writeDatabase(linksVault, linksDb);
  function linkConfig(includeEmbeds) {
    return rulesConfig.parseRulesConfig(JSON.stringify({ version: 1, rules: [{
      id: 'links', check: 'unresolvedInternalLinks', enabled: true, severity: 'warning',
      scope: { fileKinds: ['markdown'], include: ['*.md'] },
      options: { statuses: ['missing', 'missing_fragment', 'ambiguous'], includeEmbeds },
    }] }));
  }
  const ordinaryReply = await send({ id: 12, type: 'run-checks', vaultPath: linksVault, configDir: '.obsidian', config: linkConfig(false) });
  assert.deepEqual(ordinaryReply.result.diagnostics.map(({ message, line }) => [message, line]), [
    ['Internal link `missingNote` could not be resolved in the indexed vault.', 7],
    ['Internal link `note#missing` points to a missing fragment in the indexed vault.', 4],
    ['Internal link `duplicateName` is ambiguous in the indexed vault.', 4],
  ]);
  const embedsReply = await send({ id: 13, type: 'run-checks', vaultPath: linksVault, configDir: '.obsidian', config: linkConfig(true) });
  assert.equal(embedsReply.result.diagnostics.length, 4);
  assert.ok(embedsReply.result.diagnostics.some(({ message }) => message.includes('`image.png`')));
  linksDb.close();
  db.close();
});
