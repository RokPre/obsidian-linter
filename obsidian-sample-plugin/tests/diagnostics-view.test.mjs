import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const pluginDir = fileURLToPath(new URL('..', import.meta.url));

class Element {
	constructor(tagName = 'div') {
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.attributes = {};
		this.classList = new Set();
		this.textContent = '';
		this.listeners = new Map();
	}
	empty() { this.children = []; }
	addClass(name) { this.classList.add(name); }
	setAttribute(name, value) { this.attributes[name] = value; }
	addEventListener(name, callback) { this.listeners.set(name, callback); }
	removeEventListener(name, callback) {
		if (this.listeners.get(name) === callback) this.listeners.delete(name);
	}
	createDiv(options = {}) { return this.create('div', options); }
	createEl(tagName, options = {}) { return this.create(tagName, options); }
	createSpan(options = {}) { return this.create('span', options); }
	create(tagName, options) {
		const element = new Element(tagName);
		if (options.cls) element.classList.add(options.cls);
		if (options.text) element.textContent = options.text;
		for (const [name, value] of Object.entries(options.attr ?? {})) element.setAttribute(name, value);
		this.children.push(element);
		return element;
	}
}

class ItemView {
	constructor() { this.contentEl = new Element(); }
}

const compiled = await build({
	entryPoints: [`${pluginDir}/src/diagnostics-view.ts`],
	bundle: true,
	write: false,
	platform: 'node',
	format: 'cjs',
	external: ['obsidian'],
});
const module = { exports: {} };
const context = {
	module,
	exports: module.exports,
	require(name) {
		if (name === 'obsidian') return { ItemView };
		throw new Error(`Unexpected require: ${name}`);
	},
};
vm.runInNewContext(compiled.outputFiles[0].text, context, { filename: 'diagnostics-view.bundle.cjs' });
const { DiagnosticsView } = module.exports;

function descendants(element) {
	return element.children.flatMap((child) => [child, ...descendants(child)]);
}

await test('diagnostics view renders fields and preserves optional line absence', () => {
	const activated = [];
	const view = new DiagnosticsView({}, (finding) => activated.push(finding));
	view.setOutcome({ status: 'completed', diagnostics: [
		{ ruleId: 'frontmatter-aliases', check: 'requiredFrontmatterProperty', severity: 'warning', path: 'folder/one.md', message: 'Add aliases', line: 7 },
		{ ruleId: 'link-targets', check: 'unresolvedInternalLinks', severity: 'error', path: 'two.md', message: 'Target is missing' },
	] });

	const elements = descendants(view.contentEl);
	assert.equal(elements.filter((element) => element.tagName === 'BUTTON').length, 2);
	assert.ok(elements.some((element) => element.tagName === 'SPAN' && element.textContent === 'frontmatter-aliases'));
	assert.ok(elements.some((element) => element.tagName === 'SPAN' && element.textContent === 'warning'));
	assert.ok(elements.some((element) => element.tagName === 'SPAN' && element.textContent === 'folder/one.md'));
	assert.ok(elements.some((element) => element.tagName === 'SPAN' && element.textContent === 'Add aliases'));
	assert.ok(elements.some((element) => element.tagName === 'SPAN' && element.textContent === 'Line 7'));
	assert.ok(elements.some((element) => element.tagName === 'SPAN' && element.textContent === 'Target is missing'));
	const buttons = elements.filter((element) => element.tagName === 'BUTTON');
	assert.ok(!descendants(buttons[1]).some((element) =>
		element.tagName === 'SPAN' && element.textContent.startsWith('Line ')));
	assert.ok(elements.filter((element) => element.tagName === 'BUTTON').every((button) => button.attributes.type === 'button'));
	buttons[0].listeners.get('click')();
	assert.equal(activated[0].path, 'folder/one.md');
});

await test('diagnostics view renders empty results and releases rendered findings on close', async () => {
	const view = new DiagnosticsView({}, () => {});
	await view.onOpen();
	assert.ok(descendants(view.contentEl).some((element) => element.textContent === 'No diagnostics found.'));

	view.setOutcome({ status: 'completed', diagnostics: [
		{ ruleId: 'rule', check: 'filenameCase', severity: 'warning', path: 'note.md', message: 'Rename it' },
	] });
	const button = descendants(view.contentEl).find((element) => element.tagName === 'BUTTON');
	await view.onClose();
	assert.deepEqual([...button.listeners], []);
	assert.deepEqual(view.contentEl.children, []);
});
await test('diagnostics view replaces findings with whole-run failure state', () => {
	const view = new DiagnosticsView({}, () => {});
	view.setOutcome({ status: 'completed', diagnostics: [
		{ ruleId: 'old', check: 'filenameCase', severity: 'warning', path: 'old.md', message: 'Old result' },
	] });
	view.setOutcome({ status: 'failed', message: 'worker unavailable' });
	const elements = descendants(view.contentEl);
	assert.ok(elements.some((element) => element.textContent === 'Checks failed: worker unavailable'));
	assert.ok(!elements.some((element) => element.textContent === 'Old result'));
});
