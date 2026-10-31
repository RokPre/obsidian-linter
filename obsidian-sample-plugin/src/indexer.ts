import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import initSqlJs from 'sql.js';
import sqliteBinary from 'sql.js/dist/sql-wasm.wasm';
import type { Database, Statement, SqlValue, SqlJsStatic } from 'sql.js';
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit, YAMLMap } from "yaml";
import type { Document, Node as YamlNode } from "yaml";
import { compose as composePyYaml } from 'yaml-js';
import remarkGfm from "remark-gfm";
import remarkObsidian from "@quartz-community/remark-obsidian";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { isIgnoredVaultPath } from './ignored-paths';
import type { IndexedFile } from './rules-config';
import { assertIndexReady, readIndexedFiles as readIndexedFilesFromCursor, readRuleEngineFiles } from './indexer-reader';
import { matchRulesToFiles, type RulesConfig } from './rules-config';
import { evaluateRules, type RuleDiagnostic, type RuleExecutionFailure } from './rules-engine';


let IGNORED_PATHS: string[] = [];

export function setIgnoredPaths(paths: string[]): void {
	IGNORED_PATHS = [...paths];
}
export const INDEX_BATCH_SIZE = 1_000;
export const FRONTMATTER_BODY_FIRST_FILE_LINE = 2;
export const TIMINGS = new Map<string, [number, number, string]>();

// Keep the cursor-shaped API so the SQL and stages mirror indexer.py.
export class Cursor implements Iterable<SqlValue[]> {
	private rows: SqlValue[][] = [];
	private position = 0;
	private statements = new Map<string, Statement>();

	constructor(readonly database: Database) {}

	execute(sql: string, params: Array<SqlValue | bigint> = []): this {
		let statement = this.statements.get(sql);
		if (!statement) {
			statement = this.database.prepare(sql);
			this.statements.set(sql, statement);
		}
		this.rows = [];
		this.position = 0;
		try {
			statement.bind(params.map(value => typeof value === 'bigint' ? value.toString() : value));
			while (statement.step()) this.rows.push(statement.get());
		} finally {
			statement.reset();
		}
		return this;
	}

	fetchone(): SqlValue[] | null { return this.rows[this.position++] ?? null; }
	fetchall(): SqlValue[][] {
		const rows = this.position === 0 ? this.rows : this.rows.slice(this.position);
		this.position = this.rows.length;
		return rows;
	}
	[Symbol.iterator](): Iterator<SqlValue[]> { return this.fetchall()[Symbol.iterator](); }
	get lastrowid(): number { return this.database.exec('SELECT last_insert_rowid()')[0]!.values[0]![0] as number; }

	executescript(sql: string): void {
		this.release();
		this.database.run(sql);
	}

	release(): void {
		for (const statement of this.statements.values()) statement.free();
		this.statements.clear();
	}
}

export function record_timing(stage: string, started: number, unit = 'call'): void {
	const [total, calls] = TIMINGS.get(stage) ?? [0, 0, unit];
	TIMINGS.set(stage, [total + performance.now() - started, calls + 1, unit]);
}

export function print_timing_summary(): void {
	console.debug('\nTiming summary');
	for (const [stage, [total, calls, unit]] of [...TIMINGS].sort((a, b) => b[1][0] - a[1][0])) {
		console.debug(`${stage.padEnd(28)} ${total.toFixed(3)} ms total  ${(total / calls).toFixed(3)} ms/${unit}  ${calls} ${unit}${calls === 1 ? '' : 's'}`);
	}
}

export function find_changes(cursor: Cursor, vault_path: string, config_dir: string): [Array<[string, string]>, Array<[string, string]>] {
	const has_files = cursor.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_files'").fetchone() !== null;
	// SQLite integers exceed JavaScript's safe integer range for nanosecond mtimes.
	const stored_mtimes = new Map<string, string>(has_files ? cursor.execute('SELECT path, CAST(mtime_ns AS TEXT) FROM vault_files').fetchall() as [string, string][] : []);
	const has_directories = cursor.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_directories'").fetchone() !== null;
	const stored_inodes = new Map<string, string>(has_directories ? cursor.execute('SELECT path, CAST(inode AS TEXT) FROM vault_directories').fetchall() as [string, string][] : []);
	const directory_changes: Array<[string, string]> = [];
	const file_changes: Array<[string, string]> = [];
	const config_path = path.normalize(config_dir).split(path.sep).join('/');

	function scan_directory(directory: string): void {
		const stored_inode = stored_inodes.get(directory);
		stored_inodes.delete(directory);
		if (stored_inode === undefined) directory_changes.push(['created', directory]);
		else if (fs.statSync(directory, { bigint: true }).ino.toString() !== stored_inode) directory_changes.push(['modified', directory]);
		const entries = fs.opendirSync(directory);
		try {
			for (let child = entries.readSync(); child; child = entries.readSync()) {
				if (child.isSymbolicLink()) continue;
				const child_path = path.join(directory, child.name);
				const vault_relative_path = path.relative(vault_path, child_path).split(path.sep).join('/');
				if (isIgnoredVaultPath(vault_relative_path, IGNORED_PATHS, config_path, child.isDirectory())) continue;
				if (child.isDirectory()) scan_directory(child_path);
				else if (child.isFile()) {
					const started = performance.now();
					const stored_mtime = stored_mtimes.get(child_path);
					stored_mtimes.delete(child_path);
					if (stored_mtime === undefined) file_changes.push(['created', child_path]);
					else if (fs.statSync(child_path, { bigint: true }).mtimeNs.toString() !== stored_mtime) file_changes.push(['modified', child_path]);
					record_timing('find_changes', started, 'file');
				}
			}
		} finally { entries.closeSync(); }
	}

	scan_directory(vault_path);
	for (const directory of stored_inodes.keys()) directory_changes.push(['deleted', directory]);
	for (const file of stored_mtimes.keys()) file_changes.push(['deleted', file]);
	return [directory_changes, file_changes];
}

