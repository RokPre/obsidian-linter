import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { instrumentWorkerSource } from './electron-worker-helpers.mjs';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const RESULT_PREFIX = 'VAULT_HELPER_BUNDLE_RESULT:';
const PYTHON = process.env.PYTHON || '/usr/bin/python3';

function findElectron() {
	const result = spawnSync('which', ['electron43'], { encoding: 'utf8' });
	return result.status === 0 ? result.stdout.trim() : null;
}

const electron = findElectron();
const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
const skipReason = electron === null
	? 'electron43 is not installed; skipping bundle settings test.'
	: display === undefined
		? 'no display is available (DISPLAY or WAYLAND_DISPLAY is unset); skipping bundle settings test.'
		: undefined;
const DATABASE_QUERY = "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps([r[0] for r in c.execute('SELECT path FROM vault_files ORDER BY path')]))";
const DATABASE_INTEGRITY_QUERY = "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute('PRAGMA integrity_check').fetchone()[0]))";

function rendererScript(bundlePath, vaultPath) {
	return `(async () => {
	const Module = require('node:module');
	const fs = require('node:fs');
	const path = require('node:path');
	const vaultPath = ${JSON.stringify(vaultPath)};
	const originalLoad = Module._load;
	const settings = [];
	const vaultFiles = Array.from({ length: 26 }, (_, index) => ({
		path: 'note-' + String(index).padStart(2, '0') + '.md',
	}));
	const registeredVaultEvents = [];
	const eventHandlers = {};
	const notices = [];
	const progressNotices = [];
	let settingTab;
	let layoutReadyCallback;
	let plugin;

	function decorateContainer(element) {
		element.empty = () => element.replaceChildren();
		element.createDiv = (options = {}) => {
			const child = document.createElement('div');
			if (options.cls) child.className = options.cls;
			element.appendChild(child);
			return decorateContainer(child);
		};
		return element;
	}

	class FileSystemAdapter {
		constructor(basePath) { this.basePath = basePath; }
		getBasePath() { return this.basePath; }
		getFullPath(relativePath) { return path.join(this.basePath, ...relativePath.split('/')); }
	}

	class Plugin {
		constructor(app, manifest) { this.app = app; this.manifest = manifest; }
		async loadData() { return undefined; }
		async saveData() {}
		registerEvent(event) { return event; }
		registerDomEvent() {}
		registerInterval(interval) { window.clearInterval(interval); }
		addRibbonIcon() {}
		addStatusBarItem() { return { setText() {} }; }
		addCommand() {}
		addSettingTab(tab) { settingTab = tab; }
	}

	class PluginSettingTab {
		constructor(app, plugin) {
			this.app = app;
			this.plugin = plugin;
			this.containerEl = decorateContainer(document.createElement('div'));
		}
	}

	class ButtonComponent {
		constructor(element) { this.el = element; }
		setButtonText(text) { this.el.textContent = text; return this; }
		setDisabled(disabled) { this.el.disabled = disabled; return this; }
		setCta() { this.el.classList.add('mod-cta'); return this; }
		removeCta() { this.el.classList.remove('mod-cta'); return this; }
		onClick(callback) { this.click = callback; this.el.addEventListener('click', callback); return this; }
	}

	class ExtraButtonComponent extends ButtonComponent {
		setIcon(icon) { this.el.textContent = icon === 'x' ? '×' : icon; return this; }
		setTooltip(tooltip) { this.el.title = tooltip; return this; }
	}

	class Setting {
		constructor(container) {
			this.name = '';
			this.settingEl = document.createElement('div');
			this.settingEl.className = 'setting-item';
			this.controlEl = document.createElement('div');
			this.controlEl.className = 'setting-item-control';
			this.settingEl.appendChild(this.controlEl);
			container.appendChild(this.settingEl);
			settings.push(this);
		}
		setName(name) {
			this.name = name;
			const label = document.createElement('div');
			label.className = 'setting-item-name';
			label.textContent = name;
			this.settingEl.insertBefore(label, this.controlEl);
			return this;
		}
		setDesc(description) {
			const desc = document.createElement('div');
			desc.className = 'setting-item-description';
			desc.textContent = description;
			this.settingEl.insertBefore(desc, this.controlEl);
			return this;
		}
		setClass(className) { this.settingEl.classList.add(className); return this; }
		addText(configure) {
			const inputEl = document.createElement('input');
			inputEl.type = 'text';
			this.controlEl.appendChild(inputEl);
			const component = {
				inputEl,
				setPlaceholder(value) { inputEl.placeholder = value; return this; },
				setValue(value) { inputEl.value = value; return this; },
				onChange(callback) {
					inputEl.addEventListener('input', () => callback(inputEl.value));
					return this;
				},
			};
			configure(component);
			return this;
		}
		addButton(configure) {
			this.button = new ButtonComponent(document.createElement('button'));
			this.controlEl.appendChild(this.button.el);
			configure(this.button);
			return this;
		}
		addExtraButton(configure) {
			const component = new ExtraButtonComponent(document.createElement('button'));
			this.controlEl.appendChild(component.el);
			configure(component);
			return this;
		}
	}

	class AbstractInputSuggest {
		constructor(app, inputEl) { this.app = app; this.inputEl = inputEl; }
		onSelect(callback) { this.callback = callback; return this; }
		setValue(value) { this.inputEl.value = value; }
		close() {}
		selectSuggestion() {}
	}

	class Notice {
		constructor(message) {
			if (typeof message === 'string') {
				notices.push(message);
			} else {
				this.noticeEl = document.createElement('div');
				this.noticeEl.className = 'notice';
				this.noticeEl.append(message);
				document.body.appendChild(this.noticeEl);
				progressNotices.push(this);
			}
		}
		hide() { this.noticeEl?.remove(); }
	}
	class Modal {}
	class MarkdownView {}
	class App {}
	const adapter = new FileSystemAdapter(${JSON.stringify(vaultPath)});
	const app = {
		vault: {
			adapter,
			configDir: '.obsidian',
			getAllLoadedFiles() { return vaultFiles; },
			getAbstractFileByPath(relativePath) {
				return vaultFiles.find((file) => file.path === relativePath) ?? null;
			},
			on(event, callback) { registeredVaultEvents.push(event); eventHandlers[event] = callback; return {}; },
		},
		workspace: {
			onLayoutReady(callback) { layoutReadyCallback = callback; },
			getActiveViewOfType() { return null; },
		},
	};
	const obsidian = { App, AbstractInputSuggest, ButtonComponent, ExtraButtonComponent, FileSystemAdapter, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting };
	Module._load = function(request, parent, isMain) {
		if (request === 'obsidian') return obsidian;
		return originalLoad.call(this, request, parent, isMain);
	};
	window.activeDocument = document;

	try {
		const PluginClass = require(${JSON.stringify(bundlePath)}).default;
		plugin = new PluginClass(app, { id: 'vault-helper', dir: '.obsidian/plugins/vault-helper' });
		await plugin.onload();
		settingTab.display();
		const originalIndexVault = plugin.indexerClient.indexVault.bind(plugin.indexerClient);
		const indexRequests = [];
		plugin.indexerClient.indexVault = (...args) => {
			const request = originalIndexVault(...args);
			indexRequests.push(request);
			return request;
		};
		const worker = plugin.indexerClient.worker;
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
		if (typeof layoutReadyCallback !== 'function') throw new Error('layout-ready callback was not registered');
		const paused = waitForSignal('paused');
		layoutReadyCallback();
		if (indexRequests.length !== 1) throw new Error('layout readiness did not trigger exactly one startup indexing request');
		let startupSettled = false;
		indexRequests[0].then(() => { startupSettled = true; }, () => { startupSettled = true; });
		let rejectPauseTimeout;
		const pauseTimeout = new Promise((_resolve, reject) => { rejectPauseTimeout = reject; });
		const pauseTimeoutId = setTimeout(() => rejectPauseTimeout(new Error('worker did not reach the 25-file pause')), 10_000);
		const pauseMessage = await Promise.race([
			paused,
			pauseTimeout,
			indexRequests[0].then(
				() => { throw new Error('startup indexing completed before reaching the controlled pause'); },
				(error) => { throw error; },
			),
		]).finally(() => clearTimeout(pauseTimeoutId));
		if (!(pauseMessage.gate instanceof SharedArrayBuffer)) throw new Error('pause signal did not include a SharedArrayBuffer');
		if (startupSettled) throw new Error('startup request settled before the mutation window');
		const startupProgressNotice = progressNotices.filter((notice) => notice.noticeEl.isConnected);
		if (startupProgressNotice.length !== 1) throw new Error('startup indexing did not show exactly one live progress notice');
		const startupProgress = startupProgressNotice[0].noticeEl;
		const progressElement = startupProgress.querySelector('progress[aria-label="Vault indexing progress"]');
		if (startupProgress.querySelectorAll('div')[1]?.textContent !== 'Indexing files: 25 / 26') {
			throw new Error('startup progress notice did not report 25 / 26 files');
		}
		if (!progressElement || progressElement.value !== 25 || progressElement.max !== 26) {
			throw new Error('startup progress element did not report 25 / 26');
		}
		if (startupSettled) throw new Error('progress message settled the pending startup request');
		const startupProgressSnapshot = {
			status: startupProgress.querySelectorAll('div')[1]?.textContent,
			value: progressElement.value,
			max: progressElement.max,
		};

		for (let index = 0; index < vaultFiles.length; index += 1) {
			fs.writeFileSync(path.join(vaultPath, vaultFiles[index].path), '# Changed during indexing ' + index + '\\n');
		}
		const modifyPromise = eventHandlers.modify();
		if (indexRequests.length !== 2) throw new Error('modify event did not trigger an indexing request');
		const concurrentProgressNotices = progressNotices.filter((notice) => notice.noticeEl.isConnected);
		if (concurrentProgressNotices.length !== 1 || concurrentProgressNotices[0] !== startupProgressNotice[0]) {
			throw new Error('concurrent indexing requests did not reuse the live progress notice');
		}
		const modifyPaused = waitForSignal('paused');
		const gate = new Int32Array(pauseMessage.gate);
		Atomics.store(gate, 0, 1);
		Atomics.notify(gate, 0);
		const startupResult = await indexRequests[0];
		const modifyPauseMessage = await modifyPaused;
		if (!(modifyPauseMessage.gate instanceof SharedArrayBuffer)) throw new Error('modify pause did not include a SharedArrayBuffer');
		const modifyGate = new Int32Array(modifyPauseMessage.gate);
		Atomics.store(modifyGate, 0, 1);
		Atomics.notify(modifyGate, 0);
		const modifyResult = await indexRequests[1];
		await modifyPromise;
		if (progressNotices.some((notice) => notice.noticeEl.isConnected)) {
			throw new Error('progress notice remained visible after all indexing requests settled');
		}
		if (startupSettled !== true) throw new Error('startup request did not settle after the worker resumed');

		const indexButton = settings.find((setting) => setting.name === 'Indexing')?.button;
		if (indexButton === undefined) throw new Error('Index vault button was not rendered');
		const clickPromise = indexButton.click();
		if (indexRequests.length !== 3) throw new Error('Index vault click did not trigger an indexing request');
		await clickPromise;
		const manualResult = await indexRequests[2];
		const manualButtonDisabled = indexButton.el.disabled;
		const deletedPath = 'event-created.md';
		fs.writeFileSync(path.join(vaultPath, deletedPath), '# Delete target\\n');
		const createEvent = eventHandlers.create();
		if (indexRequests.length !== 4) throw new Error('create event did not trigger an indexing request');
		await createEvent;
		const createResult = await indexRequests[3];
		for (let index = 0; index < vaultFiles.length; index += 1) {
			fs.writeFileSync(path.join(vaultPath, vaultFiles[index].path), '# Changed before deletion ' + index + '\\n');
		}
		const deleteRunPaused = waitForSignal('paused');
		const deleteRunPromise = eventHandlers.modify();
		if (indexRequests.length !== 5) throw new Error('modify event before deletion did not trigger an indexing request');
		const deletePauseMessage = await deleteRunPaused;
		fs.unlinkSync(path.join(vaultPath, deletedPath));
		const deleteEvent = eventHandlers.delete();
		if (indexRequests.length !== 6) throw new Error('delete event did not trigger an indexing request');
		const deleteGate = new Int32Array(deletePauseMessage.gate);
		Atomics.store(deleteGate, 0, 1);
		Atomics.notify(deleteGate, 0);
		const deleteRunResult = await indexRequests[4];
		await deleteRunPromise;
		const deleteResult = await indexRequests[5];
		await deleteEvent;

		const renameSource = 'rename-target.md';
		fs.writeFileSync(path.join(vaultPath, renameSource), '# Rename target\\n');
		const renameCreateEvent = eventHandlers.create();
		if (indexRequests.length !== 7) throw new Error('create event before rename did not trigger an indexing request');
		await renameCreateEvent;
		const renameCreateResult = await indexRequests[6];
		for (let index = 0; index < vaultFiles.length; index += 1) {
			fs.writeFileSync(path.join(vaultPath, vaultFiles[index].path), '# Changed before rename ' + index + '\\n');
		}
		const renameRunPaused = waitForSignal('paused');
		const renameRunPromise = eventHandlers.modify();
		if (indexRequests.length !== 8) throw new Error('modify event before rename did not trigger an indexing request');
		const renamePauseMessage = await renameRunPaused;
		const renamedPath = 'renamed-' + renameSource;
		fs.renameSync(path.join(vaultPath, renameSource), path.join(vaultPath, renamedPath));
		const renameEvent = eventHandlers.rename();
		if (indexRequests.length !== 9) throw new Error('rename event did not trigger an indexing request');
		const renameGate = new Int32Array(renamePauseMessage.gate);
		Atomics.store(renameGate, 0, 1);
		Atomics.notify(renameGate, 0);
		const renameRunResult = await indexRequests[7];
		await renameRunPromise;
		const renameResult = await indexRequests[8];
		await renameEvent;
		const ignoreInput = settingTab.containerEl.querySelector('.vault-helper-ignore-list input[type="text"]');
		ignoreInput.value = 'note-02.md';
		ignoreInput.dispatchEvent(new Event('input'));
		const ignoreActions = settings.find((setting) => setting.settingEl.classList.contains('vault-helper-ignore-actions'));
		const savePromise = ignoreActions.button.click();
		await savePromise;
		if (indexRequests.length !== 10) throw new Error('Save did not trigger an indexing request');
		const saveResult = await indexRequests[9];

		const root = settingTab.containerEl;
		const buttons = [...root.querySelectorAll('button')].map((button) => button.textContent);
		return {
			layoutReadyRegistered: typeof layoutReadyCallback === 'function',
			blacklistRendered: root.querySelector('.vault-helper-ignore-list') !== null,
			pickerCount: root.querySelectorAll('input[type="text"]').length,
			buttons,
			removeTooltip: root.querySelector('button[title="Remove from blacklist"]')?.title,
			settingNames: settings.map((setting) => setting.name),
			startupRequestCount: 1,
			createRequestCount: 2,
			createResult,
			renameCreateResult,
			renameRunResult,
			deleteRequestCount: 1,
			deleteResult,
			deleteRunResult,
			deletedPath,
			renameRequestCount: 1,
			saveRequestCount: 1,
			savedIgnoredPaths: plugin.settings.ignoredPaths,
			saveResult,
			renameResult,
			renamedPath,
			modifyRequestCount: 1,
			manualRequestCount: 1,
			startupResult,
			modifyResult,
			mutationOccurredDuringRun: true,
			startupProgress: startupProgressSnapshot,
			progressNoticeCleared: progressNotices.every((notice) => !notice.noticeEl.isConnected),
			manualResult,
			manualButtonDisabled,
			notices,
			registeredVaultEvents,
		};
	} finally {
		plugin?.onunload();
		Module._load = originalLoad;
	}
})()`;
}

