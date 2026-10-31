import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type { RuleDiagnostic } from './rules-engine';

export const DIAGNOSTICS_VIEW_TYPE = 'linter-diagnostics';

export type DiagnosticsOutcome =
	| { status: 'completed'; diagnostics: RuleDiagnostic[] }
	| { status: 'failed'; message: string };

export class DiagnosticsView extends ItemView {
	private outcome: DiagnosticsOutcome = { status: 'completed', diagnostics: [] };
	private domListenerCleanups: Array<() => void> = [];
	private activateFinding: ((finding: RuleDiagnostic) => void) | undefined;

	constructor(leaf: WorkspaceLeaf, activateFinding: (finding: RuleDiagnostic) => void) {
		super(leaf);
		this.activateFinding = activateFinding;
	}

	getViewType() {
		return DIAGNOSTICS_VIEW_TYPE;
	}

	getDisplayText() {
		return 'Linter diagnostics';
	}

	async onOpen() {
		this.render();
	}

	async onClose() {
		this.clearListeners();
		this.activateFinding = undefined;
		this.outcome = { status: 'completed', diagnostics: [] };
		this.contentEl.empty();
	}

	setOutcome(outcome: DiagnosticsOutcome) {
		this.outcome = outcome;
		this.render();
	}

	private clearListeners() {
		for (const removeListener of this.domListenerCleanups) removeListener();
		this.domListenerCleanups = [];
	}

	private render() {
		this.clearListeners();
		this.contentEl.empty();
		this.contentEl.addClass('linter-diagnostics-view');
		const results = this.contentEl.createDiv({ cls: 'linter-diagnostics-results' });
		results.setAttribute('role', 'region');
		results.setAttribute('aria-label', 'Linter diagnostics results');

		if (this.outcome.status === 'failed') {
			results.createDiv({
				cls: 'linter-diagnostics-failure',
				text: `Checks failed: ${this.outcome.message}`,
			});
			return;
		}

		if (this.outcome.diagnostics.length === 0) {
			results.createDiv({
				cls: 'linter-diagnostics-empty',
				text: 'No diagnostics found.',
			});
			return;
		}

		for (const finding of this.outcome.diagnostics) {
			const entry = results.createEl('button', {
				cls: 'linter-diagnostic',
				attr: { type: 'button' },
			});
			entry.createSpan({ cls: 'linter-diagnostic-rule', text: finding.ruleId });
			entry.createSpan({ cls: 'linter-diagnostic-severity', text: finding.severity });
			entry.createSpan({ cls: 'linter-diagnostic-path', text: finding.path });
			if (finding.line !== undefined) {
				entry.createSpan({ cls: 'linter-diagnostic-line', text: `Line ${finding.line}` });
			}
			entry.createSpan({ cls: 'linter-diagnostic-message', text: finding.message });
			if (this.activateFinding) {
				const activateFinding = this.activateFinding;
				const onClick = () => activateFinding(finding);
				entry.addEventListener('click', onClick);
				this.domListenerCleanups.push(() => entry.removeEventListener('click', onClick));
			}
		}
	}
}