export function initialize_database(cursor: Cursor): void {
	const statements = [
		`
        CREATE TABLE IF NOT EXISTS vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            inode INTEGER NOT NULL,
            parent_id INTEGER REFERENCES vault_directories(id) ON DELETE CASCADE
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS vault_files (
            id INTEGER PRIMARY KEY,
            directory_id INTEGER NOT NULL REFERENCES vault_directories(id) ON DELETE CASCADE,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            inode INTEGER NOT NULL,
            device INTEGER,
            mtime_ns INTEGER NOT NULL,
            extension TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (
                kind IN (
                    'excalidraw',
                    'pdf',
                    'image',
                    'script',
                    'video',
                    'recording',
                    'markdown',
                    'other'
                )
            )
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS frontmatter_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            key TEXT,
            node_type TEXT NOT NULL CHECK (
                node_type IN ('mapping', 'sequence', 'scalar')
            ),
            value TEXT,
            raw_yaml TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS frontmatter_errors (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            error_output TEXT NOT NULL,
            line INTEGER,
            column INTEGER,
            raw_yaml BLOB NOT NULL
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            node_type TEXT NOT NULL,
            value TEXT,
            block_id TEXT,
            attributes_json TEXT NOT NULL,
            start_line INTEGER,
            start_column INTEGER,
            start_offset_utf16 INTEGER,
            end_line INTEGER,
            end_column INTEGER,
            end_offset_utf16 INTEGER
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS vault_tags (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            parent_id INTEGER REFERENCES vault_tags(id) ON DELETE CASCADE
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS note_tag_occurrences (
            id INTEGER PRIMARY KEY,
            tag_id INTEGER NOT NULL REFERENCES vault_tags(id) ON DELETE CASCADE,
            frontmatter_node_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
            markdown_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
            CHECK (
                (frontmatter_node_id IS NOT NULL AND markdown_node_id IS NULL)
                OR
                (frontmatter_node_id IS NULL AND markdown_node_id IS NOT NULL)
            )
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS vault_missing_targets (
            id INTEGER PRIMARY KEY,
            target_type TEXT NOT NULL CHECK (target_type IN ('name', 'path', 'heading', 'block')),
            target TEXT NOT NULL,
            target_file_id INTEGER REFERENCES vault_files(id) ON DELETE CASCADE
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS vault_links (
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
                resolution_status IN ('resolved', 'missing', 'ambiguous', 'external', 'missing_fragment', 'ignored', 'ambiguous_ignored')
            )
        )
        `,
		`
        CREATE TABLE IF NOT EXISTS vault_index_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            derived_data_dirty INTEGER NOT NULL CHECK (derived_data_dirty IN (0, 1)),
            block_ids_version INTEGER NOT NULL DEFAULT 0,
            link_resolution_version INTEGER NOT NULL DEFAULT 0,
            tag_occurrence_version INTEGER NOT NULL DEFAULT 0,
            fenced_code_version INTEGER NOT NULL DEFAULT 0,
            callout_version INTEGER NOT NULL DEFAULT 0,
            ignored_file_paths_snapshot TEXT
        )
        `,
		"CREATE INDEX IF NOT EXISTS vault_directories_parent_idx ON vault_directories(parent_id)",
		"CREATE INDEX IF NOT EXISTS vault_files_directory_idx ON vault_files(directory_id)",
		`
        CREATE INDEX IF NOT EXISTS note_tag_occurrences_tag_idx
        ON note_tag_occurrences(tag_id)
        `,
		`
        CREATE INDEX IF NOT EXISTS frontmatter_nodes_file_parent_ordinal_idx
        ON frontmatter_nodes(file_id, parent_id, ordinal)
        `,
		`
        CREATE INDEX IF NOT EXISTS vault_links_target_source_idx
        ON vault_links(target_file_id, source_file_id)
        `,
		"CREATE INDEX IF NOT EXISTS markdown_nodes_parent_idx ON markdown_nodes(parent_id)",
		`
        CREATE INDEX IF NOT EXISTS markdown_nodes_file_parent_ordinal_idx
        ON markdown_nodes(file_id, parent_id, ordinal)
        `,
	];

	for (const statement of statements) {
		cursor.execute(statement);
	}

	const tagOccurrenceColumns = new Set(
		cursor
			.execute("PRAGMA table_info(note_tag_occurrences)")
			.fetchall()
			.map((column) => String(column[1]!)),
	);
	if (tagOccurrenceColumns.has("source") || tagOccurrenceColumns.has("file_id")) {
		cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_tag_idx");
		cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_tag_file_idx");
		cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_frontmatter_node_idx");
		cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_markdown_node_idx");
		cursor.execute("DROP TABLE note_tag_occurrences");
		cursor.execute(`
            CREATE TABLE note_tag_occurrences (
                id INTEGER PRIMARY KEY,
                tag_id INTEGER NOT NULL REFERENCES vault_tags(id) ON DELETE CASCADE,
                frontmatter_node_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
                markdown_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
                CHECK (
                    (frontmatter_node_id IS NOT NULL AND markdown_node_id IS NULL)
                    OR
                    (frontmatter_node_id IS NULL AND markdown_node_id IS NOT NULL)
                )
            )
            `);
		cursor.execute("UPDATE vault_index_state SET derived_data_dirty = 1 WHERE id = 1");
	}

	cursor.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS note_tag_occurrences_frontmatter_node_idx
        ON note_tag_occurrences(frontmatter_node_id)
        WHERE frontmatter_node_id IS NOT NULL
        `);
	cursor.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS note_tag_occurrences_markdown_node_idx
        ON note_tag_occurrences(markdown_node_id)
        WHERE markdown_node_id IS NOT NULL
        `);
	cursor.execute("INSERT OR IGNORE INTO vault_index_state (id, derived_data_dirty) VALUES (1, 0)");

	const initialStateColumns = new Set(
		cursor
			.execute("PRAGMA table_info(vault_index_state)")
			.fetchall()
			.map((column) => String(column[1]!)),
	);
	if (!initialStateColumns.has("ignored_file_paths_snapshot")) {
		cursor.execute("ALTER TABLE vault_index_state ADD COLUMN ignored_file_paths_snapshot TEXT");
	}

	const noteColumns = new Set(
		cursor
			.execute("PRAGMA table_info(vault_files)")
			.fetchall()
			.map((column) => String(column[1]!)),
	);
	if (!noteColumns.has("device")) {
		cursor.execute("ALTER TABLE vault_files ADD COLUMN device INTEGER");
	}
	if (!noteColumns.has("mtime_ns")) {
		cursor.execute("ALTER TABLE vault_files ADD COLUMN mtime_ns INTEGER NOT NULL DEFAULT 0");
	}

	const stateColumns = new Set(
		cursor
			.execute("PRAGMA table_info(vault_index_state)")
			.fetchall()
			.map((column) => String(column[1]!)),
	);
	if (!stateColumns.has("block_ids_version")) {
		cursor.execute("ALTER TABLE vault_index_state ADD COLUMN block_ids_version INTEGER NOT NULL DEFAULT 0");
	}
	if (Number(cursor.execute("SELECT block_ids_version FROM vault_index_state WHERE id = 1").fetchone()![0]!) < 1) {
		cursor.execute("UPDATE vault_files SET mtime_ns = 0 WHERE kind = 'markdown'");
		cursor.execute("UPDATE vault_index_state SET block_ids_version = 1 WHERE id = 1");
	}

	if (!stateColumns.has("link_resolution_version")) {
		cursor.execute(
			"ALTER TABLE vault_index_state ADD COLUMN link_resolution_version INTEGER NOT NULL DEFAULT 0",
		);
	}
	if (
		Number(cursor.execute("SELECT link_resolution_version FROM vault_index_state WHERE id = 1").fetchone()![0]!) <
		5
	) {
		cursor.execute("UPDATE vault_index_state SET link_resolution_version = 5, derived_data_dirty = 1 WHERE id = 1");
	}

	if (!stateColumns.has("tag_occurrence_version")) {
		cursor.execute(
			"ALTER TABLE vault_index_state ADD COLUMN tag_occurrence_version INTEGER NOT NULL DEFAULT 0",
		);
	}
	if (Number(cursor.execute("SELECT tag_occurrence_version FROM vault_index_state WHERE id = 1").fetchone()![0]!) < 1) {
		cursor.execute("UPDATE vault_index_state SET tag_occurrence_version = 1, derived_data_dirty = 1 WHERE id = 1");
	}
	if (!stateColumns.has("fenced_code_version")) {
		cursor.execute("ALTER TABLE vault_index_state ADD COLUMN fenced_code_version INTEGER NOT NULL DEFAULT 0");
	}
	if (Number(cursor.execute("SELECT fenced_code_version FROM vault_index_state WHERE id = 1").fetchone()![0]!) < 1) {
		cursor.execute("UPDATE vault_files SET mtime_ns = 0 WHERE kind = 'markdown'");
		cursor.execute("UPDATE vault_index_state SET fenced_code_version = 1 WHERE id = 1");
	}
	if (!stateColumns.has("callout_version")) {
		cursor.execute("ALTER TABLE vault_index_state ADD COLUMN callout_version INTEGER NOT NULL DEFAULT 0");
	}
	if (Number(cursor.execute("SELECT callout_version FROM vault_index_state WHERE id = 1").fetchone()![0]!) < 1) {
		cursor.execute("UPDATE vault_files SET mtime_ns = 0 WHERE kind = 'markdown'");
		cursor.execute("UPDATE vault_index_state SET callout_version = 1 WHERE id = 1");
	}

	const markdownNodeColumns = new Set(
		cursor
			.execute("PRAGMA table_info(markdown_nodes)")
			.fetchall()
			.map((column) => String(column[1]!)),
	);
	if (markdownNodeColumns.has("heading_text")) {
		cursor.execute("UPDATE markdown_nodes SET value = heading_text WHERE node_type = 'heading'");
		cursor.execute("DROP INDEX IF EXISTS markdown_nodes_file_heading_text_idx");
		cursor.execute("ALTER TABLE markdown_nodes DROP COLUMN heading_text");
	}
	if (!markdownNodeColumns.has("block_id")) {
		cursor.execute("ALTER TABLE markdown_nodes ADD COLUMN block_id TEXT");
	}

	const markdownIndexes = new Map(
		cursor
			.execute("PRAGMA index_list(markdown_nodes)")
			.fetchall()
			.map((row) => [String(row[1]!), Number(row[4]!)] as const),
	);
	const markdownIndexDefinitions: ReadonlyArray<readonly [string, string, string]> = [
		["markdown_nodes_file_value_idx", "file_id, node_type, value", "node_type = 'heading' AND value IS NOT NULL"],
		["markdown_nodes_file_block_id_idx", "file_id, block_id", "block_id IS NOT NULL"],
	];
	for (const [indexName, columns, predicate] of markdownIndexDefinitions) {
		if (markdownIndexes.get(indexName) === 0) {
			cursor.execute(`DROP INDEX ${indexName}`);
		}
		cursor.execute(
			`CREATE INDEX IF NOT EXISTS ${indexName} ON markdown_nodes(${columns}) WHERE ${predicate}`,
		);
	}

	const linkColumns = new Set(
		cursor
			.execute("PRAGMA table_info(vault_links)")
			.fetchall()
			.map((column) => String(column[1]!)),
	);
	if (linkColumns.has("source_node_id")) {
		cursor.execute("ALTER TABLE vault_links RENAME COLUMN source_node_id TO source_markdown_node_id");
		linkColumns.delete("source_node_id");
		linkColumns.add("source_markdown_node_id");
	}
	if (!linkColumns.has("source_markdown_node_id")) {
		cursor.execute(
			"ALTER TABLE vault_links ADD COLUMN source_markdown_node_id " +
			"INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE",
		);
	}
	if (!linkColumns.has("source_frontmatter_node_id")) {
		cursor.execute(
			"ALTER TABLE vault_links ADD COLUMN source_frontmatter_node_id " +
			"INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE",
		);
	}
	if (!linkColumns.has("target_node_id")) {
		cursor.execute(
			"ALTER TABLE vault_links ADD COLUMN target_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE SET NULL",
		);
	}
	if (!linkColumns.has("missing_target_id")) {
		cursor.execute(
			"ALTER TABLE vault_links ADD COLUMN missing_target_id INTEGER " +
			"REFERENCES vault_missing_targets(id) ON DELETE SET NULL",
		);
	}
	if (!linkColumns.has("resolution_status")) {
		cursor.execute(
			"ALTER TABLE vault_links ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'resolved' " +
			"CHECK (resolution_status IN ('resolved', 'missing', 'ambiguous', 'external', 'missing_fragment', 'ignored', 'ambiguous_ignored'))",
		);
	}
	for (const column of ["target_heading", "target_block_id"] as const) {
		if (linkColumns.has(column)) {
			cursor.execute(`ALTER TABLE vault_links DROP COLUMN ${column}`);
		}
	}
	const linkSchema = String(
		cursor.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_links'").fetchone()![0]!,
	);
	if (!linkSchema.includes("'ignored'") || !linkSchema.includes("'ambiguous_ignored'")) {
		cursor.execute(`
            CREATE TABLE vault_links_with_ignored_statuses (
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
                    resolution_status IN ('resolved', 'missing', 'ambiguous', 'external', 'missing_fragment', 'ignored', 'ambiguous_ignored')
                )
            )
        `);
		cursor.execute(`
            INSERT INTO vault_links_with_ignored_statuses
                (id, source_file_id, source_markdown_node_id, source_frontmatter_node_id,
                 target_file_id, target_node_id, missing_target_id, raw_target, display_text,
                 link_syntax, is_embed, resolution_status)
            SELECT id, source_file_id, source_markdown_node_id, source_frontmatter_node_id,
                   target_file_id, target_node_id, missing_target_id, raw_target, display_text,
                   link_syntax, is_embed, resolution_status
            FROM vault_links
        `);
		cursor.execute("DROP TABLE vault_links");
		cursor.execute("ALTER TABLE vault_links_with_ignored_statuses RENAME TO vault_links");
	}


	cursor.execute(
		"CREATE INDEX IF NOT EXISTS vault_links_target_source_idx ON vault_links(target_file_id, source_file_id)",
	);

	cursor.execute(
		"CREATE INDEX IF NOT EXISTS vault_links_missing_target_idx ON vault_links(missing_target_id, source_file_id)",
	);
	cursor.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS vault_missing_targets_without_file_idx
        ON vault_missing_targets(target_type, target)
        WHERE target_file_id IS NULL
        `);
	cursor.execute(`
        CREATE UNIQUE INDEX IF NOT EXISTS vault_missing_targets_with_file_idx
        ON vault_missing_targets(target_type, target, target_file_id)
        WHERE target_file_id IS NOT NULL
        `);
}



export type FrontmatterNode = YamlNode<unknown>;
export type FrontmatterDocument = Document<YamlNode<unknown>, boolean>;

export interface ParsedFrontmatter {
	properties: FrontmatterNode;
	error: string | null;
	error_line: number | null;
	error_column: number | null;
	document?: FrontmatterDocument;
}

export interface ParsedFile {
	path: string;
	inode: bigint;
	device: bigint;
	mtime_ns: bigint;
	kind: string;
	frontmatter_source: string;
	frontmatter_result: ParsedFrontmatter | null;
	syntax_tree: MarkdownNode | null;
}
/**
 * Candidate metadata consumed by match_file_moves. The caller must classify
 * created paths with the plugin's effective-kind parser and mark regular only
 * after a non-following file-type check; null/unsafe identity values are
 * deliberately ineligible. The indexing flow consumes matches while leaving
 * all unmatched changes on the existing delete-and-index path.
 */
export interface MoveMatchFile {
	path: string;
	device: bigint | number | string | null;
	inode: bigint | number | string | null;
	mtime_ns: bigint | number | string | null;
	kind: string | null;
	regular: boolean;
}

function exactNonnegativeInteger(value: MoveMatchFile['device']): bigint | null {
	if (typeof value === 'bigint') return value >= 0n ? value : null;
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
	if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function exactSignedInteger(value: MoveMatchFile['mtime_ns']): bigint | null {
	if (typeof value === 'bigint') return value;
	if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
	if (typeof value !== 'string' || !/^(0|-?[1-9]\d*)$/.test(value)) return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function moveIdentity(file: MoveMatchFile): string | null {
	const device = exactNonnegativeInteger(file.device);
	const inode = exactNonnegativeInteger(file.inode);
	return device === null || inode === null ? null : `${device}:${inode}`;
}

/**
 * Return only unambiguous deleted-to-created matches. Inputs represent the
 * scan's deleted, created, and still-indexed paths; source/destination kinds
 * must already be established using the plugin's effective-kind semantics.
 */
export function match_file_moves(
	deleted: readonly MoveMatchFile[],
	created: readonly MoveMatchFile[],
	unchanged: readonly MoveMatchFile[],
): Array<{ source: MoveMatchFile; destination: MoveMatchFile }> {
	const groups = new Map<string, { deleted: MoveMatchFile[]; created: MoveMatchFile[]; unchanged: number }>();
	const groupFor = (file: MoveMatchFile) => {
		const identity = moveIdentity(file);
		if (identity === null) return null;
		let group = groups.get(identity);
		if (group === undefined) {
			group = { deleted: [], created: [], unchanged: 0 };
			groups.set(identity, group);
		}
		return group;
	};
	for (const file of deleted) groupFor(file)?.deleted.push(file);
	for (const file of created) groupFor(file)?.created.push(file);
	for (const file of unchanged) {
		const group = groupFor(file);
		if (group !== null) group.unchanged++;
	}

	const matches: Array<{ source: MoveMatchFile; destination: MoveMatchFile }> = [];
	for (const group of groups.values()) {
		if (group.deleted.length !== 1 || group.created.length !== 1 || group.unchanged !== 0) continue;
		const source = group.deleted[0]!;
		const destination = group.created[0]!;
		if (!destination.regular || source.kind === null || destination.kind === null || source.kind !== destination.kind) continue;
		const sourceMtime = exactSignedInteger(source.mtime_ns);
		if (sourceMtime === null || sourceMtime !== exactSignedInteger(destination.mtime_ns)) continue;
		matches.push({ source, destination });
	}
	return matches;
}


export interface MarkdownPosition {
	line: number;
	column: number;
	offset: number;
}

export interface MarkdownNode {
	type: string;
	value?: string;
	children?: MarkdownNode[];
	position?: { start: MarkdownPosition; end: MarkdownPosition };
	block_id?: string;
	[key: string]: unknown;
}

export const FILE_KIND_BY_EXTENSION: Readonly<Record<string, string>> = {
	".excalidraw": "excalidraw", ".pdf": "pdf", ".djvu": "pdf", ".djv": "pdf",
	".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".svg": "image",
	".gif": "image", ".bmp": "image", ".tif": "image", ".tiff": "image", ".avif": "image",
	".py": "script", ".sh": "script", ".bash": "script", ".zsh": "script", ".fish": "script",
	".lua": "script", ".js": "script", ".ts": "script", ".c": "script", ".h": "script",
	".cpp": "script", ".hpp": "script", ".java": "script", ".rs": "script", ".go": "script",
	".mp4": "video", ".mkv": "video", ".webm": "video", ".mov": "video", ".avi": "video", ".m4v": "video",
	".mp3": "recording", ".flac": "recording", ".ogg": "recording", ".wav": "recording", ".m4a": "recording",
	".aac": "recording", ".opus": "recording", ".md": "markdown",
};


function decodeUtf8(bytes: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

function linesWithEndings(source: string): string[] {
	const lines: string[] = [];
	let start = 0;
	while (start < source.length) {
		let end = start;
		while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end += 1;
		if (end === source.length) {
			lines.push(source.slice(start));
			break;
		}
		if (source[end] === "\r" && source[end + 1] === "\n") end += 2;
		else end += 1;
		lines.push(source.slice(start, end));
		start = end;
	}
	return lines;
}

export function get_frontmatter(source_bytes: Uint8Array | string): [string[], boolean] | null {
	const source = typeof source_bytes === "string" ? source_bytes : decodeUtf8(source_bytes);
	const lines = linesWithEndings(source);
	if (lines.length === 0 || lines[0]!.replace(/[\r\n]+$/, "") !== "---") return null;
	const source_frontmatter: string[] = [];
	for (const line of lines.slice(1)) {
		const withoutEnding = line.replace(/[\r\n]+$/, "");
		if (withoutEnding === "---" || withoutEnding === "...") return [source_frontmatter, true];
		source_frontmatter.push(line);
	}
	return [source_frontmatter, false];
}

function scalarText(node: unknown, document?: FrontmatterDocument): string {
	const resolved = isAlias(node) ? resolvedNode(node, document) : node;
	if (!isScalar(resolved)) return "";
	if (typeof resolved.value === "string") return resolved.value;
	return resolved.source ?? "";
}

function scalarKeyText(node: unknown, document?: FrontmatterDocument): string {
	const resolved = isAlias(node) ? resolvedNode(node, document) : node;
	if (!isScalar(resolved)) throw new TypeError("Complex frontmatter key");
	return scalarText(resolved, document);
}

function hasInvalidYamlSymbols(document: FrontmatterDocument): boolean {
	const anchors = new Set<string>();
	let invalid = false;
	visit(document, {
		Alias(_key, node) {
			if (!anchors.has(node.source)) invalid = true;
		},
		Node(_key, node) {
			if ("anchor" in node && typeof node.anchor === "string") {
				if (anchors.has(node.anchor)) invalid = true;
				anchors.add(node.anchor);
			}
		},
	});
	return invalid;
}

function positionForOffset(source: string, offset: number): { line: number; column: number } {
	const bounded = Math.max(0, Math.min(offset, source.length));
	const before = source.slice(0, bounded);
	const newline = before.lastIndexOf("\n");
	const lineSource = before.slice(newline + 1).replace(/^.*\r/, "");
	return { line: 1 + (before.match(/\n/g)?.length ?? 0), column: [...lineSource].length + 1 };
}

export function parse_frontmatter(source: string[]): ParsedFrontmatter {
	const sourceText = source.join("");
	const fallback_properties: FrontmatterNode = new YAMLMap();
	let properties: FrontmatterNode = fallback_properties;
	let document: FrontmatterDocument | undefined;
	try {
		const parsed = parseDocument(sourceText, { version: "1.1", uniqueKeys: false });
		document = parsed;
		if (parsed.contents !== null) properties = parsed.contents;
		const error = parsed.errors[0];
		if (error !== undefined || hasInvalidYamlSymbols(parsed)) {
			// PyYAML reports its problem token, whereas yaml reports the invalid node's start.
			// Use the same scanner/parser family for persisted diagnostic coordinates.
			try {
				composePyYaml(sourceText);
			} catch (diagnostic) {
				if (diagnostic instanceof Error && 'problem_mark' in diagnostic) {
					const problem = diagnostic.problem_mark;
					if (problem && typeof problem === 'object' && 'pointer' in problem && typeof problem.pointer === 'number') {
						const mark = positionForOffset(sourceText, problem.pointer);
						return { properties: fallback_properties, error: String(diagnostic), error_line: mark.line, error_column: mark.column, document };
					}
				}
			}
			const mark = positionForOffset(sourceText, Number(error?.pos?.[0] ?? 0));
			return { properties: fallback_properties, error: error?.message ?? "YAML parse error", error_line: mark.line, error_column: mark.column, document };
		}
		return { properties, error: null, error_line: null, error_column: null, document };
	} catch (error) {
		return {
			properties,
			error: error instanceof Error ? error.message : String(error),
			error_line: null,
			error_column: null,
			document,
		};
	}
}

export function _has_frontmatter_tag(frontmatter: ParsedFrontmatter, tag: string): boolean {
	if (!isMap(frontmatter.properties)) throw new TypeError("Frontmatter root is not a mapping");
	for (const pair of frontmatter.properties.items) {
		const key = scalarKeyText(pair.key, frontmatter.document);
		if (key !== "tag" && key !== "tags") continue;
		const values: unknown[] = isSeq(pair.value) ? pair.value.items : [pair.value];
		for (const value of values) {
			const resolved = isAlias(value) ? resolvedNode(value, frontmatter.document) : value;
			if (isScalar(resolved) && scalarText(resolved, frontmatter.document) === tag) return true;
		}
	}
	return false;
}

function resolvedNode(node: FrontmatterNode, document: FrontmatterDocument | undefined): FrontmatterNode {
	if (isAlias(node) && document !== undefined) {
		const resolved = node.resolve(document);
		if (resolved !== undefined) return resolved;
	}
	return node;
}

function nodeRange(node: FrontmatterNode, source: string): [number, number] {
	const range = node.range;
	if (range === undefined || range === null) return [0, 0];
	let start = range[0];
	const anchor = "anchor" in node && typeof node.anchor === "string" ? node.anchor : undefined;
	if (anchor !== undefined) {
		const anchorStart = source.lastIndexOf("&" + anchor, start);
		if (anchorStart >= 0 && source.slice(anchorStart + anchor.length + 1, start).trim() === "") start = anchorStart;
	}
	return [start, range[1]];
}

function nodeLine(source: string, offset: number): number {
	return source.slice(0, Math.max(0, Math.min(offset, source.length))).split("\n").length;
}

export function insert_frontmatter_node(
	cursor: Cursor,
	file_id: number,
	node: FrontmatterNode,
	source: string,
	key: string | null,
	parent_id: number | null,
	ordinal: number,
	document?: FrontmatterDocument,
): void {
	node = resolvedNode(node, document);
	let node_type: string;
	let value: string | null;
	if (isMap(node)) {
		node_type = "mapping";
		value = null;
	} else if (isSeq(node)) {
		node_type = "sequence";
		value = null;
	} else {
		node_type = "scalar";
		value = scalarText(node);
	}
	const [start, end] = nodeRange(node, source);
	const raw_yaml = source.slice(start, end);
	const start_line = nodeLine(source, start) + FRONTMATTER_BODY_FIRST_FILE_LINE - 1;
	const end_line = nodeLine(source, end) + FRONTMATTER_BODY_FIRST_FILE_LINE - 1;
	cursor.execute(
		"INSERT INTO frontmatter_nodes (file_id, parent_id, ordinal, key, node_type, value, raw_yaml, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[file_id, parent_id, ordinal, key, node_type, value, raw_yaml, start_line, end_line],
	);
	const node_id = cursor.lastrowid;
	if (node_id === undefined || node_id === null) throw new Error("Failed to insert frontmatter node");
	if (isMap(node)) {
		for (let child_ordinal = 0; child_ordinal < node.items.length; child_ordinal += 1) {
			const pair = node.items[child_ordinal]!;
			if (pair.value === null || !isNode(pair.value)) continue;
			insert_frontmatter_node(cursor, file_id, pair.value, source, scalarKeyText(pair.key, document), node_id, child_ordinal, document);
		}
	} else if (isSeq(node)) {
		for (let child_ordinal = 0; child_ordinal < node.items.length; child_ordinal += 1) {
			const child = node.items[child_ordinal];
			if (child !== undefined && isNode(child)) {
				insert_frontmatter_node(cursor, file_id, child, source, null, node_id, child_ordinal, document);
			}
		}
	}
}

export function insert_frontmatter_nodes(cursor: Cursor, frontmatter_result: ParsedFrontmatter, file_id: number, source: string): void {
	if (!isMap(frontmatter_result.properties)) throw new TypeError("Frontmatter root is not a mapping");
	for (let ordinal = 0; ordinal < frontmatter_result.properties.items.length; ordinal += 1) {
		const pair = frontmatter_result.properties.items[ordinal]!;
		if (pair.value === null || !isNode(pair.value)) continue;
		insert_frontmatter_node(cursor, file_id, pair.value, source, scalarKeyText(pair.key, frontmatter_result.document), null, ordinal, frontmatter_result.document);

	}
}

interface TextNode {
	value?: string | null;
	children?: TextNode[];
}

export function get_node_text(node: TextNode): string {
	if (typeof node.value === "string") return node.value;
	return (node.children ?? []).map((child) => get_node_text(child)).join("");
}

export function add_block_ids(node: MarkdownNode, source: string): void {
	function visit(current: MarkdownNode): void {
		const position = current.position;
		if (current.type === "paragraph" && position !== undefined) {
			const paragraph_source = source.slice(position.start.offset, position.end.offset);
			const match = /(?:^|\s)\^([A-Za-z0-9_-]+)\s*$/.exec(paragraph_source);
			if (match !== null) current.block_id = match[1];
		}
		for (const child of current.children ?? []) visit(child);
	}
	visit(node);
}

export function get_markdown_node_attributes(node: MarkdownNode): Record<string, unknown> {
	let fields: string[];
	switch (node.type) {
		case "heading": fields = ["depth"]; break;
		case "list": fields = ["ordered", "start", "spread"]; break;
		case "listItem": fields = ["checked", "spread"]; break;
		case "blockquote": fields = ["callout"]; break;
		case "code": fields = ["lang", "meta", "fenced"]; break;
		case "math": fields = ["meta"]; break;
		case "table": fields = ["align"]; break;
		case "footnoteDefinition":
		case "footnoteReference": fields = ["identifier", "label"]; break;
		case "definition": fields = ["identifier", "label", "url", "title"]; break;
		case "wikilink": fields = ["path", "alias", "heading"]; break;
		case "link": fields = ["url", "title"]; break;
		case "linkReference": fields = ["identifier", "label", "referenceType"]; break;
		case "image": fields = ["url", "alt", "title"]; break;
		default: return {};
	}
	const result: Record<string, unknown> = {};
	for (const field of fields) if (Object.prototype.hasOwnProperty.call(node, field)) result[field] = node[field];
	return result;
}

export function insert_markdown_nodes(cursor: Cursor, file_id: number, node: MarkdownNode, parent_id: number | null = null, ordinal = 0): void {
	const position = node.position;
	const attributes = get_markdown_node_attributes(node);
	const serialized = JSON.stringify(attributes);
	cursor.execute(
		"INSERT INTO markdown_nodes (file_id, parent_id, ordinal, node_type, value, block_id, attributes_json, start_line, start_column, start_offset_utf16, end_line, end_column, end_offset_utf16) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		[
			file_id, parent_id, ordinal, node.type,
			node.type === "heading" ? get_node_text(node) : (node.value ?? null),
			node.block_id ?? null, serialized === undefined ? "{}" : serialized,
			position?.start.line ?? null, position?.start.column ?? null, position?.start.offset ?? null,
			position?.end.line ?? null, position?.end.column ?? null, position?.end.offset ?? null,
		],
	);
	const node_id = cursor.lastrowid;
	if (node_id === undefined || node_id === null) throw new Error(`Failed to insert Markdown node: ${node.type}`);
	for (let child_ordinal = 0; child_ordinal < (node.children ?? []).length; child_ordinal += 1) {
		insert_markdown_nodes(cursor, file_id, node.children![child_ordinal]!, node_id, child_ordinal);
	}
}

function splitFrontmatter(source: string): { markdown: string; offset: number; lineOffset: number } {
	const firstLineEnd = source.indexOf("\n");
	const firstLine = source.slice(0, firstLineEnd === -1 ? source.length : firstLineEnd).replace(/\r$/, "");
	if (firstLineEnd === -1 || firstLine !== "---") return { markdown: source, offset: 0, lineOffset: 0 };
	let cursor = firstLineEnd + 1;
	while (cursor <= source.length) {
		const nextLineEnd = source.indexOf("\n", cursor);
		const lineEnd = nextLineEnd === -1 ? source.length : nextLineEnd;
		const line = source.slice(cursor, lineEnd).replace(/\r$/, "");
		const nextCursor = nextLineEnd === -1 ? source.length : nextLineEnd + 1;
		if (line === "---") return { markdown: source.slice(nextCursor), offset: nextCursor, lineOffset: source.slice(0, nextCursor).split("\n").length - 1 };
		if (nextLineEnd === -1) break;
		cursor = nextCursor;
	}
	return { markdown: source, offset: 0, lineOffset: 0 };
}

function shiftPositions(node: MarkdownNode, offset: number, lineOffset: number): void {
	if (node.position !== undefined) {
		node.position.start.offset += offset;
		node.position.end.offset += offset;
		node.position.start.line += lineOffset;
		node.position.end.line += lineOffset;
	}
	for (const child of node.children ?? []) shiftPositions(child, offset, lineOffset);
}

function markFencedCodeNodes(node: MarkdownNode, source: string): void {
	if (node.type === "code") {
		const offset = node.position?.start.offset;
		const marker = typeof offset === "number" ? source[offset] : null;
		const markerSource = typeof offset === "number" ? source.slice(offset, offset + 3) : "";
		node.fenced = (marker === "`" || marker === "~") && markerSource === marker.repeat(3);
	}
	for (const child of node.children ?? []) markFencedCodeNodes(child, source);
}

