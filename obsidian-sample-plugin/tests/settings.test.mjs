import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

async function settingsTab(adapter, ignoredPaths = [], renderMode = 'legacy') {
	const settings = [];
	const buttons = [];
	const notices = [];
	const errors = [];
	const saveRequests = [];
	const suggestions = [];
	class FileSystemAdapter {
		constructor(basePath) { this.basePath = basePath; }
		getBasePath() { return this.basePath; }
	}
	class AbstractInputSuggest {
		constructor(app, inputEl) {
			this.app = app;
			this.inputEl = inputEl;
			suggestions.push(this);
		}
		onSelect(callback) {
			this.selectCallback = callback;
			return this;
		}
	}
	class Container {
		constructor() { this.children = []; }
		empty() { this.children.length = 0; }
		createDiv() {
			const child = new Container();
			this.children.push(child);
			return child;
		}
	}
	class PluginSettingTab {
		constructor(app) {
			this.app = app;
			this.containerEl = {
				empty() { settings.length = 0; },
				createDiv() { return new Container(); },
			};
		}
	}
	class Setting {
		constructor(parent) {
			this.parent = parent;
			settings.push(this);
			if (parent instanceof Container) parent.children.push(this);
		}
		setName(name) { this.name = name; return this; }
		setDesc(description) { this.description = description; return this; }
		setClass(name) { this.className = name; return this; }
		addExtraButton(configure) {
			const button = {
				disabled: false,
				setDisabled(disabled) { this.disabled = disabled; return this; },
				setIcon(icon) { this.icon = icon; return this; },
				setTooltip(tooltip) { this.tooltip = tooltip; return this; },
				onClick(callback) { this.click = callback; return this; },
			};
			this.extraButton = button;
			configure(button);
			return this;
		}
		addButton(configure) {
			const button = {
				label: '', disabled: false, cta: false,
				buttonEl: { classList: new Set() },
				setButtonText(label) { this.label = label; return this; },
				setDisabled(disabled) { this.disabled = disabled; return this; },
				setCta() { this.cta = true; return this; },
				removeCta() { this.cta = false; return this; },
				onClick(callback) { this.click = callback; return this; },
			};
			this.button = button;
			buttons.push(button);
			configure(button);
			return this;
		}
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
	}
	class Notice { constructor(message) { notices.push(message); } }
	const compiled = await build({
		stdin: {
			contents: "export { ObsidianLinterSettingTab } from './src/settings'; export { indexVault, setIgnoredPaths } from './src/indexer';",
			resolveDir: fileURLToPath(new URL('..', import.meta.url)),
			loader: 'ts',
		},
		bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
		loader: { '.wasm': 'binary' },
	});
	const module = { exports: {} };
	vm.runInNewContext(compiled.outputFiles[0].text, {
		module, exports: module.exports, process, performance, TextDecoder, Buffer, setTimeout,
		__dirname: fileURLToPath(new URL('..', import.meta.url)),
		console: { ...console, debug() {}, error(...args) { errors.push(args); } },
		require(name) { return name === 'obsidian' ? { AbstractInputSuggest, FileSystemAdapter, PluginSettingTab, Setting, Notice } : require(name); },
	});
	const vaultAdapter = typeof adapter === 'string' ? new FileSystemAdapter(adapter) : adapter;
	const vault = {
		adapter: vaultAdapter,
		getAllLoadedFiles() {
			if (typeof adapter !== 'string') return [];
			return readdirSync(adapter, { recursive: true })
				.map(path => ({ path: path.split(sep).join('/') }));
		},
		getAbstractFileByPath(path) {
			return this.getAllLoadedFiles().find(file => file.path === path) ?? null;
		},
	};
	const indexRequests = [];
	const plugin = {
		settings: { ignoredPaths: [...ignoredPaths] },
		async saveSettings(settings) { saveRequests.push([...settings.ignoredPaths]); },
		indexerClient: {
			indexVault(vaultPath, paths) {
				indexRequests.push([...paths]);
				module.exports.setIgnoredPaths(paths);
				return module.exports.indexVault(vaultPath);
			},
		},
	};
	const tab = new module.exports.ObsidianLinterSettingTab({ vault }, plugin);
	if (renderMode === 'legacy') tab.display();
	else tab.getSettingDefinitions()[0].render(new Container());
	return {
		settings, notices, errors, tab, plugin, buttons, indexRequests, saveRequests, suggestions,
		descriptions: settings.filter(setting => setting.description).map(setting => setting.description),
		button: settings.find(setting => setting.name === 'Indexing')?.button,
		get pickers() {
			return settings.filter(setting =>
				setting.name === 'Ignored path' && setting.parent.children.includes(setting));
		},
	};
}
test('declarative settings define a searchable custom ignored-path editor', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-declarative-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		const ui = await settingsTab(vault, ['a.md'], 'declarative');
		const definitions = ui.tab.getSettingDefinitions();
		assert.equal(definitions.length, 1);
		const [definition] = definitions;
		assert.equal(definition.id, 'ignoredPaths');
		assert.equal(definition.name, 'Blacklist for files and folders');
		assert.equal(definition.description, 'Exclude files or folders from indexing. Paths are relative to the vault root. Press save to apply changes.');
		assert.equal(definition.type, 'custom');
		assert.equal(typeof definition.render, 'function');
		assert.equal(ui.pickers.length, 1);
		assert.deepEqual(ui.buttons.map(button => button.label), ['Add', 'Clear', 'Save', 'Index vault']);
		assert.equal(ui.descriptions[0], definition.description);
		assert.equal(ui.buttons.find(button => button.label === 'Save').disabled, true);
		assert.deepEqual(ui.saveRequests, []);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('legacy settings retain the minimum version and exact description', async () => {
	const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
	assert.equal(manifest.minAppVersion, '1.6.6');
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-legacy-'));
	try {
		const ui = await settingsTab(vault);
		assert.equal(typeof ui.tab.display, 'function');
		assert.equal(ui.descriptions[0], 'Exclude files or folders from indexing. Paths are relative to the vault root. Press save to apply changes.');
		assert.equal(ui.pickers.length, 1);
		assert.deepEqual(ui.saveRequests, []);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('declarative renderer preserves explicit clear-and-save behavior', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-declarative-clear-'));
	try {
		const ui = await settingsTab(vault, ['a.md'], 'declarative');
		const clear = ui.buttons.find(button => button.label === 'Clear');
		const save = ui.buttons.find(button => button.label === 'Save');
		assert.equal(save.disabled, true);
		clear.click();
		assert.equal(save.disabled, false);
		assert.deepEqual(ui.saveRequests, []);
		await save.click();
		assert.deepEqual(ui.saveRequests, [[]]);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), []);
		assert.deepEqual(ui.indexRequests, [[]]);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('unchanged and empty drafts disable Save and direct invocation has no side effects', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-unchanged-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		for (const ignoredPaths of [['a.md'], []]) {
			const ui = await settingsTab(vault, ignoredPaths);
			const save = ui.buttons.find(button => button.label === 'Save');

			assert.equal(save.disabled, true);
			assert.equal(save.cta, false);
			await save.click();
			assert.deepEqual(ui.saveRequests, []);
			assert.deepEqual(ui.indexRequests, []);
			assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ignoredPaths);
		}
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('valid edits enable Save, and reverting the ordered draft disables it again', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-eligibility-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		await writeFile(join(vault, 'b.md'), '# B\n');

		const changed = await settingsTab(vault, ['a.md']);
		const changedSave = changed.buttons.find(button => button.label === 'Save');
		const changedInput = changed.pickers[0].text;
		changedInput.inputEl.value = 'b.md';
		changedInput.change('b.md');
		assert.equal(changedSave.disabled, false);
		assert.equal(changedSave.cta, true);
		changedInput.inputEl.value = 'a.md';
		changedInput.change('a.md');
		assert.equal(changedSave.disabled, true);
		assert.equal(changedSave.cta, false);

		const reordered = await settingsTab(vault, ['a.md', 'b.md']);
		const reorderedSave = reordered.buttons.find(button => button.label === 'Save');
		const secondInput = reordered.pickers[1].text;
		secondInput.inputEl.value = 'a.md';
		secondInput.change('a.md');
		const firstInput = reordered.pickers[0].text;
		firstInput.inputEl.value = 'b.md';
		firstInput.change('b.md');
		assert.equal(reorderedSave.disabled, false);
		assert.equal(reorderedSave.cta, true);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('invalid changed drafts disable Save and direct invocation has no side effects', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-invalid-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		await writeFile(join(vault, 'b.md'), '# B\n');
		for (const { ignoredPaths, index, value } of [
			{ ignoredPaths: ['a.md'], index: 0, value: '/' },
			{ ignoredPaths: ['a.md'], index: 0, value: 'missing.md' },
			{ ignoredPaths: ['a.md', 'b.md'], index: 1, value: 'a.md' },
		]) {
			const ui = await settingsTab(vault, ignoredPaths);
			const input = ui.pickers[index].text;
			input.inputEl.value = value;
			input.change(value);
			const save = ui.buttons.find(button => button.label === 'Save');

			assert.equal(save.disabled, true);
			assert.equal(save.cta, false);
			await save.click();
			assert.deepEqual(ui.saveRequests, []);
			assert.deepEqual(ui.indexRequests, []);
			assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ignoredPaths);
		}
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('adding an extra blank picker does not make an unchanged draft eligible', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-blank-picker-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		const ui = await settingsTab(vault, ['a.md']);
		ui.buttons.find(button => button.label === 'Add').click();
		const save = ui.buttons.find(button => button.label === 'Save');

		assert.equal(ui.pickers.length, 2);
		assert.equal(ui.pickers[1].text.inputEl.value, '');
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});
test('blanking a saved path saves only the remaining paths, including an empty list', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-blank-saved-path-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		await writeFile(join(vault, 'b.md'), '# B\n');
		const ui = await settingsTab(vault, ['a.md', 'b.md']);
		const save = ui.buttons.find(button => button.label === 'Save');
		const input = ui.pickers[0].text;
		input.inputEl.value = ' \t ';
		input.change(' \t ');

		assert.equal(save.disabled, false);
		assert.equal(save.cta, true);
		await save.click();
		assert.deepEqual(ui.saveRequests, [['b.md']]);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ['b.md']);
		assert.deepEqual(ui.indexRequests, [['b.md']]);
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);

		const last = ui.pickers[1].text;
		last.inputEl.value = '';
		last.change('');
		assert.equal(save.disabled, false);
		assert.equal(save.cta, true);
		await save.click();
		assert.deepEqual(ui.saveRequests, [['b.md'], []]);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), []);
		assert.deepEqual(ui.indexRequests, [['b.md'], []]);
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('clearing saved exclusions and saving persists an empty list', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-clear-saved-paths-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		const ui = await settingsTab(vault, ['a.md']);
		const save = ui.buttons.find(button => button.label === 'Save');
		ui.buttons.find(button => button.label === 'Clear').click();

		assert.equal(save.disabled, false);
		assert.equal(save.cta, true);
		await save.click();
		assert.deepEqual(ui.saveRequests, [[]]);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), []);
		assert.deepEqual(ui.indexRequests, [[]]);
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('Clear state follows blank, selected, and row-change transitions', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-clear-state-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		const ui = await settingsTab(vault);
		const whitespaceUi = await settingsTab(vault, [' \t ']);
		assert.equal(whitespaceUi.pickers.length, 1);
		assert.equal(
			whitespaceUi.buttons.find(button => button.label === 'Clear').disabled,
			true,
		);
		const clear = ui.buttons.find(button => button.label === 'Clear');
		const add = ui.buttons.find(button => button.label === 'Add');
		const save = ui.buttons.find(button => button.label === 'Save');
		assert.equal(clear.buttonEl.classList.has('vault-helper-clear-button'), true);
		assert.equal(add.buttonEl.classList.has('vault-helper-clear-button'), false);
		assert.equal(save.buttonEl.classList.has('vault-helper-clear-button'), false);

		assert.equal(ui.pickers.length, 1);
		assert.equal(clear.disabled, true);

		const input = ui.pickers[0].text;
		input.inputEl.value = ' \t ';
		input.change(' \t ');
		assert.equal(clear.disabled, true);

		input.inputEl.value = 'a.md';
		input.change('a.md');
		assert.equal(clear.disabled, false);

		input.inputEl.value = ' \t ';
		input.change(' \t ');
		assert.equal(clear.disabled, true);

		input.inputEl.value = 'a.md';
		ui.suggestions[0].selectCallback('a.md');
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['a.md']);
		assert.equal(clear.disabled, false);

		add.click();
		assert.equal(ui.pickers.length, 2);
		assert.equal(clear.disabled, false);

		input.inputEl.value = '';
		input.change('');
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['', '']);
		assert.equal(clear.disabled, false);

		ui.pickers[1].extraButton.click();
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['']);
		assert.equal(clear.disabled, true);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('Clear resets saved paths without persisting until Save', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-clear-draft-only-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		const ui = await settingsTab(vault, ['a.md']);
		const clear = ui.buttons.find(button => button.label === 'Clear');
		const add = ui.buttons.find(button => button.label === 'Add');
		const save = ui.buttons.find(button => button.label === 'Save');

		assert.equal(clear.disabled, false);
		clear.click();

		assert.equal(ui.pickers.length, 1);
		assert.equal(ui.pickers[0].text.inputEl.value, '');
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['']);
		assert.equal(clear.disabled, true);
		assert.equal(add.disabled, true);
		assert.equal(ui.pickers[0].extraButton.disabled, true);
		assert.equal(save.disabled, false);
		assert.equal(save.cta, true);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ['a.md']);
		assert.deepEqual(ui.saveRequests, []);
		assert.deepEqual(ui.indexRequests, []);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('successful persistence disables Save before indexing settles', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-before-index-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		await writeFile(join(vault, 'b.md'), '# B\n');
		const ui = await settingsTab(vault, ['a.md']);
		const input = ui.pickers[0].text;
		input.inputEl.value = 'b.md';
		input.change('b.md');
		const save = ui.buttons.find(button => button.label === 'Save');
		let indexStarted;
		const started = new Promise(resolve => { indexStarted = resolve; });
		let finishIndex;
		ui.plugin.indexerClient.indexVault = (_vaultPath, paths) => {
			ui.indexRequests.push([...paths]);
			indexStarted();
			return new Promise(resolve => { finishIndex = resolve; });
		};

		const saving = save.click();
		await started;
		await Promise.resolve();
		assert.deepEqual(ui.saveRequests, [['b.md']]);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ['b.md']);
		assert.deepEqual(ui.indexRequests, [['b.md']]);
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
		finishIndex({ addedFiles: 0, indexedFiles: 0, deletedFiles: 0 });
		await saving;
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});


