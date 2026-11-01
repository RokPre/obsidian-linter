# Diagnostics sidebar for linter findings

## Status and authority

**Status:** Requirements prepared; awaiting user approval before implementation. No implementation or verification work is authorized by this specification alone.

## Feature identity and source

- Selected backlog item: `add_a_diagnostics`, from the original repository's root `TODO.md`, source revision `b58d0f9c0e4d8a663239db3a41b1c3473964764e`.
- Selected request: **“Add a diagnostics sidebar for linter findings.”** The full selected backlog request, including all child items, is preserved below.
- Target worktree: `/home/rok/offline/tmp/obsidian-linter-diagnostics-sidebar`.
- Original checkout `/home/rok/sync/obsidian-linter` is read-only for this task. The unrelated prior specification is preserved at `docs/inode-move-spec.md`; this document is the diagnostics feature's root `SPEC.md`.

### Selected backlog request, preserved in full

> Add a diagnostics sidebar for linter findings.
>
> - Define the view input: rule ID, check, severity, vault-relative file path, message, and optional one-based line.
> - Register a dedicated Obsidian diagnostics view type.
> - Add a command to open the diagnostics view in the right sidebar.
> - Add a command to open the diagnostics view in the left sidebar.
> - Reuse an existing diagnostics view when either command is run again.
> - Add a vertically scrollable results container.
> - Render each finding with its rule ID, severity, file path, and message.
> - Display the line number when a finding provides one.
> - Show an empty-results message when there are no findings.
> - Replace the previous findings when a new health-check result arrives.
> - Make finding entries keyboard-accessible buttons.
> - Resolve the clicked finding's vault-relative path to an Obsidian file.
> - Open that file in an editor without replacing the diagnostics sidebar.
> - Convert a supplied one-based line to the editor's zero-based line.
> - Place the editor cursor on that line and scroll it into view.
> - Open findings without a line normally, without forcing a cursor position.
> - Show a notice instead of throwing if the file no longer exists.
> - Clear view-owned listeners and references when the view closes.
> - Verify both sidebar commands open or reuse the diagnostics view.
> - Verify a long findings list scrolls inside the sidebar.
> - Verify clicking a finding with a line opens the correct file and line.
> - Verify clicking a finding without a line opens the correct file.
> - Verify clicking a finding for a deleted file shows the notice.

The source TODO expresses the parent and children at `/home/rok/sync/obsidian-linter/TODO.md:24-47`; child IDs and parent grouping are listed at lines 172-174. No child adds requirements beyond the full descriptions preserved above.

## Problem and goal

The **Run checks** settings action currently receives structured rule diagnostics and execution failures, logs them to the console, and reports counts; there is no diagnostics sidebar. The goal is to make findings available in a dedicated, navigable sidebar, with commands to reveal it on either side, while preserving the latest completed findings or whole-run failure state even when the view is closed.

## Existing behavior and evidence

- `RuleDiagnostic` in `obsidian-sample-plugin/src/rules-engine.ts` has `ruleId`, `check`, `severity`, vault-relative `path`, `message`, and optional `line`; the line is one-based and omitted when unavailable.
- `runChecksForVault` returns `diagnostics` and `failures` separately. The worker and `IndexerClient.runChecks` transport that result to the settings tab.
- `obsidian-sample-plugin/src/settings.ts` handles **Run checks**: it logs each diagnostic and failure and reports finding/failure counts and clean/partial status. If the operation throws before returning a result, it logs the error and displays a `Notice` containing the rules-file path and error message. It does not currently publish findings to a view.
- `main.ts` owns plugin initialization and command registration. Existing code has no custom diagnostics view or workspace-view reuse convention. Existing tests cover diagnostics generation/transport and settings result handling, but not this sidebar behavior.
- `docs/TOC.md` indexes active-plugin entry points and tests; no additional diagnostics-view convention is documented.

These are repository facts, not implementation prescriptions. The existing diagnostic payload already supplies the requested view input; changing the worker payload is not required by the backlog.

## Required behavior

1. The view accepts findings with `ruleId`, `check`, `severity`, vault-relative `path`, `message`, and optional one-based `line`. Findings are the diagnostics in a completed check result; execution failures remain a separate result category.
2. Register one dedicated Obsidian diagnostics view type and commands for requesting it on the right and left sidebar.
3. If a diagnostics view already exists, reuse and reveal that view. **User decision:** if it is currently on the side opposite the command's requested side, reveal it in place; do not move it. Running a command again must not create a duplicate view.
4. A completed checks result replaces the prior findings, including replacement with an empty list and results with partial rule failures. Keep the latest findings available in plugin/view state while the view is closed; receiving results while closed must not open it. If it is already open, reflect the new result there.
5. Render each finding's rule ID, severity, file path, and message; display its line when provided. Show a clear empty-results message for zero findings. The results region scrolls vertically without scrolling the surrounding workspace.
6. Each finding is a keyboard-accessible button. Activating one resolves its vault-relative path in the active vault and opens the file in an editor leaf without replacing the diagnostics view. If a line is present, convert one-based line `n` to editor line `n - 1`, place the cursor there, and scroll it into view. If line is absent, open the file normally without imposing a cursor position.
7. If the referenced file no longer exists when activated, show a notice and do not throw an uncaught error.
8. Closing the view clears view-owned listeners and references. The retained latest display state (completed findings or failed-run state) remains available for a later view reveal.
9. If an entire checks run fails before returning a result, replace the displayed findings with an explicit failed-run state; do not present prior findings as current. If the view is closed, retain that state for its next reveal without opening the view automatically. Preserve the existing `Run checks` failure notification: log the error and show the existing Notice containing the rules-file path and error message.