function markCalloutNodes(node: MarkdownNode, source: string): void {
	if (node.type === "blockquote") {
		const offset = node.position?.start.offset;
		const lineEnd = typeof offset === "number" ? source.indexOf("\n", offset) : -1;
		const line = typeof offset === "number" ? source.slice(offset, lineEnd === -1 ? source.length : lineEnd).replace(/\r$/, "") : "";
		const firstChild = node.children?.[0];
		const hasCalloutMarker = /^>[ \t]*\[![A-Za-z0-9_-]+(?:\|[^\]]*)?\](?:[+-])?.*[ \t]*$/i.test(line);
		node.callout = hasCalloutMarker && (firstChild?.type === "paragraph" || firstChild?.type === "heading");
	}
	for (const child of node.children ?? []) markCalloutNodes(child, source);
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkObsidian);

export class MarkdownTreeParser {
	parse(source: string): MarkdownNode {
		const { markdown, offset, lineOffset } = splitFrontmatter(source);
		const tree = processor.parse(markdown) as unknown as MarkdownNode;
		markFencedCodeNodes(tree, markdown);
		markCalloutNodes(tree, markdown);
		shiftPositions(tree, offset, lineOffset);
		return tree;
	}
}

function parse_file_bytes(parsed: ParsedFile, source_bytes: Uint8Array, markdown_parser: MarkdownTreeParser): ParsedFile {
	let started = performance.now();
	const frontmatter = get_frontmatter(source_bytes);
	record_timing("get_frontmatter", started, "file");
	if (frontmatter !== null) {
		const [frontmatter_source, has_closing_delimiter] = frontmatter;
		parsed.frontmatter_source = frontmatter_source.join("");
		started = performance.now();
		parsed.frontmatter_result = parse_frontmatter(frontmatter_source);
		if (!has_closing_delimiter && parsed.frontmatter_result.error === null) {
			parsed.frontmatter_result = { ...parsed.frontmatter_result, error: "Frontmatter is missing a closing '---' delimiter.", error_line: null, error_column: null };
		}
		record_timing("parse_frontmatter", started, "file");
		if (parsed.frontmatter_result.error === null && _has_frontmatter_tag(parsed.frontmatter_result, "excalidraw")) {
			parsed.kind = "excalidraw";
			return parsed;
		}
	}
	const source = decodeUtf8(source_bytes);
	started = performance.now();
	parsed.syntax_tree = markdown_parser.parse(source);
	record_timing("parse_markdown_tree", started, "file");
	add_block_ids(parsed.syntax_tree, source);
	return parsed;
}

