import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
	constructor(app, manifest) { this.app = app; this.manifest = manifest; this.commands = []; }
	async loadData() { return { rulesFilePath: 'rules.json', ignoredPaths: [] }; }
	async saveData() {}
	addRibbonIcon() {}
	addStatusBarItem() { return { setText() {} }; }
	addCommand(command) { this.commands.push(command); }
	registerView(type, factory) { registeredViews.set(type, factory); }
	addSettingTab(tab) { this.settingTab = tab; }
	registerDomEvent() {}
	registerEvent() {}
}
class MarkdownView {
	constructor(file, mode = 'preview') {
		this.file = file;
		this.mode = mode;
		this.editor = {
			setCursor(position) { cursorPositions.push(position); },
			scrollIntoView(range, center) { scrollRequests.push({ range, center }); },
		};
	}
	getMode() { return this.mode; }
}
class Modal {}
class FakeElement {
	constructor(tagName = 'div') {
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.attributes = {};
		this.textContent = '';
		this.listeners = new Map();
	}
	empty() { this.children = []; }
	addClass() {}
	setAttribute(name, value) { this.attributes[name] = value; }
	addEventListener(name, callback) { this.listeners.set(name, callback); }
	removeEventListener(name, callback) {
		if (this.listeners.get(name) === callback) this.listeners.delete(name);
	}
	createDiv(options = {}) { return this.create('div', options); }
	createEl(tagName, options = {}) { return this.create(tagName, options); }
	createSpan(options = {}) { return this.create('span', options); }
	create(tagName, options) {
		const child = new FakeElement(tagName);
		child.textContent = options.text ?? '';
		this.children.push(child);
		return child;
	}
}
class ItemView {
	constructor(leaf) { this.leaf = leaf; this.contentEl = new FakeElement(); }
}
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

