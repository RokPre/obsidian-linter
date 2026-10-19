import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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
const indexVault = (vaultPath, databasePath, onProgress) => indexer.indexVault(vaultPath, '.obsidian', databasePath, onProgress);
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
    snapshot[table] = {
      columns: tableData.columns,
      rows: tableData.rows.map(row => normalize(table, row)).sort((a, b) => key(a).localeCompare(key(b))),
    };
  }
  return snapshot;
}

function assertParity(pythonDb, typescriptDb, label) {
  assert.deepStrictEqual(JSON.parse(execFileSync(PYTHON, ['-c', FOREIGN_KEYS_SCRIPT, pythonDb], { encoding: 'utf8' })), [], label + ': Python foreign keys');
  assert.deepStrictEqual(JSON.parse(execFileSync(PYTHON, ['-c', FOREIGN_KEYS_SCRIPT, typescriptDb], { encoding: 'utf8' })), [], label + ': TypeScript foreign keys');
  const actual = semanticSnapshot(typescriptDb);
  const expected = semanticSnapshot(pythonDb);
  if (!isDeepStrictEqual(actual, expected)) {
    const badTables = TABLES.filter(table => !isDeepStrictEqual(actual[table], expected[table]));
    const mismatch = badTables.map(table => table + ' actual=' + actual[table].rows.length + ' expected=' + expected[table].rows.length);
    const differences = badTables.flatMap(table => actual[table].rows.map((row, index) => isDeepStrictEqual(row, expected[table].rows[index]) ? null : ({ table, index, actual: row, expected: expected[table].rows[index] })).filter(Boolean));
    throw new Error(label + ': mismatched tables ' + mismatch.join(', ') + ' firstDiff=' + JSON.stringify(differences[0]));
  }
  assert.deepStrictEqual(actual, expected, label);
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

async function runBoth(vault, name) {
  const pythonDb = join(workRoot, `${name}-python.db`);
  const typescriptDb = join(workRoot, `${name}-typescript.db`);
  oracle(vault, pythonDb);
  const result = await indexVault(vault, typescriptDb);
  assert.equal(result.databasePath, typescriptDb);
  assertParity(pythonDb, typescriptDb, `Python/TypeScript database mismatch for ${name}`);
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

test('indexes a complete fixture with semantic parity, all table rows, tags, links, errors, and positions', async () => {
  const vault = await makeVault('complete', COMPLEX_FILES);
  await symlink('Target.md', join(vault, 'target-link.md'));
  const { pythonDb, typescriptDb } = await runBoth(vault, 'complete');
  const tsBefore = await stat(typescriptDb, { bigint: true });
  const result = await indexVault(vault, typescriptDb);
  assert.equal(result.indexedFiles, 0);
  assert.equal(result.deletedFiles, 0);
  assert.equal((await stat(typescriptDb, { bigint: true })).mtimeNs, tsBefore.mtimeNs, 'unchanged indexing must not rewrite the database');
  oracle(vault, pythonDb);
  assertParity(pythonDb, typescriptDb, 'unchanged rerun diverged from oracle');
  const clearLinks = ['import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM vault_links"); c.commit()'];
  execFileSync(PYTHON, ['-c', clearLinks[0], pythonDb]);
  execFileSync(PYTHON, ['-c', clearLinks[0], typescriptDb]);
  oracle(vault, pythonDb);
  await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'empty vault_links backfill diverged from oracle');
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
  const { pythonDb, typescriptDb } = await runBoth(vault, 'changes');
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
  assertParity(pythonDb, typescriptDb, 'incremental mutation diverged from oracle');
  assert(semanticSnapshot(typescriptDb).vault_files.rows.some(row => row.path === join(vault, 'renamed', 'child.MD')));
  assert(!semanticSnapshot(typescriptDb).vault_files.rows.some(row => row.path === removed));
  void py;

  await rm(join(vault, 'swap.md'));
  await mkdir(join(vault, 'swap'));
  await writeFile(join(vault, 'swap', 'child.md'), '# Child swap\n');
  oracle(vault, pythonDb);
  await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'file/folder replacement diverged from oracle');

  await markDirty(pythonDb);
  await markDirty(typescriptDb);
  oracle(vault, pythonDb);
  const recovered = await indexVault(vault, typescriptDb);
  assertParity(pythonDb, typescriptDb, 'dirty derived-data recovery diverged from oracle');
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
  const result = await indexer.indexVault(vault, configDir);
  assert.equal(result.databasePath, expectedDatabase);
  const indexedPaths = rawSnapshot(result.databasePath).vault_files.rows
    .map(file => relative(vault, file.path))
    .sort();
  assert.deepEqual(indexedPaths, ['.obsidian/visible.md', 'nested/vault-config/visible.md', 'note.md']);
});
test('applies user ignored file and directory paths with a custom configDir', async () => {
  indexer.setIgnoredPaths([]);
  const vault = await makeVault('user-ignored-paths', {
    'custom-settings/config-note.md': '# Config note\n',
    'ignored.md': '# Ignored file\n',
    'ignored-folder/nested/hidden.md': '# Ignored descendant\n',
    'note.md': '# Control note\n',
  });
  try {
    indexer.setIgnoredPaths(['ignored.md', 'ignored-folder']);
    const result = await indexer.indexVault(vault, 'custom-settings');
    const snapshot = rawSnapshot(result.databasePath);
    const indexedPaths = snapshot.vault_files.rows
      .map(file => relative(vault, file.path))
      .sort();
    const indexedDirectories = snapshot.vault_directories.rows
      .map(directory => relative(vault, directory.path));
    assert.deepEqual(indexedPaths, ['note.md']);
    assert(!indexedDirectories.includes('ignored-folder'));
  } finally {
    indexer.setIgnoredPaths([]);
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