function parsed_file_metadata(filePath: string, file_stat: fs.BigIntStats): ParsedFile {
	const suffix = graph_python_suffix(filePath).toLowerCase();
	const name = path.basename(filePath);
	const kind = name.toLowerCase().endsWith("excalidraw.md") ? "excalidraw" : (FILE_KIND_BY_EXTENSION[suffix] ?? "other");
	return { path: filePath, inode: file_stat.ino, device: file_stat.dev, mtime_ns: file_stat.mtimeNs, kind, frontmatter_source: "", frontmatter_result: null, syntax_tree: null };
}
function parse_file_candidate(filePath: string, candidate_stat: fs.BigIntStats, markdown_parser: MarkdownTreeParser): ParsedFile {
	const nofollow = fs.constants.O_NOFOLLOW;
	const nonblock = fs.constants.O_NONBLOCK;
	if (typeof nofollow !== "number" || typeof nonblock !== "number") throw new Error("Safe nonblocking candidate open flags are unavailable");
	const fd = fs.openSync(filePath, fs.constants.O_RDONLY | nofollow | nonblock);
	try {
		const opened_stat = fs.fstatSync(fd, { bigint: true });
		if (!opened_stat.isFile()
			|| opened_stat.dev !== candidate_stat.dev
			|| opened_stat.ino !== candidate_stat.ino
			|| opened_stat.mtimeNs !== candidate_stat.mtimeNs) {
			throw new Error("Candidate changed before safe classification");
		}
		const parsed = parsed_file_metadata(filePath, opened_stat);
		if (parsed.kind !== "markdown") return parsed;
		const started = performance.now();
		const source_bytes = fs.readFileSync(fd);
		record_timing("read_bytes", started, "file");
		return parse_file_bytes(parsed, source_bytes, markdown_parser);
	} finally {
		fs.closeSync(fd);
	}
}

export function parse_file(filePath: string, markdown_parser: MarkdownTreeParser): ParsedFile {
	const file_stat = fs.statSync(filePath, { bigint: true });
	const parsed = parsed_file_metadata(filePath, file_stat);
	if (parsed.kind !== "markdown") return parsed;
	const started = performance.now();
	const source_bytes = fs.readFileSync(filePath);
	record_timing("read_bytes", started, "file");
	return parse_file_bytes(parsed, source_bytes, markdown_parser);
}

function indexed_file_name_and_extension(filePath: string): [string, string] {
	const suffix = graph_python_suffix(filePath);
	const extension = suffix === "." ? "" : suffix.toLowerCase();
	return [path.basename(filePath, extension === "" ? "" : suffix), extension];
}

