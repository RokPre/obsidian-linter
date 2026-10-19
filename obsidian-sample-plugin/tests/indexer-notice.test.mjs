import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);

test('indexer notice keeps progress behavior and uses sentence-case title', async () => {
	let noticeContent;
	let hidden = false;
	let fragmentCalls = 0;
	const divCalls = [];
	const elementCalls = [];
	const createElement = (tag) => ({
		tag,
		textContent: '',
		attributes: {},
		removedAttributes: [],
		setAttribute(name, value) { this.attributes[name] = value; },
		removeAttribute(name) { this.removedAttributes.push(name); delete this.attributes[name]; },
	});
	const createFragment = () => {
		fragmentCalls++;
		return { children: [], append(...children) { this.children.push(...children); } };
	};
	const createDiv = () => {
		divCalls.push('div');
		return createElement('div');
	};
	const createEl = (tag) => {
		elementCalls.push(tag);
		return createElement(tag);
	};
	class Notice {
		constructor(content) { noticeContent = content; }
		hide() { hidden = true; }
	}
	const obsidian = { Notice };
	const compiled = await build({
		stdin: {
			contents: "export { IndexerNotice } from './src/indexer-notice';",
			resolveDir: fileURLToPath(new URL('..', import.meta.url)),
			loader: 'ts',
		},
		bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
	});
	const module = { exports: {} };
	vm.runInNewContext(compiled.outputFiles[0].text, {
		module, exports: module.exports,
		require(name) { return name === 'obsidian' ? obsidian : require(name); },
		createFragment, createDiv, createEl,
	});

	const notice = new module.exports.IndexerNotice();
	const [title, status, progress] = noticeContent.children;
	assert.equal(fragmentCalls, 1);
	assert.deepEqual(divCalls, ['div', 'div']);
	assert.deepEqual(elementCalls, ['progress']);
	assert.deepEqual([title.tag, status.tag, progress.tag], ['div', 'div', 'progress']);
	assert.equal(title.textContent, 'Vault helper — indexing vault…');
	assert.equal(status.textContent, 'Scanning vault…');
	assert.equal(progress.attributes['aria-label'], 'Vault indexing progress');
	assert.equal(progress.removedAttributes.at(-1), 'value');
	notice.update('Indexed files', 2, 5);
	assert.equal(status.textContent, 'Indexed files');
	assert.equal(progress.max, 5);
	assert.equal(progress.value, 2);
	notice.update('Scanning vault…');
	assert.equal(status.textContent, 'Scanning vault…');
	assert.equal(progress.removedAttributes.at(-1), 'value');
	notice.hide();
	assert.equal(hidden, true);
});
