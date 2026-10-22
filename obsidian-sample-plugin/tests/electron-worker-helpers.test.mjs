import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import {
	findYieldMatches,
	instrumentWorkerSource,
	parseGeneratedJavaScript,
} from './electron-worker-helpers.mjs';

const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..');
let workRoot;
let workerPath;
let workerSource;
let clientSource;
let requestHandlerSource;

before(async () => {
	workRoot = await mkdtemp(join(tmpdir(), 'vault-helper-worker-helper-tests-'));
	workerPath = join(workRoot, 'indexer-worker.cjs');
	await build({
		entryPoints: [join(pluginDir, 'src', 'indexer-worker.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'es2021',
		loader: { '.wasm': 'binary' },
		minify: true,
		outfile: workerPath,
		logLevel: 'silent',
	});
	workerSource = await readFile(workerPath, 'utf8');
	const clientBuild = await build({
		entryPoints: [join(pluginDir, 'src', 'indexer-client.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'es2021',
		write: false,
		logLevel: 'silent',
	});
	clientSource = clientBuild.outputFiles[0].text;
	const handlerBuild = await build({
		entryPoints: [join(pluginDir, 'src', 'indexer-worker.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		target: 'es2021',
		external: ['./indexer'],
		write: false,
		logLevel: 'silent',
	});
	requestHandlerSource = handlerBuild.outputFiles[0].text;
});

after(async () => {
	if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

const compiledYield = '(_+1)%25===0&&await new Promise(G=>self.setTimeout(G,0))';

test('matches and instruments exactly one compiled 25-file yield', () => {
	const source = `async function run() { ${compiledYield}; }`;
	assert.equal(findYieldMatches(source).length, 1);
	const transformed = instrumentWorkerSource(source);
	parseGeneratedJavaScript(transformed);
	assert.match(transformed, /\(_\+1\)%25===0&&await new Promise/);
	assert.match(transformed, /type: 'paused'/);
	assert.match(transformed, /Atomics\.wait/);
});

test('rejects a missing compiled yield', () => {
	assert.throws(() => instrumentWorkerSource('async function run() {}'), /exactly one.*found 0/);
});

test('rejects duplicate compiled yields', () => {
	assert.throws(
		() => instrumentWorkerSource(`async function run() { ${compiledYield}; ${compiledYield}; }`),
		/exactly one.*found 2/,
	);
});

test('generated worker and transformed worker are valid JavaScript', async () => {
	const source = await readFile(workerPath, 'utf8');
	parseGeneratedJavaScript(source);
	parseGeneratedJavaScript(instrumentWorkerSource(source));
});
test('bridges batched Obsidian link selections and metadata inventory to the worker', async () => {
	const indexCalls = [];
	let ignoredPaths;
	let clientWorker;
	const indexResult = { databasePath: '/vault/config/vaultHelper.db', addedFiles: 1, indexedFiles: 1, deletedFiles: 0 };
	const queries = [
		{ linkpath: 'folder/B', sourcePath: 'A.md' },
		{ linkpath: 'folder/B', sourcePath: 'A.md' },
		{ linkpath: 'B', sourcePath: 'notes/A.md' },
		{ linkpath: 'B', sourcePath: 'notes/C.md' },
	];
	const expectedResolution = {
		vaultFiles: [
			{ path: 'A.md', ignored: false },
			{ path: 'B.md', ignored: false },
			{ path: 'folder/B.md', ignored: false },
			{ path: 'notes/A.md', ignored: false },
			{ path: 'notes/C.md', ignored: false },
			{ path: 'ignored/nested/hidden.md', ignored: true },
			{ path: '.obsidian/vaultHelper.db', ignored: true },
			{ path: '.git/config', ignored: true },
			{ path: 'templates/template.md', ignored: true },
		],
		selections: [
			{ linkpath: 'folder/B', sourcePath: 'A.md', targetPath: 'folder/B.md' },
			{ linkpath: 'B', sourcePath: 'notes/A.md', targetPath: 'B.md' },
			{ linkpath: 'B', sourcePath: 'notes/C.md', targetPath: null },
		],
	};
	const workerSelf = {
		onmessage: null,
		postMessage(data) {
			clientWorker.emit('message', { data });
		},
	};
	const indexerMock = {
		setIgnoredPaths(paths) { ignoredPaths = [...paths]; },
		async indexVault(vaultPath, configDir, databasePath, onProgress, resolveLinks, ignoredFilePaths) {
			indexCalls.push([vaultPath, configDir, databasePath, ignoredFilePaths]);
			onProgress({ phase: 'scanning' });
			const resolution = await resolveLinks(queries);
			assert.deepEqual(JSON.parse(JSON.stringify(resolution)), expectedResolution);
			return indexResult;
		},
	};
	const handlerModule = { exports: {} };
	vm.runInNewContext(requestHandlerSource, {
		module: handlerModule,
		exports: handlerModule.exports,
		require(name) {
			if (name === './indexer') return indexerMock;
			throw new Error(`Unexpected worker dependency: ${name}`);
		},
		self: workerSelf,
	});

	class TestWorker {
		constructor() {
			this.listeners = new Map();
			this.messages = [];
			clientWorker = this;
		}
		addEventListener(type, listener) {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push(listener);
			this.listeners.set(type, listeners);
		}
		postMessage(data) {
			this.messages.push(JSON.parse(JSON.stringify(data)));
			void workerSelf.onmessage({ data });
		}
		emit(type, event) {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
		terminate() {}
	}
	const resolverCalls = [];
	const resolved = new Map([
		[JSON.stringify(['folder/B', 'A.md']), { path: 'folder/B.md' }],
		[JSON.stringify(['B', 'notes/A.md']), { path: 'B.md' }],
		[JSON.stringify(['B', 'notes/C.md']), null],
	]);
	const clientModule = { exports: {} };
	vm.runInNewContext(clientSource, {
		module: clientModule,
		exports: clientModule.exports,
		Worker: TestWorker,
		Blob: class {},
		URL: { createObjectURL() { return 'blob:test-worker'; }, revokeObjectURL() {} },
	});

	const progress = [];
	const client = new clientModule.exports.IndexerClient('worker.cjs', {
		getFiles: () => expectedResolution.vaultFiles.map(({ path }) => ({ path })),
		getFirstLinkpathDest(linkpath, sourcePath) {
			resolverCalls.push([linkpath, sourcePath]);
			return resolved.get(JSON.stringify([linkpath, sourcePath])) ?? null;
		},
	}, update => progress.push(update));
	const result = await client.indexVault('/vault', ['ignored'], '.obsidian');
	assert.deepEqual(clientWorker.messages, [
		{ id: 1, vaultPath: '/vault', ignoredPaths: ['ignored'], ignoredFilePaths: ['.git/config', '.obsidian/vaultHelper.db', 'ignored/nested/hidden.md', 'templates/template.md'], configDir: '.obsidian' },
		{ id: 1, type: 'resolve-links-result', resolution: expectedResolution },
	]);
	assert.deepEqual(ignoredPaths, ['ignored']);
	assert.deepEqual(indexCalls, [['/vault', '.obsidian', undefined, ['.git/config', '.obsidian/vaultHelper.db', 'ignored/nested/hidden.md', 'templates/template.md']]]);
	assert.deepEqual(resolverCalls, [
		['folder/B', 'A.md'],
		['B', 'notes/A.md'],
		['B', 'notes/C.md'],
	]);
	assert.deepEqual(JSON.parse(JSON.stringify(result)), indexResult);
	assert.deepEqual(JSON.parse(JSON.stringify(progress)), [{ phase: 'scanning' }, { phase: 'scanning' }, null]);
	client.stop();
});
test('coalesces an ignore request through the real client, worker, indexer, and SQLite database', async () => {
	await assertRealRouteCoalescing({
		databaseName: 'coalesced-client-ignore.db',
		firstIgnoredPaths: [],
		secondIgnoredPaths: ['B.md'],
		expectedStatus: 'ignored',
		expectTarget: false,
	});
});

test('coalesces an unignore request through the real client, worker, indexer, and SQLite database', async () => {
	await assertRealRouteCoalescing({
		databaseName: 'coalesced-client-unignore.db',
		firstIgnoredPaths: ['B.md'],
		secondIgnoredPaths: [],
		expectedStatus: 'resolved',
		expectTarget: true,
	});
});

test('returns a rejected Promise when host getFiles throws', async () => {
	const clientModule = { exports: {} };
	class TestWorker {
		addEventListener() {}
		postMessage() {}
		terminate() {}
	}
	vm.runInNewContext(clientSource, {
		module: clientModule,
		exports: clientModule.exports,
		Worker: TestWorker,
		Blob: class {},
		URL: { createObjectURL() { return 'blob:test-worker'; }, revokeObjectURL() {} },
	});
	const failure = new Error('host inventory unavailable');
	const client = new clientModule.exports.IndexerClient('worker.cjs', {
		getFiles() { throw failure; },
		getFirstLinkpathDest() { return null; },
	});
	let result;
	assert.doesNotThrow(() => { result = client.indexVault('/vault', [], '.obsidian'); });
	assert.equal(typeof result?.then, 'function', 'indexVault must return a Promise-like result even on host failure');
	await assert.rejects(result, error => error === failure);
	client.stop();
});

async function assertRealRouteCoalescing({
	databaseName,
	firstIgnoredPaths,
	secondIgnoredPaths,
	expectedStatus,
	expectTarget,
}) {
	const vaultPath = join(workRoot, databaseName.replace(/\.db$/, ''));
	const databasePath = join(vaultPath, '.obsidian', 'vaultHelper.db');
	await mkdir(join(vaultPath, '.obsidian'), { recursive: true });
	await writeFile(join(vaultPath, 'A.md'), '[[B]]\n');
	await writeFile(join(vaultPath, 'B.md'), '---\nsecret: indexed-only-when-unignored\n---\n# Target\n');
	const firstResolutionGate = createGate();
	const workerMessages = [];
	const requestMessages = [];
	const workerRequire = createRequire(import.meta.url);

	class InMemoryWorker {
		constructor() {
			this.listeners = new Map();
			this.self = {
				onmessage: null,
				postMessage: data => {
					workerMessages.push(data);
					queueMicrotask(() => this.emit('message', { data }));
				},
			};
			const workerModule = { exports: {} };
			vm.runInNewContext(workerSource, {
				module: workerModule,
				exports: workerModule.exports,
				require: workerRequire,
				self: this.self,
				__dirname: pluginDir,
				process,
				TextDecoder,
				Buffer,
				performance,
				setTimeout,
				clearTimeout,
				console,
			});
		}
		addEventListener(type, listener) {
			const listeners = this.listeners.get(type) ?? [];
			listeners.push(listener);
			this.listeners.set(type, listeners);
		}
		postMessage(data) {
			requestMessages.push(data);
			if (data.type === 'resolve-links-result' && data.id === 1) {
				firstResolutionGate.enter();
				void firstResolutionGate.wait().then(() => this.self.onmessage({ data }));
				return;
			}
			void this.self.onmessage({ data });
		}
		emit(type, event) {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
		terminate() {}
	}

	const clientModule = { exports: {} };
	vm.runInNewContext(clientSource, {
		module: clientModule,
		exports: clientModule.exports,
		Worker: InMemoryWorker,
		Blob: class {},
		URL: { createObjectURL() { return 'blob:test-worker'; }, revokeObjectURL() {} },
	});
	const host = {
		getFiles() {
			return readdirSync(vaultPath, { withFileTypes: true })
				.filter(entry => entry.isFile())
				.map(entry => ({ path: relative(vaultPath, join(vaultPath, entry.name)).split('\\').join('/') }));
		},
		getFirstLinkpathDest(linkpath, sourcePath) {
			assert.equal(linkpath, 'B');
			assert.equal(sourcePath, 'A.md');
			return { path: 'B.md' };
		},
	};
	const client = new clientModule.exports.IndexerClient('worker.cjs', host);
	try {
		const first = client.indexVault(vaultPath, firstIgnoredPaths, '.obsidian');
		await firstResolutionGate.reached;
		const second = client.indexVault(vaultPath, secondIgnoredPaths, '.obsidian');
		assert.notStrictEqual(second, first, 'each client request must have an independent Promise');
		assert.deepEqual(requestMessages.filter(message => !('type' in message)).map(({ id }) => id), [1, 2],
			'both client index requests must reach the real worker');
		assert.equal(workerMessages.filter(({ type }) => type === 'resolve-links').length, 1,
			'the first resolution result must remain held while request two is sent');
		firstResolutionGate.release();
		const results = await Promise.all([first, second]);
		assert.equal(results.length, 2, 'both client requests must settle');
		assert(results.every(result => result.databasePath === databasePath));

		const snapshot = JSON.parse(execFileSync(process.env.PYTHON || '/usr/bin/python3', ['-c', String.raw`
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
out = {}
for table in ('vault_files', 'vault_links', 'vault_missing_targets', 'markdown_nodes', 'frontmatter_nodes', 'frontmatter_errors'):
    columns = [column[1] for column in c.execute(f'PRAGMA table_info({table})')]
    out[table] = [dict(zip(columns, row)) for row in c.execute(f'SELECT * FROM {table} ORDER BY id')]
print(json.dumps(out))
`, databasePath], { encoding: 'utf8' }));
		const source = snapshot.vault_files.find(file => file.path === join(vaultPath, 'A.md'));
		const target = snapshot.vault_files.find(file => file.path === join(vaultPath, 'B.md'));
		const links = snapshot.vault_links.filter(link => link.source_file_id === source?.id && link.raw_target === 'B');
		assert.equal(links.length, 1);
		assert.equal(links[0].resolution_status, expectedStatus);
		assert.equal(links[0].target_file_id, expectTarget ? target?.id : null);
		assert.equal(links[0].target_node_id, null);
		assert.equal(links[0].missing_target_id, null);
		assert.equal(Boolean(target), expectTarget, 'B contents must only be indexed after unignore');
		assert.equal(snapshot.markdown_nodes.some(node => node.file_id === target?.id), expectTarget,
			'B markdown content membership must follow the final ignore setting');
		assert.equal(snapshot.frontmatter_nodes.some(node => node.file_id === target?.id), expectTarget,
			'B frontmatter content membership must follow the final ignore setting');
		if (!expectTarget) {
			assert.equal(snapshot.vault_missing_targets.length, 0);
			assert(!JSON.stringify(snapshot).includes('indexed-only-when-unignored'),
				'ignored B contents must not be present in indexed tables');
		}
		assert(workerMessages.some(({ id, type }) => id === 1 && type === 'resolve-links'));
		assert(workerMessages.some(({ id, type }) => id === 2 && type === 'resolve-links'));
		assert(workerMessages.some(({ id, result }) => id === 1 && result?.databasePath === databasePath));
		assert(workerMessages.some(({ id, result }) => id === 2 && result?.databasePath === databasePath));
		const secondRequest = requestMessages.find(message => !('type' in message) && message.id === 2);
		assert.deepEqual(Array.from(secondRequest.ignoredPaths), secondIgnoredPaths);
		assert.deepEqual(Array.from(secondRequest.ignoredFilePaths), secondIgnoredPaths.length ? ['B.md'] : []);
		assert(requestMessages.filter(message => !('type' in message)).every(({ ignoredFilePaths }) =>
			ignoredFilePaths.every(filePath => typeof filePath === 'string')),
		'worker inventory must contain ignored paths only, not file contents');
		assert(!JSON.stringify([...requestMessages, ...workerMessages]).includes('indexed-only-when-unignored'),
			'client/worker traffic must exchange only paths and target selections, never note contents');
	} finally {
		firstResolutionGate.release();
		client.stop();
	}
}

function createGate() {
	let enter;
	let release;
	const reached = new Promise(resolve => { enter = resolve; });
	const pending = new Promise(resolve => { release = resolve; });
	return { reached, enter, release, wait: () => pending };
}
