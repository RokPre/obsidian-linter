# TODOs

- [ ] TODO: Detect moves where inode is the same but file is deleted and created. [detect_moves_where](#detect_moves_where)
  - [ ] TODO: Review and retain carried project navigation setup [move_setup](#move_setup)
  - [ ] TODO: Persist file device identity [move_device](#move_device)
  - [ ] TODO: Match safe file moves [move_match](#move_match)
  - [ ] TODO: Reconcile matched file moves [move_reconcile](#move_reconcile)
  - [ ] TODO: Verify moves through the plugin indexer [move_integration](#move_integration)
- [ ] TODO: Decide where to keep the legacy Python code and move it there. It has served its purpose for indexing, but may still be useful for developing checks; choose a suitable location in the repo that keeps that possible future use separate from the active indexing code. [decide_where_to](#decide_where_to)
- [ ] TODO: Inspect Obsidian plugin link resolution for targets excluded by the ignored list: determine whether existing-but-ignored files become future/missing links, and define how changing the list should update those links. [inspect_obsidian_plugin](#inspect_obsidian_plugin)
- [ ] TODO: Unify yaml delimiters. [unify_yaml_delimiters](#unify_yaml_delimiters)
- [ ] TODO: Modified files have their nodes and source links deleted and reinserted (/home/rok/sync/vaultHelper/obsidian-sample-plugin/src/indexer.ts:894). Database node IDs therefore should not become durable identifiers in saved rules, diagnostics, or future edit plans. Use source-oriented locators and freshness information. A simple path/range plus source revision or fingerprint is a more appropriate starting point than inventing permanent identities for every Markdown node. [modified_files_have](#modified_files_have)
- [ ] TODO: Test the sql.js file for memory usage, performance, ui stuttering and other possible issues. [test_the_sql](#test_the_sql)
- [ ] TODO: Run indexing independently of Save completion: persist settings and apply exclusions first, then request indexing without holding Save open; verify the settings remain responsive during long scans. [run_indexing_independently](#run_indexing_independently)
- [ ] TODO: Add automated worker integration tests for startup, vault events, Save, and Index vault: use the built worker and a temporary vault; verify saved exclusions, result/error replies, one shared worker, responsive parent thread, and shutdown on unload. [add_automated_worker](#add_automated_worker)
- [ ] TODO: Add settings button interaction tests. [add_settings_button](#add_settings_button)
  - [ ] TODO: Extend the fake environment to expose each button separately, track picker rows when cleared, and record settings saves. [extend_the_fake](#extend_the_fake)
  - [ ] TODO: Test Add: append one blank picker without losing existing values; disable while any picker is blank; use the theme primary color when enabled. [test_add_append](#test_add_append)
  - [ ] TODO: Test Clear: replace all paths with one blank picker and a blank draft entry; keep Add and that picker's × disabled until it is filled; leave saved settings and active exclusions unchanged until Save. [test_clear_replace](#test_clear_replace)
  - [ ] TODO: Test Save styling: highlight valid unsaved changes; return to normal for invalid or unchanged drafts and after successful saving; ignore blank pickers when comparing changes. [test_save_styling](#test_save_styling)
  - [ ] TODO: Test Save validation: reject root, missing paths, and duplicates through both the disabled button and a direct handler call, without saving or indexing. [test_save_validation](#test_save_validation)
  - [ ] TODO: Test successful Save: persist nonblank draft paths, update active exclusions, and request indexing once; Clear followed by Save must persist an empty list. [test_successful_save](#test_successful_save)
  - [ ] TODO: Test failed persistence: do not update active exclusions or request indexing when saving settings fails. [test_failed_persistence](#test_failed_persistence)
- [ ] TODO: Add a diagnostics sidebar for linter findings. [add_a_diagnostics](#add_a_diagnostics)
  - [ ] TODO: Define the view input: rule ID, check, severity, vault-relative file path, message, and optional one-based line. [define_the_view](#define_the_view)
  - [ ] TODO: Register a dedicated Obsidian diagnostics view type. [register_a_dedicated](#register_a_dedicated)
  - [ ] TODO: Add a command to open the diagnostics view in the right sidebar. [add_a_command](#add_a_command)
  - [ ] TODO: Add a command to open the diagnostics view in the left sidebar. [add_a_command_2](#add_a_command_2)
  - [ ] TODO: Reuse an existing diagnostics view when either command is run again. [reuse_an_existing](#reuse_an_existing)
  - [ ] TODO: Add a vertically scrollable results container. [add_a_vertically](#add_a_vertically)
  - [ ] TODO: Render each finding with its rule ID, severity, file path, and message. [render_each_finding](#render_each_finding)
  - [ ] TODO: Display the line number when a finding provides one. [display_the_line](#display_the_line)
  - [ ] TODO: Show an empty-results message when there are no findings. [show_an_empty](#show_an_empty)
  - [ ] TODO: Replace the previous findings when a new health-check result arrives. [replace_the_previous](#replace_the_previous)
  - [ ] TODO: Make finding entries keyboard-accessible buttons. [make_finding_entries](#make_finding_entries)
  - [ ] TODO: Resolve the clicked finding's vault-relative path to an Obsidian file. [resolve_the_clicked](#resolve_the_clicked)
  - [ ] TODO: Open that file in an editor without replacing the diagnostics sidebar. [open_that_file](#open_that_file)
  - [ ] TODO: Convert a supplied one-based line to the editor's zero-based line. [convert_a_supplied](#convert_a_supplied)
  - [ ] TODO: Place the editor cursor on that line and scroll it into view. [place_the_editor](#place_the_editor)
  - [ ] TODO: Open findings without a line normally, without forcing a cursor position. [open_findings_without](#open_findings_without)
  - [ ] TODO: Show a notice instead of throwing if the file no longer exists. [show_a_notice](#show_a_notice)
  - [ ] TODO: Clear view-owned listeners and references when the view closes. [clear_view_owned](#clear_view_owned)
  - [ ] TODO: Verify both sidebar commands open or reuse the diagnostics view. [verify_both_sidebar](#verify_both_sidebar)
  - [ ] TODO: Verify a long findings list scrolls inside the sidebar. [verify_a_long](#verify_a_long)
  - [ ] TODO: Verify clicking a finding with a line opens the correct file and line. [verify_clicking_a](#verify_clicking_a)
  - [ ] TODO: Verify clicking a finding without a line opens the correct file. [verify_clicking_a_2](#verify_clicking_a_2)
  - [ ] TODO: Verify clicking a finding for a deleted file shows the notice. [verify_clicking_a_3](#verify_clicking_a_3)

## detect_moves_where

- Children: move_setup & move_device & move_match & move_reconcile & move_integration

Active feature work: implement inode-based move reconciliation in the TypeScript plugin, not the legacy Python indexer. The user approved the execution plan below for implementation; completion of any item does not authorize a commit. `SPEC.md` is the source of requirements and acceptance criteria: [SPEC.md](SPEC.md).

### Workflow status

**In progress.** User authorized G1 and G2 commits after their individual gates pass. G1 verification, reduction, polish, and independent review passed; next: commit-gate. Matching rejection remains G2 work.

### Workflow evidence

- Original checkout: `/home/rok/sync/obsidian-linter`; backlog source `detect_moves_where`, revision `853c7221a544d2b5d7e02e5efbfc4eaf12b1ef2b`.
- Worktree: `/home/rok/offline/tmp/obsidian-linter-plugin-inode-moves`; branch `feature/plugin-inode-moves`; remote `origin`, base `main`, starting commit `fe1d557ae0f37bf7eb4fb0fbef5c4453a8419836`. Fetched `origin/main`: `974a3d606facf559cb4b8ecaea8e0c6421997a87`. User approved the local merge of remote history into divergent `main`.
- PR #9 merged Python move detection; its commits `4241f11` and `30b7865` are design evidence only, not plugin implementation.
- Carried project-navigation setup in this worktree: `README.md` SHA-256 `a094472e1bba949bd8afaac16b12399dfc57415b978e1766d3186a6e753eeae1`; `docs/TOC.md` SHA-256 `ada18e97875412e566749cade8a6e232d0472f851c888fb1df9cd55465081899`. The original checkout's `docs/TOC.md` was separately committed as `1faf51a` after this worktree's base; do not change the worktree base. The setup task and first commit group retain both carried artifacts for review.
- Requirements decisions: exact equality of plugin effective `kind` (including frontmatter-derived `excalidraw`); preserve eligible file IDs and valid directory references but not directory-row IDs; user-approved fallback for a candidate identity shared by another unchanged indexed path.
- ArchitectureFinal guidance: precision-safe device/inode identity, nullable unverified legacy device, non-following destination revalidation, account for unchanged hard links, reconcile before stale-directory deletion, and reuse derived-data refresh. No tests/build were run.
- Historical findings retained for context: the earlier ArchitectureReview identified a hard-link ambiguity, subsequently resolved by explicit user decision and `MOVE-AC-12`; earlier notes that Q1/Q2 were unresolved or specification was still being produced are superseded by the resolved decisions and current `SPEC.md`.
- User approved the specification and G0–G4 task plan for implementation. Publication is not authorized; completion of an item does not itself authorize a commit.
- G0TestStrategy: check README and TOC relative links, case, and labels against actual worktree destinations; review both carried artifacts together. No execution was claimed by the strategy. The pre-existing README tools-list placeholder is outside G0 and will be preserved.
- G0Implementation: no edits needed; Python link scan checked 12 README and 16 TOC conventional Markdown links for existing, exact-case destinations, and labels were reviewed against targets. Both SHA-256 hashes match the values above. The scan is not a full Markdown parser; no tests/build run.
- G0Reduction (base `fe1d557`, README/TOC hashes above): no reduction selected; README shortcuts and the broader TOC serve distinct navigation purposes. No files changed or checks run by this stage.
- G0Polish (base `fe1d557`, README/TOC hashes above): no in-scope changes; labels and organization were statically inspected. Rendered appearance and interactive behavior were not observed.
- G0Review: Accepted, no findings, against `fe1d557`; README/TOC hashes above, SPEC SHA-256 `7ee99373517f8d7f529e1b4cf41bdea5acd79639f3c0865531974ad428cc6a2d`, reviewed TODO SHA-256 `92efd51541cd6f41239e7cd63e2cf3bd14b140d4d2aa8de40e3c15f8fb374953`. Independently inspected 28 link destinations and shared requirements/plan. Static review only; no tests, builds, rendering, or interactive navigation run.
- G0CommitGate: committed exactly one group commit, `7ab989bdda1ef49ac910a20be3447afaf08c583f` (`docs: add project navigation index (G0)`), on `feature/plugin-inode-moves`, parent `fe1d557ae0f37bf7eb4fb0fbef5c4453a8419836`. Included only `README.md` and `docs/TOC.md` (accepted hashes above), mapped to `move_setup`; G0 has no MOVE acceptance criteria. Review: Accepted, no findings. Verification: reviewed the complete staged patch, confirmed accepted README/TOC hashes and commit contents, and `git diff --cached --check` passed; static review/link inspection only, no tests/build. Commit contents match the accepted state. Unrelated work remains uncommitted: `TODO.md` bookkeeping and untracked `SPEC.md`; no unrelated staged changes remain.
- G1TestStrategy: test fresh device persistence against bigint filesystem stat, legacy nullable migration and repeated initialization with row preservation; normalize only the plugin-only device column in Python parity comparisons while retaining direct plugin assertions. Legacy ineligibility as matching behavior is deferred to G2 because no matcher exists in G1. Planned focused commands: `node --test tests/schema.test.mjs` and `node --test tests/indexer.test.mjs` from the plugin directory. No tests or builds run by strategy.
- G1Implementation added device storage and tests; first execution required installing plugin and root lockfile dependencies. Initial schema run: 8/10 passed; indexer run: 21/29 passed, initially with missing root parser dependencies. After installing those dependencies and correction attempts, schema remains 9/10 (Python `st_dev` parity mismatch) and indexer 21/29 (`pluginState` is undefined in `semanticSnapshot`). No successful G1 verification or review.
- Workspace correction: two agents used relative edit paths that resolved to the original checkout despite worktree-only instructions. Their changes to original `obsidian-sample-plugin/src/indexer.ts`, `obsidian-sample-plugin/tests/indexer.test.mjs`, `obsidian-sample-plugin/tests/schema.test.mjs`, and `tests/test_schema_migration.py` were reverted; original pre-existing `README.md` modification remains. Future agent edits must use absolute worktree paths. No feature changes were committed.
- G1 correction: ParityDiagnosis identified asymmetric schema normalization and an undefined test-helper variable; ParityCorrection fixed both, and LegacyParityFix excluded only device identity from Python/TypeScript parity where migrated databases have different device columns. Direct plugin device and legacy-NULL assertions remain. Schema: 10/10 passed on system Python; indexer: 29/29 passed with isolated Python 3.12 (system Python 3.14 changes trailing-dot `pathlib` behavior); `npm run build` passed. Earlier failed attempts above remain historical evidence.
- G1Reduction selected stronger fresh-device parity and removal of unnecessary test-helper rewrites. G1ReductionWorker changed the worktree test; subsequent schema run passed 10/10, but indexer run with Python 3.12 failed 8/29: seven `vault_files` mismatches with no differing row reported, plus a legacy oracle device assertion (`52` versus expected `NULL`). The earlier 29/29 result does not validate this new state. Worker also accidentally edited original `obsidian-sample-plugin/tests/indexer.test.mjs`; that worker-created edit was reverted and the original checkout's pre-existing README change remains.
- ReductionDiagnosis identified `vault_files` column ordering and an incorrect legacy assertion after reindexing. RepairParity canonicalized mapped column order without dropping fresh device comparison; LegacyDiagnosis confirmed stale mtime triggers reindex, so LegacyAssertion compares the resulting device with bigint filesystem stat. Indexer tests then passed 29/29 under Python 3.12; schema had passed 10/10 after reduction. No G1 review or commit yet.
- G1ReductionFinal reviewed the full G1 diff at base `7ab989b` and found fresh device parity preserved; selected removal of one duplicate row-ID guard. RemoveDuplicate removed it; focused indexer suite passed 29/29 afterward under Python 3.12. No other reduction selected.
- G1Polish statically inspected source, tests, naming, and documentation impact against MOVE-AC-01–03; no changes or documentation update recommended. No rendered or interactive behavior exercised.
- G1CodeReview: Accepted, no findings, base `7ab989b`; G1 representation and migration satisfy MOVE-AC-01–02 and the representation portion of AC-03. Matching rejection remains unverified until G2. Reviewed SHA-256: source `6ff97281b68577307ece6b61edef956a12f53145f5305ca55e640f2f5579dc70`, indexer tests `26ecc38b8195dffebaf366eca1c07b475cd15dfa39adab0889343fea8b3c149c`, schema tests `b686e252d70f72aebd68afc95a1b680d8f11eebd680eea1e6af867fd1c30cad4`, SPEC `7ee99373517f8d7f529e1b4cf41bdea5acd79639f3c0865531974ad428cc6a2d`, reviewed TODO `2f3974c06c5bd41d2aeaf06fb7a52c8255b0428ad2d3c1af4526095fd248f843`. Static review; no tests/build run by reviewer. Actual filesystem identity test did not synthesize values above JavaScript safe-integer range.
- User approved the current unstaged changes and explicitly authorized G1–G2 commits after their individual gates pass. G3, G4, and publication are not covered by this commit authorization.

### Planned commit groups and acceptance coverage

1. **G0 — carried navigation setup** (`move_setup`): review and retain the prepared `README.md` and `docs/TOC.md` changes as one independently reviewable setup commit. No MOVE acceptance criterion applies.
2. **G1 — identity persistence** (`move_device`): schema, migration, and their regression tests; `MOVE-AC-01`–`03`.
3. **G2 — safe candidate matching** (`move_match`; depends on G1): matching and fallback behavior with regression tests; `MOVE-AC-04`, matching cases in `MOVE-AC-05`, and `MOVE-AC-12`.
4. **G3 — safe reconciliation** (`move_reconcile`; depends on G2): destination revalidation, preservation, derived-link refresh, and regression tests; destination-race case in `MOVE-AC-05`, `MOVE-AC-06`, and `MOVE-AC-07`.
5. **G4 — indexing-flow integration** (`move_integration`; depends on G3): file/directory move flow and cross-boundary regression tests; `MOVE-AC-08`–`11`, including subsequent-scan stability and foreign-key/derived-data consistency.

For G1–G4, inspect the relevant README/docs/TOC at that commit boundary and update affected documentation and navigation in the same group only if existing content becomes inaccurate; do not force documentation edits. The setup artifacts in G0 are retained even if later groups need no documentation changes. All groups remain uncommitted; required implementation, verification, reduction, polish, and independent review outcomes must be recorded separately when observed.

### Findings and unresolved issues

No blocking product or architecture decision remains in the current specification. The exact smallest safe identity comparison at destination revalidation is intentionally an implementation detail constrained by `MOVE-AC-05` and ArchitectureFinal guidance; it must be settled in test-strategy/implementation without weakening non-following revalidation or candidate identity safety.

## move_setup

- Commit group: G0
- Dependency: none
- Acceptance criteria: none; this is carried project setup, not feature behavior.

Review the carried worktree navigation changes in `README.md` and `docs/TOC.md`, preserving their recorded content and hashes unless a specific inconsistency is found and approved. Keep both artifacts together in the setup commit. Verify the README's project-documentation navigation and the TOC's links against the worktree files; do not modify the original checkout.


## decide_where_to

## inspect_obsidian_plugin

## unify_yaml_delimiters

## modified_files_have

## test_the_sql

## run_indexing_independently

## add_automated_worker

## add_settings_button

- Children: extend_the_fake & test_add_append & test_clear_replace & test_save_styling & test_save_validation & test_successful_save & test_failed_persistence

## extend_the_fake

## test_add_append

## test_clear_replace

## test_save_styling

## test_save_validation

## test_successful_save

## test_failed_persistence

## add_a_diagnostics

- Children: define_the_view & register_a_dedicated & add_a_command & add_a_command_2 & reuse_an_existing & add_a_vertically & render_each_finding & display_the_line & show_an_empty & replace_the_previous & make_finding_entries & resolve_the_clicked & open_that_file & convert_a_supplied & place_the_editor & open_findings_without & show_a_notice & clear_view_owned & verify_both_sidebar & verify_a_long & verify_clicking_a & verify_clicking_a_2 & verify_clicking_a_3

## define_the_view

## register_a_dedicated

## add_a_command

## add_a_command_2

## reuse_an_existing

## add_a_vertically

## render_each_finding

## display_the_line

## show_an_empty

## replace_the_previous

## make_finding_entries

## resolve_the_clicked

## open_that_file

## convert_a_supplied

## place_the_editor

## open_findings_without

## show_a_notice

## clear_view_owned

## verify_both_sidebar

## verify_a_long

## verify_clicking_a

## verify_clicking_a_2

## verify_clicking_a_3

## move_device

- Commit group: G1
- Dependency: move_setup
- Acceptance criteria: MOVE-AC-01, MOVE-AC-02, MOVE-AC-03

In `obsidian-sample-plugin/src/indexer.ts`, persist device identity alongside inode identity. Extend the existing column-presence migration pattern idempotently. Legacy rows without verified device identity must remain ineligible (use a nullable/unverified representation, never a matching placeholder). Add focused coverage in `obsidian-sample-plugin/tests/schema.test.mjs` and relevant indexing tests for fresh schema, existing rows, repeat initialization, and legacy ineligibility. Verify with those focused tests.

## move_match

- Commit group: G2
- Dependency: move_device
- Acceptance criteria: MOVE-AC-04, matching cases in MOVE-AC-05, MOVE-AC-12

In the plugin indexer, match only a deleted indexed file and a newly created regular file with the same verified device/inode, unchanged nanosecond mtime, and exactly equal effective kind. Establish effective destination kind safely, including Markdown frontmatter classification; if classification is unsafe, fall back. Require uniqueness across deleted, created, and unchanged indexed paths. Preserve unchanged hard-link paths and use normal deletion plus create/reindex for ambiguous pairs. Add focused indexer tests for unique matches and fallback on ambiguous/shared hard links, missing identity, changed mtime, kind mismatch, and unclassifiable destination. Verify with the focused indexer tests.

## move_reconcile

- Commit group: G3
- Dependency: move_match
- Acceptance criteria: destination-race case in MOVE-AC-05, MOVE-AC-06, MOVE-AC-07

Immediately before database reconciliation, non-followingly stat the destination and reject it if it is no longer the matched regular file. On success, update the existing row's path, name, and directory while preserving its file ID and parsed records; refresh derived link resolution, including links to the moved file and previously missing destination. Unsafe/replaced destinations use normal delete-and-reindex. Add focused tests for replacement between match and update, preserved IDs/parsed rows, moved-link resolution, and missing-target resolution. Verify with the focused indexer tests.

## move_integration

- Commit group: G4
- Dependency: move_reconcile
- Acceptance criteria: MOVE-AC-08, MOVE-AC-09, MOVE-AC-10, MOVE-AC-11

Integrate reconciliation in the normal plugin indexing flow for file and directory moves. Reconcile eligible files into valid destination directories before stale-directory cleanup can cascade-delete them. Cover directory moves, a subsequent scan with no further work, and foreign-key/derived-data consistency for successful moves and fallback. Ensure focused coverage collectively satisfies MOVE-AC-11 across fresh/migrated schemas, matching, races, preservation, links, moves, subsequent scans, and consistency. Update affected documentation and `docs/TOC.md` in this group only if existing content no longer matches. Verify via focused plugin schema/indexer integration tests.

# DONEs

- [x] DONE: Enable Save only when the ignore-list draft is valid and has unsaved changes; disable it when unchanged, invalid, or successfully saved. Ignore blank pickers when comparing with saved settings. [enable_save_only](#enable_save_only)
- [x] DONE: Disable Clear when only one blank picker is present; enable it when there are paths or extra rows to clear. [disable_clear_when](#disable_clear_when)

## enable_save_only

## disable_clear_when
