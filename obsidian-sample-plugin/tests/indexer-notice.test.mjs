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
	const document = {
		createDocumentFragment() { return { children: [], append(...children) { this.children.push(...children); } }; },
		createElement(tag) {
			return {
				tag,
				textContent: '',
				attributes: {},
				setAttribute(name, value) { this.attributes[name] = value; },
				removeAttribute(name) { delete this.attributes[name]; },
			};
		},
	};
	class Notice {
		constructor(content) { noticeContent = content; }
		hide() { hidden = true; }
	}
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
		module, exports: module.exports, document,
		require(name) { return name === 'obsidian' ? { Notice } : require(name); },
	});

	const notice = new module.exports.IndexerNotice();
	const [title, status, progress] = noticeContent.children;
	assert.equal(title.textContent, 'Vault helper — indexing vault…');
	assert.equal(status.textContent, 'Scanning vault…');
	assert.equal(progress.attributes['aria-label'], 'Vault indexing progress');
	notice.update('Indexed files', 2, 5);
	assert.equal(status.textContent, 'Indexed files');
	assert.equal(progress.max, 5);
	assert.equal(progress.value, 2);
	notice.hide();
	assert.equal(hidden, true);
});
