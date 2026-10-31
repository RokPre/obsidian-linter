import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const counters = { reads: 0, parses: 0, matches: 0, projections: 0, indexes: 0 };
const notices = [];
const errors = [];
const settings = [];
const workers = [];

class TFile {
	constructor(path) { this.path = path; }
}
class FileSystemAdapter {
	getBasePath() { return '/vault'; }
	getFullPath(path) { return `/vault/${path}`; }
}
class AbstractInputSuggest {
	constructor(_app, inputEl) { this.inputEl = inputEl; }
	onSelect(callback) { this.selectCallback = callback; return this; }
	setValue(value) { this.inputEl.value = value; }
	close() {}
}
class Container {
	constructor() { this.children = []; }
	empty() { this.children.length = 0; }
	createDiv() { const child = new Container(); this.children.push(child); return child; }
}
class PluginSettingTab {
	constructor(app) {
		this.app = app;
		this.containerEl = new Container();
	}
}
class Setting {
	constructor(parent) { this.parent = parent; settings.push(this); }
	setName(name) { this.name = name; return this; }
	setDesc() { return this; }
	setClass() { return this; }
	addText(configure) {
		const text = {
			inputEl: { value: '' },
			setPlaceholder() { return this; },
			setValue(value) { this.inputEl.value = value; return this; },
			onChange(callback) { this.change = callback; return this; },
		};
		this.text = text;
		configure(text);
		return this;
	}
	addExtraButton(configure) {
		const button = { setIcon() { return this; }, setTooltip() { return this; }, setDisabled() { return this; }, onClick(callback) { this.click = callback; return this; } };
		configure(button);
		return this;
	}
	addButton(configure) {
		const button = {
			label: '', disabled: false,
			setButtonText(label) { this.label = label; return this; },
			setDisabled(disabled) { this.disabled = disabled; return this; },
			setCta() { return this; }, removeCta() { return this; },
			buttonEl: { classList: { add() {} } },
			onClick(callback) { this.click = callback; return this; },
		};
		this.buttons ??= [];
		this.buttons.push(button);
		this.button ??= button;
		configure(button);
		return this;
	}
}
class Notice {
	constructor(message) { notices.push(message); }
	hide() {}
}
class Plugin {
	constructor(app, manifest) { this.app = app; this.manifest = manifest; }
	async loadData() { return { rulesFilePath: 'rules.json', ignoredPaths: [] }; }
	async saveData() {}
	addRibbonIcon() {}
	addStatusBarItem() { return { setText() {} }; }
	addCommand() {}
	addSettingTab(tab) { this.settingTab = tab; }
	registerDomEvent() {}
	registerEvent() {}
}
class Modal {}
class Worker {
	constructor() { this.listeners = new Map(); this.messages = []; workers.push(this); }
	addEventListener(type, listener) { this.listeners.set(type, listener); }
	postMessage(message) {
		this.messages.push(message);
		if (message.type === 'get-indexed-files') counters.projections++;
		else counters.indexes++;
		const reply = message.type === 'get-indexed-files'
			? { id: message.id, type: 'indexed-files-result', files: [{ path: 'note.md', kind: 'markdown' }] }
			: { id: message.id, result: { addedFiles: 0, indexedFiles: 0, deletedFiles: 0 } };
		queueMicrotask(() => this.listeners.get('message')?.({ data: reply }));
	}
	terminate() {}
}

const rulesWrapper = `
 import { parseRulesConfig as parse, matchRulesToFiles as match } from 'real-rules-config';
 export function parseRulesConfig(source) { globalThis.__lifecycleCounters.parses++; return parse(source); }
 export function matchRulesToFiles(config, files) { globalThis.__lifecycleCounters.matches++; return match(config, files); }
`;
const compiled = await build({
	entryPoints: [`${pluginDir}/src/main.ts`],
	bundle: true,
	write: false,
	platform: 'node',
	format: 'cjs',
	external: ['obsidian'],
	plugins: [{
		name: 'non-electron-lifecycle-test',
		setup(buildApi) {
			buildApi.onResolve({ filter: /^\.\/rules-config$/ }, (args) => ({ path: args.path, namespace: 'rules-wrapper' }));
			buildApi.onLoad({ filter: /.*/, namespace: 'rules-wrapper' }, () => ({ contents: rulesWrapper, loader: 'js' }));
			buildApi.onResolve({ filter: /^real-rules-config$/ }, () => ({ path: `${pluginDir}/src/rules-config.ts` }));
		},
	}],
});