## Acceptance criteria

Stable IDs below are intended to survive implementation decomposition. Each criterion states an observable behavior.

- **DIAG-AC-01 — Complete finding input:** A view can receive a diagnostic containing `ruleId`, `check`, `severity`, vault-relative `path`, and `message`, with or without optional one-based `line`; absence of `line` is preserved as absence rather than fabricated as a source location.
- **DIAG-AC-02 — Commands and reuse:** Invoking either side command opens/reveals a diagnostics view. Repeating a command reuses the existing diagnostics view rather than creating a duplicate.
- **DIAG-AC-03 — Opposite-side view remains in place:** If the existing diagnostics view is on the other sidebar from the command's requested side, the command reveals that same view without moving it.
- **DIAG-AC-04 — Finding rendering:** For a nonempty result, every finding visibly includes its rule ID, severity, path, and message; a supplied line is displayed, and an absent line is not displayed as a fabricated location.
- **DIAG-AC-05 — Empty results:** A zero-finding result displays an empty-results message instead of stale findings.
- **DIAG-AC-06 — Result replacement while open:** Delivering a new completed checks result replaces the prior findings rather than appending; this includes a clean result and a result with diagnostics plus rule failures.
- **DIAG-AC-07 — Retention while closed:** After a completed result or whole-run failure arrives while the view is closed, opening the view shows that latest outcome, and its arrival itself does not open the view.
- **DIAG-AC-08 — Scroll containment:** A sufficiently long list can be scrolled vertically within the results container while the surrounding sidebar/workspace is not the list's scroll target.
- **DIAG-AC-09 — Keyboard activation:** A finding can receive keyboard focus and be activated using standard button keyboard behavior.
- **DIAG-AC-10 — Navigation with line:** Activating a finding with a line resolves and opens its file in an editor without replacing the diagnostics view; the cursor is on zero-based line `line - 1` and that line is scrolled into view.
- **DIAG-AC-11 — Navigation without line:** Activating a finding without a line opens the correct file in an editor without replacing the diagnostics view and does not force a cursor position.
- **DIAG-AC-12 — Deleted target:** Activating a finding whose path no longer resolves to a file displays a user notice and produces no uncaught exception.
- **DIAG-AC-13 — View cleanup:** Closing the diagnostics view releases its view-owned listeners and references; reopening still displays the most recently retained outcome.
- **DIAG-AC-14 — Whole-run failure replaces findings:** If the check operation fails before returning a result, an open diagnostics view replaces any previously displayed findings with an explicit failed-run state, not stale findings. If closed, the failure state is retained and shown on the next reveal without auto-opening. The existing `Run checks` behavior of logging the error and showing a Notice containing the rules-file path and error message is preserved.

## Scope, exclusions, and constraints

- In scope: the dedicated view, two reveal commands, result handoff from the existing Run checks flow, retention of the latest outcome, rendering, accessibility, file/line navigation, missing-file notice, cleanup, and focused behavioral verification for all acceptance criteria.
- Out of scope: changing rule evaluation or diagnostic semantics; adding diagnostics fields; folding rule execution failures into the findings list; automatically moving an existing view to satisfy a command's requested side; opening the view automatically when a result arrives; changing indexing, persistence, or rule configuration behavior.
- Preserve the distinction between diagnostics and execution failures already present in `RunChecksResult`. Diagnostics from a partial result are findings; a failed whole run does not supply a replacement diagnostics result, but it does replace the sidebar's displayed outcome with the explicit failure state required by DIAG-AC-14. Preserve the current `Run checks` error logging and rules-file-path-prefixed failure Notice.
- No code, tests, TODO, or original-checkout files are changed as part of preparing this requirements document. Implementation requires explicit approval.

## Decisions and rationale

- **Resolved — opposite-side existing view:** Reveal the existing view where it is; do not move it. This is the user's explicit decision and defines the observable behavior in DIAG-AC-03.
- **Resolved — results arrive while the view is closed:** Retain the latest outcome and keep the view closed. A whole-run failure is an outcome that replaces findings rather than a findings result. This decision defines DIAG-AC-07 and DIAG-AC-14.
- **Existing behavior — findings data:** Use the established `RuleDiagnostic` shape and `RunChecksResult.diagnostics`; the data already carries every requested field.
- **Existing behavior — failures are separate:** `RunChecksResult.failures` and diagnostics are separate. A partial run may have findings and failures; the view displays findings, not failures.
- **Proposed implementation choice, not a requirement:** Keep the latest diagnostics in plugin-owned state and pass them to a view when created/revealed. This fits retention after view closure and avoids treating a UI instance as the authoritative result store, but the precise state mechanism remains for architecture review.

## Verification requirements

Focused behavioral tests must establish DIAG-AC-01–14, including both commands, same-side and opposite-side reuse, retained findings without auto-opening, replacement by clean and partial results, whole-run failure replacement/retention plus the existing failure notification, long-list scroll containment, keyboard activation, navigation with and without a line, deleted-file notice, and cleanup/reopen behavior. Do not treat the existing diagnostic-shape or settings logging tests as coverage for the sidebar contract. No tests, builds, or formatters have been run during requirements preparation.
