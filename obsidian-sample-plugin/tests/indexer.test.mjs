import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { test, before, after } from 'node:test';
import { build } from 'esbuild';

const savedSelf = globalThis.self;
globalThis.self = globalThis;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const ROOT_DIR = resolve(PLUGIN_DIR, '..');
const ORACLE = join(ROOT_DIR, 'indexer.py');
const NODE_BIN = dirname(process.execPath);
const PYTHON = process.env.PYTHON || '/usr/bin/python3';
const TABLES = [
  'frontmatter_errors', 'frontmatter_nodes', 'markdown_nodes', 'note_tag_occurrences',
  'vault_directories', 'vault_files', 'vault_index_state', 'vault_links',
  'vault_missing_targets', 'vault_tags',
];

let indexer;
let testIgnoredPaths = [];
const TEST_IGNORED_DIRECTORY_NAMES = new Set(['.git', 'templates', 'excalidraws', '.diaryTrash']);

function isTestIgnoredPath(filePath, ignoredPaths, configDir) {
  const ignoredRoots = [...ignoredPaths, configDir.replaceAll('\\', '/')];
  if (ignoredRoots.some(root => filePath === root || filePath.startsWith(`${root}/`))) return true;
  return filePath.split('/').slice(0, -1).some(part => TEST_IGNORED_DIRECTORY_NAMES.has(part));
}

async function testHostResolution(vaultPath, queries, configDir, overrides = new Map(), ignoredPaths = testIgnoredPaths, reverseInventory = false) {
  const paths = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else if (entry.isFile()) paths.push(relative(vaultPath, absolute).split('\\').join('/'));
    }
  }
  await collect(vaultPath);
  const vaultFiles = (reverseInventory ? [...paths].reverse() : paths).map(filePath => ({
    path: filePath,
    ignored: isTestIgnoredPath(filePath, ignoredPaths, configDir),
  }));
  const selections = queries.map(query => {
    const key = JSON.stringify([query.linkpath, query.sourcePath]);
    return {
      ...query,
      targetPath: overrides.has(key) ? overrides.get(key) : resolveTestLink(query, paths),
    };
  });
  return { vaultFiles, selections };
}

function resolveTestLink({ linkpath, sourcePath }, paths) {
  const target = linkpath.trim();
  if (!target) return null;
  const matchingPaths = (candidate) => {
    const normalized = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
    const candidates = [normalized];
    if (!/[.]$|\.[^/]+$/.test(normalized)) candidates.push(`${normalized}.md`);
    return candidates.filter(item => paths.includes(item));
  };
  if (target.startsWith('/')) {
    const matches = matchingPaths(target.replace(/^\/+/, ''));
    return matches.length === 1 ? matches[0] : null;
  }
  if (target.startsWith('./') || target.startsWith('../')) {
    const matches = matchingPaths(path.posix.join(path.posix.dirname(sourcePath), target));
    return matches.length === 1 ? matches[0] : null;
  }
  if (target.includes('/')) {
    const matches = matchingPaths(target);
    return matches.length === 1 ? matches[0] : null;
  }
  const sourceDirectory = path.posix.dirname(sourcePath);
  if (sourceDirectory !== '.') {
    const localMatches = matchingPaths(path.posix.join(sourceDirectory, target));
    if (localMatches.length === 1) return localMatches[0];
  }
  const matches = paths.filter(filePath => {
    const basename = path.posix.basename(filePath);
    return basename === target || basename === `${target}.md`;
  });
  return matches.length === 1 ? matches[0] : null;
}

function setIgnoredPaths(paths) {
  testIgnoredPaths = [...paths];
  indexer.setIgnoredPaths(paths);
}
function createGate() {
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  return { reached, release, wait: () => pending, enter: () => entered() };
}

function testIgnoredFileSnapshot(vaultPath, configDir, ignoredPaths) {
  const paths = [];
  function collect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) collect(absolute);
      else if (entry.isFile()) {
        const filePath = relative(vaultPath, absolute).split('\\').join('/');
        if (isTestIgnoredPath(filePath, ignoredPaths, configDir)) paths.push(filePath);
      }
    }
  }
  collect(vaultPath);
  return paths.sort();
}

const indexVault = (vaultPath, databasePath, onProgress, configDir = '.obsidian', overrides, beforeResolve, reverseInventory = false) => {
  const ignoredPaths = [...testIgnoredPaths];
  const ignoredFilePaths = testIgnoredFileSnapshot(vaultPath, configDir, ignoredPaths);
  return indexer.indexVault(vaultPath, configDir, databasePath, onProgress, async queries => {
    await beforeResolve?.();
    return testHostResolution(vaultPath, queries, configDir, overrides, ignoredPaths, reverseInventory);
  }, ignoredFilePaths);
};
let bundlePath;
let workRoot;

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'vault-helper-node-tests-'));
  bundlePath = join(PLUGIN_DIR, `.indexer-test-${process.pid}.cjs`);
  await build({
    entryPoints: [join(PLUGIN_DIR, 'src', 'indexer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    loader: { '.wasm': 'binary' },
    outfile: bundlePath,
    external: [],
    logLevel: 'silent',
  });
  indexer = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
  assert.equal(typeof indexer.indexVault, 'function', 'indexer.ts must export indexVault');
});

after(async () => {
  if (bundlePath) await rm(bundlePath, { force: true });
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
  if (savedSelf === undefined) delete globalThis.self;
  else globalThis.self = savedSelf;
});

function oracle(vault, database) {
  const result = spawnSync(PYTHON, [ORACLE, vault, database], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH || ''}` },
  });
  if (result.status !== 0) {
    throw new Error(`Python oracle failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
function setMtimeNs(path, mtimeNs) {
  execFileSync(PYTHON, ['-c', 'import os,sys; p=sys.argv[1]; s=os.stat(p); os.utime(p, ns=(s.st_atime_ns, int(sys.argv[2])));', path, String(mtimeNs)], { cwd: ROOT_DIR });
}
function oracleInterrupted(vault, database) {
  const script = String.raw`
import indexer, sys
from pathlib import Path
calls = [0]
original = indexer.parse_file
def fail_after_1000(*args, **kwargs):
    calls[0] += 1
    if calls[0] == 1001:
        raise RuntimeError('intentional batch interruption')
    return original(*args, **kwargs)
indexer.parse_file = fail_after_1000
indexer.parse_args = lambda: (Path(sys.argv[1]), Path(sys.argv[2]))
try:
    indexer.main()
except RuntimeError as error:
    if str(error) != 'intentional batch interruption':
        raise
else:
    raise AssertionError('interruption hook was not reached')
`;
  const result = spawnSync(PYTHON, ['-c', script, vault, database], { cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env, PATH: NODE_BIN } });
  assert.equal(result.status, 0, 'interrupted Python oracle must recover its exception: ' + result.stderr);
}

const FOREIGN_KEYS_SCRIPT = 'import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute("PRAGMA foreign_key_check").fetchall()))';

const DUMP_SCRIPT = String.raw`
import base64, json, sqlite3, sys

def value(v):
    if isinstance(v, bytes):
        return {"$bytes": base64.b64encode(v).decode("ascii")}
    return v

con = sqlite3.connect(sys.argv[1])
out = {}
for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
    columns = [row[1] for row in con.execute(f'PRAGMA table_info("{name}")')]
    rows = [dict(zip(columns, (value(v) for v in row))) for row in con.execute(f'SELECT * FROM "{name}" ORDER BY id')]
    out[name] = {"columns": columns, "rows": rows}
print(json.dumps(out, separators=(",", ":")))
`;

function rawSnapshot(database) {
  return JSON.parse(execFileSync(PYTHON, ['-c', DUMP_SCRIPT, database], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }));
}

function key(value) {
  return JSON.stringify(value);
}