const module = { exports: {} };
const app = {
	vault: {
		adapter: new FileSystemAdapter(),
		configDir: '.obsidian',
		getFiles: () => [{ path: 'note.md' }],
		getAbstractFileByPath(path) { return path === 'rules.json' ? new TFile(path) : null; },
		async read(file) {
			counters.reads++;
			assert.equal(file.path, 'rules.json');
			return JSON.stringify({ version: 1, rules: [{
				id: 'required-aliases', check: 'requiredFrontmatterProperty', enabled: true,
				severity: 'warning', scope: { fileKinds: ['markdown'], include: ['**/*.md'] },
				options: { properties: ['aliases'], caseSensitive: true },
			}] });
		},
		on(event, callback) { eventCallbacks.set(event, callback); return { event, callback }; },
	},
	metadataCache: { getFirstLinkpathDest: () => null },
	workspace: { onLayoutReady(callback) { layoutReady = callback; } },
};
const eventCallbacks = new Map();
let layoutReady;
const context = {
	module, exports: module.exports, process, performance, TextDecoder, Buffer, setTimeout, clearTimeout,
	URL, Blob, Worker, __lifecycleCounters: counters, activeDocument: {},
	createFragment() { return { append() {} }; },
	createDiv() { return { textContent: '' }; },
	createEl() { return { setAttribute() {}, removeAttribute() {}, max: 0, value: 0 }; },
	console: { ...console, error(...args) { errors.push(args.map(String)); } },
	require(name) { if (name === 'obsidian') return obsidian; throw new Error(`Unexpected require: ${name}`); },
};
const obsidian = { FileSystemAdapter, AbstractInputSuggest, PluginSettingTab, Setting, Notice, Plugin, Modal, TFile };
vm.runInNewContext(compiled.outputFiles[0].text, context, { filename: 'main-lifecycle.bundle.cjs' });
const ObsidianLinterPlugin = module.exports.default;

function assertNoRulesFlow(stage) {
	assert.deepEqual(counters, { reads: 0, parses: 0, matches: 0, projections: 0, indexes: counters.indexes }, `${stage}: rules processing must not run`);
}

await test('real plugin lifecycle is manual-only outside explicit Read/validate', async () => {
	const plugin = new ObsidianLinterPlugin(app, { id: 'test-plugin', dir: '.obsidian/plugins/test-plugin' });
	await plugin.onload();
	let indexerClientCalls = 0;
	const indexVault = plugin.indexerClient.indexVault.bind(plugin.indexerClient);
	plugin.indexerClient.indexVault = (...args) => {
		indexerClientCalls++;
		return indexVault(...args);
	};
	assert.equal(workers.length, 1, 'desktop plugin startup creates the indexer worker');
	assert.equal(typeof layoutReady, 'function', 'plugin startup registers layout-ready work');
	assert.equal(counters.indexes, 0, 'startup defers the existing index until layout readiness');
	assertNoRulesFlow('plugin startup');

	plugin.settingTab.display();
	assertNoRulesFlow('settings display');
	const rulesSetting = settings.find((setting) => setting.name === 'Rules JSON file');
	assert.deepEqual(rulesSetting.buttons.map((button) => button.label), ['Read/validate', 'Run checks']);
	assert.equal(rulesSetting.button, rulesSetting.buttons[0], 'the first button remains Read/validate');

	layoutReady();
	assert.equal(eventCallbacks.size, 4, 'layout-ready registers all four existing vault indexing events');
	assert.equal(counters.indexes, 1, 'layout-ready starts the initial indexing request');
	assertNoRulesFlow('layout-ready');

	for (const eventName of ['create', 'modify', 'delete', 'rename']) {
		await eventCallbacks.get(eventName)(new TFile('rules.json'));
		assert.equal(counters.indexes, 2 + ['create', 'modify', 'delete', 'rename'].indexOf(eventName), `${eventName} preserves existing indexing`);
		assertNoRulesFlow(`${eventName} rules-file event`);
	}
	assert.deepEqual(errors, [], 'the existing index lifecycle must succeed in the harness');

	const beforeClickIndexCalls = indexerClientCalls;
	const beforeClickIndexes = counters.indexes;
	const beforeClickWorkerMessages = workers[0].messages.length;
	await rulesSetting.buttons.find((button) => button.label === 'Read/validate').click();
	assert.deepEqual(workers[0].messages.slice(beforeClickWorkerMessages).map((message) => message.type), ['get-indexed-files'], 'validation does not request run-checks');
	assert.equal(counters.reads, 1, 'explicit click reads the configured vault file');
	assert.equal(counters.parses, 1, 'explicit click invokes the actual JRC-01 parser wrapper');
	assert.equal(counters.projections, 1, 'explicit click crosses the real IndexerClient projection request boundary');
	assert.equal(counters.matches, 1, 'explicit click invokes the actual JRC-01 matcher wrapper');
	assert.equal(counters.indexes, beforeClickIndexes, 'validation does not trigger reindexing');
	assert.equal(indexerClientCalls, beforeClickIndexCalls, 'validation does not request reindexing');
	assert.deepEqual(errors, [], 'plugin lifecycle and validation must not log errors');
	assert.ok(notices.some((message) => /rules file is valid/i.test(message)), 'valid input produces a success Notice');
	plugin.onunload();
});
