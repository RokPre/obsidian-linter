import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { instrumentWorkerSource } from './electron-worker-helpers.mjs';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const PYTHON = process.env.PYTHON || '/usr/bin/python3';
const RESULT_PREFIX = 'VAULT_HELPER_ELECTRON_RESULT:';

function findElectron() {
	const result = spawnSync('which', ['electron43'], { encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : null;
}

const electron = findElectron();
const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
const skipReason = electron === null
	? 'electron43 is not installed; skipping Electron worker integration test.'
	: display === undefined
		? 'no display is available (DISPLAY or WAYLAND_DISPLAY is unset); skipping Electron worker integration test.'
		: undefined;

async function waitForExit(child) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};
		child.once('close', (code, signal) => finish({ code, signal }));
		child.once('error', (error) => finish({ error }));
	});
}

async function runElectron(appDir, configPath) {
	const child = spawn(electron, [
		'--disable-gpu',
		appDir,
	], { env: { ...process.env, VAULT_HELPER_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk) => { stdout += chunk; });
	child.stderr.on('data', (chunk) => { stderr += chunk; });

	const exitPromise = waitForExit(child);
	let timeout;
	const timeoutPromise = new Promise((resolveTimeout) => {
		timeout = setTimeout(() => resolveTimeout({ timedOut: true }), 30_000);
	});
	const outcome = await Promise.race([exitPromise, timeoutPromise]);
	clearTimeout(timeout);
	if (outcome.timedOut) {
		child.kill('SIGKILL');
		await exitPromise;
		throw new Error(`Electron timed out and was killed. stdout:\n${stdout}\nstderr:\n${stderr}`);
	}
	return { ...outcome, stdout, stderr };
}

function rendererScript(clientPath, workerPath, missingWorkerPath, vaultPath, configDir) {
	return `(async () => {
	const { IndexerClient } = require(${JSON.stringify(clientPath)});
	const progress = [];
	const failingProgress = [];
	let client;
	let failingClient;
	let workerLoadError;
	let settled = false;
	try {
		const host = { getFiles: () => [], getFirstLinkpathDest: () => null };
		client = new IndexerClient(${JSON.stringify(workerPath)}, host, (update) => progress.push(update));
		const worker = client.worker;
		const waitForSignal = (type) => new Promise((resolve, reject) => {
			const onMessage = (event) => {
				if (event.data?.type !== type) return;
				worker.removeEventListener('message', onMessage);
				worker.removeEventListener('error', onError);
				resolve(event.data);
			};
			const onError = (event) => {
				worker.removeEventListener('message', onMessage);
				worker.removeEventListener('error', onError);
				reject(new Error(event.message || 'worker error'));
			};
			worker.addEventListener('message', onMessage);
			worker.addEventListener('error', onError);
		});

		const armed = waitForSignal('armed');
		await armed;
		const paused = waitForSignal('paused');
		const resultPromise = client.indexVault(${JSON.stringify(vaultPath)}, ['excluded.md'], ${JSON.stringify(configDir)});
		resultPromise.then(() => { settled = true; }, () => { settled = true; });
		resultPromise.catch(() => {});
		const pauseMessage = await Promise.race([
			paused,
			resultPromise.then(
				() => { throw new Error('indexing completed before the worker pause'); },
				(error) => { throw error; },
			),
		]);
		if (!(pauseMessage.gate instanceof SharedArrayBuffer)) throw new Error('paused signal did not include a SharedArrayBuffer gate');
		if (settled) throw new Error('indexing Promise settled before the worker pause');
		let timerRan = false;
		await new Promise((resolve) => setTimeout(() => { timerRan = true; resolve(); }, 0));
		if (!timerRan || settled) throw new Error('renderer did not remain responsive while indexing was paused');
		const gate = new Int32Array(pauseMessage.gate);
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		const result = await resultPromise;
		const secondResult = await client.indexVault(${JSON.stringify(vaultPath)}, ['excluded.md'], ${JSON.stringify(configDir)});
		if (secondResult.addedFiles !== 0 || secondResult.indexedFiles !== 0 || secondResult.deletedFiles !== 0) {
			throw new Error('second request through the same client reported file changes');
		}

		client.stop();
		let stoppedRequestError;
		try {
			await client.indexVault(${JSON.stringify(vaultPath)}, ['excluded.md'], ${JSON.stringify(configDir)});
		} catch (error) {
			stoppedRequestError = error.message;
		}
		if (stoppedRequestError !== 'Indexer worker stopped.') throw new Error('request after stop did not reject');

		failingClient = new IndexerClient(${JSON.stringify(missingWorkerPath)}, host, (update) => failingProgress.push(update));
		try {
			await failingClient.indexVault(${JSON.stringify(vaultPath)}, [], ${JSON.stringify(configDir)});
		} catch (error) {
			workerLoadError = error.message;
		}
		if (!workerLoadError) throw new Error('worker-load failure did not reject the pending request');
		if (failingProgress.at(-1) !== null) throw new Error('worker-load failure did not clear progress');

		return { result, secondResult, timerRan, workerArmed: true, stoppedRequestError, workerLoadError, progress, failingProgress };
	} finally {
		client?.stop();
		failingClient?.stop();
	}
})()`;
}

test('generated renderer script handles worker signals and load failure without leaking globals', async () => {
	const clients = [];
	let workerListenerFailure;
	let rejectWorkerListenerFailure;
	const workerListenerFailurePromise = new Promise((resolve, reject) => {
		rejectWorkerListenerFailure = reject;
	});
	workerListenerFailurePromise.catch(() => {});

	class FakeIndexerClient {
		constructor(workerPath, _host, onProgress) {
			this.worker = {
				listeners: new Map(),
				addEventListener: (type, listener) => {
					const listeners = this.worker.listeners.get(type) ?? new Set();
					listeners.add(listener);
					this.worker.listeners.set(type, listeners);
				},
				removeEventListener: (type, listener) => this.worker.listeners.get(type)?.delete(listener),
				emit: (type, data) => {
					for (const listener of this.worker.listeners.get(type) ?? []) {
						try {
							listener(type === 'message' ? { data } : { message: data });
						} catch (error) {
							workerListenerFailure = error;
							rejectWorkerListenerFailure(error);
						}
					}
				},
			};
			this.onProgress = onProgress;
			this.failing = workerPath === '/missing-worker.js';
			this.requestCount = 0;
			this.stopped = false;
			clients.push(this);
			if (!this.failing) setTimeout(() => this.worker.emit('message', { type: 'armed' }), 0);
		}
		indexVault() {

			if (this.stopped) return Promise.reject(new Error('Indexer worker stopped.'));
			if (this.failing) {
				this.onProgress(null);
				return Promise.reject(new Error('simulated worker-load rejection'));
			}

			if (this.requestCount++ > 0) {
				return Promise.resolve({ addedFiles: 0, indexedFiles: 0, deletedFiles: 0 });
			}
			const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
			setTimeout(() => this.worker.emit('message', { type: 'paused', gate }), 0);
			return new Promise((resolve) => {
				const pollGate = () => {
					if (Atomics.load(new Int32Array(gate), 0) === 1) {
						resolve({ addedFiles: 1, indexedFiles: 1, deletedFiles: 0 });
					} else {
						setTimeout(pollGate, 0);
					}
				};
				pollGate();
			});
		}

		stop() {
			this.stopped = true;
		}
	}

	const context = { require: () => ({ IndexerClient: FakeIndexerClient }), setTimeout, SharedArrayBuffer, Atomics };
	const script = rendererScript('/client.js', '/worker.js', '/missing-worker.js', '/vault', '/config');
	const rendererPromise = runInNewContext(script, context);
	const outcome = await Promise.race([rendererPromise, workerListenerFailurePromise]);
	assert.equal(workerListenerFailure, undefined);
	assert.deepEqual(outcome.result, { addedFiles: 1, indexedFiles: 1, deletedFiles: 0 });
	assert.deepEqual(outcome.secondResult, { addedFiles: 0, indexedFiles: 0, deletedFiles: 0 });
	assert.equal(outcome.timerRan, true);
	assert.equal(outcome.stoppedRequestError, 'Indexer worker stopped.');
	assert.equal(outcome.workerLoadError, 'simulated worker-load rejection');
	assert.equal(outcome.failingProgress.at(-1), null);
	assert.equal(Object.hasOwn(context, 'workerLoadError'), false);
	assert.equal(clients.length, 2);
});

const DATABASE_QUERY = String.raw`
import json, sqlite3, sys
with sqlite3.connect(sys.argv[1]) as connection:
    paths = [row[0] for row in connection.execute("SELECT path FROM vault_files ORDER BY path")]
print(json.dumps(paths))
`;

test('real IndexerClient worker indexes included notes without blocking the renderer', { skip: skipReason }, async () => {
	let workRoot;
	try {
		workRoot = await mkdtemp(join(tmpdir(), 'vault-helper-electron-worker-'));
		const buildResult = spawnSync(process.execPath, ['esbuild.config.mjs', 'production'], {
			cwd: PLUGIN_DIR,
			encoding: 'utf8',
			timeout: 120_000,
		});
		if (buildResult.status !== 0) {
			throw new Error(`production worker build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);
		}

		const vaultPath = join(workRoot, 'vault');
		const configDir = 'custom-settings';
		const appDir = join(workRoot, 'electron-app');
		await mkdir(join(vaultPath, configDir), { recursive: true });
		await writeFile(join(vaultPath, configDir, 'config-note.md'), '# Config note\n');
		await mkdir(appDir, { recursive: true });
		for (let index = 0; index < 26; index += 1) {
			await writeFile(join(vaultPath, `note-${String(index).padStart(2, '0')}.md`), `# Note ${index}\n`);
		}
		await writeFile(join(vaultPath, 'excluded.md'), '# Excluded\n');

		const generatedWorker = await readFile(join(PLUGIN_DIR, 'indexer-worker.cjs'), 'utf8');
		const instrumentedWorker = join(workRoot, 'indexer-worker.instrumented.cjs');
		const workerEntry = join(workRoot, 'indexer-worker.entry.cjs');
		const missingWorkerPath = join(workRoot, 'missing-worker.cjs');
		await writeFile(instrumentedWorker, instrumentWorkerSource(generatedWorker));
		await writeFile(workerEntry, `require(${JSON.stringify(instrumentedWorker)}); self.postMessage({ type: 'armed' });\n`);

		const clientBundle = join(workRoot, 'indexer-client.cjs');
		await build({
			entryPoints: [join(PLUGIN_DIR, 'src', 'indexer-client.ts')],
			bundle: true,
			platform: 'node',
			format: 'cjs',
			target: 'es2021',
			outfile: clientBundle,
			logLevel: 'silent',
		});

		const rendererPath = join(appDir, 'renderer.html');
		const mainPath = join(appDir, 'main.cjs');
		const packagePath = join(appDir, 'package.json');
		const configPath = join(appDir, 'config.json');
		await writeFile(rendererPath, '<!doctype html><html><body></body></html>');
		await writeFile(packagePath, JSON.stringify({ main: 'main.cjs' }));
		await writeFile(mainPath, `const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.env.VAULT_HELPER_CONFIG, 'utf8'));
const prefix = ${JSON.stringify(RESULT_PREFIX)};
let reported = false;
function report(ok, value) {
	if (reported) return;
	reported = true;
	process.stdout.write(prefix + JSON.stringify(ok ? { ok: true, value } : { ok: false, error: String(value?.stack || value) }) + '\\n');
	if (ok) app.quit(); else setImmediate(() => app.exit(1));
}
app.whenReady().then(async () => {
	const window = new BrowserWindow({
		show: false,
		webPreferences: { contextIsolation: false, nodeIntegration: true, nodeIntegrationInWorker: true, sandbox: false },
	});
	window.webContents.on('render-process-gone', (_event, details) => report(false, new Error('renderer process gone: ' + JSON.stringify(details))));
	window.webContents.on('did-fail-load', (_event, code, description) => report(false, new Error('renderer failed to load: ' + code + ' ' + description)));
	try {
		await window.loadFile(config.rendererPath);
		const value = await window.webContents.executeJavaScript(config.script, true);
		report(true, value);
	} catch (error) {
		report(false, error);
	}
}).catch((error) => report(false, error));
`);
		await writeFile(configPath, JSON.stringify({
			rendererPath,
			script: rendererScript(clientBundle, workerEntry, missingWorkerPath, vaultPath, configDir),
		}));

		const outcome = await runElectron(appDir, configPath);
		assert.equal(outcome.code, 0, `Electron exited unsuccessfully. stderr:\n${outcome.stderr}`);
		const lines = outcome.stdout.split(/\r?\n/).filter((line) => line.startsWith(RESULT_PREFIX));
		assert.equal(lines.length, 1, `expected one Electron result, got ${lines.length}; stdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`);
		const payload = JSON.parse(lines[0].slice(RESULT_PREFIX.length));
		assert.equal(payload.ok, true, payload.error || 'renderer test failed');
		assert.equal(payload.value.workerArmed, true);
		assert.equal(payload.value.timerRan, true);
		assert.deepEqual(payload.value.secondResult, {
			databasePath: join(vaultPath, configDir, 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 0,
			deletedFiles: 0,
		});
		assert.equal(payload.value.stoppedRequestError, 'Indexer worker stopped.');
		assert.ok(payload.value.workerLoadError);
		assert.ok(payload.value.progress.some((update) => update?.phase === 'scanning'));
		assert.ok(payload.value.progress.some((update) => update?.phase === 'indexing'
			&& update.completed === 26 && update.total === 26), 'progress did not report the final 26 / 26 files');
		assert.ok(payload.value.progress.some((update) => update?.phase === 'finishing'));
		assert.equal(payload.value.progress.at(-1), null, 'successful indexing did not clear progress');
		assert.equal(payload.value.failingProgress.at(-1), null, 'worker-load failure did not clear progress');
		assert.deepEqual(payload.value.result, {
			databasePath: join(vaultPath, configDir, 'vaultHelper.db'),
			addedFiles: 26,
			indexedFiles: 26,
			deletedFiles: 0,
		});

		const paths = JSON.parse(execFileSync(PYTHON, ['-c', DATABASE_QUERY, payload.value.result.databasePath], { encoding: 'utf8' }));
		assert.equal(paths.length, 26);
		assert.ok(paths.every((path) => path.endsWith('.md')));
		assert.ok(paths.some((path) => path.endsWith('note-00.md')));
		assert.ok(!paths.some((path) => path.endsWith('excluded.md')));
		assert.ok(!paths.some((path) => path.endsWith('config-note.md')));
	} finally {
		if (workRoot) await rm(workRoot, { recursive: true, force: true });
	}
});
