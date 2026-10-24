import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import { build } from 'esbuild';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');

let api;
let workRoot;

before(async () => {
	workRoot = await mkdtemp(join(tmpdir(), 'rules-config-tests-'));
	const bundlePath = join(workRoot, 'rules-config.mjs');
	await build({
		entryPoints: [join(PLUGIN_DIR, 'src', 'rules-config.ts')],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundlePath,
		logLevel: 'silent',
	});
	api = await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`);
});

after(async () => {
	if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

const checkOptions = {
	requiredFrontmatterProperty: { properties: ['aliases'], caseSensitive: true },
	filenameCase: { case: 'camelCase' },
	unresolvedInternalLinks: { statuses: ['missing'], includeEmbeds: false },
};

function makeRule(check = 'requiredFrontmatterProperty', overrides = {}) {
	return {
		id: 'rule-1',
		check,
		enabled: true,
		severity: 'warning',
		scope: { fileKinds: ['markdown'], include: ['**'] },
		options: checkOptions[check],
		...overrides,
	};
}

function makeDocument(rules = [makeRule()], overrides = {}) {
	return { version: 1, rules, ...overrides };
}

function parse(document = makeDocument()) {
	return api.parseRulesConfig(JSON.stringify(document));
}

function matchedPaths(ruleId, config, files) {
	const match = api.matchRulesToFiles(config, files).find((item) => item.ruleId === ruleId);
	return match?.files.map(({ path }) => path);
}

test('accepts the repository example with the real rules parser', async () => {
	const source = await readFile(resolve(PLUGIN_DIR, '..', 'rules.example.json'), 'utf8');
	const config = api.parseRulesConfig(source);
	assert.equal(config.version, 1);
	assert.equal(config.rules[0]?.id, 'require-aliases');
});

test('accepts version 1 documents and a zero-rule configuration', () => {
	assert.deepEqual(parse(makeDocument([])), { version: 1, rules: [] });
	assert.deepEqual(parse(), makeDocument());
});

test('rejects malformed JSON and invalid top-level schema', () => {
	assert.throws(() => api.parseRulesConfig('{'));
	for (const document of [
		{ rules: [] },
		{ version: 2, rules: [] },
		{ version: '1', rules: [] },
		{ version: 1, rules: {}, extra: true },
		{ version: 1, rules: [], extra: true },
	]) {
		assert.throws(() => parse(document), `must reject ${JSON.stringify(document)}`);
	}
});

test('requires the exact rule keys and validates disabled rules', () => {
	for (const key of ['id', 'check', 'enabled', 'severity', 'scope', 'options']) {
		const rule = makeRule();
		delete rule[key];
		assert.throws(() => parse(makeDocument([rule])), `must reject missing ${key}`);
	}
	assert.throws(() => parse(makeDocument([makeRule(undefined, { extra: true })])));
	assert.throws(() => parse(makeDocument([makeRule(undefined, { enabled: false, options: { properties: 'bad', caseSensitive: true } })])));
	assert.throws(() => parse(makeDocument([makeRule(undefined, { enabled: false, scope: { fileKinds: ['markdown'], include: ['**'], unknown: true } })])));
});


test('rejects the complete document when a later rule is invalid', () => {
	const invalidRule = makeRule(undefined, { id: 'invalid', enabled: false, severity: 'critical' });
	const invalidPatternRule = makeRule(undefined, {
		id: 'invalid-pattern',
		enabled: false,
		scope: { fileKinds: ['markdown'], include: ['^notes/file$'] },
	});
	assert.throws(() => parse(makeDocument([makeRule(), invalidRule])));
	assert.throws(() => parse(makeDocument([makeRule(), invalidPatternRule])));
});

test('rejects blank and duplicate rule identifiers', () => {
	for (const id of ['', ' ', '\t\n']) {
		assert.throws(() => parse(makeDocument([makeRule(undefined, { id })])));
	}
	assert.throws(() => parse(makeDocument([makeRule(), makeRule()])));
});

test('accepts only declared check names, boolean enabled, and severities', () => {
	for (const check of Object.keys(checkOptions)) {
		assert.doesNotThrow(() => parse(makeDocument([makeRule(check)])));
	}
	for (const rule of [
		makeRule('unsupportedCheck', { options: {} }),
		makeRule(undefined, { enabled: 'true' }),
		makeRule(undefined, { severity: 'fatal' }),
	]) {
		assert.throws(() => parse(makeDocument([rule])));
	}
	for (const severity of ['info', 'warning', 'error']) {
		assert.doesNotThrow(() => parse(makeDocument([makeRule(undefined, { severity })])));
	}
});

test('validates file-kind names and check compatibility', () => {
	const kinds = ['markdown', 'excalidraw', 'pdf', 'image', 'script', 'video', 'recording', 'other'];
	for (const kind of kinds) {
		assert.doesNotThrow(() => parse(makeDocument([makeRule('filenameCase', {
			scope: { fileKinds: [kind], include: ['**'] },
		})])));
	}
	assert.throws(() => parse(makeDocument([makeRule('filenameCase', {
		scope: { fileKinds: ['archive'], include: ['**'] },
	})])));
	for (const check of ['requiredFrontmatterProperty', 'unresolvedInternalLinks']) {
		assert.throws(() => parse(makeDocument([makeRule(check, {
			scope: { fileKinds: ['pdf'], include: ['**'] },
		})])));
	}
	assert.throws(() => parse(makeDocument([makeRule(undefined, {
		scope: { fileKinds: 'markdown', include: ['**'] },
	})])));
});

test('validates scope fields and requires at least one include pattern', () => {
	for (const scope of [
		{ fileKinds: ['markdown'], include: [] },
		{ fileKinds: ['markdown'], include: 'notes/**' },
		{ fileKinds: ['markdown'], include: ['**'], exclude: 'private/**' },
	]) {
		assert.throws(() => parse(makeDocument([makeRule(undefined, { scope })])));
	}
	assert.doesNotThrow(() => parse(makeDocument([makeRule(undefined, {
		scope: { fileKinds: ['markdown'], include: ['**'], exclude: [] },
	})])));
});

test('validates frontmatter options as a property list and mandatory boolean', () => {
	for (const options of [
		{ caseSensitive: true },
		{ properties: 'aliases', caseSensitive: true },
		{ properties: ['aliases'] },
		{ properties: ['aliases'], caseSensitive: 'true' },
		{ properties: ['aliases'], caseSensitive: true, unknown: 1 },
	]) {
		assert.throws(() => parse(makeDocument([makeRule(undefined, { options })])));
	}
	for (const caseSensitive of [true, false]) {
		assert.doesNotThrow(() => parse(makeDocument([makeRule(undefined, {
			options: { properties: ['aliases', 'tags'], caseSensitive },
		})])));
	}
	assert.throws(() => parse(makeDocument([makeRule(undefined, {
		options: { properties: ['aliases', 1], caseSensitive: true },
	})])));
});

test('validates each supported filename style and rejects other values', () => {
	for (const style of ['camelCase', 'PascalCase', 'snake_case', 'kebab-case']) {
		assert.doesNotThrow(() => parse(makeDocument([makeRule('filenameCase', {
			options: { case: style },
		})])));
	}
	for (const options of [{}, { case: 'Title Case' }, { case: 1 }, { case: 'camelCase', extra: true }]) {
		assert.throws(() => parse(makeDocument([makeRule('filenameCase', { options })])));
	}
});

test('validates unresolved-link status choices and explicit embed option', () => {
	for (const status of ['missing', 'missing_fragment', 'ambiguous']) {
		for (const includeEmbeds of [true, false]) {
			assert.doesNotThrow(() => parse(makeDocument([makeRule('unresolvedInternalLinks', {
				options: { statuses: [status], includeEmbeds },
			})])));
		}
	}
	assert.doesNotThrow(() => parse(makeDocument([makeRule('unresolvedInternalLinks', {
		options: { statuses: ['missing', 'ambiguous'], includeEmbeds: true },
	})])));
	for (const options of [
		{ includeEmbeds: true },
		{ statuses: 'missing', includeEmbeds: true },
		{ statuses: [], includeEmbeds: true },
		{ statuses: ['missing', 'missing'], includeEmbeds: true },
		{ statuses: ['resolved'], includeEmbeds: true },
		{ statuses: ['missing'] },
		{ statuses: ['missing'], includeEmbeds: 'true' },
	]) {
		assert.throws(() => parse(makeDocument([makeRule('unresolvedInternalLinks', { options })])));
	}
});

test('accepts the specified glob subset and rejects malformed or unsupported patterns', () => {
	for (const pattern of ['literal.md', 'notes/*.md', 'notes/note?.md', '**/*.md', 'a/**/b.md', 'version/1.2.md']) {
		assert.doesNotThrow(() => parse(makeDocument([makeRule(undefined, {
			scope: { fileKinds: ['markdown'], include: [pattern] },
		})])), `must accept ${pattern}`);
	}
	for (const pattern of [
		'', '/root.md', 'root.md/', 'C:/root.md', 'notes\\file.md', 'notes//file.md',
		'./root.md', 'notes/../root.md', 'notes/**part/file.md', 'notes/[ab].md',
		'notes/{a,b}.md', '!notes/private.md', '^notes/file$'
	]) {
		assert.throws(() => parse(makeDocument([makeRule(undefined, {
			scope: { fileKinds: ['markdown'], include: [pattern] },
		})])), `must reject ${pattern}`);
	}
});

test('matches whole vault-relative paths with segment-local wildcards', () => {
	const config = parse(makeDocument([
		makeRule(undefined, { id: 'star', scope: { fileKinds: ['markdown'], include: ['notes/a*.md'] } }),
		makeRule(undefined, { id: 'one', scope: { fileKinds: ['markdown'], include: ['notes/note?.md'] } }),
		makeRule(undefined, { id: 'literal', scope: { fileKinds: ['markdown'], include: ['file.md'] } }),
	]));
	const files = [
		{ path: 'notes/a.md', kind: 'markdown' },
		{ path: 'notes/ab.md', kind: 'markdown' },
		{ path: 'notes/a/child.md', kind: 'markdown' },
		{ path: 'notes/note1.md', kind: 'markdown' },
		{ path: 'notes/note12.md', kind: 'markdown' },
		{ path: 'folder/file.md', kind: 'markdown' },
		{ path: 'file.md', kind: 'markdown' },
	];
	assert.deepEqual(matchedPaths('star', config, files), ['notes/a.md', 'notes/ab.md']);
	assert.deepEqual(matchedPaths('one', config, files), ['notes/note1.md']);
	assert.deepEqual(matchedPaths('literal', config, files), ['file.md']);
});

test('matches zero-or-more directories, multiple includes, file kinds, and exclusion precedence', () => {
	const config = parse(makeDocument([makeRule('filenameCase', {
		options: { case: 'camelCase' },
		scope: {
			fileKinds: ['markdown', 'pdf'],
			include: ['**/*.md', 'notes/*.pdf'],
			exclude: ['notes/private/**'],
		},
	})]));
	const files = [
		{ path: 'root.md', kind: 'markdown' },
		{ path: 'notes/one.md', kind: 'markdown' },
		{ path: 'notes/nested/two.md', kind: 'markdown' },
		{ path: 'notes/private/hidden.md', kind: 'markdown' },
		{ path: '.hidden/note.md', kind: 'markdown' },
		{ path: 'notes/one.pdf', kind: 'pdf' },
		{ path: 'notes/one.pdf', kind: 'image' },
	];
	assert.deepEqual(matchedPaths('rule-1', config, files), [
		'root.md', 'notes/one.md', 'notes/nested/two.md', '.hidden/note.md', 'notes/one.pdf',
	]);
});

test('matches path segments case-sensitively', () => {
	const config = parse(makeDocument([makeRule(undefined, {
		scope: { fileKinds: ['markdown'], include: ['Notes/*.md'] },
	})]));
	const files = [
		{ path: 'Notes/A.md', kind: 'markdown' },
		{ path: 'notes/A.md', kind: 'markdown' },
		{ path: 'Notes/A.MD', kind: 'markdown' },
	];
	assert.deepEqual(matchedPaths('rule-1', config, files), ['Notes/A.md']);
});

test('a complete double-star segment spans zero or multiple folders only', () => {
	const config = parse(makeDocument([makeRule(undefined, {
		scope: { fileKinds: ['markdown'], include: ['a/**/b.md'] },
	})]));
	const files = [
		{ path: 'a/b.md', kind: 'markdown' },
		{ path: 'a/x/b.md', kind: 'markdown' },
		{ path: 'a/x/y/b.md', kind: 'markdown' },
		{ path: 'a/x/b.txt', kind: 'markdown' },
	];
	assert.deepEqual(matchedPaths('rule-1', config, files), ['a/b.md', 'a/x/b.md', 'a/x/y/b.md']);
});

test('keeps wildcard semantics when a filename contains an asterisk', () => {
	const config = parse(makeDocument([
		makeRule(undefined, {
			id: 'include-star',
			scope: { fileKinds: ['markdown'], include: ['notes/*.md'] },
		}),
		makeRule(undefined, {
			id: 'exclude-star',
			scope: { fileKinds: ['markdown'], include: ['notes/**'], exclude: ['notes/*.md'] },
		}),
	]));
	const files = [{ path: 'notes/*draft.md', kind: 'markdown' }];

	assert.deepEqual([
		matchedPaths('include-star', config, files),
		matchedPaths('exclude-star', config, files),
	], [['notes/*draft.md'], []]);
});

test('matches ? against exactly one Unicode character', () => {
	const config = parse(makeDocument([
		makeRule(undefined, {
			id: 'one-character',
			scope: { fileKinds: ['markdown'], include: ['notes/note?.md'] },
		}),
		makeRule(undefined, {
			id: 'two-characters',
			scope: { fileKinds: ['markdown'], include: ['notes/note??.md'] },
		}),
	]));
	const files = [{ path: 'notes/note😀.md', kind: 'markdown' }];

	assert.deepEqual([
		matchedPaths('one-character', config, files),
		matchedPaths('two-characters', config, files),
	], [['notes/note😀.md'], []]);
});
