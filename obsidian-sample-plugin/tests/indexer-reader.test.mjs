import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import initSqlJs from 'sql.js';
import { build } from 'esbuild';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const TEMP_ROOT = tmpdir();
let readerBundlePath;
let indexerBundlePath;
let reader;
let indexer;
let workRoot;
let SQL;

before(async () => {
  workRoot = await mkdtemp(join(TEMP_ROOT, 'indexer-reader-tests-'));
  readerBundlePath = join(workRoot, 'reader.mjs');
  indexerBundlePath = join(workRoot, 'indexer.cjs');
  await Promise.all([
    build({ entryPoints: [join(PLUGIN_DIR, 'src', 'indexer-reader.ts')], bundle: true, platform: 'node', format: 'esm', outfile: readerBundlePath, logLevel: 'silent' }),
    build({ entryPoints: [join(PLUGIN_DIR, 'src', 'indexer.ts')], bundle: true, platform: 'node', format: 'cjs', loader: { '.wasm': 'binary' }, outfile: indexerBundlePath, logLevel: 'silent' }),
  ]);
  [reader, indexer] = await Promise.all([
    import(pathToFileURL(readerBundlePath).href), import(pathToFileURL(indexerBundlePath).href),
  ]);
  SQL = await initSqlJs();
});

after(async () => { if (workRoot) await rm(workRoot, { recursive: true, force: true }); });

function cursorFor(responses) {
  const statements = [];
  return {
    statements,
    execute(sql) { statements.push(sql); this.rows = responses.find(([pattern]) => pattern.test(sql))?.[1] ?? []; return this; },
    fetchall() { return this.rows; },
  };
}

test('reader maps persisted indexed paths and kinds to typed vault-relative records', () => {
  const cursor = cursorFor([[/SELECT path, kind/, [
    ['/vault/a.md', 'markdown'], ['/vault/sub/photo.png', 'image'],
  ]]]);
  assert.deepEqual(reader.readIndexedFiles(cursor, '/vault'), [
    { path: 'a.md', kind: 'markdown' }, { path: 'sub/photo.png', kind: 'image' },
  ]);
  const outsideCursor = cursorFor([[/SELECT path, kind/, [['/outside/a.md', 'markdown']]]]);
  assert.throws(() => reader.readIndexedFiles(outsideCursor, '/vault'), /outside the vault/);
});

test('reader preserves absent, valid root-only, and malformed frontmatter with optional lines', () => {
  const cursor = cursorFor([
    [/SELECT path, kind/, [['/vault/absent.md', 'markdown'], ['/vault/valid.md', 'markdown'], ['/vault/bad.md', 'markdown']]],
    [/FROM frontmatter_errors AS errors/, [['/vault/bad.md', 'bad yaml', 4], ['/vault/no-line.md', 'also bad', null]]],
    [/FROM frontmatter_nodes AS nodes/, [['/vault/valid.md', 'title']]],
  ]);
  const files = reader.readRuleEngineFiles(cursor, '/vault');
  assert.deepEqual(files, [
    { path: 'absent.md', kind: 'markdown', frontmatter: { status: 'absent' }, links: [] },
    { path: 'valid.md', kind: 'markdown', frontmatter: { status: 'valid', rootProperties: ['title'] }, links: [] },
    { path: 'bad.md', kind: 'markdown', frontmatter: { status: 'malformed', message: 'bad yaml', line: 5 }, links: [] },
  ]);
  const noLine = reader.readRuleEngineFiles(cursorFor([
    [/SELECT path, kind/, [['/vault/no-line.md', 'markdown']]],
    [/FROM frontmatter_errors AS errors/, [['/vault/no-line.md', 'also bad', null]]],
    [/FROM frontmatter_nodes AS nodes/, []],
    [/FROM vault_links AS links/, []],
  ]), '/vault')[0];
  assert.deepEqual(noLine.frontmatter, { status: 'malformed', message: 'also bad' });
});

test('reader maps every link occurrence and its source metadata without synthesizing lines', () => {
  const cursor = cursorFor([
    [/SELECT path, kind/, [['/vault/note.md', 'markdown']]],
    [/FROM frontmatter_errors AS errors/, []],
    [/FROM frontmatter_nodes AS nodes/, []],
    [/FROM vault_links AS links/, [
      ['/vault/note.md', 'missingNote', 'missing', 0, 3],
      ['/vault/note.md', 'missingNote', 'missing', 1, null],
      ['/vault/note.md', 'frontmatterTarget', 'ambiguous', 0, 1],
    ]],
  ]);
  assert.deepEqual(reader.readRuleEngineFiles(cursor, '/vault'), [{
    path: 'note.md', kind: 'markdown', frontmatter: { status: 'absent' },
    links: [
      { rawTarget: 'missingNote', status: 'missing', isEmbed: false, line: 3 },
      { rawTarget: 'missingNote', status: 'missing', isEmbed: true },
      { rawTarget: 'frontmatterTarget', status: 'ambiguous', isEmbed: false, line: 1 },
    ],
  }]);
});

