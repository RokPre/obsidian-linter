import assert from 'node:assert/strict';
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
});

after(async () => {
	if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

const compiledYield = '(_+1)%25===0&&await new Promise(G=>setTimeout(G,0))';

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
