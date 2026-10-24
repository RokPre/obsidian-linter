import type { CheckName, IndexedFile, RuleConfig, Severity } from './rules-config';

export type IndexedFrontmatter =
	| { status: 'absent' }
	| { status: 'valid'; rootProperties: string[] }
	| { status: 'malformed'; message?: string; line?: number };

export type IndexedLinkStatus = 'resolved' | 'external' | 'missing' | 'missing_fragment' | 'ambiguous';

export interface IndexedLinkOccurrence {
	rawTarget: string;
	status: IndexedLinkStatus;
	isEmbed: boolean;
	line?: number;
}

export interface RuleEngineFile extends IndexedFile {
	frontmatter?: IndexedFrontmatter;
	links?: IndexedLinkOccurrence[];
}

export interface RuleEngineInput {
	rules: RuleConfig[];
	files: RuleEngineFile[];
}

export interface RuleDiagnostic {
	ruleId: string;
	check: CheckName;
	severity: Severity;
	path: string;
	message: string;
	line?: number;
}

export interface RuleExecutionFailure {
	ruleId: string;
	check: CheckName;
	message: string;
}

export interface RuleEngineResult {
	diagnostics: RuleDiagnostic[];
	failures: RuleExecutionFailure[];
}

function diagnostic(rule: RuleConfig, file: RuleEngineFile, message: string, line?: number): RuleDiagnostic {
	const result: RuleDiagnostic = {
		ruleId: rule.id,
		check: rule.check,
		severity: rule.severity,
		path: file.path,
		message,
	};
	if (line !== undefined) result.line = line;
	return result;
}

function evaluateRequiredFrontmatter(rule: Extract<RuleConfig, { check: 'requiredFrontmatterProperty' }>, files: RuleEngineFile[]): RuleDiagnostic[] {
	const findings: RuleDiagnostic[] = [];
	for (const file of files) {
		if (file.kind !== 'markdown') continue;
		const frontmatter = file.frontmatter ?? { status: 'absent' as const };
		if (frontmatter.status === 'malformed') {
			const detail = frontmatter.message ? `: ${frontmatter.message}` : '';
			findings.push(diagnostic(rule, file, `Frontmatter could not be parsed${detail}.`, frontmatter.line));
			continue;
		}
		const properties = frontmatter.status === 'valid' ? frontmatter.rootProperties : [];
		const present = new Set(properties.map(name => rule.options.caseSensitive ? name : name.toLocaleLowerCase('en-US')));
		const seen = new Set<string>();
		for (const name of rule.options.properties) {
			const effectiveName = rule.options.caseSensitive ? name : name.toLocaleLowerCase('en-US');
			if (seen.has(effectiveName)) continue;
			seen.add(effectiveName);
			if (!present.has(effectiveName)) {
				findings.push(diagnostic(rule, file, `Required frontmatter property \`${name}\` is missing.`));
			}
		}
	}
	return findings;
}

function isFilenameCase(stem: string, convention: 'camelCase' | 'PascalCase' | 'snake_case' | 'kebab-case'): boolean {
	switch (convention) {
		case 'camelCase': return /^[a-z][A-Za-z0-9]*$/.test(stem);
		case 'PascalCase': return /^[A-Z][A-Za-z0-9]*$/.test(stem);
		case 'snake_case': return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(stem);
		case 'kebab-case': return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stem);
	}
}

function evaluateFilenameCase(rule: Extract<RuleConfig, { check: 'filenameCase' }>, files: RuleEngineFile[]): RuleDiagnostic[] {
	const findings: RuleDiagnostic[] = [];
	for (const file of files) {
		const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
		const extensionStart = basename.lastIndexOf('.');
		const stem = extensionStart < 0 ? basename : basename.slice(0, extensionStart);
		if (!isFilenameCase(stem, rule.options.case)) {
			findings.push(diagnostic(rule, file, `Filename \`${basename}\` does not match \`${rule.options.case}\`.`));
		}
	}
	return findings;
}

function evaluateUnresolvedLinks(rule: Extract<RuleConfig, { check: 'unresolvedInternalLinks' }>, files: RuleEngineFile[]): RuleDiagnostic[] {
	const findings: RuleDiagnostic[] = [];
	const statuses = new Set(rule.options.statuses);
	for (const file of files) {
		if (file.kind !== 'markdown') continue;
		for (const occurrence of file.links ?? []) {
			if (!statuses.has(occurrence.status as 'missing' | 'missing_fragment' | 'ambiguous')) continue;
			if (occurrence.isEmbed && !rule.options.includeEmbeds) continue;
			let message: string;
			switch (occurrence.status) {
			case 'missing':
				message = `Internal link \`${occurrence.rawTarget}\` could not be resolved in the indexed vault.`;
				break;
			case 'missing_fragment':
				message = `Internal link \`${occurrence.rawTarget}\` points to a missing fragment in the indexed vault.`;
				break;
			case 'ambiguous':
				message = `Internal link \`${occurrence.rawTarget}\` is ambiguous in the indexed vault.`;
				break;
			default:
				continue;
			}
			findings.push(diagnostic(rule, file, message, occurrence.line));
		}
	}
	return findings;
}

export function evaluateRules(input: RuleEngineInput): RuleEngineResult {
	const result: RuleEngineResult = { diagnostics: [], failures: [] };
	for (const rule of input.rules) {
		if (!rule.enabled) continue;
		try {
			switch (rule.check) {
			case 'requiredFrontmatterProperty':
				for (const finding of evaluateRequiredFrontmatter(rule, input.files)) result.diagnostics.push(finding);
				break;
			case 'filenameCase':
				for (const finding of evaluateFilenameCase(rule, input.files)) result.diagnostics.push(finding);
				break;
			case 'unresolvedInternalLinks':
				for (const finding of evaluateUnresolvedLinks(rule, input.files)) result.diagnostics.push(finding);
				break;
			}
		} catch (error) {
			result.failures.push({
				ruleId: rule.id,
				check: rule.check,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}