function semanticSnapshot(database) {
  const raw = rawSnapshot(database);
  assert.deepStrictEqual(Object.keys(raw).sort(), [...TABLES].sort(), 'database snapshot must include exactly every application table');
  const dirs = Object.create(null);
  for (const row of raw.vault_directories?.rows || []) dirs[row.id] = row.path;
  const files = Object.create(null);
  for (const row of raw.vault_files?.rows || []) files[row.id] = row.path;
  const tags = Object.create(null);
  for (const row of raw.vault_tags?.rows || []) tags[row.id] = row.name;
  const front = Object.create(null);
  for (const row of raw.frontmatter_nodes?.rows || []) {
    const parent = row.parent_id == null ? null : front[row.parent_id];
    front[row.id] = [files[row.file_id], parent, row.ordinal, row.key, row.node_type, row.value, row.raw_yaml, row.start_line, row.end_line];
  }
  const markdown = Object.create(null);
  for (const row of raw.markdown_nodes?.rows || []) {
    const parent = row.parent_id == null ? null : markdown[row.parent_id];
    markdown[row.id] = [files[row.file_id], parent, row.ordinal, row.node_type, row.value, row.block_id,
      JSON.parse(row.attributes_json), row.start_line, row.start_column, row.start_offset_utf16,
      row.end_line, row.end_column, row.end_offset_utf16];
  }
  const missing = Object.create(null);
  for (const row of raw.vault_missing_targets?.rows || []) {
    missing[row.id] = [row.target_type, row.target, row.target_file_id == null ? null : files[row.target_file_id]];
  }

  function normalize(table, row) {
    const out = {};
    for (const [column, value] of Object.entries(row)) {
      if (column === 'id') continue;
      if (table === 'vault_directories' && column === 'parent_id') out[column] = value == null ? null : dirs[value];
      else if (table === 'vault_files' && column === 'directory_id') out[column] = dirs[value];
      else if (table === 'frontmatter_nodes' && column === 'file_id') out[column] = files[value];
      else if (table === 'frontmatter_nodes' && column === 'parent_id') out[column] = value == null ? null : front[value];
      else if (table === 'frontmatter_errors' && column === 'error_output') out[column] = /closing.*delimiter/i.test(String(value)) ? 'missing-closing-delimiter' : 'yaml-parse-error';
      else if (table === 'frontmatter_errors' && column === 'file_id') out[column] = files[value];
      else if (table === 'markdown_nodes' && column === 'file_id') out[column] = files[value];
      else if (table === 'markdown_nodes' && column === 'parent_id') out[column] = value == null ? null : markdown[value];
      else if (table === 'markdown_nodes' && column === 'attributes_json') {
        try { out[column] = JSON.parse(String(value)); } catch { out[column] = value; }
      }
      else if (table === 'vault_tags' && column === 'parent_id') out[column] = value == null ? null : tags[value];
      else if (table === 'note_tag_occurrences' && column === 'tag_id') out[column] = tags[value];
      else if (table === 'note_tag_occurrences' && column === 'frontmatter_node_id') out[column] = value == null ? null : front[value];
      else if (table === 'note_tag_occurrences' && column === 'markdown_node_id') out[column] = value == null ? null : markdown[value];
      else if (table === 'vault_links' && column === 'source_file_id') out[column] = files[value];
      else if (table === 'vault_links' && column === 'source_markdown_node_id') out[column] = value == null ? null : markdown[value];
      else if (table === 'vault_links' && column === 'source_frontmatter_node_id') out[column] = value == null ? null : front[value];
      else if (table === 'vault_links' && column === 'target_file_id') out[column] = value == null ? null : files[value];
      else if (table === 'vault_links' && column === 'target_node_id') out[column] = value == null ? null : markdown[value];
      else if (table === 'vault_links' && column === 'missing_target_id') out[column] = value == null ? null : missing[value];
      else if (table === 'vault_missing_targets' && column === 'target_file_id') out[column] = value == null ? null : files[value];
      else out[column] = value;
    }
    return out;
  }

  const snapshot = {};
  for (const table of TABLES) {
    const tableData = raw[table] || { columns: [], rows: [] };
    const pluginState = table === 'vault_index_state';
    const columns = pluginState
      ? tableData.columns.filter(column => column !== 'ignored_file_paths_snapshot')
      : tableData.columns;
    const rows = tableData.rows.map(row => {
      const normalized = normalize(table, row);
      if (pluginState) {
        delete normalized.link_resolution_version;
        delete normalized.ignored_file_paths_snapshot;
      }
      return normalized;
    }).sort((a, b) => key(a).localeCompare(key(b)));
    snapshot[table] = { columns, rows };
  }
  return snapshot;
}

function assertParity(pythonDb, typescriptDb, label, excludedTables = []) {
  assert.deepStrictEqual(JSON.parse(execFileSync(PYTHON, ['-c', FOREIGN_KEYS_SCRIPT, pythonDb], { encoding: 'utf8' })), [], label + ': Python foreign keys');
  assert.deepStrictEqual(JSON.parse(execFileSync(PYTHON, ['-c', FOREIGN_KEYS_SCRIPT, typescriptDb], { encoding: 'utf8' })), [], label + ': TypeScript foreign keys');
  const actual = semanticSnapshot(typescriptDb);
  const expected = semanticSnapshot(pythonDb);
  const comparedTables = TABLES.filter(table => !excludedTables.includes(table));
  const badTables = comparedTables.filter(table => !isDeepStrictEqual(actual[table], expected[table]));
  if (badTables.length > 0) {
    const mismatch = badTables.map(table => table + ' actual=' + actual[table].rows.length + ' expected=' + expected[table].rows.length);
    const differences = badTables.flatMap(table => actual[table].rows.map((row, index) => isDeepStrictEqual(row, expected[table].rows[index]) ? null : ({ table, index, actual: row, expected: expected[table].rows[index] })).filter(Boolean));
    throw new Error(label + ': mismatched tables ' + mismatch.join(', ') + ' firstDiff=' + JSON.stringify(differences[0]));
  }
  assert.deepStrictEqual(
    Object.fromEntries(comparedTables.map(table => [table, actual[table]])),
    Object.fromEntries(comparedTables.map(table => [table, expected[table]])),
    label,
  );
}

