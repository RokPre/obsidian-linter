import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import initSqlJs from 'sql.js';
import { build } from 'esbuild';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const ROOT_DIR = resolve(PLUGIN_DIR, '..');
const PYTHON = process.env.PYTHON || '/usr/bin/python3';
const NODE_BIN = dirname(process.execPath);

let SQL;
let indexer;
let bundlePath;
let workRoot;

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'vault-helper-schema-tests-'));
  bundlePath = join(PLUGIN_DIR, `.schema-test-${process.pid}.cjs`);
  await build({
    entryPoints: [join(PLUGIN_DIR, 'src', 'indexer.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    loader: { '.wasm': 'binary' },
    outfile: bundlePath,
    logLevel: 'silent',
  });
  indexer = await import(`${pathToFileURL(bundlePath).href}?schema=${Date.now()}`);
  SQL = await initSqlJs({
    locateFile: (name) => join(PLUGIN_DIR, 'node_modules', 'sql.js', 'dist', name),
  });
});

after(async () => {
  if (bundlePath) await rm(bundlePath, { force: true });
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

function fresh() {
  const database = new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  const cursor = new indexer.Cursor(database);
  indexer.initialize_database(cursor);
  return { database, cursor };
}

function rows(cursor, sql, params = []) {
  return cursor.execute(sql, params).fetchall();
}

function columns(cursor, table) {
  return rows(cursor, `PRAGMA table_info(${table})`).map((row) => String(row[1]));
}

function indexRows(cursor, table) {
  return rows(cursor, `PRAGMA index_list(${table})`).map((row) => ({
    name: String(row[1]),
    unique: Number(row[2]),
    partial: Number(row[4]),
  }));
}

function indexSql(cursor, name) {
  return rows(cursor, 'SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['index', name])[0]?.[0] ?? null;
}

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function assertThrowsSql(cursor, sql, params = []) {
  assert.throws(() => cursor.execute(sql, params).fetchall());
}

function addDirectoryAndFile(cursor, { fileId = 1, path = '/vault/note.md', mtime = 123, directoryPath = '/vault' } = {}) {
  cursor.execute('INSERT INTO vault_directories (id, path, inode, parent_id) VALUES (?, ?, ?, NULL)', [fileId, directoryPath, 10 + fileId]);
  cursor.execute(
    `INSERT INTO vault_files (id, directory_id, path, name, inode, mtime_ns, extension, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'markdown')`,
    [fileId, fileId, path, 'note', 20 + fileId, mtime, '.md'],
  );
}

function schemaSnapshot(cursor) {
  const tables = rows(cursor, "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(([name, sql]) => [name, normalizeSql(sql)]);
  const indexes = rows(cursor, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    .map(([name, sql]) => [name, normalizeSql(sql)]);
  const tableColumns = Object.fromEntries(tables.map(([name]) => [name, columns(cursor, name)]));
  return { tables, indexes, tableColumns };
}

function pythonFreshSnapshot(path) {
  const script = String.raw`
import json, sqlite3, sys
import indexer
p = sys.argv[1]
with sqlite3.connect(p) as c:
    indexer.initialize_database(c)
    def norm(s): return ' '.join(str(s).lower().split())
    tables = [(n, norm(sql)) for n, sql in c.execute("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
    indexes = [(n, norm(sql)) for n, sql in c.execute("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")]
    columns = {n: [r[1] for r in c.execute(f'PRAGMA table_info("{n}")')] for n, _ in tables}
    print(json.dumps({'tables': tables, 'indexes': indexes, 'tableColumns': columns}, sort_keys=True))
`;
  return JSON.parse(execFileSync(PYTHON, ['-c', script, path], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH || ''}` },
  }));
}
function sharedSchemaSnapshot(snapshot) {
  return {
    ...snapshot,
    tables: snapshot.tables.map(([name, sql]) => [name,
      name === 'vault_links'
        ? sql.replace(", 'ignored', 'ambiguous_ignored')", ')')
        : name === 'vault_index_state'
          ? sql.replace(', ignored_file_paths_snapshot text', '')
          : name === 'vault_files' ? sql.replace(/, (?:st_dev|device) integer/g, '') : sql,
    ]),
    tableColumns: Object.fromEntries(Object.entries(snapshot.tableColumns).map(([name, values]) => [
      name,
      name === 'vault_index_state'
        ? values.filter((column) => column !== 'ignored_file_paths_snapshot')
        : name === 'vault_files' ? values.filter((column) => column !== 'st_dev' && column !== 'device') : values,
    ])),
  };
}

function resolutionStatuses(cursor) {
  const sql = String(rows(cursor, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_links'")[0][0]);
  const check = sql.match(/resolution_status\s+in\s*\(([^)]*)\)/i);
  assert.ok(check, 'vault_links must constrain resolution_status');
  return [...check[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}


function addLink(cursor, { id, sourceFileId, sourceNodeId = null, status }) {
  cursor.execute(
    `INSERT INTO vault_links
      (id, source_file_id, source_markdown_node_id, raw_target, link_syntax, is_embed, resolution_status)
     VALUES (?, ?, ?, ?, 'wikilink', 0, ?)`,
    [id, sourceFileId, sourceNodeId, `target-${id}`, status],
  );
}

function legacyVaultLinks(cursor) {
  cursor.execute('DROP INDEX vault_links_target_source_idx');
  cursor.execute('DROP TABLE vault_links');
  cursor.execute(`
    CREATE TABLE vault_links (
      id INTEGER PRIMARY KEY,
      source_file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
      source_markdown_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
      source_frontmatter_node_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
      target_file_id INTEGER REFERENCES vault_files(id) ON DELETE SET NULL,
      target_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE SET NULL,
      missing_target_id INTEGER REFERENCES vault_missing_targets(id) ON DELETE SET NULL,
      raw_target TEXT NOT NULL,
      display_text TEXT,
      link_syntax TEXT NOT NULL CHECK (link_syntax IN ('wikilink', 'link', 'image')),
      is_embed INTEGER NOT NULL CHECK (is_embed IN (0, 1)),
      resolution_status TEXT NOT NULL DEFAULT 'missing' CHECK (
        resolution_status IN ('resolved', 'missing', 'ambiguous', 'external', 'missing_fragment')
      )
    )
  `);
}

test('fresh schema accepts plugin-specific statuses and rejects unknown statuses', () => {
  const { database, cursor } = fresh();
  addDirectoryAndFile(cursor);
  addLink(cursor, { id: 1, sourceFileId: 1, status: 'ignored' });
  addLink(cursor, { id: 2, sourceFileId: 1, status: 'ambiguous_ignored' });
  assert.deepEqual(rows(cursor, 'SELECT resolution_status FROM vault_links ORDER BY id'), [['ignored'], ['ambiguous_ignored']]);
  assert.deepEqual(resolutionStatuses(cursor), [
    'resolved', 'missing', 'ambiguous', 'external', 'missing_fragment', 'ignored', 'ambiguous_ignored',
  ]);
  assertThrowsSql(cursor, `INSERT INTO vault_links (source_file_id, raw_target, link_syntax, is_embed, resolution_status)
    VALUES (1, 'unknown', 'wikilink', 0, 'unknown')`);
  database.close();
});

test('rebuilds legacy link status constraint without losing rows or foreign keys', () => {
  const { database, cursor } = fresh();
  addDirectoryAndFile(cursor, { fileId: 1, path: '/vault/source.md' });
  addDirectoryAndFile(cursor, { fileId: 2, path: '/vault/target.md', directoryPath: '/vault/target' });
  cursor.execute("INSERT INTO markdown_nodes (id, file_id, ordinal, node_type, attributes_json) VALUES (9, 1, 0, 'paragraph', '{}')");
  legacyVaultLinks(cursor);
  addLink(cursor, { id: 3, sourceFileId: 1, sourceNodeId: 9, status: 'resolved' });
  addLink(cursor, { id: 4, sourceFileId: 1, status: 'missing' });
  addLink(cursor, { id: 5, sourceFileId: 1, status: 'ambiguous' });
  addLink(cursor, { id: 6, sourceFileId: 1, status: 'missing_fragment' });
  addLink(cursor, { id: 7, sourceFileId: 1, status: 'external' });
  cursor.execute("INSERT INTO markdown_nodes (id, file_id, ordinal, node_type, attributes_json) VALUES (10, 2, 0, 'paragraph', '{}')");
  cursor.execute("INSERT INTO vault_missing_targets (id, target_type, target) VALUES (8, 'path', 'missing.md')");
  cursor.execute("UPDATE vault_links SET target_file_id = 2, target_node_id = 10, display_text = 'Target' WHERE id = 3");
  cursor.execute("UPDATE vault_links SET missing_target_id = 8 WHERE id = 6");
  const before = rows(cursor, `SELECT id, source_file_id, source_markdown_node_id, source_frontmatter_node_id,
    target_file_id, target_node_id, missing_target_id, raw_target, display_text, link_syntax, is_embed, resolution_status
    FROM vault_links ORDER BY id`);

  indexer.initialize_database(cursor);

  assert.deepEqual(rows(cursor, `SELECT id, source_file_id, source_markdown_node_id, source_frontmatter_node_id,
    target_file_id, target_node_id, missing_target_id, raw_target, display_text, link_syntax, is_embed, resolution_status
    FROM vault_links ORDER BY id`), before);
  addLink(cursor, { id: 8, sourceFileId: 1, sourceNodeId: 9, status: 'ignored' });
  addLink(cursor, { id: 9, sourceFileId: 1, status: 'ambiguous_ignored' });
  assert.deepEqual(rows(cursor, 'SELECT resolution_status FROM vault_links WHERE id IN (8, 9) ORDER BY id'), [['ignored'], ['ambiguous_ignored']]);
  assert.deepEqual(rows(cursor, 'PRAGMA foreign_key_check'), []);
  database.close();
});

test('fresh initializer matches shared Python schema and exposes the complete contract', async () => {
  const { database, cursor } = fresh();
  const actual = schemaSnapshot(cursor);
  const expected = pythonFreshSnapshot(join(workRoot, 'python-fresh.db'));
  assert.deepEqual(sharedSchemaSnapshot(actual), sharedSchemaSnapshot(expected));
  assert.deepEqual(resolutionStatuses(cursor), [
    'resolved', 'missing', 'ambiguous', 'external', 'missing_fragment', 'ignored', 'ambiguous_ignored',
  ]);

  assert.deepEqual(columns(cursor, 'vault_files'), [
    'id', 'directory_id', 'path', 'name', 'inode', 'device', 'mtime_ns', 'extension', 'kind',
  ]);
  assert.equal(rows(cursor, 'PRAGMA table_info(vault_files)').find((row) => row[1] === 'device')[3], 0,
    'device is nullable so legacy identity remains unverified');
  assert.deepEqual(columns(cursor, 'note_tag_occurrences'), [
    'id', 'tag_id', 'frontmatter_node_id', 'markdown_node_id',
  ]);
  assert.deepEqual(columns(cursor, 'vault_links'), [
    'id', 'source_file_id', 'source_markdown_node_id', 'source_frontmatter_node_id',
    'target_file_id', 'target_node_id', 'missing_target_id', 'raw_target', 'display_text',
    'link_syntax', 'is_embed', 'resolution_status',
  ]);
  assert.deepEqual(columns(cursor, 'vault_index_state'), [
    'id', 'derived_data_dirty', 'block_ids_version', 'link_resolution_version',
    'tag_occurrence_version', 'fenced_code_version', 'callout_version', 'ignored_file_paths_snapshot',
  ]);

  for (const [table, foreignTable] of [
    ['vault_files', 'vault_directories'], ['frontmatter_nodes', 'vault_files'],
    ['markdown_nodes', 'vault_files'], ['vault_links', 'vault_files'],
    ['vault_links', 'markdown_nodes'], ['vault_links', 'frontmatter_nodes'],
    ['vault_links', 'vault_missing_targets'], ['note_tag_occurrences', 'vault_tags'],
  ]) {
    assert.ok(rows(cursor, `PRAGMA foreign_key_list(${table})`).some((row) => row[2] === foreignTable), `${table} -> ${foreignTable}`);
  }

  for (const [name, columnsText, where] of [
    ['markdown_nodes_file_value_idx', 'file_id, node_type, value', "node_type = 'heading' AND value IS NOT NULL"],
    ['markdown_nodes_file_block_id_idx', 'file_id, block_id', 'block_id IS NOT NULL'],
  ]) {
    assert.equal(indexSql(cursor, name), `CREATE INDEX ${name} ON markdown_nodes(${columnsText}) WHERE ${where}`);
    assert.equal(indexRows(cursor, 'markdown_nodes').find((row) => row.name === name).partial, 1);
  }
  assert.equal(normalizeSql(indexSql(cursor, 'note_tag_occurrences_frontmatter_node_idx')), normalizeSql('CREATE UNIQUE INDEX note_tag_occurrences_frontmatter_node_idx ON note_tag_occurrences(frontmatter_node_id) WHERE frontmatter_node_id IS NOT NULL'));
  assert.equal(normalizeSql(indexSql(cursor, 'note_tag_occurrences_markdown_node_idx')), normalizeSql('CREATE UNIQUE INDEX note_tag_occurrences_markdown_node_idx ON note_tag_occurrences(markdown_node_id) WHERE markdown_node_id IS NOT NULL'));

  assertThrowsSql(cursor, "INSERT INTO vault_index_state (id, derived_data_dirty) VALUES (2, 0)");
  assertThrowsSql(cursor, "INSERT INTO vault_missing_targets (target_type, target) VALUES ('invalid', 'x')");
  assertThrowsSql(cursor, "INSERT INTO vault_links (source_file_id, raw_target, link_syntax, is_embed) VALUES (1, 'x', 'invalid', 0)");
  assertThrowsSql(cursor, "INSERT INTO vault_links (source_file_id, raw_target, link_syntax, is_embed) VALUES (1, 'x', 'wikilink', 2)");
  assertThrowsSql(cursor, "INSERT INTO note_tag_occurrences (tag_id, frontmatter_node_id, markdown_node_id) VALUES (1, 1, 1)");
  assert.deepEqual(rows(cursor, 'PRAGMA foreign_key_check'), []);
  database.close();
});

test('adds mtime_ns to the legacy vault_files table with a zero default and preserves rows', () => {
  const database = new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  const cursor = new indexer.Cursor(database);
  cursor.executescript(`
    CREATE TABLE vault_directories (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, inode INTEGER NOT NULL, parent_id INTEGER REFERENCES vault_directories(id));
    INSERT INTO vault_directories VALUES (1, '/vault', 1, NULL);
    CREATE TABLE vault_files (id INTEGER PRIMARY KEY, directory_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, inode INTEGER NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL);
    INSERT INTO vault_files VALUES (1, 1, '/vault/note.md', 'note', 2, '.md', 'markdown');
  `);
  indexer.initialize_database(cursor);
  assert.deepEqual(rows(cursor, 'SELECT path, mtime_ns FROM vault_files'), [['/vault/note.md', 0]]);
  database.close();
});


test('adds nullable device identity to legacy files idempotently without fabricating values', () => {
  const database = new SQL.Database();
  database.run('PRAGMA foreign_keys = ON');
  const cursor = new indexer.Cursor(database);
  cursor.executescript(`
    CREATE TABLE vault_directories (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, inode INTEGER NOT NULL, parent_id INTEGER REFERENCES vault_directories(id));
    INSERT INTO vault_directories VALUES (1, '/vault', 1, NULL);
    CREATE TABLE vault_index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), derived_data_dirty INTEGER NOT NULL,
      block_ids_version INTEGER NOT NULL, link_resolution_version INTEGER NOT NULL,
      tag_occurrence_version INTEGER NOT NULL, fenced_code_version INTEGER NOT NULL,
      callout_version INTEGER NOT NULL, ignored_file_paths_snapshot TEXT
    );
    INSERT INTO vault_index_state VALUES (1, 0, 1, 5, 1, 1, 1, NULL);
    CREATE TABLE vault_files (id INTEGER PRIMARY KEY, directory_id INTEGER NOT NULL, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, inode INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, extension TEXT NOT NULL, kind TEXT NOT NULL);
    INSERT INTO vault_files VALUES (7, 1, '/vault/note.md', 'note', 22, 123, '.md', 'markdown');
  `);
  indexer.initialize_database(cursor);
  assert.deepEqual(rows(cursor, 'SELECT id, path, inode, device, mtime_ns FROM vault_files'), [
    [7, '/vault/note.md', 22, null, 123],
  ]);
  const firstColumns = columns(cursor, 'vault_files');
  indexer.initialize_database(cursor);
  indexer.initialize_database(cursor);
  assert.deepEqual(columns(cursor, 'vault_files'), firstColumns);
  assert.deepEqual(rows(cursor, 'SELECT id, path, inode, device, mtime_ns FROM vault_files'), [
    [7, '/vault/note.md', 22, null, 123],
  ]);
  assert.deepEqual(rows(cursor, 'PRAGMA foreign_key_check'), []);
  database.close();
});
test('rebuilds legacy provenance occurrences, adds uniqueness indexes, and marks derived data dirty', () => {
  const { database, cursor } = fresh();
  cursor.execute('DROP INDEX note_tag_occurrences_tag_idx');
  cursor.execute('DROP INDEX note_tag_occurrences_frontmatter_node_idx');
  cursor.execute('DROP INDEX note_tag_occurrences_markdown_node_idx');
  cursor.execute('DROP TABLE note_tag_occurrences');
  cursor.executescript(`
    CREATE TABLE note_tag_occurrences (
      id INTEGER PRIMARY KEY, tag_id INTEGER NOT NULL, source TEXT, file_id INTEGER,
      frontmatter_node_id INTEGER, markdown_node_id INTEGER
    );
    CREATE INDEX note_tag_occurrences_tag_idx ON note_tag_occurrences(tag_id);
    CREATE INDEX note_tag_occurrences_tag_file_idx ON note_tag_occurrences(tag_id, file_id);
    INSERT INTO note_tag_occurrences VALUES (7, 1, 'frontmatter', 1, NULL, NULL);
    UPDATE vault_index_state SET derived_data_dirty = 0 WHERE id = 1;
  `);
  indexer.initialize_database(cursor);
  assert.deepEqual(columns(cursor, 'note_tag_occurrences'), ['id', 'tag_id', 'frontmatter_node_id', 'markdown_node_id']);
  assert.deepEqual(rows(cursor, 'SELECT * FROM note_tag_occurrences'), []);
  assert.deepEqual(rows(cursor, 'SELECT derived_data_dirty FROM vault_index_state'), [[1]]);
  assert.equal(indexRows(cursor, 'note_tag_occurrences').find((row) => row.name === 'note_tag_occurrences_frontmatter_node_idx').unique, 1);
  assert.equal(indexRows(cursor, 'note_tag_occurrences').find((row) => row.name === 'note_tag_occurrences_markdown_node_idx').unique, 1);
  database.close();
});

test('migrates every missing/old state version and applies the correct invalidation', () => {
  for (const [version, expected, shouldResetMtime, shouldDirty] of [
    ['block_ids_version', 1, true, false],
    ['link_resolution_version', 5, false, true],
    ['tag_occurrence_version', 1, false, true],
    ['fenced_code_version', 1, true, false],
    ['callout_version', 1, true, false],
  ]) {
    const { database, cursor } = fresh();
    addDirectoryAndFile(cursor, { mtime: 123 });
    cursor.execute(`UPDATE vault_index_state SET ${version} = 0, derived_data_dirty = 0 WHERE id = 1`);
    indexer.initialize_database(cursor);
    assert.deepEqual(rows(cursor, `SELECT ${version}, derived_data_dirty FROM vault_index_state`), [[expected, shouldDirty ? 1 : 0]]);
    assert.deepEqual(rows(cursor, 'SELECT mtime_ns FROM vault_files'), [[shouldResetMtime ? 0 : 123]]);
    database.close();
  }

  for (const missing of ['block_ids_version', 'link_resolution_version', 'tag_occurrence_version', 'fenced_code_version', 'callout_version']) {
    const { database, cursor } = fresh();
    addDirectoryAndFile(cursor, { mtime: 123 });
    cursor.execute(`ALTER TABLE vault_index_state DROP COLUMN ${missing}`);
    indexer.initialize_database(cursor);
    const values = rows(cursor, 'SELECT block_ids_version, link_resolution_version, tag_occurrence_version, fenced_code_version, callout_version FROM vault_index_state')[0];
    assert.deepEqual(values, [1, 5, 1, 1, 1]);
    assert.ok(rows(cursor, 'SELECT mtime_ns FROM vault_files')[0][0] === 0 || missing === 'link_resolution_version' || missing === 'tag_occurrence_version');
    database.close();
  }
  const { database, cursor } = fresh();
  cursor.execute('ALTER TABLE vault_index_state DROP COLUMN ignored_file_paths_snapshot');
  indexer.initialize_database(cursor);
  assert.deepEqual(columns(cursor, 'vault_index_state').slice(-1), ['ignored_file_paths_snapshot']);
  assert.deepEqual(rows(cursor, 'SELECT ignored_file_paths_snapshot FROM vault_index_state'), [[null]]);
  database.close();
});

test('copies heading_text into value, adds block_id, and drops obsolete heading indexes', () => {
  const { database, cursor } = fresh();
  addDirectoryAndFile(cursor);
  cursor.execute('ALTER TABLE markdown_nodes ADD COLUMN heading_text TEXT');
  cursor.execute('CREATE INDEX markdown_nodes_file_heading_text_idx ON markdown_nodes(file_id, heading_text)');
  cursor.execute(`INSERT INTO markdown_nodes (file_id, ordinal, node_type, value, block_id, attributes_json, start_line, end_line, heading_text)
                  VALUES (1, 0, 'heading', NULL, NULL, '{}', 1, 1, 'Legacy heading')`);
  indexer.initialize_database(cursor);
  assert.ok(!columns(cursor, 'markdown_nodes').includes('heading_text'));
  assert.deepEqual(rows(cursor, "SELECT value, block_id FROM markdown_nodes WHERE node_type = 'heading'"), [['Legacy heading', null]]);
  assert.equal(indexSql(cursor, 'markdown_nodes_file_heading_text_idx'), null);
  assert.equal(indexRows(cursor, 'markdown_nodes').find((row) => row.name === 'markdown_nodes_file_value_idx').partial, 1);
  assert.equal(indexRows(cursor, 'markdown_nodes').find((row) => row.name === 'markdown_nodes_file_block_id_idx').partial, 1);
  database.close();
});

test('renames source_node_id, adds source/target provenance FKs, and removes obsolete selectors', () => {
  const { database, cursor } = fresh();
  addDirectoryAndFile(cursor);
  cursor.execute(`INSERT INTO markdown_nodes (id, file_id, ordinal, node_type, attributes_json) VALUES (9, 1, 0, 'paragraph', '{}')`);
  cursor.execute('DROP INDEX vault_links_target_source_idx');
  cursor.execute('DROP TABLE vault_links');
  cursor.executescript(`
    CREATE TABLE vault_links (
      id INTEGER PRIMARY KEY,
      source_file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
      source_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
      target_file_id INTEGER REFERENCES vault_files(id) ON DELETE SET NULL,
      raw_target TEXT NOT NULL,
      display_text TEXT,
      link_syntax TEXT NOT NULL,
      is_embed INTEGER NOT NULL,
      target_heading TEXT,
      target_block_id TEXT
    );
    INSERT INTO vault_links (id, source_file_id, source_node_id, raw_target, link_syntax, is_embed, target_heading, target_block_id)
    VALUES (3, 1, 9, 'Target#Heading', 'wikilink', 0, 'Heading', 'block');
  `);
  indexer.initialize_database(cursor);
  assert.deepEqual(columns(cursor, 'vault_links'), [
    'id', 'source_file_id', 'source_markdown_node_id', 'target_file_id', 'raw_target', 'display_text',
    'link_syntax', 'is_embed', 'source_frontmatter_node_id', 'target_node_id', 'missing_target_id', 'resolution_status',
  ]);
  assert.deepEqual(rows(cursor, 'SELECT source_markdown_node_id, raw_target, resolution_status FROM vault_links'), [[9, 'Target#Heading', 'resolved']]);
  assert.ok(!columns(cursor, 'vault_links').includes('source_node_id'));
  assert.ok(!columns(cursor, 'vault_links').includes('target_heading'));
  assert.ok(!columns(cursor, 'vault_links').includes('target_block_id'));
  for (const table of ['markdown_nodes', 'frontmatter_nodes', 'vault_missing_targets']) {
    assert.ok(rows(cursor, 'PRAGMA foreign_key_list(vault_links)').some((row) => row[2] === table), `vault_links -> ${table}`);
  }
  assert.equal(indexSql(cursor, 'vault_links_missing_target_idx'), 'CREATE INDEX vault_links_missing_target_idx ON vault_links(missing_target_id, source_file_id)');
  database.close();
});

test('preserves data on repeated initialization and enforces partial uniqueness for targets and lookups', () => {
  const { database, cursor } = fresh();
  addDirectoryAndFile(cursor, { fileId: 1, mtime: 987 });
  addDirectoryAndFile(cursor, { fileId: 2, path: '/vault/other.md', directoryPath: '/vault/other', mtime: 654 });
  cursor.execute("INSERT INTO vault_tags (id, name) VALUES (1, 'tag')");
  cursor.execute("INSERT INTO frontmatter_nodes (id, file_id, ordinal, node_type, raw_yaml, start_line, end_line) VALUES (1, 1, 0, 'scalar', 'tag', 1, 1)");
  cursor.execute("INSERT INTO markdown_nodes (id, file_id, ordinal, node_type, block_id, attributes_json) VALUES (1, 1, 0, 'paragraph', 'block-a', '{}')");
  cursor.execute("INSERT INTO markdown_nodes (id, file_id, ordinal, node_type, attributes_json) VALUES (2, 1, 1, 'heading', '{}')");
  cursor.execute("INSERT INTO note_tag_occurrences (tag_id, frontmatter_node_id) VALUES (1, 1)");
  cursor.execute("INSERT INTO note_tag_occurrences (tag_id, markdown_node_id) VALUES (1, 1)");
  cursor.execute("INSERT INTO vault_missing_targets (id, target_type, target) VALUES (1, 'name', 'Missing')");
  cursor.execute("INSERT INTO vault_missing_targets (id, target_type, target, target_file_id) VALUES (2, 'name', 'Known', 1)");
  cursor.execute("INSERT INTO vault_links (source_file_id, source_markdown_node_id, missing_target_id, raw_target, link_syntax, is_embed) VALUES (1, 1, 1, 'Missing', 'wikilink', 0)");
  const before = {
    files: rows(cursor, 'SELECT path, mtime_ns FROM vault_files ORDER BY id'),
    headings: rows(cursor, 'SELECT value, block_id FROM markdown_nodes ORDER BY id'),
    links: rows(cursor, 'SELECT source_markdown_node_id, missing_target_id, resolution_status FROM vault_links'),
    state: rows(cursor, 'SELECT * FROM vault_index_state'),
  };
  indexer.initialize_database(cursor);
  indexer.initialize_database(cursor);
  assert.deepEqual({
    files: rows(cursor, 'SELECT path, mtime_ns FROM vault_files ORDER BY id'),
    headings: rows(cursor, 'SELECT value, block_id FROM markdown_nodes ORDER BY id'),
    links: rows(cursor, 'SELECT source_markdown_node_id, missing_target_id, resolution_status FROM vault_links'),
    state: rows(cursor, 'SELECT * FROM vault_index_state'),
  }, before);
  assert.deepEqual(rows(cursor, 'PRAGMA foreign_key_check'), []);

  assertThrowsSql(cursor, "INSERT INTO vault_missing_targets (target_type, target) VALUES ('name', 'Missing')");
  assertThrowsSql(cursor, "INSERT INTO vault_missing_targets (target_type, target, target_file_id) VALUES ('name', 'Known', 1)");
  cursor.execute("INSERT INTO vault_missing_targets (target_type, target, target_file_id) VALUES ('name', 'Known', 2)");
  assertThrowsSql(cursor, "INSERT INTO note_tag_occurrences (tag_id, frontmatter_node_id) VALUES (1, 1)");
  assertThrowsSql(cursor, "INSERT INTO note_tag_occurrences (tag_id, markdown_node_id) VALUES (1, 1)");
  database.close();
});