test('settings button indexes the active vault and is re-enabled after success', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-settings-'));
	try {
		await mkdir(join(vault, '.obsidian'));
		await writeFile(join(vault, 'note.md'), '# Note\n#project/tag\n');
		const { button, notices, errors, plugin, buttons } = await settingsTab(vault);
		const save = buttons.find(candidate => candidate.label === 'Save');
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
		assert.deepEqual(Array.from(plugin.settings.ignoredPaths), []);
		assert.equal(button.label, 'Index vault');
		assert.deepEqual(notices, []);
		const indexing = button.click();
		assert.equal(button.disabled, true);
		assert.deepEqual(notices, []);
		await indexing;
		assert.equal(button.disabled, false);
		assert.equal(notices.at(-1), 'Index updated: 1 added, 0 updated, 0 removed.');
		assert.deepEqual(errors, []);
		const database = await readFile(join(vault, '.obsidian', 'vaultHelper.db'));
		assert.equal(database.subarray(0, 16).toString(), 'SQLite format 3\0');
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
		assert.deepEqual(Array.from(plugin.settings.ignoredPaths), []);
		await button.click();
		assert.equal(notices.at(-1), 'Index updated: 0 added, 0 updated, 0 removed.');
	} finally { await rm(vault, { recursive: true, force: true }); }
});