async function makeVault(name, files) {
  const vault = join(workRoot, name);
  await mkdir(vault, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const path = join(vault, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return vault;
}

test('marks a pre-index ignored target as ignored without storing its contents', async () => {
  const secret = 'ignored-target-secret-content';
  const vault = await makeVault('ignored-before-first-index', {
    'A.md': '[[B]]\n[[B]]\n',
    'B.md': `---\nsecret: ${secret}\n---\n# Hidden\n\n${secret}\n`,
  });
  setIgnoredPaths(['B.md']);
  try {
    const result = await indexVault(vault, join(workRoot, 'ignored-before-first-index.db'));
    const snapshot = rawSnapshot(result.databasePath);
    const links = snapshot.vault_links.rows.filter(row => row.raw_target === 'B');
    assert.equal(links.length, 2, 'repeated link occurrences must both be retained');
    assert.deepEqual(links.map(row => row.resolution_status), ['ignored', 'ignored']);
    assert(links.every(row => row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));
    assert(!snapshot.vault_files.rows.some(row => relative(vault, row.path) === 'B.md'));
    assert.equal(snapshot.frontmatter_nodes.rows.length, 0);
    assert.equal(snapshot.frontmatter_errors.rows.length, 0);
    assert(!JSON.stringify(snapshot).includes(secret));
  } finally {
    setIgnoredPaths([]);
  }
});

test('re-resolves a clean v4 missing link to an ignored target once', async () => {
  const vault = await makeVault('ignored-target-clean-v4', {
    'A.md': '[[B]]\n',
    'B.md': '# Ignored target\n',
  });
  const database = join(workRoot, 'ignored-target-clean-v4.db');
  const sourceContent = await readFile(join(vault, 'A.md'));
  const targetContent = await readFile(join(vault, 'B.md'));
  const sourceMtime = (await stat(join(vault, 'A.md'), { bigint: true })).mtimeNs;
  const targetMtime = (await stat(join(vault, 'B.md'), { bigint: true })).mtimeNs;
  setIgnoredPaths(['B.md']);
  try {
    await indexVault(vault, database);
    const seeded = rawSnapshot(database);
    const source = seeded.vault_files.rows.find(row => row.path === join(vault, 'A.md'));
    const originalLink = seeded.vault_links.rows.find(row => row.source_file_id === source?.id && row.raw_target === 'B');
    assert(source && originalLink, 'fixture setup must index A and retain its A→B occurrence');

    execFileSync(PYTHON, ['-c', String.raw`
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("PRAGMA foreign_keys=ON")
con.execute("INSERT INTO vault_missing_targets(target_type,target) VALUES('name','B')")
missing_id = con.execute("SELECT last_insert_rowid()").fetchone()[0]
con.execute("UPDATE vault_links SET target_file_id=NULL,target_node_id=NULL,missing_target_id=?,resolution_status='missing' WHERE id=?", (missing_id, int(sys.argv[2])))
con.execute("UPDATE vault_index_state SET link_resolution_version=4,derived_data_dirty=0 WHERE id=1")
con.commit()
con.close()
`, database, String(originalLink.id)], { cwd: ROOT_DIR });

    const before = rawSnapshot(database);
    const beforeLink = before.vault_links.rows.find(row => row.id === originalLink.id);
    const beforeState = before.vault_index_state.rows.find(row => row.id === 1);
    assert.equal(beforeState?.link_resolution_version, 4, 'seed must represent the existing version-4 database');
    assert.equal(beforeState?.derived_data_dirty, 0, 'seed must be clean before reindexing');
    assert.equal(beforeLink?.resolution_status, 'missing');
    assert.notEqual(beforeLink?.missing_target_id, null, 'baseline missing occurrence must reference its missing target');
    assert.equal(beforeLink?.target_file_id, null);
    assert.equal(beforeLink?.target_node_id, null);
    assert(!before.vault_files.rows.some(row => row.path === join(vault, 'B.md')), 'ignored B must remain absent from indexed content');
    assert.deepEqual(await readFile(join(vault, 'A.md')), sourceContent);
    assert.deepEqual(await readFile(join(vault, 'B.md')), targetContent);
    assert.equal((await stat(join(vault, 'A.md'), { bigint: true })).mtimeNs, sourceMtime);
    assert.equal((await stat(join(vault, 'B.md'), { bigint: true })).mtimeNs, targetMtime);
    assert.deepEqual(testIgnoredPaths, ['B.md'], 'ignore settings must be unchanged');

    let resolverCalls = 0;
    await indexVault(vault, database, undefined, '.obsidian', undefined, () => { resolverCalls++; });
    const resolved = rawSnapshot(database);
    const ignoredLink = resolved.vault_links.rows.find(row => row.id === originalLink.id);
    assert.equal(resolverCalls, 1, 'clean version-4 rows must be re-resolved once under the new semantics');
    assert.equal(ignoredLink?.resolution_status, 'ignored');
    assert.equal(ignoredLink?.target_file_id, null);
    assert.equal(ignoredLink?.target_node_id, null);
    assert.equal(ignoredLink?.missing_target_id, null);
    assert(!resolved.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
    assert.equal(resolved.frontmatter_nodes.rows.length, 0);
    assert.equal(resolved.frontmatter_errors.rows.length, 0);
    assert(!JSON.stringify(resolved).includes('Ignored target'));

    const linksAfterResolution = resolved.vault_links.rows;
    const missingAfterResolution = resolved.vault_missing_targets.rows;
    await indexVault(vault, database, undefined, '.obsidian', undefined, () => { resolverCalls++; });
    const unchanged = rawSnapshot(database);
    assert.equal(resolverCalls, 1, 'a truly unchanged clean rerun must not invoke resolution again');
    assert.deepEqual(unchanged.vault_links.rows, linksAfterResolution, 'unchanged rerun must not churn link rows or references');
    assert.deepEqual(unchanged.vault_missing_targets.rows, missingAfterResolution, 'unchanged rerun must not churn missing-target rows');
  } finally {
    setIgnoredPaths([]);
  }
});
test('re-resolves an ignored target deleted from an unchanged ignored folder to missing', async () => {
  const secret = 'deleted-ignored-target-secret';
  const vault = await makeVault('ignored-target-deletion', {
    'A.md': '[[B]]\n',
    'ignored/B.md': `---\nsecret: ${secret}\n---\n# Hidden\n${secret}\n`,
  });
  const database = join(workRoot, 'ignored-target-deletion.db');
  const ignoredTarget = join(vault, 'ignored', 'B.md');
  setIgnoredPaths(['ignored']);
  const fs = createRequire(import.meta.url)('node:fs');
  const originalReadFileSync = fs.readFileSync;
  const ignoredReads = [];
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && resolve(filePath) === ignoredTarget) ignoredReads.push(filePath);
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    await indexVault(vault, database);
    const initial = rawSnapshot(database);
    const source = initial.vault_files.rows.find(row => row.path === join(vault, 'A.md'));
    const initialLink = initial.vault_links.rows.find(row => row.source_file_id === source?.id && row.raw_target === 'B');
    assert(source && initialLink, 'fixture must persist A and its A→B occurrence');
    assert.equal(initialLink.resolution_status, 'ignored');
    assert.equal(initialLink.target_file_id, null);
    assert.equal(initialLink.target_node_id, null);
    assert.equal(initialLink.missing_target_id, null);
    assert(!initial.vault_files.rows.some(row => row.path === ignoredTarget));
    const indexedContent = Object.fromEntries(['vault_files', 'vault_directories', 'markdown_nodes', 'frontmatter_nodes', 'frontmatter_errors', 'vault_tags', 'note_tag_occurrences']
      .map(table => [table, initial[table].rows]));

    await rm(ignoredTarget);
    let resolverCalls = 0;
    await indexVault(vault, database, undefined, '.obsidian', undefined, () => { resolverCalls++; });
    const deleted = rawSnapshot(database);
    const deletedLink = deleted.vault_links.rows.find(row => row.id === initialLink.id);
    assert.equal(resolverCalls, 1, 'deleting an ignored candidate must re-resolve existing links');
    assert.equal(deletedLink?.source_file_id, source.id);
    assert.equal(deletedLink?.resolution_status, 'missing');
    assert.equal(deletedLink?.target_file_id, null);
    assert.equal(deletedLink?.target_node_id, null);
    assert.notEqual(deletedLink?.missing_target_id, null);
    assert(!deleted.vault_files.rows.some(row => row.path === ignoredTarget));
    for (const [table, rows] of Object.entries(indexedContent)) {
      assert.deepEqual(deleted[table].rows, rows, `${table} must remain unchanged by deleting an ignored-only candidate`);
    }
    assert.equal(ignoredReads.length, 0, 'reindexing after deletion must not read ignored B');
    assert(!JSON.stringify(deleted).includes(secret));

    const linksAfterTransition = deleted.vault_links.rows;
    const missingAfterTransition = deleted.vault_missing_targets.rows;
    await indexVault(vault, database, undefined, '.obsidian', undefined, () => { resolverCalls++; });
    const unchanged = rawSnapshot(database);
    assert.equal(resolverCalls, 1, 'unchanged ignored inventory must be a true resolution no-op');
    assert.deepEqual(unchanged.vault_links.rows, linksAfterTransition);
    assert.deepEqual(unchanged.vault_missing_targets.rows, missingAfterTransition);
  } finally {
    fs.readFileSync = originalReadFileSync;
    setIgnoredPaths([]);
  }
});

test('re-resolves a newly created target inside an ignored folder from missing to ignored', async () => {
  const secret = 'created-ignored-target-secret';
  const vault = await makeVault('ignored-target-creation', {
    'A.md': '[[B]]\n',
  });
  const database = join(workRoot, 'ignored-target-creation.db');
  const ignoredDirectory = join(vault, 'ignored');
  const ignoredTarget = join(ignoredDirectory, 'B.md');
  await mkdir(ignoredDirectory);
  setIgnoredPaths(['ignored']);
  const fs = createRequire(import.meta.url)('node:fs');
  const originalReadFileSync = fs.readFileSync;
  const ignoredReads = [];
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && resolve(filePath) === ignoredTarget) ignoredReads.push(filePath);
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    await indexVault(vault, database);
    const initial = rawSnapshot(database);
    const source = initial.vault_files.rows.find(row => row.path === join(vault, 'A.md'));
    const initialLink = initial.vault_links.rows.find(row => row.source_file_id === source?.id && row.raw_target === 'B');
    assert(source && initialLink, 'fixture must persist A and its A→B occurrence');
    assert.equal(initialLink.resolution_status, 'missing');
    assert.equal(initialLink.target_file_id, null);
    assert.equal(initialLink.target_node_id, null);
    assert.notEqual(initialLink.missing_target_id, null);
    const indexedContent = Object.fromEntries(['vault_files', 'vault_directories', 'markdown_nodes', 'frontmatter_nodes', 'frontmatter_errors', 'vault_tags', 'note_tag_occurrences']
      .map(table => [table, initial[table].rows]));

    await writeFile(ignoredTarget, `---\nsecret: ${secret}\n---\n# Hidden\n${secret}\n`);
    let resolverCalls = 0;
    await indexVault(vault, database, undefined, '.obsidian', undefined, () => { resolverCalls++; });
    const created = rawSnapshot(database);
    const createdLink = created.vault_links.rows.find(row => row.id === initialLink.id);
    assert.equal(resolverCalls, 1, 'creating an ignored candidate must re-resolve existing links');
    assert.equal(createdLink?.source_file_id, source.id);
    assert.equal(createdLink?.resolution_status, 'ignored');
    assert.equal(createdLink?.target_file_id, null);
    assert.equal(createdLink?.target_node_id, null);
    assert.equal(createdLink?.missing_target_id, null);
    assert(!created.vault_files.rows.some(row => row.path === ignoredTarget));
    for (const [table, rows] of Object.entries(indexedContent)) {
      assert.deepEqual(created[table].rows, rows, `${table} must remain unchanged by creating an ignored-only candidate`);
    }
    assert.equal(ignoredReads.length, 0, 'reindexing must not read ignored B contents');
    assert(!JSON.stringify(created).includes(secret));

    const linksAfterTransition = created.vault_links.rows;
    const missingAfterTransition = created.vault_missing_targets.rows;
    await indexVault(vault, database, undefined, '.obsidian', undefined, () => { resolverCalls++; });
    const unchanged = rawSnapshot(database);
    assert.equal(resolverCalls, 1, 'unchanged ignored inventory must be a true resolution no-op');
    assert.deepEqual(unchanged.vault_links.rows, linksAfterTransition);
    assert.deepEqual(unchanged.vault_missing_targets.rows, missingAfterTransition);
  } finally {
    fs.readFileSync = originalReadFileSync;
    setIgnoredPaths([]);
  }
});

