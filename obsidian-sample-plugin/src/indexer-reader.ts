import * as path from 'node:path';
import type { Cursor } from './indexer';
import type { IndexedFile } from './rules-config';
import type { IndexedFrontmatter, IndexedLinkStatus, RuleEngineFile } from './rules-engine';


export function assertIndexReady(cursor: Cursor): void {
	const tables = new Set(cursor.execute(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vault_files', 'vault_index_state')",
	).fetchall().map(([name]) => name));
	const state = tables.has('vault_index_state')
		? cursor.execute('SELECT derived_data_dirty FROM vault_index_state WHERE id = 1').fetchone()
		: null;
	if (!tables.has('vault_files') || state === null || state[0] !== 0) {
		throw new Error('The persisted index is missing or not ready. Select Index vault before running checks.');
	}
}

function relativePath(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Indexed file is outside the vault: ${filePath}`);
	}
	return relative.split(path.sep).join('/');
}

export function readIndexedFiles(cursor: Cursor, root: string): IndexedFile[] {
	return cursor.execute('SELECT path, kind FROM vault_files ORDER BY path').fetchall().map(([filePath, kind]) => {
		if (typeof filePath !== 'string' || typeof kind !== 'string') {
			throw new Error('Indexed file path or kind is not a string');
		}
		return { path: relativePath(root, filePath), kind: kind as IndexedFile['kind'] };
	});
}

function optionalLine(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function readRuleEngineFiles(cursor: Cursor, root: string): RuleEngineFile[] {
	const indexedFiles = readIndexedFiles(cursor, root);
	const byPath = new Map<string, RuleEngineFile>();
	for (const file of indexedFiles) {
		byPath.set(file.path, {
			...file,
			...(file.kind === 'markdown' ? { frontmatter: { status: 'absent' } as const, links: [] } : {}),
		});
	}

	const malformed = new Map<string, IndexedFrontmatter>();
	for (const [filePath, message, rawLine] of cursor.execute(
		`SELECT files.path, errors.error_output, errors.line
		 FROM frontmatter_errors AS errors
		 JOIN vault_files AS files ON files.id = errors.file_id
		 ORDER BY errors.file_id, errors.id`,
	).fetchall()) {
		if (typeof filePath !== 'string' || typeof message !== 'string') throw new Error('Invalid indexed frontmatter error row');
		const bodyLine = optionalLine(rawLine);
		malformed.set(relativePath(root, filePath), {
			status: 'malformed',
			message,
			...(bodyLine === undefined ? {} : { line: bodyLine + 1 }),
		});
	}

	const properties = new Map<string, string[]>();
	for (const [filePath, key] of cursor.execute(
		`SELECT files.path, nodes.key
		 FROM frontmatter_nodes AS nodes
		 JOIN vault_files AS files ON files.id = nodes.file_id
		 WHERE nodes.parent_id IS NULL AND nodes.key IS NOT NULL
		 ORDER BY nodes.file_id, nodes.ordinal`,
	).fetchall()) {
		if (typeof filePath !== 'string' || typeof key !== 'string') throw new Error('Invalid indexed frontmatter property row');
		const relative = relativePath(root, filePath);
		let rootProperties = properties.get(relative);
		if (rootProperties === undefined) properties.set(relative, rootProperties = []);
		rootProperties.push(key);
	}

	for (const [filePath, file] of byPath) {
		if (file.kind !== 'markdown') continue;
		const error = malformed.get(filePath);
		if (error !== undefined) file.frontmatter = error;
		else {
			const rootProperties = properties.get(filePath);
			if (rootProperties !== undefined) file.frontmatter = { status: 'valid', rootProperties };
		}
	}

	for (const [filePath, rawTarget, rawStatus, rawEmbed, rawLine] of cursor.execute(
		`SELECT files.path, links.raw_target, links.resolution_status, links.is_embed,
			COALESCE(markdown.start_line, frontmatter.start_line)
		 FROM vault_links AS links
		 JOIN vault_files AS files ON files.id = links.source_file_id
		 LEFT JOIN markdown_nodes AS markdown ON markdown.id = links.source_markdown_node_id
		 LEFT JOIN frontmatter_nodes AS frontmatter ON frontmatter.id = links.source_frontmatter_node_id
		 ORDER BY links.id`,
	).fetchall()) {
		if (typeof filePath !== 'string' || typeof rawTarget !== 'string' || typeof rawStatus !== 'string') {
			throw new Error('Invalid indexed link occurrence row');
		}
		const file = byPath.get(relativePath(root, filePath));
		if (file === undefined || file.kind !== 'markdown') continue;
		const line = optionalLine(rawLine);
		const status = rawStatus as IndexedLinkStatus;
		file.links!.push({ rawTarget, status, isEmbed: rawEmbed === 1, ...(line === undefined ? {} : { line }) });
	}

	return [...byPath.values()];
}