export function insert_file(cursor: Cursor, parsed: ParsedFile, directory_id: number): number {
	const filePath = parsed.path;
	const [name, extension] = indexed_file_name_and_extension(filePath);
	cursor.execute(
		"INSERT INTO vault_files (directory_id, path, name, inode, device, mtime_ns, extension, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET directory_id = excluded.directory_id, name = excluded.name, inode = excluded.inode, device = excluded.device, mtime_ns = excluded.mtime_ns, extension = excluded.extension, kind = excluded.kind RETURNING id",
		[directory_id, filePath, name, parsed.inode, parsed.device, parsed.mtime_ns, extension, parsed.kind],
	);
	const row = cursor.fetchone();
	if (row === null || row[0] === undefined || row[0] === null) throw new Error("Failed to insert vault file");
	const file_id = Number(row[0]);
	let started = performance.now();
	cursor.execute("DELETE FROM frontmatter_nodes WHERE file_id = ?", [file_id]);
	cursor.execute("DELETE FROM frontmatter_errors WHERE file_id = ?", [file_id]);
	cursor.execute("DELETE FROM markdown_nodes WHERE file_id = ?", [file_id]);
	cursor.execute("DELETE FROM vault_links WHERE source_file_id = ?", [file_id]);
	record_timing("delete_file_nodes", started, "file");
	if (parsed.frontmatter_result !== null) {
		const frontmatter_result = parsed.frontmatter_result;
		if (frontmatter_result.error !== null) {
			cursor.execute("INSERT INTO frontmatter_errors (file_id, error_output, line, column, raw_yaml) VALUES (?, ?, ?, ?, ?)", [file_id, frontmatter_result.error, frontmatter_result.error_line, frontmatter_result.error_column, parsed.frontmatter_source]);
		} else {
			started = performance.now();
			insert_frontmatter_nodes(cursor, frontmatter_result, file_id, parsed.frontmatter_source);
			record_timing("insert_frontmatter_nodes", started, "file");
		}
	}
	if (parsed.syntax_tree !== null) {
		started = performance.now();
		insert_markdown_nodes(cursor, file_id, parsed.syntax_tree);
		record_timing("insert_markdown_nodes", started, "file");
		insert_vault_links(cursor, file_id, parsed.syntax_tree);
	}
	return file_id;
}

type GraphMarkdownPosition = {
	start?: { offset?: number };
	end?: { offset?: number };
};

type GraphMarkdownNode = {
	type: string;
	position?: GraphMarkdownPosition;
	children?: GraphMarkdownNode[];
	heading?: string | null;
	path?: string;
	alias?: string | null;
	embedded?: boolean;
	url?: string;
	alt?: string | null;
};

type GraphLinkRecord = {
	source_frontmatter_node_id?: number;
	raw_target: string;
	display_text: string | null;
	link_syntax: "wikilink" | "link" | "image";
	is_embed: boolean;
	source_start_offset_utf16?: number | null;
	source_end_offset_utf16?: number | null;
};

function graph_id(row: unknown[] | null, context: string): number {
	if (row === null || row[0] === undefined || row[0] === null) {
		throw new Error(`Missing ${context} id`);
	}
	return Number(row[0]);
}

