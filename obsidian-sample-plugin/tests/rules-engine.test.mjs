import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
let api;
let workRoot;

before(async () => {
	workRoot = await mkdtemp(join(tmpdir(), 'rules-engine-tests-'));
	const bundlePath = join(workRoot, 'rules-engine.mjs');
	await build({
		entryPoints: [join(PLUGIN_DIR, 'src', 'rules-engine.ts')],
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

const options = {
	requiredFrontmatterProperty: { properties: ['aliases'], caseSensitive: true },
	filenameCase: { case: 'camelCase' },
	unresolvedInternalLinks: { statuses: ['missing', 'missing_fragment', 'ambiguous'], includeEmbeds: false },
};

function rule(check, overrides = {}) {
	return {
		id: `${check}-rule`, check, enabled: true, severity: 'warning',
		scope: { fileKinds: ['markdown'], include: ['**'] }, options: options[check], ...overrides,
	};
}

function file(path, data = {}) {
	return { path, kind: 'markdown', ...data };
}

function evaluate(rules, files) {
	return api.evaluateRules({ rules, files });
}

function diagnostics(result) {
	return [...result.diagnostics].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('required properties deduplicate effective names and compare according to case sensitivity', () => {
	const target = file('notes/Target.md', { frontmatter: { status: 'valid', rootProperties: [] } });
	const caseInsensitive = rule('requiredFrontmatterProperty', {
		id: 'insensitive', severity: 'error', options: { properties: ['Alias', 'alias', 'missing', 'missing'], caseSensitive: false },
	});
	const caseSensitive = rule('requiredFrontmatterProperty', {
		id: 'sensitive', severity: 'info', options: { properties: ['Alias', 'alias'], caseSensitive: true },
	});
	const result = evaluate([caseInsensitive, caseSensitive], [target]);
	assert.equal(result.failures.length, 0);
	assert.deepEqual(result.diagnostics.map(({ ruleId, severity, message, path, check, line }) => ({ ruleId, severity, message, path, check, line })), [
		{ ruleId: 'insensitive', severity: 'error', message: 'Required frontmatter property `Alias` is missing.', path: target.path, check: 'requiredFrontmatterProperty', line: undefined },
		{ ruleId: 'insensitive', severity: 'error', message: 'Required frontmatter property `missing` is missing.', path: target.path, check: 'requiredFrontmatterProperty', line: undefined },
		{ ruleId: 'sensitive', severity: 'info', message: 'Required frontmatter property `Alias` is missing.', path: target.path, check: 'requiredFrontmatterProperty', line: undefined },
		{ ruleId: 'sensitive', severity: 'info', message: 'Required frontmatter property `alias` is missing.', path: target.path, check: 'requiredFrontmatterProperty', line: undefined },
	]);
	assert.ok(result.diagnostics.every((diagnostic) => !Object.hasOwn(diagnostic, 'line')));
	assert.deepEqual(diagnostics(evaluate([caseSensitive, caseInsensitive], [target])), diagnostics(result));
});
test('required property matching applies case sensitivity to existing root names', () => {
	const target = file('notes/Target.md', { frontmatter: { status: 'valid', rootProperties: ['ALIASES'] } });
	const insensitive = rule('requiredFrontmatterProperty', {
		id: 'insensitive-existing', options: { properties: ['aliases'], caseSensitive: false },
	});
	const sensitive = rule('requiredFrontmatterProperty', {
		id: 'sensitive-existing', options: { properties: ['aliases'], caseSensitive: true },
	});
	const result = evaluate([insensitive, sensitive], [target]);
	assert.equal(result.failures.length, 0);
	assert.deepEqual(result.diagnostics.map(({ ruleId, check, message, path }) => ({ ruleId, check, message, path })), [
		{
			ruleId: sensitive.id,
			check: 'requiredFrontmatterProperty',
			message: 'Required frontmatter property `aliases` is missing.',
			path: target.path,
		},
	]);
});


test('required properties need only exist at the frontmatter root, regardless of value', () => {
	const target = file('notes/Target.md', {
		frontmatter: { status: 'valid', rootProperties: ['nullValue', 'emptyList', 'emptyString', 'objectValue'] },
	});
	const configured = rule('requiredFrontmatterProperty', {
		options: { properties: ['nullValue', 'emptyList', 'emptyString', 'objectValue', 'nestedOnly'], caseSensitive: true },
	});
	const result = evaluate([configured], [target]);
	assert.deepEqual(result.diagnostics.map(({ message }) => message), [
		'Required frontmatter property `nestedOnly` is missing.',
	]);
});

test('absent frontmatter reports each distinct property while malformed frontmatter is attributed and skipped', () => {
	const absent = file('notes/Absent.md');
	const malformedWithLine = file('notes/Bad.md', {
		frontmatter: { status: 'malformed', message: 'Unexpected token', line: 4 },
	});
	const malformedWithoutLine = file('notes/Bad2.md', {
		frontmatter: { status: 'malformed', message: 'Invalid YAML' },
	});
	const oneRule = rule('requiredFrontmatterProperty', { options: { properties: ['aliases', 'tags'], caseSensitive: true } });
	const secondRule = rule('requiredFrontmatterProperty', { id: 'second', severity: 'error' });
	const result = evaluate([oneRule, secondRule], [absent, malformedWithLine, malformedWithoutLine]);
	assert.deepEqual(result.diagnostics.filter(({ path }) => path === absent.path).map(({ message }) => message), [
		'Required frontmatter property `aliases` is missing.', 'Required frontmatter property `tags` is missing.',
		'Required frontmatter property `aliases` is missing.',
	]);
	const malformed = result.diagnostics.filter(({ path }) => path !== absent.path);
	assert.equal(malformed.length, 4);
	assert.ok(malformed.every(({ message }) => message.toLowerCase().includes('frontmatter') && !message.includes('is missing.')));
	assert.deepEqual(malformed.map(({ path, ruleId, line }) => ({ path, ruleId, line })).sort((a, b) => `${a.path}:${a.ruleId}`.localeCompare(`${b.path}:${b.ruleId}`)), [
		{ path: malformedWithLine.path, ruleId: oneRule.id, line: 4 },
		{ path: malformedWithLine.path, ruleId: secondRule.id, line: 4 },
		{ path: malformedWithoutLine.path, ruleId: oneRule.id, line: undefined },
		{ path: malformedWithoutLine.path, ruleId: secondRule.id, line: undefined },
	]);
	assert.ok(malformed.filter(({ path }) => path === malformedWithoutLine.path).every((diagnostic) => !Object.hasOwn(diagnostic, 'line')));
});

test('filenameCase validates only the basename stem after its final extension', () => {
	const cases = [
		['camelCase', ['cameraModel', 'note2', 'myHTTP2'], ['CameraModel', '2note', 'camera-model', 'éclair']],
		['PascalCase', ['CameraModel', 'XMLParser2'], ['cameraModel', '2Camera', 'Camera_Model']],
		['snake_case', ['camera_model', 'camera2_model', 'camera_2model'], ['Camera_model', '_camera', 'camera_', 'camera__model', 'camera-model']],
		['kebab-case', ['camera-model', 'camera2-model', 'camera-2model'], ['Camera-model', '-camera', 'camera-', 'camera--model', 'camera_model']],
	];
	for (const [convention, accepted, rejected] of cases) {
		const configured = rule('filenameCase', { options: { case: convention } });
		const result = evaluate([configured], [
			...accepted.map((name) => file(`UPPER_DIRECTORY/${name}.mD`)),
			...rejected.map((name) => file(`lower_directory/${name}.md`)),
		]);
		assert.deepEqual(result.diagnostics.map(({ path }) => path), rejected.map((name) => `lower_directory/${name}.md`));
		assert.ok(result.diagnostics.every(({ message, ...diagnostic }) => message.includes(`\`${convention}\``) && !Object.hasOwn(diagnostic, 'line')));
	}
});

test('filenameCase handles empty and dotted stems without stripping more than the final extension', () => {
	const configured = rule('filenameCase', { options: { case: 'camelCase' } });
	const result = evaluate([configured], [file('.md'), file('notes/Upper.MD'), file('notes/good.name.md'), file('notes/.hidden.md')]);
	assert.deepEqual(result.diagnostics.map(({ path, message }) => ({ path, message })), [
		{ path: '.md', message: 'Filename `.md` does not match `camelCase`.' },
		{ path: 'notes/Upper.MD', message: 'Filename `Upper.MD` does not match `camelCase`.' },
		{ path: 'notes/good.name.md', message: 'Filename `good.name.md` does not match `camelCase`.' },
		{ path: 'notes/.hidden.md', message: 'Filename `.hidden.md` does not match `camelCase`.' },
	]);
	assert.ok(result.diagnostics.every((diagnostic) => !Object.hasOwn(diagnostic, 'line')));
});

test('unresolved links report each selected occurrence and preserve status, raw target, line, and rule attribution', () => {
	const source = file('notes/source.md', { links: [
		{ rawTarget: 'missingNote', status: 'missing', isEmbed: false, line: 3 },
		{ rawTarget: 'missingNote', status: 'missing', isEmbed: false, line: 8 },
		{ rawTarget: 'Page#Heading', status: 'missing_fragment', isEmbed: false },
		{ rawTarget: '[[Ambiguous]] & target', status: 'ambiguous', isEmbed: false, line: 12 },
		{ rawTarget: 'resolved', status: 'resolved', isEmbed: false },
		{ rawTarget: 'external', status: 'external', isEmbed: false },
	] });
	const configured = rule('unresolvedInternalLinks', { id: 'links', severity: 'error' });
	const duplicate = rule('unresolvedInternalLinks', { id: 'links-2', severity: 'info', options: { statuses: ['missing'], includeEmbeds: false } });
	const result = evaluate([configured, duplicate], [source]);
	assert.equal(result.failures.length, 0);
	const findings = result.diagnostics.filter(({ ruleId }) => ruleId === configured.id);
	assert.deepEqual(findings, [
		{ ruleId: 'links', check: 'unresolvedInternalLinks', severity: 'error', path: source.path, message: 'Internal link `missingNote` could not be resolved in the indexed vault.', line: 3 },
		{ ruleId: 'links', check: 'unresolvedInternalLinks', severity: 'error', path: source.path, message: 'Internal link `missingNote` could not be resolved in the indexed vault.', line: 8 },
		{ ruleId: 'links', check: 'unresolvedInternalLinks', severity: 'error', path: source.path, message: 'Internal link `Page#Heading` points to a missing fragment in the indexed vault.', },
		{ ruleId: 'links', check: 'unresolvedInternalLinks', severity: 'error', path: source.path, message: 'Internal link `[[Ambiguous]] & target` is ambiguous in the indexed vault.', line: 12 },
	]);
	assert.equal(result.diagnostics.filter(({ ruleId }) => ruleId === duplicate.id).length, 2);
	assert.ok(findings[2] && !Object.hasOwn(findings[2], 'line'));
	assert.deepEqual(result.diagnostics.map(({ ruleId, message }) => [ruleId, message]).filter(([ruleId]) => ruleId === duplicate.id).map(([, message]) => message), [
		'Internal link `missingNote` could not be resolved in the indexed vault.',
		'Internal link `missingNote` could not be resolved in the indexed vault.',
	]);
});

test('unresolved-link status selection and embed option include frontmatter and image-reference occurrences', () => {
	const source = file('notes/source.md', { links: [
		// The indexed occurrence list includes links sourced from frontmatter.
		{ rawTarget: 'ordinary', status: 'missing', isEmbed: false },
		{ rawTarget: 'image.png', status: 'missing', isEmbed: true },
		{ rawTarget: 'fragment', status: 'missing_fragment', isEmbed: false },
		{ rawTarget: 'ambiguous', status: 'ambiguous', isEmbed: false },
		{ rawTarget: 'frontmatter-link', status: 'missing', isEmbed: false },
	] });
	const ordinaryOnly = rule('unresolvedInternalLinks', { options: { statuses: ['missing_fragment', 'ambiguous'], includeEmbeds: false } });
	const includeEmbeds = rule('unresolvedInternalLinks', { id: 'embeds', options: { statuses: ['missing', 'missing_fragment'], includeEmbeds: true } });
	const result = evaluate([ordinaryOnly, includeEmbeds], [source]);
	assert.deepEqual(result.diagnostics.map(({ ruleId, message }) => [ruleId, message]), [
		[ordinaryOnly.id, 'Internal link `fragment` points to a missing fragment in the indexed vault.'],
		[ordinaryOnly.id, 'Internal link `ambiguous` is ambiguous in the indexed vault.'],
		[includeEmbeds.id, 'Internal link `ordinary` could not be resolved in the indexed vault.'],
		[includeEmbeds.id, 'Internal link `image.png` could not be resolved in the indexed vault.'],
		[includeEmbeds.id, 'Internal link `fragment` points to a missing fragment in the indexed vault.'],
		[includeEmbeds.id, 'Internal link `frontmatter-link` could not be resolved in the indexed vault.'],
	]);
});
test('embed selection changes only whether matching embed occurrences are reported', () => {
	const source = file('notes/source.md', { links: [
		{ rawTarget: 'ordinary', status: 'missing', isEmbed: false },
		{ rawTarget: 'image.png', status: 'missing', isEmbed: true },
	] });
	const ordinaryOnly = rule('unresolvedInternalLinks', {
		id: 'ordinary-only',
		options: { statuses: ['missing'], includeEmbeds: false },
	});
	const withEmbeds = rule('unresolvedInternalLinks', {
		id: 'with-embeds',
		options: { statuses: ['missing'], includeEmbeds: true },
	});
	const result = evaluate([ordinaryOnly, withEmbeds], [source]);
	assert.equal(result.failures.length, 0);
	assert.deepEqual(result.diagnostics.map(({ ruleId, message }) => [ruleId, message]), [
		[ordinaryOnly.id, 'Internal link `ordinary` could not be resolved in the indexed vault.'],
		[withEmbeds.id, 'Internal link `ordinary` could not be resolved in the indexed vault.'],
		[withEmbeds.id, 'Internal link `image.png` could not be resolved in the indexed vault.'],
	]);
});

test('large unresolved-link results are fully retained alongside independent findings', () => {
	const occurrenceCount = 250_000;
	const source = file('notes/source.md', {
		links: Array.from({ length: occurrenceCount }, (_, index) => ({
			rawTarget: `missing-${index}`,
			status: 'missing',
			isEmbed: false,
			line: index + 1,
		})),
	});
	const invalidFilename = file('notes/BadName.md');
	const links = rule('unresolvedInternalLinks', { id: 'large-links', severity: 'error' });
	const filename = rule('filenameCase', { id: 'independent-filename', options: { case: 'camelCase' } });
	const result = evaluate([links, filename], [source, invalidFilename]);
	assert.deepEqual(result.failures, []);
	const linkFindings = result.diagnostics.filter(({ ruleId }) => ruleId === links.id);
	assert.equal(linkFindings.length, occurrenceCount);
	assert.ok(linkFindings.every(({ check, severity, path }) =>
		check === 'unresolvedInternalLinks' && severity === 'error' && path === source.path));
	assert.deepEqual(linkFindings[0], {
		ruleId: links.id,
		check: 'unresolvedInternalLinks',
		severity: 'error',
		path: source.path,
		message: 'Internal link `missing-0` could not be resolved in the indexed vault.',
		line: 1,
	});
	assert.deepEqual(linkFindings.at(-1), {
		ruleId: links.id,
		check: 'unresolvedInternalLinks',
		severity: 'error',
		path: source.path,
		message: `Internal link \`missing-${occurrenceCount - 1}\` could not be resolved in the indexed vault.`,
		line: occurrenceCount,
	});
	assert.deepEqual(result.diagnostics.filter(({ ruleId }) => ruleId === filename.id), [{
		ruleId: filename.id,
		check: 'filenameCase',
		severity: 'warning',
		path: invalidFilename.path,
		message: 'Filename `BadName.md` does not match `camelCase`.',
	}]);
});

test('engine separates per-rule failures and continues evaluating independent rules', () => {
	const invalidRule = rule('requiredFrontmatterProperty', { id: 'broken', options: { properties: null, caseSensitive: true } });
	const validRule = rule('filenameCase', { id: 'still-runs', options: { case: 'camelCase' } });
	const result = evaluate([invalidRule, validRule], [file('notes/BadName.md')]);
	assert.equal(result.diagnostics.length, 1);
	assert.equal(result.diagnostics[0].ruleId, validRule.id);
	assert.equal(result.failures.length, 1);
	assert.equal(result.failures[0].ruleId, invalidRule.id);
	assert.equal(result.failures[0].check, invalidRule.check);
	assert.equal(typeof result.failures[0].message, 'string');
});