test('reader SQL maps top-level properties and every markdown/frontmatter link source', () => {
  const db = new SQL.Database();
  db.run('CREATE TABLE vault_files (id INTEGER PRIMARY KEY, path TEXT, kind TEXT)');
  db.run('CREATE TABLE frontmatter_errors (id INTEGER PRIMARY KEY, file_id INTEGER, error_output TEXT, line INTEGER)');
  db.run('CREATE TABLE frontmatter_nodes (id INTEGER PRIMARY KEY, file_id INTEGER, parent_id INTEGER, ordinal INTEGER, key TEXT, start_line INTEGER)');
  db.run('CREATE TABLE markdown_nodes (id INTEGER PRIMARY KEY, file_id INTEGER, start_line INTEGER)');
  db.run('CREATE TABLE vault_links (id INTEGER PRIMARY KEY, source_file_id INTEGER, source_markdown_node_id INTEGER, source_frontmatter_node_id INTEGER, raw_target TEXT, resolution_status TEXT, is_embed INTEGER)');
  db.run("INSERT INTO vault_files VALUES (1, '/vault/absent.md', 'markdown'), (2, '/vault/valid.md', 'markdown'), (3, '/vault/bad.md', 'markdown')");
  db.run("INSERT INTO frontmatter_errors VALUES (1, 3, 'parse details', NULL)");
  db.run("INSERT INTO frontmatter_nodes VALUES (20, 2, NULL, 0, 'title', 1), (21, 2, 20, 0, 'nestedOnly', 2), (22, 2, NULL, 1, 'links', 1)");
  db.run('INSERT INTO markdown_nodes VALUES (40, 2, 5), (41, 2, NULL)');
  db.run("INSERT INTO vault_links VALUES (1, 2, 40, NULL, 'missingNote', 'missing', 0), (2, 2, 41, NULL, 'missingNote', 'missing', 1), (3, 2, NULL, 22, '[[missingNote]]', 'ambiguous_ignored', 0)");
  const files = reader.readRuleEngineFiles(new indexer.Cursor(db), '/vault');
  assert.deepEqual(files, [
    { path: 'absent.md', kind: 'markdown', frontmatter: { status: 'absent' }, links: [] },
    { path: 'bad.md', kind: 'markdown', frontmatter: { status: 'malformed', message: 'parse details' }, links: [] },
    {
      path: 'valid.md', kind: 'markdown', frontmatter: { status: 'valid', rootProperties: ['title', 'links'] },
      links: [
        { rawTarget: 'missingNote', status: 'missing', isEmbed: false, line: 5 },
        { rawTarget: 'missingNote', status: 'missing', isEmbed: true },
        { rawTarget: '[[missingNote]]', status: 'ambiguous_ignored', isEmbed: false, line: 1 },
      ],
    },
  ]);
  db.close();
});

test('reader SQL retains links without source-node references', () => {
  const db = new SQL.Database();
  db.run('CREATE TABLE vault_files (id INTEGER PRIMARY KEY, path TEXT, kind TEXT)');
  db.run('CREATE TABLE frontmatter_errors (id INTEGER PRIMARY KEY, file_id INTEGER, error_output TEXT, line INTEGER)');
  db.run('CREATE TABLE frontmatter_nodes (id INTEGER PRIMARY KEY, file_id INTEGER, parent_id INTEGER, ordinal INTEGER, key TEXT, start_line INTEGER)');
  db.run('CREATE TABLE markdown_nodes (id INTEGER PRIMARY KEY, file_id INTEGER, start_line INTEGER)');
  db.run('CREATE TABLE vault_links (id INTEGER PRIMARY KEY, source_file_id INTEGER, source_markdown_node_id INTEGER, source_frontmatter_node_id INTEGER, raw_target TEXT, resolution_status TEXT, is_embed INTEGER)');
  db.run("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')");
  db.run("INSERT INTO vault_links VALUES (1, 1, NULL, NULL, '[[missing target]]', 'missing', 1)");

  const files = reader.readRuleEngineFiles(new indexer.Cursor(db), '/vault');

  assert.deepEqual(files, [{
    path: 'note.md', kind: 'markdown', frontmatter: { status: 'absent' },
    links: [{ rawTarget: '[[missing target]]', status: 'missing', isEmbed: true }],
  }]);
  assert.equal(Object.hasOwn(files[0].links[0], 'line'), false);
  db.close();
});
