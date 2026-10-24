import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import { build } from 'esbuild';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const TEMP_ROOT = tmpdir();
let bundlePath;
let clientModule;
let workRoot;
let savedGlobals;

before(async () => {
  workRoot = await mkdtemp(join(TEMP_ROOT, 'indexer-client-tests-'));
  bundlePath = join(workRoot, 'client.mjs');
  await build({ entryPoints: [join(PLUGIN_DIR, 'src', 'indexer-client.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundlePath, logLevel: 'silent' });
  clientModule = await import(pathToFileURL(bundlePath).href);
  savedGlobals = { Worker: globalThis.Worker, Blob: globalThis.Blob, URL: globalThis.URL };
});

after(async () => {
  if (savedGlobals) Object.assign(globalThis, savedGlobals);
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

function fakeWorker() {
  const worker = { listeners: new Map(), sent: [], addEventListener(type, callback) { this.listeners.set(type, callback); }, postMessage(message) { this.sent.push(message); }, emit(data) { this.listeners.get('message')({ data }); }, terminate() {} };
  globalThis.Worker = class { constructor() { return worker; } };
  globalThis.Blob = class { constructor() {} };
  globalThis.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  return worker;
}

test('IndexerClient correlates typed run-checks request and resolves structured results', async () => {
  const worker = fakeWorker();
  const client = new clientModule.IndexerClient('worker.cjs', { getFiles: () => [], getFirstLinkpathDest: () => null });
  const config = { version: 1, rules: [] };
  const resultPromise = client.runChecks('/vault', '.obsidian', config);
  const request = worker.sent[0];
  assert.deepEqual(request, { id: 1, type: 'run-checks', vaultPath: '/vault', configDir: '.obsidian', config });
  const result = { diagnostics: [{ ruleId: 'r', check: 'filenameCase', severity: 'warning', path: 'bad_name.md', message: 'bad' }], failures: [] };
  worker.emit({ id: request.id, type: 'run-checks-result', result });
  assert.deepEqual(await resultPromise, result);
  client.stop();
});

test('IndexerClient rejects whole-run errors and returns per-rule failures separately', async () => {
  const worker = fakeWorker();
  const client = new clientModule.IndexerClient('worker.cjs', { getFiles: () => [], getFirstLinkpathDest: () => null });
  const config = { version: 1, rules: [] };
  const absent = client.runChecks('/missing', '.obsidian', config);
  worker.emit({ id: 1, error: 'Index vault first: index is not ready.' });
  await assert.rejects(absent, /Index vault/);
  const partial = client.runChecks('/vault', '.obsidian', config);
  const reply = { diagnostics: [], failures: [{ ruleId: 'bad', check: 'filenameCase', message: 'failure' }] };
  worker.emit({ id: 2, type: 'run-checks-result', result: reply });
  assert.deepEqual(await partial, reply);
  client.stop();
});
