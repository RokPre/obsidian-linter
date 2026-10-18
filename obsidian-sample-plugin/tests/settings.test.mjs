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

async function settingsTab(adapter, ignoredPaths = []) {
	const settings = [];
	const buttons = [];
	const notices = [];
	const errors = [];
	class FileSystemAdapter {
		constructor(basePath) { this.basePath = basePath; }
		getBasePath() { return this.basePath; }
	}
	class AbstractInputSuggest {
		constructor(app, inputEl) {
			this.app = app;
			this.inputEl = inputEl;
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
		setDesc() { return this; }
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
			contents: "export { SampleSettingTab } from './src/settings'; export { indexVault, setIgnoredPaths } from './src/indexer';",
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
		async saveSettings() {},
		indexerClient: {
			indexVault(vaultPath, paths) {
				indexRequests.push([...paths]);
				module.exports.setIgnoredPaths(paths);
				return module.exports.indexVault(vaultPath);
			},
		},
	};
	const tab = new module.exports.SampleSettingTab({ vault }, plugin);
	tab.display();
	return {
		settings, notices, errors, tab, plugin, buttons, indexRequests,
		button: settings.find(setting => setting.name === 'Indexing').button,
		get pickers() {
			return settings.filter(setting =>
				setting.name === 'Ignored path' && setting.parent.children.includes(setting));
		},
	};
}

test('settings button indexes the active vault and is re-enabled after success', async () => {
	const vault = await mkdtemp(join(tmpdir(), 'vault-helper-settings-'));
	try {
		await mkdir(join(vault, '.obsidian'));
		await writeFile(join(vault, 'note.md'), '# Note\n#project/tag\n');
		const { button, notices, errors } = await settingsTab(vault);
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
		ui.plugin.saveSettings = async () => { throw new Error('settings write failed'); };
		const input = ui.pickers[0].text;
		input.inputEl.value = 'b.md';
		input.change('b.md');
		const save = ui.buttons.find(button => button.label === 'Save');

		await save.click();
		assert.deepEqual(ui.notices, ['Settings could not be saved: Error: settings write failed']);
		assert.equal(ui.errors.length, 1);
		assert.deepEqual(ui.plugin.settings.ignoredPaths, ['a.md']);
		assert.deepEqual(ui.indexRequests, []);
		assert.equal(save.cta, true);
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
		assert.equal(save.cta, false);
	} finally {
		await rm(vault, { recursive: true, force: true });
	}
});