const registeredViews = new Map();
const revealedLeaves = [];
const expandedDocks = [];
const activeLeaves = [];
class WorkspaceSidedock {
	constructor(side) {
		this.side = side;
		this.collapsed = true;
	}
	expand() {
		this.collapsed = false;
		expandedDocks.push(this);
	}
}
const sideDocks = {
	left: new WorkspaceSidedock('left'),
	right: new WorkspaceSidedock('right'),
};
let createdLeaf;
const cursorPositions = [];
const scrollRequests = [];
const openedFiles = [];
const activeEditorLeaves = [];
let editorLeaf;
function makeLeaf(side) {
	return {
		side,
		parent: { parent: { parent: sideDocks[side] } },
		async setViewState(state) {
			this.viewType = state.type;
			this.state = state;
			this.view = registeredViews.get(state.type)(this);
			await this.view.onOpen();
			createdLeaf = this;
		},
	};
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
		getAbstractFileByPath(path) { return ['rules.json', 'note.md', 'no-line.md'].includes(path) ? new TFile(path) : null; },
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
	workspace: {
		leftSplit: sideDocks.left,
		rightSplit: sideDocks.right,
		onLayoutReady(callback) { layoutReady = callback; },
		getLeavesOfType(type) { return createdLeaf?.viewType === type ? [createdLeaf] : []; },
		getRightLeaf(create) { assert.equal(create, false); return makeLeaf('right'); },
		getLeftLeaf(create) { assert.equal(create, false); return makeLeaf('left'); },
		revealLeaf(leaf) { revealedLeaves.push(leaf); },
		setActiveLeaf(leaf, params) {
			assert.equal(params.focus, true);
			leaf.active = true;
			activeLeaves.push(leaf);
			activeEditorLeaves.push(leaf);
		},
		getLeaf(type) {
			assert.equal(type, 'tab');
			editorLeaf = {
				active: false,
				async openFile(file) {
					openedFiles.push(file);
					this.openedWhileInactive = !this.active;
					this.state = { type: 'markdown', state: { file: file.path, mode: 'preview' } };
					this.view = new MarkdownView(file);
				},
				getViewState() { return this.state; },
				async setViewState(state) {
					this.state = state;
					this.view = new MarkdownView(this.view.file, state.state.mode);
				},
			};
			return editorLeaf;
		},
	},
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
const obsidian = { FileSystemAdapter, AbstractInputSuggest, PluginSettingTab, Setting, Notice, Plugin, Modal, TFile, ItemView, MarkdownView, WorkspaceSidedock };
vm.runInNewContext(compiled.outputFiles[0].text, context, { filename: 'main-lifecycle.bundle.cjs' });
const ObsidianLinterPlugin = module.exports.default;

function renderedText(element) {
	return [element.textContent, ...element.children.flatMap(renderedText)].join(' ');
}

function assertNoRulesFlow(stage) {
	assert.deepEqual(counters, { reads: 0, parses: 0, matches: 0, projections: 0, indexes: counters.indexes }, `${stage}: rules processing must not run`);
}

await test('real plugin lifecycle is manual-only outside explicit Read/validate', async () => {
	const plugin = new ObsidianLinterPlugin(app, { id: 'test-plugin', dir: '.obsidian/plugins/test-plugin' });
	await plugin.onload();
	const diagnosticsViewType = 'linter-diagnostics';
	assert.ok(registeredViews.has(diagnosticsViewType), 'plugin registers the diagnostics view type');
	const diagnosticsCommands = plugin.commands.filter((command) => command.id.startsWith('open-diagnostics-'));
	assert.deepEqual(diagnosticsCommands.map((command) => command.id), ['open-diagnostics-right', 'open-diagnostics-left']);
	await diagnosticsCommands[0].callback();
	const diagnosticsLeaf = createdLeaf;
	assert.equal(diagnosticsLeaf.side, 'right');
	assert.equal(diagnosticsLeaf.state.type, diagnosticsViewType);
	assert.equal(sideDocks.right.collapsed, false, 'opening on the right expands the right dock');
	assert.deepEqual(expandedDocks, [sideDocks.right]);
	assert.equal(activeLeaves.at(-1), diagnosticsLeaf, 'opening activates the new diagnostics leaf');
	await diagnosticsCommands[0].callback();
	assert.equal(createdLeaf, diagnosticsLeaf, 'repeating the same-side command reuses the existing view');
	await diagnosticsCommands[1].callback();
	assert.equal(createdLeaf, diagnosticsLeaf, 'opposite-side command reuses the existing view in place');
	assert.deepEqual(expandedDocks, [sideDocks.right, sideDocks.right, sideDocks.right],
		'opposite-side command expands the actual dock containing the existing leaf');
	assert.deepEqual(activeLeaves, [diagnosticsLeaf, diagnosticsLeaf, diagnosticsLeaf],
		'each command activates the existing diagnostics leaf');
	assert.equal(sideDocks.left.collapsed, true, 'opposite-side command does not expand the requested, incorrect dock');
	assert.deepEqual(revealedLeaves, [], 'diagnostics opening does not use revealLeaf');
	const originalParent = diagnosticsLeaf.parent;
	diagnosticsLeaf.parent = { parent: null };
	const dockExpansionCount = expandedDocks.length;
	await diagnosticsCommands[1].callback();
	assert.equal(expandedDocks.length, dockExpansionCount, 'root-level existing view does not expand either sidebar');
	assert.equal(activeLeaves.at(-1), diagnosticsLeaf, 'root-level existing view is still activated');
	diagnosticsLeaf.parent = originalParent;
	const completedFindings = [{
		ruleId: 'new-result', check: 'filenameCase', severity: 'warning', path: 'note.md', message: 'New finding',
	}];
	plugin.setDiagnosticsOutcome({ status: 'completed', diagnostics: completedFindings });
	assert.match(renderedText(diagnosticsLeaf.view.contentEl), /New finding/);
	const openView = diagnosticsLeaf.view;
	await openView.onClose();
	diagnosticsLeaf.viewType = undefined;
	const revealCount = revealedLeaves.length;
	plugin.setDiagnosticsOutcome({ status: 'completed', diagnostics: [{
		...completedFindings[0], message: 'Closed-view result',
	}] });
	assert.equal(revealedLeaves.length, revealCount, 'new outcomes do not open a closed view');
	await diagnosticsCommands[1].callback();
	const reopenedLeaf = createdLeaf;
	assert.equal(reopenedLeaf.side, 'left');
	assert.equal(sideDocks.left.collapsed, false, 'opening on the left expands the left dock');
	assert.equal(expandedDocks.at(-1), sideDocks.left);
	assert.equal(activeLeaves.at(-1), reopenedLeaf, 'opening activates the new left diagnostics leaf');
	assert.match(renderedText(reopenedLeaf.view.contentEl), /Closed-view result/);
	await reopenedLeaf.view.onClose();
	reopenedLeaf.viewType = undefined;
	plugin.setDiagnosticsOutcome({ status: 'failed', message: 'worker failed' });
	assert.equal(revealedLeaves.length, revealCount, 'whole-run failure leaves a closed view closed');
	await diagnosticsCommands[1].callback();
	assert.equal(createdLeaf.side, 'left');
	assert.match(renderedText(createdLeaf.view.contentEl), /Checks failed: worker failed/);
	await plugin.openDiagnosticFinding({
		ruleId: 'with-line', check: 'filenameCase', severity: 'warning', path: 'note.md', message: 'Review', line: 4,
	});
	assert.equal(openedFiles.at(-1).path, 'note.md');
	assert.equal(editorLeaf.openedWhileInactive, true, 'new tab is initially inactive');
	assert.equal(editorLeaf.active, true, 'line navigation activates the editor leaf');
	assert.equal(activeEditorLeaves.at(-1), editorLeaf);
	assert.equal(editorLeaf.view.getMode(), 'source', 'line navigation switches preview to source mode');
	const cursorPosition = cursorPositions.at(-1);
	assert.equal(cursorPosition.line, 3);
	assert.equal(cursorPosition.ch, 0);
	const { range, center } = scrollRequests.at(-1);
	assert.equal(range.from.line, 3);
	assert.equal(range.from.ch, 0);
	assert.equal(range.to.line, 3);
	assert.equal(range.to.ch, 0);
	assert.equal(center, true);
	await plugin.openDiagnosticFinding({
		ruleId: 'no-line', check: 'filenameCase', severity: 'warning', path: 'no-line.md', message: 'Review',
	});
	assert.equal(openedFiles.at(-1).path, 'no-line.md');
	assert.equal(editorLeaf.openedWhileInactive, true, 'line-less navigation also activates a new tab');
	assert.equal(editorLeaf.active, true);
	assert.equal(activeEditorLeaves.at(-1), editorLeaf);
	assert.equal(editorLeaf.view.getMode(), 'preview', 'line-less navigation keeps the default reading mode');
	assert.equal(createdLeaf.viewType, diagnosticsViewType, 'editor navigation keeps the diagnostics sidebar open');
	assert.equal(cursorPositions.length, 1, 'line-less navigation does not set a cursor');
	assert.equal(scrollRequests.length, 1, 'line-less navigation does not scroll to a cursor');
	const noticeCount = notices.length;
	await plugin.openDiagnosticFinding({
		ruleId: 'deleted', check: 'filenameCase', severity: 'warning', path: 'deleted.md', message: 'Gone',
	});
	assert.equal(notices.length, noticeCount + 1);
	assert.match(notices.at(-1), /deleted\.md/);
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
	const runChecksButton = rulesSetting.buttons.find((button) => button.label === 'Run checks');
	const deliveredFinding = {
		ruleId: 'setting-result', check: 'filenameCase', severity: 'warning', path: 'note.md', message: 'From Run checks',
	};
	plugin.indexerClient.runChecks = async () => ({
		diagnostics: [deliveredFinding],
		failures: [{ ruleId: 'partial', check: 'filenameCase', message: 'Rule failed' }],
	});
	await runChecksButton.click();
	assert.match(renderedText(createdLeaf.view.contentEl), /From Run checks/);
	assert.doesNotMatch(renderedText(createdLeaf.view.contentEl), /worker failed/);

	plugin.indexerClient.runChecks = async () => ({ diagnostics: [], failures: [] });
	await runChecksButton.click();
	assert.match(renderedText(createdLeaf.view.contentEl), /No diagnostics found\./);
	assert.doesNotMatch(renderedText(createdLeaf.view.contentEl), /From Run checks/);

	plugin.indexerClient.runChecks = async () => { throw new Error('worker unavailable'); };
	await runChecksButton.click();
	assert.match(renderedText(createdLeaf.view.contentEl), /Checks failed: worker unavailable/);
	assert.ok(notices.some((message) => /rules\.json: worker unavailable/.test(message)));
	assert.ok(errors.some((args) => args[0] === 'Rule checks failed'));
	plugin.onunload();
});
await test('diagnostic buttons override fixed-height and no-wrap styles', async () => {
	const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
	const rule = css.match(/\.linter-diagnostic\s*\{([^}]*)\}/)?.[1];
	assert.ok(rule, 'diagnostic button rule exists');
	assert.match(rule, /height:\s*auto\s*;/);
	assert.match(rule, /white-space:\s*normal\s*;/);
	assert.match(rule, /overflow-wrap:\s*anywhere\s*;/);
});