function graph_realpath(pathname: string): string {
	const absolute = path.resolve(pathname);
	try {
		return fs.realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function graph_python_suffix(pathname: string): string {
	const basename = path.basename(pathname);
	const dot = basename.lastIndexOf(".");
	if (dot <= 0) {
		return "";
	}
	return basename.slice(dot);
}

function graph_with_markdown_suffix(pathname: string): string {
	const suffix = graph_python_suffix(pathname);
	return suffix === "" ? pathname + ".md" : pathname.slice(0, -suffix.length) + ".md";
}

function graph_relative_path(root: string, target: string): string | null {
	if (target === root) {
		return ".";
	}
	const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	if (!target.startsWith(prefix)) {
		return null;
	}
	return target.slice(prefix.length);
}

export function insert_vault_tags(cursor: Cursor): void {
	const tags = cursor.execute(
		`WITH RECURSIVE tag_nodes(id, node_type, value) AS (
			SELECT id, node_type, value
			FROM frontmatter_nodes
			WHERE parent_id IS NULL
			  AND key IN ('tag', 'tags')

			UNION ALL

			SELECT child.id, child.node_type, child.value
			FROM frontmatter_nodes AS child
			JOIN tag_nodes AS parent
			  ON child.parent_id = parent.id
		)
		SELECT value
		FROM tag_nodes
		WHERE node_type = 'scalar'
		  AND value IS NOT NULL

		UNION

		SELECT value
		FROM markdown_nodes
		WHERE node_type = 'tag'`,
	).fetchall();

	const required_tags = new Set<string>();
	for (const row of tags) {
		const tag = String(row[0]);
		const started = performance.now();
		const parts = tag.split("/");
		let parent_tag_id: number | null = null;

		for (let index = 0; index < parts.length; index += 1) {
			const normalized_name = parts.slice(0, index + 1).join("/");
			required_tags.add(normalized_name);
			cursor.execute(
				`INSERT OR IGNORE INTO vault_tags (name, parent_id)
				 VALUES (?, ?)`,
				[normalized_name, parent_tag_id],
			);
			parent_tag_id = graph_id(
				cursor.execute("SELECT id FROM vault_tags WHERE name = ?", [normalized_name]).fetchone(),
				"tag",
			);
		}
		record_timing("insert_vault_tags-insert", started, "tag");
	}

	for (const row of cursor.execute("SELECT id, name FROM vault_tags").fetchall()) {
		const started = performance.now();
		const tag_id = Number(row[0]);
		const name = String(row[1]);
		if (!required_tags.has(name)) {
			cursor.execute("DELETE FROM vault_tags WHERE id = ?", [tag_id]);
		}
		record_timing("insert_vault_tags-delete", started, "tag");
	}
}

export function insert_note_tags(cursor: Cursor, file_ids: number[]): void {
	const tag_ids = new Map<string, number>();
	for (const row of cursor.execute("SELECT name, id FROM vault_tags").fetchall()) {
		tag_ids.set(String(row[0]), Number(row[1]));
	}

	for (const file_id of file_ids) {
		cursor.execute(
			`DELETE FROM note_tag_occurrences
			 WHERE frontmatter_node_id IN (
				 SELECT id FROM frontmatter_nodes WHERE file_id = ?
			 )
			 OR markdown_node_id IN (
				 SELECT id FROM markdown_nodes WHERE file_id = ?
			 )`,
			[file_id, file_id],
		);
		const tag_occurrences = cursor.execute(
			`WITH RECURSIVE frontmatter_tag_nodes(id) AS (
				SELECT id
				FROM frontmatter_nodes
				WHERE file_id = ?
				  AND parent_id IS NULL
				  AND key IN ('tag', 'tags')

				UNION ALL

				SELECT child.id
				FROM frontmatter_nodes AS child
				JOIN frontmatter_tag_nodes AS parent
				  ON child.parent_id = parent.id
			)
			SELECT frontmatter_tag_nodes.id AS frontmatter_node_id,
			       NULL AS markdown_node_id,
			       frontmatter_nodes.value,
			       frontmatter_nodes.id AS source_position,
			       0 AS source_order
			FROM frontmatter_tag_nodes
			JOIN frontmatter_nodes
			  ON frontmatter_nodes.id = frontmatter_tag_nodes.id
			WHERE frontmatter_nodes.node_type = 'scalar'
			  AND frontmatter_nodes.value IS NOT NULL

			UNION ALL

			SELECT NULL AS frontmatter_node_id,
			       id AS markdown_node_id,
			       value,
			       start_offset_utf16 AS source_position,
			       1 AS source_order
			FROM markdown_nodes
			WHERE file_id = ? AND node_type = 'tag'
			ORDER BY source_order, source_position`,
			[file_id, file_id],
		).fetchall();

		for (const occurrence of tag_occurrences) {
			const frontmatter_node_id = occurrence[0] === null ? null : Number(occurrence[0]);
			const markdown_node_id = occurrence[1] === null ? null : Number(occurrence[1]);
			const tag_name = String(occurrence[2]);
			const tag_id = tag_ids.get(tag_name);
			if (tag_id === undefined) {
				throw new Error(`Unknown tag ${tag_name}`);
			}
			const started = performance.now();
			cursor.execute(
				`INSERT INTO note_tag_occurrences (
					tag_id,
					frontmatter_node_id,
					markdown_node_id
				)
				VALUES (?, ?, ?)`,
				[tag_id, frontmatter_node_id, markdown_node_id],
			);
			record_timing("insert_note_tags", started, "tags");
		}
	}
}

export function get_frontmatter_links(cursor: Cursor, file_id: number): GraphLinkRecord[] {
	const links: GraphLinkRecord[] = [];
	const values = cursor.execute(
		`SELECT id, value
		 FROM frontmatter_nodes
		 WHERE file_id = ?
		   AND node_type = 'scalar'
		   AND value IS NOT NULL
		 ORDER BY id`,
		[file_id],
	);
	const pattern = /!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

	for (const row of values.fetchall()) {
		const source_frontmatter_node_id = Number(row[0]);
		const value = String(row[1]);
		for (const match of value.matchAll(pattern)) {
			const raw_target = match[1];
			if (raw_target === undefined) {
				continue;
			}
			links.push({
				source_frontmatter_node_id,
				raw_target,
				display_text: match[2] ?? null,
				link_syntax: "wikilink",
				is_embed: match[0].startsWith("!"),
			});
		}
	}
	return links;
}

export function insert_vault_links(cursor: Cursor, source_file_id: number, tree: GraphMarkdownNode): void {
	const started = performance.now();
	const links = get_frontmatter_links(cursor, source_file_id);

	const visit = (node: GraphMarkdownNode): void => {
		const node_type = String(node.type);
		const position = node.position ?? {};
		const start_position = position.start ?? {};
		const end_position = position.end ?? {};
		const source_start_offset_utf16 = start_position.offset;
		const source_end_offset_utf16 = end_position.offset;

		if (node_type === "wikilink") {
			const fragment = node.heading || null;
			links.push({
				raw_target: String(node.path),
				display_text: node.alias || null,
				link_syntax: "wikilink",
				is_embed: Boolean(node.embedded),
				source_start_offset_utf16,
				source_end_offset_utf16,
			});
			const link = links[links.length - 1]!;
			if (fragment !== null) {
				link.raw_target += `#${String(fragment)}`;
			}
		} else if (node_type === "link") {
			links.push({
				raw_target: String(node.url),
				display_text: get_node_text(node) || null,
				link_syntax: "link",
				is_embed: false,
				source_start_offset_utf16,
				source_end_offset_utf16,
			});
		} else if (node_type === "image") {
			links.push({
				raw_target: String(node.url),
				display_text: node.alt || null,
				link_syntax: "image",
				is_embed: true,
				source_start_offset_utf16,
				source_end_offset_utf16,
			});
		}

		for (const child of node.children ?? []) {
			visit(child);
		}
	};
	visit(tree);

	for (const link of links) {
		let source_markdown_node_id: number | null = null;
		const source_frontmatter_node_id = link.source_frontmatter_node_id ?? null;
		if (link.source_start_offset_utf16 !== undefined && link.source_start_offset_utf16 !== null) {
			const row = cursor.execute(
				`SELECT id
				 FROM markdown_nodes
				 WHERE file_id = ?
				   AND node_type = ?
				   AND start_offset_utf16 = ?
				   AND end_offset_utf16 = ?`,
				[source_file_id, link.link_syntax, link.source_start_offset_utf16, link.source_end_offset_utf16 ?? null],
			).fetchone();
			source_markdown_node_id = row === null ? null : Number(row[0]);
		}

		cursor.execute(
			`INSERT INTO vault_links (
				source_file_id, source_markdown_node_id, source_frontmatter_node_id,
				target_file_id, target_node_id, missing_target_id, raw_target, display_text,
				link_syntax, is_embed, resolution_status
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[source_file_id, source_markdown_node_id, source_frontmatter_node_id, null, null, null, link.raw_target, link.display_text, link.link_syntax, link.is_embed ? 1 : 0, "missing"],
		);
	}
	record_timing("insert_vault_links", started, "file");
}

export async function resolve_vault_links(
	cursor: Cursor,
	vault_path: string,
	resolveLinks: ResolveLinkTargets,
): Promise<void> {
	const resolved_vault_path = graph_realpath(vault_path);
	const indexed_paths = new Map<string, number>();
	for (const row of cursor.execute("SELECT id, path FROM vault_files").fetchall()) {
		const relative_path = graph_relative_path(resolved_vault_path, String(row[1]));
		if (relative_path !== null) indexed_paths.set(relative_path.split(path.sep).join('/'), Number(row[0]));
	}

	const links = cursor.execute(
		`SELECT vault_links.id, vault_links.source_file_id, vault_links.raw_target,
		        vault_links.link_syntax, vault_files.path
		 FROM vault_links
		 JOIN vault_files ON vault_files.id = vault_links.source_file_id
		 WHERE vault_links.link_syntax IN ('wikilink', 'link', 'image')`,
	).fetchall().map((row) => {
		const raw_target = String(row[2]);
		const hash = raw_target.indexOf("#");
		const target_path = (hash < 0 ? raw_target : raw_target.slice(0, hash)).trim();
		const source_path = String(row[4]);
		const relative_source_path = graph_relative_path(resolved_vault_path, source_path);
		if (relative_source_path === null) throw new Error(`Link source is outside vault: ${source_path}`);
		const source_link_path = relative_source_path.split(path.sep).join('/');
		const query = target_path && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target_path)
			? { linkpath: target_path, sourcePath: source_link_path }
			: null;
		return {
			link_id: Number(row[0]),
			source_file_id: Number(row[1]),
			raw_target,
			target_path,
			link_syntax: String(row[3]),
			source_path,
			source_link_path,
			separator: hash < 0 ? "" : "#",
			fragment: (hash < 0 ? "" : raw_target.slice(hash + 1)).trim(),
			query,
		};
	});
	const queries = links.flatMap((link) => link.query === null ? [] : [link.query]);
	const resolution = await resolveLinks(queries);
	const vault_files_by_path = new Map(resolution.vaultFiles.map((file) => [file.path, file]));
	const selections_by_key = new Map(
		resolution.selections.map((selection) => [
			JSON.stringify([selection.linkpath, selection.sourcePath]),
			selection.targetPath,
		]),
	);
	for (const query of queries) {
		if (!selections_by_key.has(JSON.stringify([query.linkpath, query.sourcePath]))) {
			throw new Error(`Obsidian did not return a selection for ${query.linkpath} from ${query.sourcePath}`);
		}
	}

	const names_by_name = new Map<string, VaultFileMetadata[]>();
	const names_by_filename = new Map<string, VaultFileMetadata[]>();
	for (const file of resolution.vaultFiles) {
		const suffix = graph_python_suffix(file.path);
		const extension = suffix === "." ? "" : suffix.toLowerCase();
		const name = path.posix.basename(file.path, extension === "" ? "" : suffix);
		const by_name = names_by_name.get(name) ?? [];
		by_name.push(file);
		names_by_name.set(name, by_name);
		const filename = name + extension;
		const by_filename = names_by_filename.get(filename) ?? [];
		by_filename.push(file);
		names_by_filename.set(filename, by_filename);
	}

	const get_missing_target_id = (
		target_type: string,
		target: string,
		target_file_id: number | null = null,
	): number => {
		const row = cursor.execute(
			`SELECT id
			 FROM vault_missing_targets
			 WHERE target_type = ? AND target = ? AND target_file_id IS ?`,
			[target_type, target, target_file_id],
		).fetchone();
		if (row !== null) return Number(row[0]);
		cursor.execute(
			`INSERT INTO vault_missing_targets (target_type, target, target_file_id)
			 VALUES (?, ?, ?)`,
			[target_type, target, target_file_id],
		);
		return cursor.lastrowid;
	};

	const heading_matches_by_file = new Map<number, [Map<string, number[]>, Map<string, number[]>]>();
	const get_heading_matches = (file_id: number, fragment: string): number[] => {
		let cached = heading_matches_by_file.get(file_id);
		if (cached === undefined) {
			const exact_matches = new Map<string, number[]>();
			const path_matches = new Map<string, number[]>();
			const heading_stack: Array<[number, string]> = [];
			const rows = cursor.execute(
				`SELECT id, value, attributes_json
				 FROM markdown_nodes
				 WHERE file_id = ? AND node_type = 'heading'
				 ORDER BY start_offset_utf16, id`,
				[file_id],
			).fetchall();
			for (const row of rows) {
				const heading = row[1] as string | null;
				const attributes = JSON.parse(String(row[2])) as { depth?: number | null };
				const depth = attributes.depth;
				if (!heading || depth === undefined || depth === null) continue;
				while (heading_stack.length > 0 && heading_stack[heading_stack.length - 1]![0] >= depth) {
					heading_stack.pop();
				}
				heading_stack.push([depth, heading]);
				const heading_path = heading_stack.map((entry) => entry[1]).join("/");
				const node_id = Number(row[0]);
				const exact = exact_matches.get(heading) ?? [];
				exact.push(node_id);
				exact_matches.set(heading, exact);
				const nested = path_matches.get(heading_path) ?? [];
				nested.push(node_id);
				path_matches.set(heading_path, nested);
			}
			cached = [exact_matches, path_matches];
			heading_matches_by_file.set(file_id, cached);
		}

		const exact_node_ids = cached[0].get(fragment);
		if (exact_node_ids !== undefined && exact_node_ids.length > 0) return exact_node_ids;
		const nested_fragment = fragment.replaceAll("#", "/");
		return cached[1].get(fragment) ?? cached[1].get(nested_fragment) ?? [];
	};

	cursor.execute(
		`UPDATE vault_links
		 SET target_file_id = NULL,
		     target_node_id = NULL,
		     missing_target_id = NULL,
		     resolution_status = 'missing'`,
	);

	for (const link of links) {
		const started = performance.now();
		const link_key = link.query === null
			? null
			: JSON.stringify([link.query.linkpath, link.query.sourcePath]);
		let target_file_id: number | null = null;
		let target_node_id: number | null = null;
		let missing_id: number | null = null;
		let status = "missing";
		let target_type: string | null = null;
		let target_value: string | null = null;

		if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(link.target_path)) {
			status = "external";
		} else if (!link.target_path) {
			target_file_id = link.source_file_id;
		} else {
			const selected_path = selections_by_key.get(link_key!);
			if (selected_path === undefined) {
				throw new Error(`Obsidian omitted a selection for ${link.target_path} from ${link.source_link_path}`);
			}
			if (selected_path !== null) {
				const selected_file = vault_files_by_path.get(selected_path);
				if (selected_file === undefined) {
					throw new Error(`Obsidian selected a target absent from vault inventory: ${selected_path}`);
				}
				if (selected_file.ignored) {
					status = "ignored";
				} else {
					target_file_id = indexed_paths.get(selected_path) ?? null;
					if (target_file_id === null) {
						throw new Error(`Obsidian selected an unignored target absent from the index: ${selected_path}`);
					}
				}
			} else {
				let candidates = new Map<string, VaultFileMetadata>();
				const bare_wikilink =
					link.link_syntax === "wikilink" &&
					!link.target_path.startsWith("./") &&
					!link.target_path.startsWith("../") &&
					!link.target_path.startsWith("/") &&
					!link.target_path.startsWith("~") &&
					!link.target_path.includes("/");
				if (bare_wikilink) {
					for (const file of names_by_name.get(link.target_path) ?? []) candidates.set(file.path, file);
					for (const file of names_by_filename.get(link.target_path) ?? []) candidates.set(file.path, file);
					if (candidates.size === 0) {
						target_type = "name";
						target_value = link.target_path;
					}
				} else {
					let candidate_path = link.target_path.startsWith("~")
						? path.join(os.homedir(), link.target_path.slice(1))
						: link.target_path;
					if (!path.isAbsolute(candidate_path)) {
						if (link.link_syntax === "wikilink" && !link.target_path.startsWith("./") && !link.target_path.startsWith("../")) {
							candidate_path = path.join(resolved_vault_path, candidate_path);
						} else {
							candidate_path = path.join(path.dirname(link.source_path), candidate_path);
						}
					}
					const candidate_absolute_path = path.resolve(candidate_path);
					const candidate_relative_path = graph_relative_path(resolved_vault_path, candidate_absolute_path);
					if (candidate_relative_path !== null) {
						const relative_path = candidate_relative_path.split(path.sep).join('/');
						const candidate_paths = [relative_path];
						if (graph_python_suffix(relative_path) === "") {
							candidate_paths.push(graph_with_markdown_suffix(relative_path));
						}
						for (const candidate of candidate_paths) {
							const file = vault_files_by_path.get(candidate);
							if (file !== undefined) candidates.set(file.path, file);
						}
					}
					if (candidates.size === 0) {
						target_type = "path";
						const missing_path = graph_python_suffix(candidate_path)
							? candidate_path
							: graph_with_markdown_suffix(candidate_path);
						const normalized_path = path.resolve(missing_path);
						target_value = graph_relative_path(resolved_vault_path, normalized_path) ?? normalized_path;
					}
				}

				if (candidates.size > 0) {
					status = [...candidates.values()].some((candidate) => candidate.ignored)
						? "ambiguous_ignored"
						: "ambiguous";
				}
			}
		}

		if (target_file_id !== null && link.separator !== "" && link.fragment !== "") {
			let target_nodes: Array<[number]>;
			if (link.fragment.startsWith("^")) {
				target_nodes = cursor.execute(
					"SELECT id FROM markdown_nodes WHERE file_id = ? AND block_id = ?",
					[target_file_id, link.fragment.slice(1)],
				).fetchall() as Array<[number]>;
				target_type = "block";
				target_value = link.fragment.slice(1);
			} else {
				const target_node_ids = get_heading_matches(target_file_id, link.fragment);
				target_nodes = target_node_ids.map((node_id) => [node_id]);
				target_type = "heading";
				target_value = link.fragment;
			}
			if (target_nodes.length === 1) {
				target_node_id = Number(target_nodes[0]![0]);
				target_type = null;
				target_value = null;
				status = "resolved";
			} else if (target_nodes.length > 1) {
				status = "ambiguous";
				target_type = null;
				target_value = null;
			} else {
				status = "missing_fragment";
				missing_id = get_missing_target_id(target_type, target_value, target_file_id);
			}
		} else if (target_file_id !== null) {
			status = "resolved";
		} else if (target_type !== null) {
			missing_id = get_missing_target_id(target_type, target_value!);
		}

		cursor.execute(
			`UPDATE vault_links
			 SET target_file_id = ?, target_node_id = ?, missing_target_id = ?, resolution_status = ?
			 WHERE id = ?`,
			[target_file_id, target_node_id, missing_id, status, link.link_id],
		);
		record_timing("resolve_vault_links", started, "link");
	}

	cursor.execute(
		`DELETE FROM vault_missing_targets
		 WHERE NOT EXISTS (
			 SELECT 1 FROM vault_links WHERE vault_links.missing_target_id = vault_missing_targets.id
		 )`,
	);
}

export interface IndexResult {
	databasePath: string;
	addedFiles: number;
	indexedFiles: number;
	deletedFiles: number;
}

let sqlite: Promise<SqlJsStatic> | undefined;

function resolve_vault_path(vault_path: string): string {
	const expanded_path = vault_path === '~' || vault_path.startsWith('~/')
		? path.join(os.homedir(), vault_path.slice(2))
		: vault_path;
	const resolved_path = path.resolve(expanded_path);
	if (!fs.existsSync(resolved_path)) throw new Error(`Path does not exist: ${resolved_path}`);
	if (!fs.statSync(resolved_path).isDirectory()) throw new Error(`Path is not a directory: ${resolved_path}`);
	return fs.realpathSync(resolved_path);
}

async function withExistingCursor<T>(databasePath: string, read: (cursor: Cursor) => T): Promise<T> {
	const SQL = await (sqlite ??= initSqlJs({ wasmBinary: sqliteBinary.buffer }));
	const connection = new SQL.Database(fs.readFileSync(databasePath));
	const cursor = new Cursor(connection);
	try {
		return read(cursor);
	} finally {
		cursor.release();
		connection.close();
	}
}

async function readIndexedFiles(databasePath: string, root: string): Promise<IndexedFile[]> {
	return withExistingCursor(databasePath, cursor => readIndexedFilesFromCursor(cursor, root));
}

export async function getIndexedFiles(databasePath: string, vaultPath: string): Promise<IndexedFile[]> {
	return readIndexedFiles(databasePath, resolve_vault_path(vaultPath));
}

export async function getIndexedFilesForVault(vaultPath: string, configDir: string): Promise<IndexedFile[]> {
	const root = resolve_vault_path(vaultPath);
	const databasePath = path.resolve(path.join(root, configDir, 'vaultHelper.db'));
	return readIndexedFiles(databasePath, root);
}

export interface RunChecksResult {
	diagnostics: RuleDiagnostic[];
	failures: RuleExecutionFailure[];
}

export async function runChecksForVault(
	vaultPath: string,
	configDir: string,
	config: RulesConfig,
): Promise<RunChecksResult> {
	const root = resolve_vault_path(vaultPath);
	const databasePath = path.resolve(path.join(root, configDir, 'vaultHelper.db'));
	if (!fs.existsSync(databasePath)) {
		throw new Error('The persisted index is missing or not ready. Select Index vault before running checks.');
	}

	return withExistingCursor(databasePath, cursor => {
		assertIndexReady(cursor);
		const files = readRuleEngineFiles(cursor, root);
		const matches = new Map(matchRulesToFiles(config, files).map(match => [match.ruleId, match.files]));
		const result: RunChecksResult = { diagnostics: [], failures: [] };
		for (const rule of config.rules) {
			if (!rule.enabled) continue;
			try {
				const evaluated = evaluateRules({ rules: [rule], files: matches.get(rule.id) ?? [] });
				for (const diagnostic of evaluated.diagnostics) result.diagnostics.push(diagnostic);
				result.failures.push(...evaluated.failures);
			} catch (error) {
				result.failures.push({
					ruleId: rule.id,
					check: rule.check,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return result;
	});
}


let active_index: Promise<IndexResult> | undefined;
let active_index_request: { resolveLinks: ResolveLinkTargets; ignoredFilePaths: string[] } | undefined;
let index_rerun_pending = false;

export type IndexProgress = { phase: 'scanning' | 'finishing' } | { phase: 'indexing'; completed: number; total: number };

export interface VaultFileMetadata {
	path: string;
	ignored: boolean;
}

export interface LinkTargetQuery {
	linkpath: string;
	sourcePath: string;
}

export interface LinkTargetSelection extends LinkTargetQuery {
	targetPath: string | null;
}

export interface LinkResolution {
	vaultFiles: VaultFileMetadata[];
	selections: LinkTargetSelection[];
}

export type ResolveLinkTargets = (queries: LinkTargetQuery[]) => Promise<LinkResolution>;

export function indexVault(
	vault_path: string,
	config_dir: string,
	db_path: string | undefined,
	onProgress: ((progress: IndexProgress) => void) | undefined,
	resolveLinks: ResolveLinkTargets,
	ignoredFilePaths: string[],
): Promise<IndexResult> {
	if (active_index !== undefined) {
		active_index_request!.resolveLinks = resolveLinks;
		active_index_request!.ignoredFilePaths = [...ignoredFilePaths].sort();
		index_rerun_pending = true;
		return active_index;
	}
	const request = { resolveLinks, ignoredFilePaths: [...ignoredFilePaths].sort() };
	const run = run_queued_index(vault_path, config_dir, db_path, onProgress, request);
	active_index = run;
	active_index_request = request;
	void run.then(
		() => {
			if (active_index === run) {
				active_index = undefined;
				active_index_request = undefined;
			}
		},
		() => {
			if (active_index === run) {
				active_index = undefined;
				active_index_request = undefined;
			}
		},
	);
	return run;
}

async function run_queued_index(
	vault_path: string,
	config_dir: string,
	db_path: string | undefined,
	onProgress: ((progress: IndexProgress) => void) | undefined,
	request: { resolveLinks: ResolveLinkTargets; ignoredFilePaths: string[] },
): Promise<IndexResult> {
	let result: IndexResult | undefined;
	let addedFiles = 0;
	let indexedFiles = 0;
	let deletedFiles = 0;
	do {
		index_rerun_pending = false;
		const iterationRequest = {
			resolveLinks: request.resolveLinks,
			ignoredFilePaths: [...request.ignoredFilePaths],
		};
		try {
			result = await index_vault_once(vault_path, config_dir, db_path, onProgress, iterationRequest);
			addedFiles += result.addedFiles;
			indexedFiles += result.indexedFiles;
			deletedFiles += result.deletedFiles;
		} catch (error) {
			if (!index_rerun_pending) throw error;
		}
	} while (index_rerun_pending);
	if (result === undefined) throw new Error("Vault index did not complete");
	return { ...result, addedFiles, indexedFiles, deletedFiles };
}

async function index_vault_once(
	vault_path: string,
	config_dir: string,
	db_path: string | undefined,
	onProgress: ((progress: IndexProgress) => void) | undefined,
	request: { resolveLinks: ResolveLinkTargets; ignoredFilePaths: string[] },
): Promise<IndexResult> {
	onProgress?.({ phase: 'scanning' });
	vault_path = resolve_vault_path(vault_path);
	db_path = db_path ?? path.join(vault_path, config_dir, 'vaultHelper.db');
	db_path = path.resolve(db_path === '~' || db_path.startsWith('~/') ? path.join(os.homedir(), db_path.slice(2)) : db_path);
	const SQL = await (sqlite ??= initSqlJs({ wasmBinary: sqliteBinary.buffer }));
	const connection = new SQL.Database(fs.existsSync(db_path) ? fs.readFileSync(db_path) : undefined);
	const cursor = new Cursor(connection);
	TIMINGS.clear();
	const started = performance.now();
	const markdown_parser = new MarkdownTreeParser();
	record_timing('launch_markdown_parser', started);
	const temporary_path = `${db_path}.${process.pid}.tmp`;
	let saved_changes = 0;
	let saved_schema = Number(connection.exec('PRAGMA schema_version')[0]!.values[0]![0]);

	function commit(): void {
		cursor.execute('COMMIT');
		const changes = Number(connection.exec('SELECT total_changes()')[0]!.values[0]![0]);
		const schema = Number(connection.exec('PRAGMA schema_version')[0]!.values[0]![0]);
		if (changes !== saved_changes || schema !== saved_schema || !fs.existsSync(db_path!)) {
			cursor.release();
			fs.mkdirSync(path.dirname(db_path!), { recursive: true });
			fs.writeFileSync(temporary_path, connection.export());
			fs.renameSync(temporary_path, db_path!);
			// Export reopens SQLite: restore its connection-local settings and counters.
			connection.run('PRAGMA foreign_keys = ON');
			saved_changes = 0;
			saved_schema = schema;
		}
		cursor.execute('BEGIN');
	}

	try {
		connection.run('PRAGMA foreign_keys = ON');
		cursor.execute('BEGIN');
		initialize_database(cursor);
		const stored_inventory = cursor.execute('SELECT ignored_file_paths_snapshot FROM vault_index_state WHERE id = 1').fetchone()![0];
		const inventory_snapshot = JSON.stringify(request.ignoredFilePaths);
		const inventory_changed = stored_inventory !== inventory_snapshot;
		const derived_data_dirty = Boolean(cursor.execute('SELECT derived_data_dirty FROM vault_index_state WHERE id = 1').fetchone()![0]) || inventory_changed;
		const [changed_directories, changed_files] = find_changes(cursor, vault_path, config_dir);
		let added_files = 0;
		const directories_to_insert = changed_directories.filter(([action]) => action === 'created' || action === 'modified').map(([, directory]) => directory);
		let files_to_index = changed_files.filter(([action]) => action === 'created' || action === 'modified').map(([, file]) => file);
		if (!derived_data_dirty && cursor.execute('SELECT 1 FROM vault_links LIMIT 1').fetchone() === null) {
			const link_file_paths = cursor.execute(`
				SELECT DISTINCT vault_files.path
				FROM vault_files
				JOIN markdown_nodes ON markdown_nodes.file_id = vault_files.id
				WHERE markdown_nodes.node_type IN ('wikilink', 'link', 'image')
			`).fetchall();
			const indexed_paths = new Set(files_to_index);
			for (const [file] of link_file_paths) {
				if (typeof file === 'string' && !indexed_paths.has(file)) files_to_index.push(file);
			}
		}
		const indexed_file_ids: number[] = [];
		let file_paths_to_delete = changed_files.filter(([action]) => action === 'deleted').map(([, file]) => file);
		const directory_paths_to_delete = changed_directories.filter(([action]) => action === 'deleted').map(([, directory]) => directory);
		const file_changes_by_path = new Map(changed_files.map(([action, file]) => [file, action]));
		const created_candidates: MoveMatchFile[] = [];
		const parsed_created = new Map<string, ParsedFile>();
		const deleted_rows: SqlValue[][] = [];
		for (let start = 0; start < file_paths_to_delete.length; start += 400) {
			const batch = file_paths_to_delete.slice(start, start + 400);
			deleted_rows.push(...cursor.execute(
				`SELECT path, CAST(device AS TEXT), CAST(inode AS TEXT), CAST(mtime_ns AS TEXT), kind FROM vault_files WHERE path IN (${batch.map(() => '?').join(',')})`,
				batch,
			).fetchall());
		}
		const deleted_candidates: MoveMatchFile[] = deleted_rows.map(row => ({
			path: String(row[0]),
			device: row[1] as string | null,
			inode: row[2] as string | null,
			mtime_ns: row[3] as string | null,
			kind: typeof row[4] === 'string' ? row[4] : null,
			regular: true,
		}));
		const deleted_identities = new Set(deleted_candidates.map(file => `${file.device}:${file.inode}`));
		for (const file of files_to_index) {
			if (deleted_candidates.length === 0) continue;
			if (file_changes_by_path.get(file) !== 'created') continue;
			let candidate_stat: fs.BigIntStats;
			try {
				candidate_stat = fs.lstatSync(file, { bigint: true });
			} catch {
				files_to_index = files_to_index.filter(candidate => candidate !== file);
				continue;
			}
			if (!candidate_stat.isFile()) {
				files_to_index = files_to_index.filter(candidate => candidate !== file);
				continue;
			}
			if (!deleted_identities.has(`${candidate_stat.dev}:${candidate_stat.ino}`)) continue;
			if (typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_NONBLOCK !== 'number') {
				throw new Error("Safe nonblocking open flags are unavailable for a move candidate; scan deferred to preserve indexed data");
			}
			let parsed: ParsedFile;
			try {
				parsed = parse_file_candidate(file, candidate_stat, markdown_parser);
			} catch (error) {
				// A failed safe open can be a non-regular replacement. Never fall
				// back to reading this path unless a fresh no-follow open succeeds.
				let replacement_stat: fs.BigIntStats;
				try {
					replacement_stat = fs.lstatSync(file, { bigint: true });
				} catch {
					files_to_index = files_to_index.filter(candidate => candidate !== file);
					continue;
				}
				if (!replacement_stat.isFile()) {
					files_to_index = files_to_index.filter(candidate => candidate !== file);
					continue;
				}
				try {
					parsed = parse_file_candidate(file, replacement_stat, markdown_parser);
				} catch {
					throw error;
				}
			}
			parsed_created.set(file, parsed);
			created_candidates.push({ path: file, device: parsed.device, inode: parsed.inode, mtime_ns: parsed.mtime_ns, kind: parsed.kind, regular: true });
		}
		const changed_paths = new Set(changed_files.map(([, file]) => file));
		const unchanged_candidates: MoveMatchFile[] = [];
		if (deleted_candidates.length > 0 && created_candidates.length > 0) {
			const identity_pairs = new Map<string, [string, string]>();
			for (const file of created_candidates) {
				const identity = `${file.device}:${file.inode}`;
				identity_pairs.set(identity, [String(file.device), String(file.inode)]);
			}
			cursor.execute('CREATE TEMP TABLE move_candidate_identities (device TEXT NOT NULL, inode TEXT NOT NULL, PRIMARY KEY (device, inode)) WITHOUT ROWID');
			const identities = [...identity_pairs.values()];
			for (let start = 0; start < identities.length; start += 400) {
				const batch = identities.slice(start, start + 400);
				const placeholders = batch.map(() => '(?, ?)').join(', ');
				const params: string[] = [];
				for (const [device, inode] of batch) params.push(device, inode);
				cursor.execute(`INSERT OR IGNORE INTO move_candidate_identities (device, inode) VALUES ${placeholders}`, params);
			}
			const unchanged_rows = cursor.execute(
				`SELECT path, CAST(device AS TEXT), CAST(inode AS TEXT), CAST(mtime_ns AS TEXT), kind
				 FROM vault_files
				 WHERE EXISTS (
					SELECT 1 FROM move_candidate_identities
					WHERE CAST(vault_files.device AS TEXT) = move_candidate_identities.device
					AND CAST(vault_files.inode AS TEXT) = move_candidate_identities.inode
				 )`,
			).fetchall();
			cursor.execute('DROP TABLE move_candidate_identities');
			for (const row of unchanged_rows) {
				if (typeof row[0] !== 'string' || changed_paths.has(row[0])) continue;
				unchanged_candidates.push({
					path: row[0],
					device: row[1] as string | null,
					inode: row[2] as string | null,
					mtime_ns: row[3] as string | null,
					kind: typeof row[4] === 'string' ? row[4] : null,
					regular: true,
				});
			}
		}
		const move_candidates = match_file_moves(deleted_candidates, created_candidates, unchanged_candidates);
		const moves_to_reconcile: Array<{ source: MoveMatchFile; destination: MoveMatchFile; parsed: ParsedFile }> = [];
		for (const candidate of move_candidates) {
			const parsed = parsed_created.get(candidate.destination.path);
			if (parsed !== undefined) moves_to_reconcile.push({ ...candidate, parsed });
		}
		const has_file_changes = files_to_index.length > 0 || file_paths_to_delete.length > 0;
		if (has_file_changes || inventory_changed) cursor.execute('UPDATE vault_index_state SET derived_data_dirty = 1 WHERE id = 1');

		for (const directory of directories_to_insert) {
			const parent_id = directory === vault_path ? null : Number(cursor.execute('SELECT id FROM vault_directories WHERE path = ?', [path.dirname(directory)]).fetchone()![0]);
			cursor.execute(`
				INSERT INTO vault_directories (path, inode, parent_id)
				VALUES (?, ?, ?)
				ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, parent_id = excluded.parent_id
			`, [directory, fs.statSync(directory, { bigint: true }).ino, parent_id]);
		}

		for (const candidate of moves_to_reconcile) {
			let parsed = candidate.parsed;
			const destination_path = candidate.destination.path;
			const [name, extension] = indexed_file_name_and_extension(destination_path);
			const directory_id = cursor.execute('SELECT id FROM vault_directories WHERE path = ?', [path.dirname(destination_path)]).fetchone()?.[0];
			if (directory_id === undefined || directory_id === null) {
				parsed_created.delete(destination_path);
				continue;
			}
			let destination_stat: fs.BigIntStats;
			try {
				destination_stat = fs.lstatSync(destination_path, { bigint: true });
			} catch {
				parsed_created.delete(destination_path);
				files_to_index = files_to_index.filter(file => file !== destination_path);
				continue;
			}
			if (!destination_stat.isFile()) {
				parsed_created.delete(destination_path);
				files_to_index = files_to_index.filter(file => file !== destination_path);
				continue;
			}
			if (
				destination_stat.dev !== BigInt(candidate.destination.device!) ||
				destination_stat.ino !== BigInt(candidate.destination.inode!) ||
				destination_stat.mtimeNs !== BigInt(candidate.destination.mtime_ns!) ||
				parsed.device !== destination_stat.dev ||
				parsed.inode !== destination_stat.ino ||
				parsed.mtime_ns !== destination_stat.mtimeNs
			) {
				try {
					parsed = parse_file_candidate(destination_path, destination_stat, markdown_parser);
					parsed_created.set(destination_path, parsed);
				} catch (error) {
					let still_regular = false;
					try {
						still_regular = fs.lstatSync(destination_path, { bigint: true }).isFile();
					} catch {
						// The destination vanished or became inaccessible.
					}
					if (still_regular) throw error;
					parsed_created.delete(destination_path);
					files_to_index = files_to_index.filter(file => file !== destination_path);
				}
				continue;
			}
			const updated = cursor.execute(
				`UPDATE vault_files
				SET directory_id = ?, path = ?, name = ?, inode = ?, device = ?, mtime_ns = ?, extension = ?, kind = ?
				WHERE path = ? RETURNING id`,
				[directory_id, destination_path, name, parsed.inode, parsed.device, parsed.mtime_ns, extension, parsed.kind, candidate.source.path],
			).fetchone();
			if (updated === null) {
				parsed_created.delete(destination_path);
				continue;
			}
			files_to_index = files_to_index.filter(file => file !== destination_path);
			file_paths_to_delete = file_paths_to_delete.filter(file => file !== candidate.source.path);
		}
		for (const file of files_to_index) {
			if (file_changes_by_path.get(file) === 'created') added_files++;
		}
		onProgress?.({ phase: 'indexing', completed: 0, total: files_to_index.length });

		if (files_to_index.length) {
			console.debug(`Indexing ${files_to_index.length} files`);
			const files_to_process = [...files_to_index];
			for (let index = 0; index < files_to_process.length; index++) {
				const file_path = files_to_process[index]!;
				let parsed_file = parsed_created.get(file_path);
				let skip_file = false;
				if (parsed_file !== undefined) {
					let current_stat: fs.BigIntStats;
					try {
						current_stat = fs.lstatSync(file_path, { bigint: true });
					} catch {
						parsed_file = undefined;
						skip_file = true;
					}
					if (parsed_file !== undefined && !current_stat!.isFile()) {
						parsed_file = undefined;
						skip_file = true;
					}
					if (
						parsed_file !== undefined
						&& (parsed_file.device !== current_stat!.dev
							|| parsed_file.inode !== current_stat!.ino
							|| parsed_file.mtime_ns !== current_stat!.mtimeNs)
					) {
						try {
							parsed_file = parse_file_candidate(file_path, current_stat!, markdown_parser);
							parsed_created.set(file_path, parsed_file);
						} catch (error) {
							let still_regular = false;
							try {
								still_regular = fs.lstatSync(file_path, { bigint: true }).isFile();
							} catch {
								// The replacement vanished or became inaccessible.
							}
							if (still_regular) throw error;
							parsed_file = undefined;
							skip_file = true;
						}
					}
					if (skip_file) {
						parsed_created.delete(file_path);
						files_to_index = files_to_index.filter(candidate => candidate !== file_path);
						if (file_changes_by_path.get(file_path) === 'created') added_files--;
					}
				}
				if (!skip_file) {
					parsed_file ??= parse_file(file_path, markdown_parser);
					const directory_id = Number(cursor.execute('SELECT id FROM vault_directories WHERE path = ?', [path.dirname(file_path)]).fetchone()![0]);
					indexed_file_ids.push(insert_file(cursor, parsed_file, directory_id));
				}
				const completed = index + 1;
				if (completed % 25 === 0 || completed === files_to_process.length) {
					onProgress?.({ phase: 'indexing', completed, total: files_to_process.length });
				}
				if ((index + 1) % INDEX_BATCH_SIZE === 0) {
					commit();
					if (index + 1 < files_to_process.length) cursor.execute('UPDATE vault_index_state SET derived_data_dirty = 1 WHERE id = 1');
				}
				if ((index + 1) % 1_000 === 0 || index + 1 === files_to_process.length) console.debug(`Indexed ${index + 1}/${files_to_process.length} files`);
				// Keep one file's AST in memory and allow Obsidian to process UI events.
				if ((index + 1) % 25 === 0) await new Promise<void>(resolve => self.setTimeout(resolve, 0));
			}
		}
		onProgress?.({ phase: 'finishing' });

		for (const file of file_paths_to_delete) cursor.execute('DELETE FROM vault_files WHERE path = ?', [file]);
		for (const directory of directory_paths_to_delete) cursor.execute('DELETE FROM vault_directories WHERE path = ?', [directory]);
		if (has_file_changes || inventory_changed) commit();

		if (has_file_changes || derived_data_dirty) {
			const tag_file_ids = derived_data_dirty ? cursor.execute('SELECT id FROM vault_files').fetchall().map(([id]) => Number(id)) : indexed_file_ids;
			console.debug('Inserting vault tags ...');
			insert_vault_tags(cursor);
			console.debug('Inserted vault tags');
			console.debug('Inserting note tags ...');
			insert_note_tags(cursor, tag_file_ids);
			console.debug('Inserted note tags');
			console.debug('Resolving wikilinks ...');
			await resolve_vault_links(cursor, vault_path, request.resolveLinks);
			console.debug('Resolved wikilinks');
			cursor.execute('UPDATE vault_index_state SET derived_data_dirty = 0, ignored_file_paths_snapshot = ? WHERE id = 1', [inventory_snapshot]);
		}
		commit();
		print_timing_summary();
		return { databasePath: db_path, addedFiles: added_files, indexedFiles: files_to_index.length, deletedFiles: file_paths_to_delete.length };
	} finally {
		cursor.release();
		connection.close();
		if (fs.existsSync(temporary_path)) fs.unlinkSync(temporary_path);
	}
}
