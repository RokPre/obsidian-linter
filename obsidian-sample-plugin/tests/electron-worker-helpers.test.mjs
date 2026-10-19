import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
test('passes configDir and ignored paths through the bundled client and worker handler', async () => {
	const indexCalls = [];
	let ignoredPaths;
	let clientWorker;
	const indexResult = { databasePath: '/vault/config/vaultHelper.db', addedFiles: 1, indexedFiles: 1, deletedFiles: 0 };
	const workerSelf = {
		onmessage: null,
		postMessage(data) {
			clientWorker.emit('message', { data });
		},
	};
	const indexerMock = {
		setIgnoredPaths(paths) { ignoredPaths = [...paths]; },
		async indexVault(vaultPath, configDir, databasePath, onProgress) {
			indexCalls.push([vaultPath, configDir, databasePath]);
			onProgress({ phase: 'scanning' });
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
	const clientModule = { exports: {} };
	vm.runInNewContext(clientSource, {
		module: clientModule,
		exports: clientModule.exports,
		Worker: TestWorker,
		Blob: class {},
		URL: { createObjectURL() { return 'blob:test-worker'; }, revokeObjectURL() {} },
	});

	const progress = [];
	const client = new clientModule.exports.IndexerClient('worker.cjs', update => progress.push(update));
	const result = await client.indexVault('/vault', ['excluded.md'], 'config');
	assert.deepEqual(clientWorker.messages, [{
		id: 1,
		vaultPath: '/vault',
		ignoredPaths: ['excluded.md'],
		configDir: 'config',
	}]);
	assert.deepEqual(ignoredPaths, ['excluded.md']);
	assert.deepEqual(indexCalls, [['/vault', 'config', undefined]]);
	assert.deepEqual(JSON.parse(JSON.stringify(result)), indexResult);
	assert.deepEqual(JSON.parse(JSON.stringify(progress)), [{ phase: 'scanning' }, { phase: 'scanning' }, null]);
	client.stop();
});