test('settings button reports a real indexing error and is re-enabled', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-settings-error-'));
	try {
		await writeFile(join(vault, 'invalid.md'), Buffer.from([0xc3, 0x28]));
		const { button, notices, errors } = await settingsTab(vault);
		await button.click();
		assert.equal(button.disabled, false);
		assert.match(notices.at(-1), /^Indexing failed:/);
		assert.equal(errors.length, 1);
		await assert.rejects(readFile(join(vault, '.obsidian', 'vaultHelper.db')), { code: 'ENOENT' });
	} finally { await rm(vault, { recursive: true, force: true }); }
});

test('settings button rejects a non-filesystem adapter without indexing', async () => {
	const { button, notices, errors } = await settingsTab({});
	await button.click();
	assert.equal(button.disabled, false);
	assert.deepEqual(notices, ['Vault indexing requires Obsidian desktop.']);
	assert.deepEqual(errors, []);
});

test('clicking × removes only that path from the draft, not the saved blacklist or the file', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-remove-path-'));
	try {
		const paths = ['a.md', 'b.md', 'c.md'];
		for (const path of paths) {
			await writeFile(join(vault, path), '# Note\n');
		}
		const ui = await settingsTab(vault, paths);
		assert.deepEqual(ui.pickers.map(row => row.text.inputEl.value), paths);

		ui.pickers[1].extraButton.click();

		assert.deepEqual(
			ui.pickers.map(row => row.text.inputEl.value),
			['a.md', 'c.md'],
		);
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['a.md', 'c.md']);
		assert.deepEqual(ui.plugin.settings.ignoredPaths, paths);
		assert.equal(await readFile(join(vault, 'b.md'), 'utf8'), '# Note\n');
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('editing a remaining path after removing another updates the correct draft entry', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-edit-after-removal-'));
	try {
		const paths = ['a.md', 'b.md', 'c.md'];
		for (const path of [...paths, 'd.md']) {
			await writeFile(join(vault, path), '# Note\n');
		}
		const ui = await settingsTab(vault, paths);

		ui.pickers[1].extraButton.click();

		const input = ui.pickers[1].text;
		assert.equal(input.inputEl.value, 'c.md');
		input.inputEl.value = 'd.md';
		input.change('d.md');

		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['a.md', 'd.md']);
		assert.deepEqual(ui.plugin.settings.ignoredPaths, paths);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('removing the last filled path leaves one blank picker with its × disabled', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-remove-last-path-'));
	try {
		await writeFile(join(vault, 'a.md'), '# Note\n');
		const ui = await settingsTab(vault, ['a.md']);
		const add = ui.buttons.find(button => button.label === 'Add');

		ui.pickers[0].extraButton.click();

		assert.equal(ui.pickers.length, 1);
		assert.equal(ui.pickers[0].text.inputEl.value, '');
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['']);
		assert.equal(add.disabled, true);
		assert.equal(ui.pickers[0].extraButton.disabled, true);

		const input = ui.pickers[0].text;
		input.inputEl.value = 'a.md';
		input.change('a.md');

		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['a.md']);
		assert.equal(add.disabled, false);
		assert.equal(ui.pickers[0].extraButton.disabled, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('removing an invalid path makes Save available again', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-remove-invalid-path-'));
	try {
		await writeFile(join(vault, 'a.md'), '# Note\n');
		const paths = ['a.md', 'missing.md'];
		const ui = await settingsTab(vault, paths);
		const save = ui.buttons.find(button => button.label === 'Save');

		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);

		ui.pickers[1].extraButton.click();

		assert.deepEqual(ui.pickers.map(row => row.text.inputEl.value), ['a.md']);
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['a.md']);
		assert.equal(save.disabled, false);
		assert.equal(save.cta, true);
		assert.deepEqual(ui.plugin.settings.ignoredPaths, paths);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('failed Save keeps the last saved ignore paths active', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-failure-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		await writeFile(join(vault, 'b.md'), '# B\n');
		const ui = await settingsTab(vault, ['a.md']);
		ui.plugin.saveSettings = async settings => {
			ui.saveRequests.push([...settings.ignoredPaths]);
			throw new Error('settings write failed');
		};
		const input = ui.pickers[0].text;
		input.inputEl.value = 'b.md';
		input.change('b.md');
		const save = ui.buttons.find(button => button.label === 'Save');

		await save.click();
		assert.deepEqual(ui.saveRequests, [['b.md']]);
		assert.deepEqual(ui.notices, ['Settings could not be saved: Error: settings write failed']);
		assert.equal(ui.errors.length, 1);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ['a.md']);
		assert.deepEqual(ui.indexRequests, []);
		assert.equal(save.disabled, false);
		assert.equal(save.cta, true);

		ui.plugin.saveSettings = async settings => { ui.saveRequests.push([...settings.ignoredPaths]); };
		await save.click();
		assert.deepEqual(ui.saveRequests, [['b.md'], ['b.md']]);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ['b.md']);
		assert.deepEqual(ui.indexRequests, [['b.md']]);
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});