test('re-resolves ignored targets when ignore settings change after indexing', async () => {
  const vault = await makeVault('ignored-target-lifecycle', {
    'A.md': '[[B]]\n',
    'B.md': '---\nsecret: indexed-content\n---\n# Target\n',
  });
  const database = join(workRoot, 'ignored-target-lifecycle.db');
  setIgnoredPaths([]);
  try {
    await indexVault(vault, database);
    const initiallyResolved = rawSnapshot(database);
    const sourceId = initiallyResolved.vault_files.rows.find(row => row.path === join(vault, 'A.md')).id;
    const originalLink = initiallyResolved.vault_links.rows.find(row => row.source_file_id === sourceId);
    const targetBeforeIgnore = initiallyResolved.vault_files.rows.find(row => row.path === join(vault, 'B.md'));
    assert.equal(originalLink?.resolution_status, 'resolved');
    assert.equal(originalLink?.target_file_id, targetBeforeIgnore?.id);

    setIgnoredPaths(['B.md']);
    await indexVault(vault, database);
    const ignored = rawSnapshot(database);
    const ignoredLink = ignored.vault_links.rows.find(row => row.source_file_id === sourceId);
    assert.equal(ignoredLink?.id, originalLink?.id);
    assert.equal(ignoredLink?.resolution_status, 'ignored');
    assert.equal(ignoredLink?.target_file_id, null);
    assert(!ignored.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
    assert(!JSON.stringify(ignored).includes('indexed-content'));

    setIgnoredPaths([]);
    await indexVault(vault, database);
    const unignored = rawSnapshot(database);
    const unignoredLink = unignored.vault_links.rows.find(row => row.source_file_id === sourceId);
    const targetAfterUnignore = unignored.vault_files.rows.find(row => row.path === join(vault, 'B.md'));
    assert.equal(unignoredLink?.id, originalLink?.id);
    assert.equal(unignoredLink?.resolution_status, 'resolved');
    assert.equal(unignoredLink?.target_file_id, targetAfterUnignore?.id);
    assert(unignored.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
  } finally {
    setIgnoredPaths([]);
  }
});

test('applies a coalesced ignore change to persisted links and indexed files', async () => {
  const secret = 'coalesced-ignore-secret';
  const vault = await makeVault('coalesced-ignore', {
    'A.md': '[[B]]\n',
    'B.md': `---\nsecret: ${secret}\n---\n# Target\n${secret}\n`,
  });
  const database = join(workRoot, 'coalesced-ignore.db');
  const gate = createGate();
  let paused = false;
  setIgnoredPaths([]);
  try {
    const first = indexVault(vault, database, undefined, '.obsidian', undefined, async () => {
      if (!paused) {
        paused = true;
        gate.enter();
        await gate.wait();
      }
    });
    await gate.reached;
    setIgnoredPaths(['B.md']);
    const second = indexVault(vault, database);
    assert.strictEqual(second, first, 'the second request must coalesce while the first index is active');
    gate.release();
    await first;

    const snapshot = rawSnapshot(database);
    const source = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'));
    const link = snapshot.vault_links.rows.find(row => row.source_file_id === source?.id && row.raw_target === 'B');
    assert.equal(link?.resolution_status, 'ignored');
    assert.equal(link?.target_file_id, null);
    assert.equal(link?.target_node_id, null);
    assert.equal(link?.missing_target_id, null);
    assert(!snapshot.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
    assert(!snapshot.markdown_nodes.rows.some(row => JSON.stringify(row).includes(secret)));
    assert.equal(snapshot.frontmatter_nodes.rows.length, 0);
    assert.equal(snapshot.frontmatter_errors.rows.length, 0);
    assert(!JSON.stringify(snapshot).includes(secret));
  } finally {
    gate.release();
    setIgnoredPaths([]);
  }
});

test('applies a coalesced unignore change and indexes the newly selected target', async () => {
  const secret = 'coalesced-unignore-content';
  const vault = await makeVault('coalesced-unignore', {
    'A.md': '[[B]]\n',
    'B.md': `---\nsecret: ${secret}\n---\n# Target\n${secret}\n`,
  });
  const database = join(workRoot, 'coalesced-unignore.db');
  const gate = createGate();
  let paused = false;
  setIgnoredPaths(['B.md']);
  try {
    const first = indexVault(vault, database, undefined, '.obsidian', undefined, async () => {
      if (!paused) {
        paused = true;
        gate.enter();
        await gate.wait();
      }
    });
    await gate.reached;
    setIgnoredPaths([]);
    const second = indexVault(vault, database);
    assert.strictEqual(second, first, 'the unignore request must coalesce while the first index is active');
    gate.release();
    await first;

    const snapshot = rawSnapshot(database);
    const source = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'));
    const target = snapshot.vault_files.rows.find(row => row.path === join(vault, 'B.md'));
    const link = snapshot.vault_links.rows.find(row => row.source_file_id === source?.id && row.raw_target === 'B');
    assert.equal(link?.resolution_status, 'resolved');
    assert.equal(link?.target_file_id, target?.id);
    assert.notEqual(link?.target_file_id, null);
    assert.equal(link?.target_node_id, null);
    assert.equal(link?.missing_target_id, null);
    assert(target, 'B must be present in vault_files after unignore');
    assert(snapshot.markdown_nodes.rows.some(row => row.file_id === target.id), 'B content must be indexed');
    assert(snapshot.frontmatter_nodes.rows.some(row => row.file_id === target.id), 'B frontmatter content must be indexed');
    assert(JSON.stringify(snapshot).includes(secret));
  } finally {
    gate.release();
    setIgnoredPaths([]);
  }
});

test('uses host target choices and distinguishes ignored ambiguity from missing targets', async () => {
  const vault = await makeVault('host-target-choices', {
    'A-indexed.md': '[[Twin]]\n',
    'A-ignored.md': '[[Twin]]\n',
    'A-ambiguous.md': '[[Twin]]\n',
    'A-missing.md': '[[Absent]]\n',
    'A-indexed-ambiguous.md': '[[Solo]]\n',
    'indexed/Twin.md': '# Indexed target\n',
    'ignored/Twin.md': '# Ignored target\n',
    'solo-one/Solo.md': '# First indexed candidate\n',
    'solo-two/Solo.md': '# Second indexed candidate\n',
  });
  setIgnoredPaths(['ignored/Twin.md']);
  const overrides = new Map([
    [JSON.stringify(['Twin', 'A-indexed.md']), 'indexed/Twin.md'],
    [JSON.stringify(['Twin', 'A-ignored.md']), 'ignored/Twin.md'],
    [JSON.stringify(['Twin', 'A-ambiguous.md']), null],
  ]);
  try {
    const result = await indexVault(vault, join(workRoot, 'host-target-choices.db'), undefined, '.obsidian', overrides);
    const snapshot = rawSnapshot(result.databasePath);
    const linkFrom = source => {
      const sourceFile = snapshot.vault_files.rows.find(row => row.path === join(vault, source));
      return snapshot.vault_links.rows.find(row => row.source_file_id === sourceFile?.id);
    };
    const indexedTarget = snapshot.vault_files.rows.find(row => row.path === join(vault, 'indexed/Twin.md'));

    assert.equal(linkFrom('A-indexed.md')?.resolution_status, 'resolved');
    assert.equal(linkFrom('A-indexed.md')?.target_file_id, indexedTarget?.id);
    assert.equal(linkFrom('A-ignored.md')?.resolution_status, 'ignored');
    assert.equal(linkFrom('A-ignored.md')?.target_file_id, null);
    assert.equal(linkFrom('A-ambiguous.md')?.resolution_status, 'ambiguous_ignored');
    assert.equal(linkFrom('A-ambiguous.md')?.missing_target_id, null);
    assert.equal(linkFrom('A-missing.md')?.resolution_status, 'missing');
    assert.notEqual(linkFrom('A-missing.md')?.missing_target_id, null);
    assert.equal(linkFrom('A-indexed-ambiguous.md')?.resolution_status, 'ambiguous');
    assert.equal(linkFrom('A-indexed-ambiguous.md')?.missing_target_id, null);
    const ignoredLink = linkFrom('A-ignored.md');
    assert.equal(ignoredLink?.target_node_id, null);
    assert.equal(ignoredLink?.missing_target_id, null);
    const ignoredAmbiguousLink = linkFrom('A-ambiguous.md');
    assert.equal(ignoredAmbiguousLink?.target_file_id, null);
    assert.equal(ignoredAmbiguousLink?.target_node_id, null);
    assert.equal(ignoredAmbiguousLink?.missing_target_id, null);
    const missingLink = linkFrom('A-missing.md');
    assert.equal(missingLink?.target_file_id, null);
    assert.equal(missingLink?.target_node_id, null);
    const indexedAmbiguousLink = linkFrom('A-indexed-ambiguous.md');
    assert.equal(indexedAmbiguousLink?.target_file_id, null);
    assert.equal(indexedAmbiguousLink?.target_node_id, null);
    assert.equal(indexedAmbiguousLink?.missing_target_id, null);
  } finally {
    setIgnoredPaths([]);
  }
});

test('persists the host-selected duplicate target regardless of inventory order', async () => {
  const vault = await makeVault('inventory-order-selection', {
    'A.md': '[[Twin]]\n',
    'a/Twin.md': '# First candidate\n',
    'z/Twin.md': '# Host-selected candidate\n',
  });
  const overrides = new Map([[JSON.stringify(['Twin', 'A.md']), 'z/Twin.md']]);
  try {
    for (const [databaseName, reverseInventory] of [['inventory-forward.db', false], ['inventory-reversed.db', true]]) {
      const result = await indexVault(vault, join(workRoot, databaseName), undefined, '.obsidian', overrides, undefined, reverseInventory);
      const snapshot = rawSnapshot(result.databasePath);
      const sourceId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'))?.id;
      const link = snapshot.vault_links.rows.find(row => row.source_file_id === sourceId);
      const selectedId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'z/Twin.md'))?.id;
      assert.equal(link?.resolution_status, 'resolved');
      assert.equal(link?.target_file_id, selectedId);
    }
  } finally {
    setIgnoredPaths([]);
  }
});

test('path-qualified links keep the selected folder target without basename fallback', async () => {
  const vault = await makeVault('path-qualified-target', {
    'A.md': '[[folder/B]]\n',
    'B.md': '# Root target\n',
    'folder/B.md': '# Folder target\n',
  });
  const database = join(workRoot, 'path-qualified-target.db');
  setIgnoredPaths(['folder/B.md']);
  try {
    await indexVault(vault, database);
    const ignored = rawSnapshot(database);
    const sourceId = ignored.vault_files.rows.find(row => row.path === join(vault, 'A.md')).id;
    const ignoredLink = ignored.vault_links.rows.find(row => row.source_file_id === sourceId);
    assert.equal(ignoredLink?.resolution_status, 'ignored');
    assert.equal(ignoredLink?.target_file_id, null);
    assert.equal(ignoredLink?.target_node_id, null);
    assert.equal(ignoredLink?.missing_target_id, null);
    assert(ignored.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
    assert(!ignored.vault_files.rows.some(row => row.path === join(vault, 'folder/B.md')));

    setIgnoredPaths([]);
    await indexVault(vault, database);
    const resolved = rawSnapshot(database);
    const resolvedLink = resolved.vault_links.rows.find(row => row.source_file_id === sourceId);
    const rootTarget = resolved.vault_files.rows.find(row => row.path === join(vault, 'B.md'));
    const folderTarget = resolved.vault_files.rows.find(row => row.path === join(vault, 'folder/B.md'));
    assert.equal(resolvedLink?.resolution_status, 'resolved');
    assert.equal(resolvedLink?.target_file_id, folderTarget?.id);
    assert.notEqual(resolvedLink?.target_file_id, rootTarget?.id);
    assert.equal(resolvedLink?.target_node_id, null);
    assert.equal(resolvedLink?.missing_target_id, null);
  } finally {
    setIgnoredPaths([]);
  }
});

test('does not fall back to a root basename when a path-qualified host selection is null', async () => {
  const vault = await makeVault('path-qualified-null-selection', {
    'A.md': '[[folder/B]]\n',
    'B.md': '# Root target\n',
  });
  const overrides = new Map([[JSON.stringify(['folder/B', 'A.md']), null]]);
  try {
    const result = await indexVault(vault, join(workRoot, 'path-qualified-null-selection.db'), undefined, '.obsidian', overrides);
    const snapshot = rawSnapshot(result.databasePath);
    const sourceId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'))?.id;
    const link = snapshot.vault_links.rows.find(row => row.source_file_id === sourceId);
    assert.equal(link?.resolution_status, 'missing');
    assert.equal(link?.target_file_id, null);
    assert.notEqual(link?.missing_target_id, null);
    assert.equal(link?.target_node_id, null);
    assert(snapshot.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
  } finally {
    setIgnoredPaths([]);
  }
});

test('classifies path-qualified null selection from ignored candidates independent of inventory order', async () => {
  const vault = await makeVault('path-qualified-ignored-null-selection', {
    'A.md': '[[folder/B]]\n',
    'B.md': '# Root target\n',
    'folder/B.md': '# Ignored folder target\n',
  });
  const overrides = new Map([[JSON.stringify(['folder/B', 'A.md']), null]]);
  setIgnoredPaths(['folder/B.md']);
  const outcomes = [];
  try {
    for (const [databaseName, reverseInventory] of [['ignored-path-forward.db', false], ['ignored-path-reversed.db', true]]) {
      const result = await indexVault(vault, join(workRoot, databaseName), undefined, '.obsidian', overrides, undefined, reverseInventory);
      const snapshot = rawSnapshot(result.databasePath);
      const sourceId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'))?.id;
      const link = snapshot.vault_links.rows.find(row => row.source_file_id === sourceId);
      assert.equal(link?.resolution_status, 'ambiguous_ignored');
      assert.equal(link?.target_file_id, null);
      assert.equal(link?.target_node_id, null);
      assert.equal(link?.missing_target_id, null);
      assert(snapshot.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
      assert(!snapshot.vault_files.rows.some(row => row.path === join(vault, 'folder/B.md')));
      assert.equal(snapshot.vault_missing_targets.rows.length, 0);
      outcomes.push([link?.resolution_status, link?.target_file_id, link?.target_node_id, link?.missing_target_id]);
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
  } finally {
    setIgnoredPaths([]);
  }
});

test('resolves ignored and indexed targets for every recorded local link form', async () => {
  const vault = await makeVault('ignored-link-forms', {
    'A.md': `---
related: "[[B]]"
embedded: "![[B]]"
---
[[B]]
![[B]]
[markdown link](B.md)
![markdown image](B.md)
[external](https://example.com)
`,
    'B.md': '# Target\n',
  });
  const database = join(workRoot, 'ignored-link-forms.db');
  setIgnoredPaths(['B.md']);
  try {
    await indexVault(vault, database);
    const ignored = rawSnapshot(database);
    const sourceId = ignored.vault_files.rows.find(row => row.path === join(vault, 'A.md')).id;
    const ignoredLinks = ignored.vault_links.rows.filter(row => row.source_file_id === sourceId);
    const localIgnoredLinks = ignoredLinks.filter(row => row.resolution_status !== 'external');
    assert.equal(localIgnoredLinks.length, 6);
    assert(localIgnoredLinks.every(row => row.resolution_status === 'ignored'));
    assert.equal(localIgnoredLinks.filter(row => row.link_syntax === 'wikilink').length, 4);
    assert.equal(localIgnoredLinks.filter(row => row.link_syntax === 'link').length, 1);
    assert.equal(localIgnoredLinks.filter(row => row.link_syntax === 'image').length, 1);
    assert.equal(localIgnoredLinks.filter(row => row.is_embed === 1).length, 3);
    assert.equal(ignoredLinks.filter(row => row.resolution_status === 'external').length, 1);
    assert(localIgnoredLinks.every(row =>
      row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));
    assert(!ignored.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
    const ignoredExternal = ignoredLinks.filter(row => row.resolution_status === 'external');
    assert.equal(ignoredExternal.length, 1);
    assert(ignoredExternal.every(row =>
      row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));

    setIgnoredPaths([]);
    await indexVault(vault, database);
    const indexed = rawSnapshot(database);
    const indexedLinks = indexed.vault_links.rows.filter(row => row.source_file_id === sourceId);
    const localIndexedLinks = indexedLinks.filter(row => row.resolution_status !== 'external');
    const target = indexed.vault_files.rows.find(row => row.path === join(vault, 'B.md'));
    assert(localIndexedLinks.every(row => row.resolution_status === 'resolved'));
    assert(localIndexedLinks.every(row => row.target_file_id === target?.id));
    assert(localIndexedLinks.every(row => row.target_node_id === null && row.missing_target_id === null));
    assert.equal(indexedLinks.filter(row => row.resolution_status === 'external').length, 1);
    const indexedExternal = indexedLinks.filter(row => row.resolution_status === 'external');
    assert.equal(indexedExternal.length, 1);
    assert(indexedExternal.every(row =>
      row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));
  } finally {
    setIgnoredPaths([]);
  }
});

test('records missing targets for every parser-produced local link form', async () => {
  const vault = await makeVault('missing-link-forms', {
    'A.md': `---
related: "[[Absent]]"
embedded: "![[Absent]]"
---
[[Absent]]
![[Absent]]
[markdown link](Absent.md)
![markdown image](Absent.md)
[external](https://example.com)
`,
  });
  try {
    const result = await indexVault(vault, join(workRoot, 'missing-link-forms.db'));
    const snapshot = rawSnapshot(result.databasePath);
    const sourceId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'))?.id;
    const links = snapshot.vault_links.rows.filter(row => row.source_file_id === sourceId);
    const local = links.filter(row => row.resolution_status !== 'external');
    assert.equal(local.length, 6);
    assert(local.every(row => row.resolution_status === 'missing'));
    assert(local.every(row => row.target_file_id === null && row.target_node_id === null && row.missing_target_id !== null));
    assert.equal(local.filter(row => row.link_syntax === 'wikilink' && row.is_embed === 0).length, 2);
    assert.equal(local.filter(row => row.link_syntax === 'wikilink' && row.is_embed === 1).length, 2);
    assert.equal(local.filter(row => row.link_syntax === 'link' && row.is_embed === 0).length, 1);
    assert.equal(local.filter(row => row.link_syntax === 'image' && row.is_embed === 1).length, 1);
    assert.equal(links.filter(row => row.resolution_status === 'external').length, 1);
    const external = links.filter(row => row.resolution_status === 'external');
    assert(external.every(row =>
      row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));
  } finally {
    setIgnoredPaths([]);
  }
});

test('classifies parser-produced frontmatter and Markdown null selections with ignored candidates', async () => {
  const vault = await makeVault('null-selection-local-link-forms', {
    'A.md': '---\nrelated: "[[Twin]]"\n---\n[ignored target](folder/Twin.md)\n',
    'Twin.md': '# Root target\n',
    'folder/Twin.md': '# Ignored target\n',
  });
  const overrides = new Map([
    [JSON.stringify(['Twin', 'A.md']), null],
    [JSON.stringify(['folder/Twin.md', 'A.md']), null],
  ]);
  setIgnoredPaths(['folder/Twin.md']);
  try {
    const result = await indexVault(vault, join(workRoot, 'null-selection-local-link-forms.db'), undefined, '.obsidian', overrides);
    const snapshot = rawSnapshot(result.databasePath);
    const sourceId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md'))?.id;
    const links = snapshot.vault_links.rows.filter(row => row.source_file_id === sourceId);
    assert.equal(links.length, 2);
    assert.equal(links.find(row => row.raw_target === 'Twin')?.resolution_status, 'ambiguous_ignored');
    assert.equal(links.find(row => row.raw_target === 'folder/Twin.md')?.resolution_status, 'ambiguous_ignored');
    assert(links.every(row => row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));
    assert(links.some(row => row.link_syntax === 'wikilink' && row.source_frontmatter_node_id !== null));
    assert(links.some(row => row.link_syntax === 'link'));
    assert(snapshot.vault_files.rows.some(row => row.path === join(vault, 'Twin.md')));
    assert(!snapshot.vault_files.rows.some(row => row.path === join(vault, 'folder/Twin.md')));
  } finally {
    setIgnoredPaths([]);
  }
});

test('ignores heading and block fragments without reading the ignored file', async () => {
  const secret = 'ignored-fragment-secret';
  const vault = await makeVault('ignored-target-fragments', {
    'A.md': '[[B#Heading]]\n[[B#^block-id]]\n[[B#Missing]]\n',
    'B.md': `---\nsecret: ${secret}\n---\n# Heading\n\nParagraph ^block-id\n`,
  });
  setIgnoredPaths(['B.md']);
  const fs = createRequire(import.meta.url)('node:fs');
  const originalReadFileSync = fs.readFileSync;
  const ignoredPath = resolve(vault, 'B.md');
  const ignoredReads = [];
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && resolve(filePath) === ignoredPath) ignoredReads.push(filePath);
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    const result = await indexVault(vault, join(workRoot, 'ignored-target-fragments.db'));
    const snapshot = rawSnapshot(result.databasePath);
    const sourceId = snapshot.vault_files.rows.find(row => row.path === join(vault, 'A.md')).id;
    const links = snapshot.vault_links.rows.filter(row => row.source_file_id === sourceId);
    assert.equal(links.length, 3);
    assert(links.every(row => row.resolution_status === 'ignored'));
    assert(links.every(row => row.target_file_id === null && row.target_node_id === null && row.missing_target_id === null));
    assert.equal(ignoredReads.length, 0);
    assert(!snapshot.vault_files.rows.some(row => row.path === join(vault, 'B.md')));
    assert(!JSON.stringify(snapshot).includes(secret));
  } finally {
    fs.readFileSync = originalReadFileSync;
    setIgnoredPaths([]);
  }
});

const COMPLEX_FILES = {
  'source.md': `---
tags:
  - project/root
  - project/root
  - unicode/😀
related:
  - "[[Target#Section]]"
  - "[[nested/Target]]"
metadata:
  enabled: true
  values: [one, 2, null]
base: &base
  owner: me # inline comment
alias: *base
description: |-
  first line
  second line
dup: first
dup: second
---
# Source

😀 before [[Target]] and [[Missing Concept]]
![[image.PNG]]
[external](https://example.com/a)
[relative](nested/Target.md#Section)
[[nested/Target#Section]]
[[nested/Target#Section]]
[[nested/Target#Missing Heading]]
[[nested/Target#^missing-block]]
![missing](assets/no-image.png)
> [!warning]- Folded\n> body

${String.fromCharCode(96).repeat(3)}js
# not a heading
${String.fromCharCode(96).repeat(3)}
Paragraph ^source-block
`,
  'syntax.md': [
    '---',
    'nullable: null',
    'attrs:',
    '  enabled: true',
    '---',
    '# Outer',
    '## Nested',
    'first ^duplicate-block',
    'second ^duplicate-block',
    '',
    '[^foot]: Footnote text',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '<div>html</div>',
    '',
    '$\\\\alpha + \\beta$',
    '',
    '> [!note]- Callout',
    '> body',
    '',
    String.fromCharCode(96).repeat(3) + 'js',
    'const fenced = true;',
    String.fromCharCode(96).repeat(3),
  ].join(String.fromCharCode(13, 10)),
  'ambiguous.md': '# Ambiguous\\n[[Twin]]\\n',
  'ambiguous/a/Twin.md': '# Twin A\\n',
  'ambiguous/b/Twin.md': '# Twin B\\n',
  'Target.md': '# Section\\n\\n## Child\\nTarget paragraph ^target-block\\n',
  'nested/Target.md': '# Section\n',
  'nested/child.MD': '# Child\n#tag/inline\n',
  'empty.md': '---\n---\n# Empty\n',
  'broken.md': '---\ntags: [unterminated\n---\n# Broken\n',
  'unclosed.md': '---\ntags:\n  - pending\n# Body\n',
  'dots.md': '---\ntags: dotted\n...\n# Dots\n',
  'image.PNG': Buffer.from([137, 80, 78, 71]),
  'script.PY': 'print("hello")\n',
  'clip.mp4': Buffer.from([0, 1, 2]),
  'audio.flac': Buffer.from([3, 4]),
  'paper.pdf': Buffer.from([5, 6]),
  'trailing.': 'not markdown\n',
  'note.md.': 'not markdown\n',
  'drawing.excalidraw.md': '---\ntags: [excalidraw]\n---\n# Drawing\n',
  'ignored/.git/config': 'not indexed\n',
  '.obsidian/app.json': '{}\n',
  'templates/template.md': '# ignored\n',
  'excalidraws/drawing.md': '# ignored\n',
  '.diaryTrash/trash.md': '# ignored\n',
};

async function runBoth(vault, name, compareOracleLinkResolution = true) {
  const pythonDb = join(workRoot, `${name}-python.db`);
  const typescriptDb = join(workRoot, `${name}-typescript.db`);
  oracle(vault, pythonDb);
  const result = await indexVault(vault, typescriptDb);
  assert.equal(result.databasePath, typescriptDb);
  const excludedTables = compareOracleLinkResolution ? [] : ['vault_links', 'vault_missing_targets'];
  assertParity(pythonDb, typescriptDb, `Python/TypeScript database mismatch for ${name}`, excludedTables);
  return { pythonDb, typescriptDb, result };
}

async function markDirty(database) {
  execFileSync(PYTHON, ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE vault_index_state SET derived_data_dirty=1 WHERE id=1"); c.commit()`, database]);
}

async function createLegacy(database, vault) {
  const script = String.raw`
import os, sqlite3, sys
from indexer import initialize_database
vault, database = sys.argv[1], sys.argv[2]
con = sqlite3.connect(database)
cur = con.cursor()
cur.execute("CREATE TABLE vault_files (id INTEGER PRIMARY KEY, directory_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, inode INTEGER NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL)")
initialize_database(cur)
cur.execute("ALTER TABLE vault_index_state DROP COLUMN fenced_code_version")
cur.execute("ALTER TABLE vault_index_state DROP COLUMN callout_version")
cur.execute("INSERT INTO vault_directories(path,inode,parent_id) VALUES(?,?,NULL)", (vault, os.stat(vault).st_ino))
cur.execute("INSERT INTO vault_files(directory_id,path,name,inode,mtime_ns,extension,kind) VALUES(?,?,?,?,?,?,?)", (1, os.path.join(vault,"legacy.md"), "legacy", os.stat(os.path.join(vault,"legacy.md")).st_ino, 0, ".md", "markdown"))
cur.execute("ALTER TABLE markdown_nodes ADD COLUMN heading_text TEXT")
cur.execute("INSERT INTO markdown_nodes(file_id,parent_id,ordinal,node_type,value,block_id,attributes_json,start_line,start_column,start_offset_utf16,end_line,end_column,end_offset_utf16,heading_text) VALUES(1,NULL,0,'heading',NULL,NULL,'{}',1,1,0,1,9,8,'Legacy')")
cur.execute("ALTER TABLE vault_links ADD COLUMN target_heading TEXT")
cur.execute("ALTER TABLE vault_links ADD COLUMN target_block_id TEXT")
cur.execute("UPDATE vault_index_state SET derived_data_dirty=1 WHERE id=1")
con.commit(); con.close()
`;
  execFileSync(PYTHON, ['-c', script, vault, database], { cwd: ROOT_DIR, env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH || ''}` } });
}

test('indexes a complete fixture with content parity and explicit link behavior', async () => {
  const vault = await makeVault('complete', COMPLEX_FILES);
  await symlink('Target.md', join(vault, 'target-link.md'));
  const { pythonDb, typescriptDb } = await runBoth(vault, 'complete', false);
  const tsBefore = await stat(typescriptDb, { bigint: true });
  const result = await indexVault(vault, typescriptDb);
  assert.equal(result.indexedFiles, 0);
  assert.equal(result.deletedFiles, 0);
  assert.equal((await stat(typescriptDb, { bigint: true })).mtimeNs, tsBefore.mtimeNs, 'unchanged indexing must not rewrite the database');
  oracle(vault, pythonDb);
  assertParity(pythonDb, typescriptDb, 'unchanged rerun diverged from oracle', ['vault_links', 'vault_missing_targets']);
  const clearLinks = ['import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM vault_links"); c.commit()'];
  execFileSync(PYTHON, ['-c', clearLinks[0], pythonDb]);
  execFileSync(PYTHON, ['-c', clearLinks[0], typescriptDb]);
  oracle(vault, pythonDb);
  await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'empty vault_links backfill diverged from oracle', ['vault_links', 'vault_missing_targets']);
  const snapshot = semanticSnapshot(typescriptDb);
  assert(snapshot.frontmatter_errors.rows.length >= 1, 'malformed YAML must be retained as an error');
  assert(snapshot.frontmatter_nodes.rows.some(row => row.key === 'dup' && row.value === 'first'));
  assert(snapshot.frontmatter_nodes.rows.some(row => row.key === 'dup' && row.value === 'second'));
  assert(snapshot.markdown_nodes.rows.some(row => row.node_type === 'heading' && row.value === 'Section'));
  assert(snapshot.markdown_nodes.rows.some(row => row.node_type === 'heading' && row.value === 'Nested'), 'nested headings must be retained');
  assert(snapshot.markdown_nodes.rows.filter(row => row.block_id === 'duplicate-block').length >= 1, 'duplicate block IDs must preserve occurrences');
  assert(snapshot.frontmatter_nodes.rows.some(row => row.key === 'nullable' && row.value === 'null'), 'YAML null scalar must remain null: ' + JSON.stringify(snapshot.frontmatter_nodes.rows.filter(row => row.key === 'nullable')));
  const statuses = Object.create(null);
  for (const row of snapshot.vault_links.rows) statuses[row.resolution_status] = true;
  assert(statuses.external && statuses.missing && statuses.missing_fragment && statuses.resolved, 'link fragment states must be retained');
  assert(snapshot.vault_links.rows.filter(row => row.raw_target === 'nested/Target#Section').length >= 2, 'duplicate link occurrences must be preserved');
  assert(snapshot.vault_links.rows.some(row => row.raw_target === 'Twin' && row.resolution_status === 'ambiguous'), 'ambiguous basename links must remain ambiguous');
  const imageLink = snapshot.vault_links.rows.find(row => row.raw_target === 'image.PNG');
  const imageFile = snapshot.vault_files.rows.find(row => row.path === join(vault, 'image.PNG'));
  assert.equal(imageLink?.resolution_status, 'resolved');
  assert.equal(imageLink?.target_file_id, imageFile?.path);
  assert.equal(imageLink?.target_node_id, null);
  assert.equal(imageLink?.missing_target_id, null);
  const links = snapshot.vault_links.rows;
  const unrelatedResolved = links.find(row => row.source_file_id === join(vault, 'source.md') && row.raw_target === 'nested/Target');
  assert.equal(unrelatedResolved?.resolution_status, 'resolved');
  assert.equal(unrelatedResolved?.target_file_id, join(vault, 'nested/Target.md'));
  assert.equal(unrelatedResolved?.target_node_id, null);
  assert.equal(unrelatedResolved?.missing_target_id, null);
  const unrelatedMissing = links.find(row => row.source_file_id === join(vault, 'source.md') && row.raw_target === 'Missing Concept');
  assert.equal(unrelatedMissing?.resolution_status, 'missing');
  assert.equal(unrelatedMissing?.target_file_id, null);
  assert.equal(unrelatedMissing?.target_node_id, null);
  assert.deepEqual(unrelatedMissing?.missing_target_id, ['name', 'Missing Concept', null]);
  const external = links.find(row => row.source_file_id === join(vault, 'source.md') && row.raw_target === 'https://example.com/a');
  assert.equal(external?.resolution_status, 'external');
  assert.equal(external?.target_file_id, null);
  assert.equal(external?.target_node_id, null);
  assert.equal(external?.missing_target_id, null);
  const ambiguous = links.find(row => row.source_file_id === join(vault, 'ambiguous.md') && row.raw_target === 'Twin');
  assert.equal(ambiguous?.resolution_status, 'ambiguous');
  assert.equal(ambiguous?.target_file_id, null);
  assert.equal(ambiguous?.target_node_id, null);
  assert.equal(ambiguous?.missing_target_id, null);
  const missingFragment = links.find(row =>
    row.source_file_id === join(vault, 'source.md') && row.raw_target === 'nested/Target#Missing Heading');
  assert.equal(missingFragment?.resolution_status, 'missing_fragment');
  assert.equal(missingFragment?.target_file_id, join(vault, 'nested/Target.md'));
  assert.equal(missingFragment?.target_node_id, null);
  assert.deepEqual(missingFragment?.missing_target_id, ['heading', 'Missing Heading', join(vault, 'nested/Target.md')]);
  const repeatedResolved = links.filter(row =>
    row.source_file_id === join(vault, 'source.md') && row.raw_target === 'nested/Target#Section');
  assert.equal(repeatedResolved.length, 2);
  assert(repeatedResolved.every(row =>
    row.resolution_status === 'resolved' &&
    row.target_file_id === join(vault, 'nested/Target.md') &&
    row.target_node_id !== null &&
    row.missing_target_id === null));
  assert(snapshot.note_tag_occurrences.rows.length >= 4, 'frontmatter and inline tag occurrences must be recorded');
  const noteWithTrailingDot = snapshot.vault_files.rows.find(row => row.path.endsWith('/note.md.'));
  assert.deepEqual(
    [noteWithTrailingDot?.name, noteWithTrailingDot?.extension, noteWithTrailingDot?.kind],
    ['note.md.', '', 'other'],
  );
  const kinds = Object.create(null);
  for (const row of snapshot.vault_files.rows) kinds[row.kind] = true;
  for (const kind of ['markdown', 'image', 'script', 'video', 'recording', 'pdf']) assert(kinds[kind], 'missing file kind ' + kind);
  assert(snapshot.frontmatter_errors.rows.some(row => row.error_output === 'yaml-parse-error'));
});
test('matches the Python oracle on a generated nine-note YAML fixture', async () => {
  const vault = await makeVault('nine-note-fixture', {
    'note1.md': '---\naliases: aliases: note2\n---\n\nImproper nesting of yaml\n',
    'note2.md': '---\naliases:\n---\n\nNo value in yaml\n',
    'note3.md': '---\naliases: a\naliases: b\n---\n\nDuplicate key in yaml\n',
    'note4.md': '---\naliases: a\n\ntags: b\n---\n\nBlank line in yaml\n',
    'note5.md': '---\naliases: a\naliases: a\n---\n\nDuplicate key and value in yaml\n',
    'note6.md': '---\nrelated: [[link]]\n---\n\nImproper link in yaml\n',
    'note7.md': '---\naliases: [link]\n---\n\nImproper link in yaml\n',
    'note8.md': '---\nrelated: "[[link]]"\n---\n\nProper link in yaml\n\n[[link]]\n',
    'note9.md': '---\ntags: [a, b, c]\ntags:\n  - a\n  - b\n  - c\n---\n',
  });
  const { result } = await runBoth(vault, 'nine-note-fixture');
  assert.equal(result.indexedFiles, 9);
});

test('rolls back a failed file parse without dirtying the previous index', async () => {
  const vault = await makeVault('transaction-failure', { 'keep.md': '# Keep\\n' });
  const { pythonDb, typescriptDb } = await runBoth(vault, 'transaction-failure');
  const beforePython = semanticSnapshot(pythonDb);
  const beforeTypescript = semanticSnapshot(typescriptDb);
  await writeFile(join(vault, 'invalid.md'), Buffer.from([0xc3, 0x28]));
  const failedOracle = spawnSync(PYTHON, [ORACLE, vault, pythonDb], { cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env, PATH: NODE_BIN } });
  assert.notEqual(failedOracle.status, 0, 'invalid UTF-8 must fail the oracle parse');
  let failedTypescript = false;
  try { await indexVault(vault, typescriptDb); } catch { failedTypescript = true; }
  assert(failedTypescript, 'invalid UTF-8 must reject the TypeScript index operation');
  assert.deepStrictEqual(semanticSnapshot(pythonDb), beforePython);
  assert.deepStrictEqual(semanticSnapshot(typescriptDb), beforeTypescript);
  assertParity(pythonDb, typescriptDb, 'failed transaction recovery diverged from oracle');
});

test('reconciles modifications, deletion, directory rename, file/folder replacement, and shared missing links', async () => {
  const vault = await makeVault('changes', COMPLEX_FILES);
  const { pythonDb, typescriptDb } = await runBoth(vault, 'changes', false);
  const source = join(vault, 'source.md');
  const oldSourceStat = await stat(source, { bigint: true });
  const sourceText = await readFile(source, 'utf8');
  await writeFile(source, sourceText + '\n[[New Note]]\n');
  setMtimeNs(source, oldSourceStat.mtimeNs + 1n);
  const removed = join(vault, 'nested', 'Target.md');
  await rm(removed);
  const created = join(vault, 'New Note.md');
  await writeFile(created, '# New Note\n');
  await rename(join(vault, 'nested'), join(vault, 'renamed'));
  await writeFile(join(vault, 'swap.md'), '# Swap\n');

  const py = oracle(vault, pythonDb);
  const tsResult = await indexVault(vault, typescriptDb);
  assert.equal(typeof tsResult.indexedFiles, 'number');
  assert.equal(typeof tsResult.deletedFiles, 'number');
  assert(tsResult.indexedFiles > 0);
  assertParity(pythonDb, typescriptDb, 'incremental mutation diverged from oracle', ['vault_links', 'vault_missing_targets']);
  assert(semanticSnapshot(typescriptDb).vault_files.rows.some(row => row.path === join(vault, 'renamed', 'child.MD')));
  assert(!semanticSnapshot(typescriptDb).vault_files.rows.some(row => row.path === removed));
  void py;

  await rm(join(vault, 'swap.md'));
  await mkdir(join(vault, 'swap'));
  await writeFile(join(vault, 'swap', 'child.md'), '# Child swap\n');
  oracle(vault, pythonDb);
  await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'file/folder replacement diverged from oracle', ['vault_links', 'vault_missing_targets']);

  await markDirty(pythonDb);
  await markDirty(typescriptDb);
  oracle(vault, pythonDb);
  const recovered = await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'dirty derived-data recovery diverged from oracle', ['vault_links', 'vault_missing_targets']);
  assert.equal(semanticSnapshot(typescriptDb).vault_index_state.rows[0].derived_data_dirty, 0);
  assert.equal(recovered.deletedFiles, 0);
});
test('recovers an interruption on the first 1001-file batch after 1000 committed inserts', async () => {
  const files = {};
  for (let i = 0; i < 1001; i += 1) {
    const name = String(i).padStart(4, '0');
    files['notes/' + name + '.md'] = '---' + String.fromCharCode(10) + 'tags: [batch-' + name + ']' + String.fromCharCode(10) + '---' + String.fromCharCode(10) + '# Note ' + name + String.fromCharCode(10);
  }
  const vault = await makeVault('interrupted-first-batch', files);
  const pythonDb = join(workRoot, 'interrupted-first-batch-python.db');
  const typescriptDb = join(workRoot, 'interrupted-first-batch-typescript.db');
  oracleInterrupted(vault, pythonDb);
  const fs = createRequire(import.meta.url)('node:fs');
  const originalReadFileSync = fs.readFileSync;
  let markdownReads = 0;
  fs.readFileSync = function patchedReadFileSync(filePath, ...args) {
    if (typeof filePath === 'string' && filePath.endsWith('.md')) {
      markdownReads += 1;
      if (markdownReads === 1001) throw new Error('intentional batch interruption');
    }
    return originalReadFileSync.call(this, filePath, ...args);
  };
  try {
    await assert.rejects(indexVault(vault, typescriptDb), /intentional batch interruption/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(markdownReads, 1001);
  assertParity(pythonDb, typescriptDb, 'interrupted first batch partial state diverged from oracle');
  let partial = semanticSnapshot(typescriptDb);
  assert.equal(partial.vault_files.rows.length, 1000);
  assert.equal(partial.note_tag_occurrences.rows.length, 0);
  assert.equal(partial.vault_index_state.rows[0].derived_data_dirty, 1);
  oracle(vault, pythonDb);
  await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'interrupted first batch recovery diverged from oracle');
  const recovered = semanticSnapshot(typescriptDb);
  assert.equal(recovered.vault_files.rows.length, 1001);
  assert.equal(recovered.note_tag_occurrences.rows.length, 1001);
  assert.equal(recovered.vault_index_state.rows[0].derived_data_dirty, 0);
});
test('recovers a failed 1000-file batch after the invalid final file is removed', async () => {
  const files = {};
  for (let index = 0; index < 1000; index += 1) files['note-' + String(index).padStart(4, '0') + '.md'] = '# Note\\n';
  const vault = await makeVault('batch-recovery', files);
  const { pythonDb, typescriptDb } = await runBoth(vault, 'batch-recovery');
  const beforePython = semanticSnapshot(pythonDb);
  const beforeTypescript = semanticSnapshot(typescriptDb);
  const invalid = join(vault, 'zzzz-invalid.md');
  await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  const failedOracle = spawnSync(PYTHON, [ORACLE, vault, pythonDb], { cwd: ROOT_DIR, encoding: 'utf8', env: { ...process.env, PATH: NODE_BIN } });
  assert.notEqual(failedOracle.status, 0);
  await assert.rejects(() => indexVault(vault, typescriptDb));
  assert.deepStrictEqual(semanticSnapshot(pythonDb), beforePython);
  assert.deepStrictEqual(semanticSnapshot(typescriptDb), beforeTypescript);
  await rm(invalid);
  oracle(vault, pythonDb);
  await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, '1000-file recovery diverged from oracle');
});

test('preserves autolink boundaries next to typographic quotes and parentheses', async () => {
  const vault = await makeVault('autolink-punctuation', {
    'note.md': '- **Text**:  \n  - Website info (“www.example.com”) and credits.  \n',
  });
  const { typescriptDb } = await runBoth(vault, 'autolink-punctuation');
  assert.equal(semanticSnapshot(typescriptDb).vault_links.rows.length, 1);
});
test('uses the vault-local default database path and preserves migration rows', async () => {
  const vault = await makeVault('default-and-legacy', { 'legacy.md': '# Legacy\n' });
  const expected = join(vault, '.obsidian', 'vaultHelper.db');
  const result = await indexVault(vault);
  assert.equal(result.databasePath, expected);
  assert.equal((await stat(expected)).isFile(), true);

  const legacyPython = join(workRoot, 'legacy-python.db');
  const legacyTypescript = join(workRoot, 'legacy-typescript.db');
  await createLegacy(legacyPython, vault);
  await readFile(legacyPython).then(bytes => writeFile(legacyTypescript, bytes));
  execFileSync(PYTHON, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("ALTER TABLE vault_files DROP COLUMN mtime_ns"); c.commit()', legacyTypescript]);
  oracle(vault, legacyPython);
  await indexVault(vault, legacyTypescript);
  assertParity(legacyPython, legacyTypescript, 'legacy schema migration diverged from oracle');
  const migrated = rawSnapshot(legacyTypescript);
  assert(!migrated.markdown_nodes.columns.includes('heading_text'));
  assert(!migrated.vault_links.columns.includes('target_heading'));
  assert(!migrated.vault_links.columns.includes('target_block_id'));
});
test('uses vault configDir for default database and excludes only its subtree', async () => {
  const vault = await makeVault('custom-config-dir', {
    'vault-config/private.md': '# Private\n',
    'vault-config/nested/private.md': '# Nested private\n',
    'nested/vault-config/visible.md': '# Visible\n',
    '.obsidian/visible.md': '# Custom config leaves .obsidian indexable\n',
    'note.md': '# Note\n',
  });
  const configDir = 'vault-config';
  const expectedDatabase = join(vault, configDir, 'vaultHelper.db');
  const result = await indexVault(vault, undefined, undefined, configDir);
  assert.equal(result.databasePath, expectedDatabase);
  const indexedPaths = rawSnapshot(result.databasePath).vault_files.rows
    .map(file => relative(vault, file.path))
    .sort();
  assert.deepEqual(indexedPaths, ['.obsidian/visible.md', 'nested/vault-config/visible.md', 'note.md']);
});
test('applies user ignored file and directory paths with a custom configDir', async () => {
  setIgnoredPaths([]);
  const vault = await makeVault('user-ignored-paths', {
    'custom-settings/config-note.md': '# Config note\n',
    'ignored.md': '# Ignored file\n',
    'ignored-folder/nested/hidden.md': '# Ignored descendant\n',
    'note.md': '# Control note\n',
  });
  try {
    setIgnoredPaths(['ignored.md', 'ignored-folder']);
    const result = await indexVault(vault, undefined, undefined, 'custom-settings');
    const snapshot = rawSnapshot(result.databasePath);
    const indexedPaths = snapshot.vault_files.rows
      .map(file => relative(vault, file.path))
      .sort();
    const indexedDirectories = snapshot.vault_directories.rows
      .map(directory => relative(vault, directory.path));
    assert.deepEqual(indexedPaths, ['note.md']);
    assert(!indexedDirectories.includes('ignored-folder'));
  } finally {
    setIgnoredPaths([]);
  }
});
test('yields through the worker-scoped timer every 25 files', async () => {
  const vault = await makeVault('worker-scoped-timer', Object.fromEntries(
    Array.from({ length: 26 }, (_, index) => [`note-${index}.md`, `# Note ${index}\n`]),
  ));
  const originalSelf = globalThis.self;
  const schedule = globalThis.setTimeout;
  const delays = [];
  globalThis.self = {
    setTimeout(callback, delay) {
      delays.push(delay);
      return schedule(callback, delay);
    },
  };
  try {
    const result = await indexVault(vault, join(workRoot, 'worker-scoped-timer.db'));
    assert.equal(result.indexedFiles, 26);
    assert.deepEqual(delays, [0]);
  } finally {
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});
