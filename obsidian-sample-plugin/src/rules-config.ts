const FILE_KINDS = {
	markdown: true,
	excalidraw: true,
	pdf: true,
	image: true,
	script: true,
	video: true,
	recording: true,
	other: true,
} as const;

export type FileKind = keyof typeof FILE_KINDS;
const CHECK_NAMES = {
	requiredFrontmatterProperty: true,
	filenameCase: true,
	unresolvedInternalLinks: true,
} as const;
export type CheckName = keyof typeof CHECK_NAMES;
const SEVERITIES = { info: true, warning: true, error: true } as const;
export type Severity = keyof typeof SEVERITIES;
const FILENAME_CASES = { camelCase: true, PascalCase: true, snake_case: true, 'kebab-case': true } as const;
type FilenameCase = keyof typeof FILENAME_CASES;
const LINK_STATUSES = { missing: true, missing_fragment: true, ambiguous: true } as const;
type LinkStatus = keyof typeof LINK_STATUSES;

const REGEX_ONLY_SYNTAX: Record<string, true> = {
	'^': true,
	'$': true,
	'+': true,
	'(': true,
	')': true,
	'|': true,
};
const BRACKET_AND_BRACE_SYNTAX: Record<string, true> = {
	'[': true,
	']': true,
	'{': true,
	'}': true,
};

export interface IndexedFile {
	path: string;
	kind: FileKind;
}

interface Scope {
	fileKinds: FileKind[];
	include: string[];
	exclude?: string[];
}

interface BaseRule {
	id: string;
	check: CheckName;
	enabled: boolean;
	severity: Severity;
	scope: Scope;
}

export interface RequiredFrontmatterOptions {
	properties: string[];
	caseSensitive: boolean;
}

export interface FilenameCaseOptions {
	case: FilenameCase;
}

export interface UnresolvedInternalLinksOptions {
	statuses: LinkStatus[];
	includeEmbeds: boolean;
}

export type RuleConfig =
	| (BaseRule & { check: 'requiredFrontmatterProperty'; options: RequiredFrontmatterOptions })
	| (BaseRule & { check: 'filenameCase'; options: FilenameCaseOptions })
	| (BaseRule & { check: 'unresolvedInternalLinks'; options: UnresolvedInternalLinksOptions });

export interface RulesConfig {
	version: 1;
	rules: RuleConfig[];
}

export interface RuleMatches {
	ruleId: string;
	files: IndexedFile[];
}

function hasExactKeys(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object);
	return required.every(key => Object.prototype.hasOwnProperty.call(object, key))
		&& keys.every(key => required.includes(key) || optional.includes(key));
}

function invalid(location: string, expectation: string): never {
	throw new Error(`${location}: ${expectation}`);
}

function validatePattern(value: unknown, location: string): string {
	if (typeof value !== 'string' || value.length === 0) {
		return invalid(location, 'expected a non-empty pattern');
	}
	if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('//')) {
		return invalid(location, 'pattern must be a vault-relative path using single / separators');
	}
	if (/^[A-Za-z]:/.test(value)) {
		return invalid(location, 'Windows drive prefixes are not supported');
	}
	if (value.startsWith('!')) {
		return invalid(location, 'leading ! negation is not supported; use exclude instead');
	}
	for (const character of value) {
		if (Object.prototype.hasOwnProperty.call(BRACKET_AND_BRACE_SYNTAX, character)) {
			return invalid(location, 'bracket expressions and brace expansion are not supported');
		}
		if (Object.prototype.hasOwnProperty.call(REGEX_ONLY_SYNTAX, character)) {
			return invalid(location, 'regular-expression syntax is not supported');
		}
	}

	for (const segment of value.split('/')) {
		if (segment === '.' || segment === '..') {
			return invalid(location, 'dot path segments are not supported');
		}
		if (segment.includes('**') && segment !== '**') {
			return invalid(location, '** is supported only as a complete path segment');
		}
	}
	return value;
}