test('Save keeps new ignore paths active and reports a subsequent indexing failure', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-save-index-failure-'));
	try {
		await writeFile(join(vault, 'a.md'), '# A\n');
		await writeFile(join(vault, 'b.md'), '# B\n');
		await writeFile(join(vault, 'invalid.md'), Buffer.from([0xc3, 0x28]));
		const ui = await settingsTab(vault, ['a.md']);
		let savedPaths;
		ui.plugin.saveSettings = async (settings) => { savedPaths = [...settings.ignoredPaths]; };
		const input = ui.pickers[0].text;
		input.inputEl.value = 'b.md';
		input.change('b.md');
		const save = ui.buttons.find(button => button.label === 'Save');

		await save.click();
		assert.deepEqual(savedPaths, ['b.md']);
		assert.deepEqual(Array.from(ui.plugin.settings.ignoredPaths), ['b.md']);
		assert.deepEqual(ui.indexRequests, [['b.md']]);
		assert.equal(ui.notices.length, 1);
		assert.match(ui.notices[0], /^Settings saved, but indexing failed:/);
		assert.equal(ui.errors.length, 1);
		assert.equal(save.disabled, true);
		assert.equal(save.cta, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});
test('suggestions use loaded paths, exclude root and duplicate draft paths, and update the selected row', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-suggestions-'));
	try {
		const ui = await settingsTab(vault, ['already.md', ''], 'declarative');
		ui.tab.app.vault.getAllLoadedFiles = () => [
			{ path: 'alpha.md' },
			{ path: '/' },
			{ path: 'already.md' },
			{ path: 'folder/beta.md' },
		];
		const suggestions = ui.suggestions[1].getSuggestions('');
		assert.deepEqual(suggestions, ['alpha.md', 'folder/beta.md']);
		assert.equal(suggestions.includes('not-loaded.md'), false);
		assert.equal(suggestions.includes('/'), false);
		assert.equal(suggestions.includes('already.md'), false);

		ui.suggestions[1].selectCallback(suggestions[1]);
		assert.deepEqual(Array.from(ui.tab.draftIgnoredPaths), ['already.md', 'folder/beta.md']);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});
