import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import { build } from 'esbuild';

const TEST_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const ROOT_DIR = resolve(PLUGIN_DIR, '..');
const PYTHON = process.env.PYTHON || '/usr/bin/python3';
const ORACLE = join(ROOT_DIR, 'indexer.py');

let indexer;
let bundlePath;
let workRoot;

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'vault-helper-frontmatter-tests-'));
  bundlePath = join(PLUGIN_DIR, `.frontmatter-test-${process.pid}.cjs`);
  await build({
    entryPoints: [join(PLUGIN_DIR, 'src', 'indexer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    loader: { '.wasm': 'binary' },
    outfile: bundlePath,
    logLevel: 'silent',
  });
  indexer = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
});

after(async () => {
  if (bundlePath) await rm(bundlePath, { force: true });
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

function parse(source) {
  return indexer.parse_frontmatter(source.split(/(?<=\n)/));
}

const DUMP = String.raw`
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
out = {}
for table in ('frontmatter_errors', 'frontmatter_nodes'):
    rows = []
    columns = [row[1] for row in con.execute(f'PRAGMA table_info({table})')]
    for row in con.execute(f'SELECT * FROM {table} ORDER BY id'):
        record = dict(zip(columns, row))
        record.pop('id', None)
        record.pop('file_id', None)
        if table == 'frontmatter_nodes':
            parent = record.pop('parent_id')
            record['parent_id'] = None if parent is None else con.execute('SELECT ordinal FROM frontmatter_nodes WHERE id = ?', (parent,)).fetchone()[0]
        rows.append(record)
    out[table] = rows
print(json.dumps(out, ensure_ascii=False, sort_keys=True))
`;

function dump(database) {
  return JSON.parse(execFileSync(PYTHON, ['-c', DUMP, database], { encoding: 'utf8' }));
}

function oracle(vault, database) {
  execFileSync(PYTHON, [ORACLE, vault, database], { cwd: ROOT_DIR, stdio: 'ignore' });
}



test('semantic aliases and duplicate anchors retain Python failure semantics', () => {
  for (const source of ['a: *missing\n', 'a: *x\nb: &x value\n', 'a: &x one\nb: &x two\n']) {
    const result = parse(source);
    assert.notEqual(result.error, null);
    assert.equal(result.error_line, source.startsWith('a: &x one') ? 2 : 1);
    assert.equal(result.error_column, 4);
    assert.deepEqual(result.properties.items, []);
  }
});

test('valid aliases resolve in keys and tags', () => {
  const result = parse('base: &name Important\n? *name\n: value\ntags: [*name]\n');
  assert.equal(result.error, null);
  assert.equal(indexer._has_frontmatter_tag(result, 'Important'), true);
  assert.equal(result.properties.items[1].key.source, 'name');
});

test('nonmapping roots and complex keys preserve insertion failures', () => {
  assert.throws(() => indexer.insert_frontmatter_nodes({}, parse('- item\n'), 1, '- item\n'), /mapping/);
  const result = parse('? {}\n: value\n');
  assert.equal(result.error, null);
  assert.throws(() => indexer._has_frontmatter_tag(result, 'tag'), /Complex frontmatter key/);
  assert.throws(() => indexer.insert_frontmatter_nodes({}, result, 1, '? {}\n: value\n'), /Complex frontmatter key/);
});

test('escapes, non-BMP scalars, CRLF comments, and block collections match Python records', async () => {
  const source = '---\r\nbase: &name "\\U0001F600" # anchor comment\r\n? *name\r\n: alias\r\ntags: [*name, plain] # tags comment\r\nfolded: > # folded comment\r\n  first\r\n  second\r\nblock:\r\n  - one # item comment\r\n  - two\r\n---\r\nBody\r\n';
  const vault = join(workRoot, 'valid-vault');
  const obsidian = join(vault, '.obsidian');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(obsidian, { recursive: true }));
  await writeFile(join(vault, 'note.md'), source);
  const nodeDb = join(workRoot, 'node-valid.db');
  const pythonDb = join(workRoot, 'python-valid.db');
  await indexer.indexVault(vault, '.obsidian', nodeDb);
  oracle(vault, pythonDb);
  const actual = dump(nodeDb);
  const expected = dump(pythonDb);
  assert.deepEqual(actual.frontmatter_errors, expected.frontmatter_errors);
  assert.deepEqual(actual.frontmatter_nodes, expected.frontmatter_nodes);
  assert.equal(actual.frontmatter_nodes.find((row) => row.key === 'base').value, '😀');
  assert.equal(actual.frontmatter_nodes.find((row) => row.key === 'folded').raw_yaml, '> # folded comment\r\n  first\r\n  second\r\n');
});