function validateStringArray(value: unknown, location: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
		return invalid(location, 'expected an array of strings');
	}
	return value;
}

function validateScope(value: unknown, check: CheckName, location: string): Scope {
	if (!hasExactKeys(value, ['fileKinds', 'include'], ['exclude'])) {
		return invalid(location, 'expected fileKinds, include, and optional exclude keys');
	}
	if (!Array.isArray(value.fileKinds) || !value.fileKinds.every(
		kind => typeof kind === 'string' && Object.prototype.hasOwnProperty.call(FILE_KINDS, kind),
	)) {
		return invalid(`${location}.fileKinds`, 'contains an unsupported file kind');
	}

	const fileKinds = value.fileKinds as FileKind[];
	if (check !== 'filenameCase' && fileKinds.some(kind => kind !== 'markdown')) {
		return invalid(`${location}.fileKinds`, `${check} supports only markdown files`);
	}
	const includes = validateStringArray(value.include, `${location}.include`);
	if (includes.length === 0) return invalid(`${location}.include`, 'must contain at least one pattern');
	const include = includes.map((pattern, index) => validatePattern(pattern, `${location}.include[${index}]`));
	let exclude: string[] | undefined;
	if (Object.prototype.hasOwnProperty.call(value, 'exclude')) {
		const excludes = validateStringArray(value.exclude, `${location}.exclude`);
		exclude = excludes.map((pattern, index) => validatePattern(pattern, `${location}.exclude[${index}]`));
	}
	return { fileKinds, include, ...(exclude === undefined ? {} : { exclude }) };
}

function validateOptions(check: CheckName, value: unknown, location: string): RuleConfig['options'] {
	switch (check) {
		case 'requiredFrontmatterProperty': {
			if (!hasExactKeys(value, ['properties', 'caseSensitive'])) {
				return invalid(location, 'expected properties and caseSensitive keys');
			}
			const properties = validateStringArray(value.properties, `${location}.properties`);
			if (typeof value.caseSensitive !== 'boolean') {
				return invalid(`${location}.caseSensitive`, 'expected a boolean');
			}
			return { properties, caseSensitive: value.caseSensitive };
		}
		case 'filenameCase':
			if (!hasExactKeys(value, ['case'])
				|| typeof value.case !== 'string'
				|| !Object.prototype.hasOwnProperty.call(FILENAME_CASES, value.case)) {
				return invalid(`${location}.case`, 'expected camelCase, PascalCase, snake_case, or kebab-case');
			}
			return { case: value.case as FilenameCase };
		case 'unresolvedInternalLinks': {
			if (!hasExactKeys(value, ['statuses', 'includeEmbeds'])) {
				return invalid(location, 'expected statuses and includeEmbeds keys');
			}
			if (!Array.isArray(value.statuses)
				|| value.statuses.length === 0
				|| !value.statuses.every(status => typeof status === 'string'
					&& Object.prototype.hasOwnProperty.call(LINK_STATUSES, status))
				|| new Set(value.statuses).size !== value.statuses.length) {
				return invalid(`${location}.statuses`, 'expected a non-empty list of unique supported statuses');
			}
			if (typeof value.includeEmbeds !== 'boolean') {
				return invalid(`${location}.includeEmbeds`, 'expected a boolean');
			}
			return {
				statuses: value.statuses as LinkStatus[],
				includeEmbeds: value.includeEmbeds,
			};
		}
	}
}