test('production bundle handles a modify event during startup indexing in Electron', { skip: skipReason }, async () => {
	let workRoot;
	try {
		workRoot = await mkdtemp(join(tmpdir(), 'vault-helper-bundle-'));
		const buildResult = spawnSync(process.execPath, ['esbuild.config.mjs', 'production'], {
			cwd: pluginDir,
			encoding: 'utf8',
			timeout: 120_000,
		});
		if (buildResult.status !== 0) {
			throw new Error(`production build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);
		}

		const vaultPath = join(workRoot, 'vault');
		const pluginPath = join(vaultPath, '.obsidian', 'plugins', 'vault-helper');
		const appDir = join(workRoot, 'electron-app');
		const bundlePath = join(appDir, 'plugin-main.cjs');
		const rendererPath = join(appDir, 'renderer.html');
		const mainPath = join(appDir, 'main.cjs');
		const configPath = join(appDir, 'config.json');
		await mkdir(pluginPath, { recursive: true });
		await mkdir(appDir, { recursive: true });
		for (let index = 0; index < 26; index += 1) {
			await writeFile(join(vaultPath, 'note-' + String(index).padStart(2, '0') + '.md'), '# Bundle fixture ' + index);
		}
		await copyFile(join(pluginDir, 'main.js'), bundlePath);
		const generatedWorker = await readFile(join(pluginDir, 'indexer-worker.cjs'), 'utf8');
		const instrumentedWorker = join(workRoot, 'indexer-worker.instrumented.cjs');
		await writeFile(instrumentedWorker, instrumentWorkerSource(generatedWorker));
		await writeFile(
			join(pluginPath, 'indexer-worker.cjs'),
			`require(${JSON.stringify(instrumentedWorker)});`,
		);
		await writeFile(rendererPath, '<!doctype html><html><body></body></html>');
		await writeFile(join(appDir, 'package.json'), JSON.stringify({ main: 'main.cjs' }));
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
			script: rendererScript(bundlePath, vaultPath),
		}));

		const result = spawnSync(electron, ['--disable-gpu', appDir], {
			env: { ...process.env, VAULT_HELPER_CONFIG: configPath },
			encoding: 'utf8',
			timeout: 30_000,
		});
		if (result.error) throw new Error(`${result.error.message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
		assert.equal(result.status, 0, `Electron exited unsuccessfully.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
		const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith(RESULT_PREFIX));
		assert.equal(lines.length, 1, `expected one Electron result, got ${lines.length}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
		const payload = JSON.parse(lines[0].slice(RESULT_PREFIX.length));
		assert.equal(payload.ok, true, payload.error || 'renderer test failed');
		assert.equal(payload.value.layoutReadyRegistered, true);
		assert.equal(payload.value.blacklistRendered, true);
		assert.equal(payload.value.pickerCount, 1);
		assert.ok(payload.value.buttons.includes('Add'));
		assert.ok(payload.value.buttons.includes('Clear'));
		assert.ok(payload.value.buttons.includes('Save'));
		assert.ok(payload.value.buttons.includes('Index vault'));
		assert.equal(payload.value.removeTooltip, 'Remove from blacklist');
		assert.ok(payload.value.settingNames.includes('Blacklist for files and folders'));
		assert.equal(payload.value.startupRequestCount, 1);
		assert.equal(payload.value.deleteRequestCount, 1);
		assert.equal(payload.value.createRequestCount, 2);
		assert.deepEqual(payload.value.createResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 1,
			indexedFiles: 1,
			deletedFiles: 0,
		});
		assert.deepEqual(payload.value.deleteRunResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 26,
			deletedFiles: 0,
		});
		assert.deepEqual(payload.value.deleteResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 0,
			deletedFiles: 1,
		});
		assert.equal(payload.value.renameRequestCount, 1);
		assert.equal(payload.value.saveRequestCount, 1);
		assert.deepEqual(payload.value.savedIgnoredPaths, ['note-02.md']);
		assert.deepEqual(payload.value.saveResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 0,
			deletedFiles: 1,
		});
		assert.deepEqual(payload.value.renameCreateResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 1,
			indexedFiles: 1,
			deletedFiles: 0,
		});
		assert.deepEqual(payload.value.renameRunResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 26,
			deletedFiles: 0,
		});
		assert.deepEqual(payload.value.renameResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 1,
			indexedFiles: 1,
			deletedFiles: 1,
		});
		assert.equal(payload.value.modifyRequestCount, 1);
		assert.equal(payload.value.mutationOccurredDuringRun, true);
		assert.deepEqual(payload.value.startupResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 26,
			indexedFiles: 26,
			deletedFiles: 0,
		});
		assert.deepEqual(payload.value.modifyResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 25,
			deletedFiles: 0,
		});
		assert.equal(payload.value.manualRequestCount, 1);
		assert.deepEqual(payload.value.manualResult, {
			databasePath: join(vaultPath, '.obsidian', 'vaultHelper.db'),
			addedFiles: 0,
			indexedFiles: 0,
			deletedFiles: 0,
		});
		assert.equal(payload.value.manualButtonDisabled, false);
		assert.deepEqual(payload.value.startupProgress, {
			status: 'Indexing files: 25 / 26',
			value: 25,
			max: 26,
		});
		assert.equal(payload.value.progressNoticeCleared, true);
		assert.deepEqual(payload.value.notices, [
			'Index updated: 0 added, 0 updated, 0 removed.',
			'Index updated: 0 added, 0 updated, 1 removed.',
		]);
		const databasePath = payload.value.startupResult.databasePath;
		const indexedPaths = JSON.parse(execFileSync(PYTHON, ['-c', DATABASE_QUERY, databasePath], { encoding: 'utf8' }));
		assert.equal(indexedPaths.length, 26);
		assert.ok(indexedPaths.every((path) => path.endsWith('.md')));
		assert.ok(indexedPaths.every((path) => !path.endsWith('/' + payload.value.deletedPath)));
		assert.ok(indexedPaths.every((path) => !path.endsWith('/note-02.md')));
		assert.ok(indexedPaths.some((path) => path.endsWith('/' + payload.value.renamedPath)));
		assert.equal(JSON.parse(execFileSync(PYTHON, ['-c', DATABASE_INTEGRITY_QUERY, databasePath], { encoding: 'utf8' })), 'ok');
	} finally {
		if (workRoot) await rm(workRoot, { recursive: true, force: true });
	}
});