function validateRule(value: unknown, index: number): RuleConfig {
	const location = `rules[${index}]`;
	if (!hasExactKeys(value, ['id', 'check', 'enabled', 'severity', 'scope', 'options'])) {
		return invalid(location, 'expected exactly id, check, enabled, severity, scope, and options keys');
	}
	if (typeof value.id !== 'string' || value.id.trim().length === 0) {
		return invalid(`${location}.id`, 'expected a non-blank string');
	}
	if (typeof value.check !== 'string' || !Object.prototype.hasOwnProperty.call(CHECK_NAMES, value.check)) {
		return invalid(`${location}.check`, 'unsupported check name');
	}
	if (typeof value.enabled !== 'boolean') return invalid(`${location}.enabled`, 'expected a boolean');
	if (typeof value.severity !== 'string' || !Object.prototype.hasOwnProperty.call(SEVERITIES, value.severity)) {
		return invalid(`${location}.severity`, 'expected info, warning, or error');
	}

	const check = value.check as CheckName;
	return {
		id: value.id,
		check,
		enabled: value.enabled,
		severity: value.severity as Severity,
		scope: validateScope(value.scope, check, `${location}.scope`),
		options: validateOptions(check, value.options, `${location}.options`),
	} as RuleConfig;
}

export function parseRulesConfig(source: string): RulesConfig {
	const document: unknown = JSON.parse(source);
	if (!hasExactKeys(document, ['version', 'rules'])) {
		return invalid('config', 'expected exactly version and rules keys');
	}
	if (document.version !== 1) return invalid('version', 'only version 1 is supported');
	if (!Array.isArray(document.rules)) return invalid('rules', 'expected an array of rules');

	const ids = new Set<string>();
	const rules = document.rules.map((rule, index) => {
		const validated = validateRule(rule, index);
		if (ids.has(validated.id)) return invalid(`rules[${index}].id`, 'must be unique');
		ids.add(validated.id);
		return validated;
	});
	return { version: 1, rules };
}

function matchSegment(pattern: string, value: string): boolean {
	let patternIndex = 0;
	let valueIndex = 0;
	let starIndex = -1;
	let retryValueIndex = 0;

	while (valueIndex < value.length) {
		const patternCharacter = pattern.codePointAt(patternIndex);
		const valueCharacter = value.codePointAt(valueIndex)!;
		if (patternCharacter === 42) {
			starIndex = patternIndex++;
			retryValueIndex = valueIndex;
		} else if (patternCharacter === 63) {
			patternIndex++;
			valueIndex += valueCharacter > 0xffff ? 2 : 1;
		} else if (patternCharacter === valueCharacter) {
			patternIndex += patternCharacter > 0xffff ? 2 : 1;
			valueIndex += valueCharacter > 0xffff ? 2 : 1;
		} else if (starIndex !== -1) {
			patternIndex = starIndex + 1;
			const retryCharacter = value.codePointAt(retryValueIndex)!;
			retryValueIndex += retryCharacter > 0xffff ? 2 : 1;
			valueIndex = retryValueIndex;
		} else {
			return false;
		}
	}
	while (pattern[patternIndex] === '*') patternIndex++;
	return patternIndex === pattern.length;
}

function matchPath(pattern: string, filePath: string): boolean {
	const patternSegments = pattern.split('/');
	const pathSegments = filePath.split('/');
	const memo = new Map<number, Map<number, boolean>>();

	function match(patternIndex: number, pathIndex: number): boolean {
		if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
		let row = memo.get(patternIndex);
		const cached = row?.get(pathIndex);
		if (cached !== undefined) return cached;

		const segment = patternSegments[patternIndex]!;
		const matched = segment === '**'
			? match(patternIndex + 1, pathIndex)
				|| (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1))
			: pathIndex < pathSegments.length
				&& matchSegment(segment, pathSegments[pathIndex]!)
				&& match(patternIndex + 1, pathIndex + 1);
		if (row === undefined) {
			row = new Map<number, boolean>();
			memo.set(patternIndex, row);
		}
		row.set(pathIndex, matched);
		return matched;
	}

	return match(0, 0);
}

export function matchRulesToFiles(config: RulesConfig, files: readonly IndexedFile[]): RuleMatches[] {
	return config.rules.map(rule => ({
		ruleId: rule.id,
		files: files.filter(file => rule.scope.fileKinds.includes(file.kind)
			&& rule.scope.include.some(pattern => matchPath(pattern, file.path))
			&& !(rule.scope.exclude ?? []).some(pattern => matchPath(pattern, file.path))),
	}));
}
