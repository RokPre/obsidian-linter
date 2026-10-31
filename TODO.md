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

Active feature work: implement inode-based move reconciliation in the TypeScript plugin, not the legacy Python indexer. G0 and G1 are completed and committed. The remaining `move_match`, `move_reconcile`, and `move_integration` tasks are separate logical items in one approved G2–G4 commit group. `SPEC.md` remains unchanged and is the source of requirements and acceptance criteria: [SPEC.md](SPEC.md).

### Workflow status

**In progress.** RaceGroupReview accepted G2–G4; next: authorized combined commit-gate. Integration review and publication remain outstanding.

### Workflow evidence

- Original checkout: `/home/rok/sync/obsidian-linter`; backlog source `detect_moves_where`, revision `853c7221a544d2b5d7e02e5efbfc4eaf12b1ef2b`.
- Worktree: `/home/rok/offline/tmp/obsidian-linter-plugin-inode-moves`; branch `feature/plugin-inode-moves`; remote `origin`, base `main`, starting commit `fe1d557ae0f37bf7eb4fb0fbef5c4453a8419836`. Fetched `origin/main`: `974a3d606facf559cb4b8ecaea8e0c6421997a87`. User approved the local merge of remote history into divergent `main`.
- PR #9 merged Python move detection; its commits `4241f11` and `30b7865` are design evidence only, not plugin implementation.
- Carried project-navigation setup in this worktree: `README.md` SHA-256 `a094472e1bba949bd8afaac16b12399dfc57415b978e1766d3186a6e753eeae1`; `docs/TOC.md` SHA-256 `ada18e97875412e566749cade8a6e232d0472f851c888fb1df9cd55465081899`. The original checkout's `docs/TOC.md` was separately committed as `1faf51a` after this worktree's base; do not change the worktree base. The setup task and first commit group retain both carried artifacts for review.
- Requirements decisions: exact equality of plugin effective `kind` (including frontmatter-derived `excalidraw`); preserve eligible file IDs and valid directory references but not directory-row IDs; user-approved fallback for a candidate identity shared by another unchanged indexed path.
- ArchitectureFinal guidance: precision-safe device/inode identity, nullable unverified legacy device, non-following destination revalidation, account for unchanged hard links, reconcile before stale-directory deletion, and reuse derived-data refresh. No tests/build were run.
- User decision for MOVE-AC-14: on a runtime without a no-follow open flag, abort or defer before committing destructive or incomplete state if safe candidate reading is required; preserve the old indexed row and parsed records, and never follow-read or silently omit the candidate. Correction route: `move_match` must surface this unsupported-safe-read condition instead of dropping/follow-reading the candidate; `move_integration` must preflight it before any batch commit or destructive mutation and verify abort/defer preserves old state. Keep prior unsupported-branch test gaps and pass results as historical evidence; this decision is not implementation or verification.
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
- G2TestStrategy found that a standalone matcher would be dead code: the current indexing flow has no consumer for its result, so matcher-only tests cannot prove moved-file behavior. Keep matching, reconciliation, normal-flow/directory integration, and their distinct tests as separate logical tasks, but combine them in one proposed G2–G4 group so matching is introduced with its production consumer and end-to-end observable behavior. No G2 implementation has started.
- The previously recorded authorization covered separate G1 and G2 commits only. It does not authorize the revised combined G2–G4 commit group; both approval of the revised grouping and explicit commit authorization covering G2–G4 remain outstanding. G3/G4 and publication were not authorized by the earlier decision.
- User approved the revised single G2–G4 commit group and explicitly authorized its commit after required gates pass. Publication remains unauthorized.
- MoveGroupStrategy: verify G3 non-following revalidation, preserved IDs/parsed rows and refreshed links; G4 normal-flow file/directory moves, surviving-hard-link fallback, stable rescans, foreign keys and derived state. Use a deterministic race seam only if needed. Focused schema/indexer suites cover the group collectively; no tests or build were run by strategy.
- MoveMatcher implemented `match_file_moves(deleted, created, unchanged)` and direct cases for exact bigint-safe identity/mtime, effective kind, non-regular destinations, ambiguity, and unverified identity. Focused command `PYTHON=/home/rok/offline/tmp/obsidian-linter-test-python/bin/python node --test --test-name-pattern='matches only unique' tests/indexer.test.mjs` passed 1/1. This tests the seam only, not production flow or fallback.
- MoveReconcile wired matching into the indexing flow and revalidates with non-following stat before preserving a file row. ReconcileTests added safe-move/parsed-row/link and destination-replacement fallback checks. The initial safe-move run exposed an undefined `parsed` reference; ReconcileFix corrected it. The two focused tests then passed 2/2. Further directory, hard-link, subsequent-scan, and cross-boundary coverage remains G4.
- MoveIntegrationTests added normal-flow directory move, parsed-row and ID preservation, missing/existing link resolution, stable rescan, foreign-key/derived-state checks, surviving-hard-link and legacy-identity fallback, and changed-mtime/kind cases. Group checks: indexer 36/36 using isolated Python 3.12, schema 10/10 using system Python, and `npm run build` passed. These results are implementation verification, not independent review.
- MoveReduction reviewed source/test state at `1055d24`: RF-1 identified full-index allocation on scans with no matching candidates; MoveReductionWorker narrowed lookup to relevant device/inode pairs. This post-review change remains unverified. RF-2 found a destination replaced by a symlink is rejected as a move but then followed by normal parsing, potentially indexing content outside the vault; normal scanning skips symlinks. The AC-05 fallback clarification was pending at the time; it was subsequently resolved by user approval of MOVE-AC-13 below.
- RF-1 verification after reduction: indexer 36/36 with Python 3.12 and `npm run build` passed. The symlink fallback finding was unresolved and not covered by that pass; subsequent user clarification is recorded below and does not alter the historical verification scope.
- User-approved clarification for RF-2 / MOVE-AC-13: when a candidate destination becomes a symlink or other non-regular entry before reconciliation, reject it via non-following revalidation, remove the stale old path, and do not index the entry or follow/index its target; if the replacement is regular, remove the old path and process the replacement through normal create/reindex. This resolves the requirements clarification only; it is not a G3/G4 implementation result or independent review acceptance. Correction route: update/execute the G3 reconciliation and G4 normal-flow tests, then record verification and obtain independent group review. No tests/build were run for this bookkeeping update.
- ReplacementStrategy planned deterministic symlink/external-marker and regular-file replacement checks. ReplacementFix updated revalidation fallback and both tests. Focused symlink and regular-replacement tests passed; full indexer suite passed 37/37 with Python 3.12, schema 10/10, and `npm run build` passed. Earlier verification remains historical; no independent group review yet.
- MoveScanReduction applied RF-1 in the G2–G4 worktree: candidate identities are inserted into a temporary composite-key table in batches of at most 400 pairs (800 bound parameters); one correlated lookup in a single `vault_files` scan replaces one full scan per identity. Results remain exact text representations of SQLite integers; the no-candidate fast path and changed-path exclusion preserve unique-match/hard-link ambiguity behavior. Restored the unrelated `inspect_obsidian_plugin` backlog entry exactly from the original checkout. No tests/build run by this worker per assignment; verification remains with the parent.
- After MoveScanReduction, indexer tests passed 37/37 under Python 3.12 and build passed. MoveReductionCheck reviewed the revised lookup, symlink handling, and backlog restoration at base `1055d24`; no further reduction selected. It noted candidate fallback may parse twice, retained to avoid changing freshness semantics. Static review only.
- MovePolish found successful moves could yield a negative updated count and stale indexing-progress total. SummaryStrategy and SummaryCorrection changed counts/progress to use the final indexing worklist and added safe move, regular and symlink fallback, and mixed-scan assertions. Indexer 38/38 under Python 3.12, settings 35/35, and build passed after correction; repeat downstream reviews required.
- MoveReductionPostSummary found a symlink-swap window between initial `lstat` and path-based classification. ClassificationStrategy and SafeClassification changed candidate reads to a non-following descriptor, checked regularity and identity/mtime before reading, and added a deterministic external-target-read regression. Indexer tests passed 39/39 under Python 3.12 and build passed. On runtimes lacking `O_NOFOLLOW`, the agent reports candidate skipping; assess this fallback against the spec during review.
- SafeReductionReview and PlatformSafetyDiagnosis found that missing `O_NOFOLLOW` currently drops a regular candidate while deleting its old row, and path-based fallback after a failed safe open can still follow a later symlink swap. Locally Linux/Node exposes `O_NOFOLLOW`; supported Obsidian runtimes/OS are not pinned. A safe unsupported-platform policy needs user approval: abort/defer without committing loss, or accept a weaker path-based fallback. Prior test passes do not cover the unsupported branch.
- User approved abort/defer when safe no-follow candidate reading is unavailable; requirements-grilling added MOVE-AC-14 and task decomposition updated the group plan. SafeFallbackImplementation added descriptor-based fallback and an unsupported-runtime test. First verification did not compile due to reassignment/type errors; SafeFallbackCompileFix corrected those, after which build and schema 10/10 passed and indexer reached 39/40. The AC14 test first failed assigning read-only `O_NOFOLLOW`; UnsupportedTestFix introduced an isolated fs clone, but its focused rerun still fails assigning read-only `constants` during harness setup. No AC14 behavioral result is established; prior passing results are historical.
- FsHarnessDiagnosis identified an inherited read-only `constants` property in the isolated test module. FsHarnessFix replaced it with an independent `node:fs` copy and mutable constants; the AC14 test passed, asserting abort, no candidate path read, and byte-identical persisted database. Full indexer suite passed 40/40 under Python 3.12, schema 10/10, and `npm run build` passed. No independent review of this state yet.
- FallbackReduction identified stale cached candidate parses after rejected matches. FallbackFreshnessFix added non-following freshness checks and safe reparse/skip behavior. Initial regression tests failed due to exact call-count, numeric snapshot, nondeterministic ordering, and Excalidraw body-parsing assumptions; FreshnessTestFix and ContentFixtureFix corrected fixtures to exercise a kind-incompatible candidate and a distinct Markdown replacement before insertion. Full indexer suite passed 42/42 under Python 3.12; build passed with the production correction before the final test-only edits. No independent review of this state yet.
- FreshnessReductionReview required deterministic post-batch coverage; PostBatchTests ordered traversal so 1,000 files precede the candidate and replaced it at progress 1,000. Indexer tests passed 42/42 under Python 3.12 afterward. FinalMoveReduction reviewed the current group and selected no further reduction; its review was static.
- FinalMovePolish statically reviewed counts/progress, unsupported-no-follow error routing, naming, and README/TOC impact; no changes or documentation update recommended. Rendered UI and live interactions were not observed.
- MoveGroupReview: Changes required against base `1055d24`; blockers CR-01 vanished-destination symlink fallback, CR-02 FIFO open blocking, CR-03 unbounded deleted-path SQL parameters, CR-04 trailing-dot destination metadata, CR-05 negative mtime matching, CR-06 ineffective cached-fallback regression. Static review; no tests/build run. Reviewed source SHA-256 `9bdbafc550cd36209aceb950a3bc410b156b5398cb0c21422d9f39db6898d7e3`, tests `544bdd21653fa6dd3edc951054f7e31031a4748d659354be826e99fd4ef01da4`, SPEC `3ea05646d05d793c8f417e0b5c39f5882396f1dbc5b5125b23df73210de758a6`, TODO `642084f32c781dbdc2189431a8126dfd14564abc17ae4d5343743397479a4880`. Prior test passes do not cover these blockers.
- CR-01/CR-02 correction: MoveSafetyCorrections removed vanished candidates from path-following fallback and added nonblocking/no-follow candidate opens; two focused regressions passed, including bounded FIFO child and symlink reappearance. CR-03–CR-06 and downstream group checks remain outstanding.
- CR-03 correction: DeletedQueryFix bounded deleted-path identity lookups in batches of 400 and added a regression that probes the installed SQL.js variable limit, seeds more stale rows, and exercises deletion plus a preserved move and foreign keys. Focused test passed 1/1; CR-04–CR-06 remain.
- CR-04/CR-05 correction: MoveMetadataFix shared filename/extension normalization and allowed exact signed nanosecond mtimes while keeping device/inode nonnegative. Focused matcher and trailing-dot reconciliation tests passed 2/2; CR-06 remains.
- CR-06 correction: CacheRegressionFix, CacheIdentityFix, and SymlinkCacheFixture changed both post-batch fixtures to retain the original device/inode/mtime while making the candidate kind incompatible before classification; safe-open hooks establish candidate classification. Initial tests exposed numeric/string and successful-match fixture mistakes; corrected focused tests now pass 2/2. Mutation testing of the freshness guard has not been performed.
- After CR-01–CR-06 corrections, the complete indexer suite initially found the unsupported-safe-open error message assertion too specific after adding nonblocking flags. DeferredAssertionFix corrected the assertion; indexer passed 45/45 under Python 3.12. Schema passed 10/10, settings 35/35, and build passed on the same production state. Downstream reviews must reassess all corrections.
- CorrectedReduction found no further reduction on CR-01–CR-06. CorrectedPolish found automatic indexing errors remain console-only under existing application behavior; extending UI error reporting is outside the approved change. It also noted an obsolete stage-specific matcher comment. A worker attempting that comment edit accidentally touched the original checkout; its edit was reverted, preserving the original README change. The worktree comment remains unchanged for review.
- CorrectedMoveReview: Changes required at base `1055d24`; CR-01–CR-06 targeted corrections confirmed, but CR-07 found that a candidate replaced by a symlink/FIFO before its first candidate `lstat` remains on ordinary path-following indexing. No test covered that boundary. Reviewed source SHA-256 `92ea48fc46c9d5e3cd3f505245deefe0be689c76e77b186a305c915d2f68835a`, tests `be702c8b1c8440fd00c23d8ffcb8d54bb358f4a2e05c85d8e8525aef3ff7a9a4`, SPEC `3ea05646d05d793c8f417e0b5c39f5882396f1dbc5b5125b23df73210de758a6`, TODO `34299534686edebc3d68ddfc342f55efb3ad224752bf0c2281b4ba1008bacb2f`. Static review only; no tests/build.
- FirstRaceStrategy/FirstRaceFix addressed CR-07 by excluding missing or non-regular destinations at the first candidate `lstat`, with symlink, bounded FIFO, missing, and regular-replacement regressions. Initial tests exposed an omitted local `candidate_stat` declaration; it was restored, then all four focused tests passed. Full indexer suite passed 49/49 under Python 3.12, schema 10/10, settings 35/35, and build passed. Independent review must reassess this exact state.
- FirstRaceReduction selected a no-deleted-candidates fast path; NoDeletionReduction applied it and indexer tests passed 49/49 plus build. FinalScanReduction subsequently claimed filtering during iteration skips entries; not selected because `files_to_index = files_to_index.filter(...)` assigns a new array while `for...of` continues iterating the original array. No in-place removal occurs.
- RacePolish statically reviewed ordinary creates, race-skip counts, progress/error routing, and documentation impact; no group-specific change recommended. Rendered UI/live interactions were not observed. Existing automatic-index errors remain console-only.
- RaceGroupReview: Accepted, no findings, base `1055d24`; CR-01–CR-07 reassessed. Exact Git blob SHA-1s: source `6f774b77e0409dd9ce7091d87b34104719ac1362`, indexer tests `ed763f69651215e3970fd0d1e0e4bea750125704`, schema tests `53524d73a46d385afccad9fb24ac8899be58987c`, SPEC `c64f0e311cd8776f22ff17605fc4e22ac5617068`, reviewed full TODO `25c51806a007c86b62a22460557128c9c322ea39`. Static review only; did not rerun tests/build or observe native cross-platform or rendered UI.
- G1CommitGate: **Committed (all criteria passed)** as `1055d2406cd887db563c0107ecc016aee6ec9b6a` (`feat(indexer): persist file device identity (G1)`) on `feature/plugin-inode-moves`, expected parent `7ab989bdda1ef49ac910a20be3447afaf08c583f`. Maps `move_device` to MOVE-AC-01, MOVE-AC-02, and the representation portion of MOVE-AC-03; matching rejection remains G2. Review: G1CodeReview Accepted, no findings, against base `7ab989b`; source, indexer test, schema test, and SPEC SHA-256 matched the exact reviewed hashes recorded above. Reviewed TODO differed only by attributable workflow status/evidence/authorization bookkeeping; SPEC and task definitions were unchanged. Verification evidence: schema 10/10, indexer 29/29 under Python 3.12, and build passed after final reduction; reviewer did not rerun tests/build, and commit gate ran no tests/build. Staged diff passed `git diff --cached --check`; complete staged patch contained only `SPEC.md`, `TODO.md`, `obsidian-sample-plugin/src/indexer.ts`, `obsidian-sample-plugin/tests/indexer.test.mjs`, and `obsidian-sample-plugin/tests/schema.test.mjs`. This committed content matches accepted source/test/SPEC hashes and approved G1 scope; TODO/SPEC provide shared task/requirements bookkeeping, with no project documentation change required per G1 polish. All included changes map to `move_device` and the G1 acceptance criteria above. Exactly one commit was created with the expected parent; no unrelated staged changes existed. Untracked `node_modules/` and `__pycache__/` remain untouched and uncommitted.

### Planned commit groups and acceptance coverage

1. **G0 — carried navigation setup** (`move_setup`): review and retain the prepared `README.md` and `docs/TOC.md` changes as one independently reviewable setup commit. No MOVE acceptance criterion applies.
2. **G1 — identity persistence** (`move_device`): schema, migration, and their regression tests; `MOVE-AC-01`–`03`. Committed as `1055d24` after G0 `7ab989b`.
3. **G2–G4 — matching, reconciliation, and indexing-flow integration** (`move_match`, `move_reconcile`, and `move_integration`): one approved commit group, with the three tasks and their focused tests retained as distinct logical work items. Together they cover `MOVE-AC-04`–`MOVE-AC-14`: matching and fallback (`MOVE-AC-04`, matching cases in `MOVE-AC-05`, `MOVE-AC-12`, plus MOVE-AC-14's safe candidate classification); destination revalidation, identity/parsed-record preservation, and derived-link refresh (destination-race case in `MOVE-AC-05`, `MOVE-AC-06`, `MOVE-AC-07`); normal file/directory move flow, subsequent-scan stability, consistency, destination replacement fallback, and unsupported no-follow preflight (`MOVE-AC-08`–`11`, `MOVE-AC-13`, `MOVE-AC-14`). For AC14, `move_match` owns detecting and propagating inability to safely classify/read a candidate; `move_integration` owns abort/defer before batch commits or destructive/incomplete state and end-to-end state-preservation coverage. This grouping is needed because a standalone G2 matcher has no production consumer and would be dead code; the group must verify behavior through normal indexing flow.

For G1–G4, inspect the relevant README/docs/TOC at that commit boundary and update affected documentation and navigation in the same group only if existing content becomes inaccurate; do not force documentation edits. The setup artifacts in G0 are retained even if later groups need no documentation changes. G0 and G1 are committed; G2–G4 are approved and uncommitted. Required implementation, verification, reduction, polish, and independent review outcomes must be recorded separately when observed.

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

- Commit group: approved G2–G4
- Dependency: move_device
- Acceptance criteria: MOVE-AC-04, matching cases in MOVE-AC-05, MOVE-AC-12, candidate safe-read handling in MOVE-AC-14

In the plugin indexer, match only a deleted indexed file and a newly created regular file with the same verified device/inode, unchanged nanosecond mtime, and exactly equal effective kind. Establish effective destination kind safely, including Markdown frontmatter classification; if classification is unsafe, fall back. If a candidate requires safe reading and no-follow open is unavailable, surface an abort/defer condition rather than following its path or silently omitting it. Require uniqueness across deleted, created, and unchanged indexed paths. Preserve unchanged hard-link paths and use normal deletion plus create/reindex for ambiguous pairs. Add focused indexer tests for unique matches and fallback on ambiguous/shared hard links, missing identity, changed mtime, kind mismatch, and unclassifiable destination; include unsupported-safe-read behavior. Verify with the focused indexer tests.

### G2TestStrategy — `move_match` / SPEC.md

| Item / criterion / aspect                                               | Expected result and relevant cases                                                                                                                                                                                                                                                                                                                                                                                                  | Verification method                                                                                                                                                                                                                                                                                              | Implementation order and cross-item boundary                                                                                                                                                                                                             | Prerequisites / reason if not test-first                                                                                                                                                                                                                                                                                                                                                                                   | Required evidence                                                                                                                                                             |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `move_match` / MOVE-AC-04 — unique candidate                            | One deleted indexed file and one newly created **regular file** produce one candidate only when verified device+inode, exact nanosecond mtime, and effective kind all match. Include extension-derived kind and Markdown frontmatter-derived `excalidraw`; reject a one-nanosecond mtime difference above `Number.MAX_SAFE_INTEGER` (synthetic BigInt/string metadata is needed so host filesystem precision cannot mask rounding). | Focused indexer test invokes the smallest production matching seam with deleted, created, and unchanged indexed records; assert the exact candidate pair (source row identity and destination path), not merely a count. Exercise real parsing for frontmatter classification and regular-file scan eligibility. | Test-first the matching seam, then implement candidate formation. Keep destination parsing/classification shared with the normal `parse_file` behavior; do not include row mutation, parsed-record preservation, or destination race handling here (G3). | Existing scan/index flow does not expose candidate matches: `find_changes` returns only action/path pairs. Before writing the test, establish a production-used seam that accepts/derives deleted, created, and unchanged identity metadata and returns candidate pairs. Avoid a test-only export or matcher whose result is discarded by production.                                                                      | Focused test output; the synthetic >safe-integer boundary rejects unequal mtimes exactly; test confirms frontmatter-effective kind rather than extension-only classification. |
| `move_match` / MOVE-AC-04, MOVE-AC-05 — precision and rejection         | Equal device/inode with changed nanosecond mtime or unequal effective kind is not a candidate. Null/unverified legacy device never matches (including any numeric placeholder); inability to classify destination safely falls back. A destination that is not a regular file is not eligible.                                                                                                                                      | Same seam tests for each distinct rejection; for unclassifiable destination inject/trigger a real classification failure and assert no candidate, not a fabricated kind. Verify created-file collection excludes symlinks/non-regular entries without following them.                                            | Implement these rejection gates alongside candidate formation; leave destination revalidation after matching to G3 and distinguish it from initial candidate eligibility.                                                                                | Classification-failure semantics need to be grounded in the chosen production classifier: test only failures it actually reports (e.g. read/parse failure); do not equate a valid Markdown file with malformed-but-deterministically-classified frontmatter unless implementation marks kind unsafe.                                                                                                                       | Each rejection case demonstrates the candidate set is empty for that identity; regular file versus symlink/non-regular eligibility is independently asserted.                 |
| `move_match` / MOVE-AC-04, MOVE-AC-05, MOVE-AC-12 — uniqueness/fallback | Reject identity groups with multiple deleted or created paths and reject one deleted + one created when an unchanged indexed hard-link path shares device/inode. The unchanged path remains eligible/indexed; unsafe source/destination continue through normal delete-and-create/reindex.                                                                                                                                          | Matcher seam tests identity multiplicities across all three scan sets, including the approved surviving-hard-link case. An index-flow assertion for delete/create effects is meaningful only once the matcher result is consumed by the flow; end-to-end source-ID preservation/fallback state belongs in G3/G4. | Match uniqueness before reconciliation; unmatched changes remain on ordinary indexing path. G3 consumes accepted pairs and verifies revalidation/preservation. G4 verifies normal file/directory move flow and subsequent-scan consistency.              | **Group-boundary risk:** today the flow has no matcher seam and G3 is the first group to consume a successful candidate. G2 can independently verify decisions only after introducing a seam that production uses; do not claim AC-04's externally visible “treated as the same moved file” result or AC-12 end-to-end fallback from matcher-unit tests alone. Coordinate the seam contract with G3 before implementation. | Candidate pair/rejection assertions for all uniqueness cases; later G3/G4 index-flow evidence for preserved/deleted IDs and fallback effects.                                 |
| `move_match` + `move_integration` / MOVE-AC-14 — unsupported no-follow open | When a candidate requires safe reading but the runtime has no no-follow open flag, propagate an abort/defer outcome before committing destructive or incomplete state. Preserve the old indexed row and parsed records; never read the candidate by following its path or silently omit it while deletions proceed. On supported runtimes, retain the normal safe-read path. | Focused index-flow test simulates unavailable no-follow support for a deleted/created regular candidate and asserts abort/defer, unchanged old row and parsed records, and no candidate/target read; assert the supported-runtime safe-read path remains exercised. | `move_match` detects and propagates the unsupported safe-read condition; `move_integration` preflights it before any batch commit or destructive mutation and verifies resulting state. | Requires deterministic injection of unavailable no-follow support at the production safe-read boundary; do not use a path-based fallback. | Test output plus explicit assertions that no partial/deleting commit occurred and prior row/parsed state survived. |

**Status: Ready for implementation with the explicit seam prerequisite above.** This plan covers G2's matching decision only; G3 owns destination revalidation and reconciliation, and G4 owns normal-flow/directory-move integration. The current code has no move matcher: `find_changes` reports path/action only, `vault_files` already persists nullable `device`, and `parse_file` already computes extension- and frontmatter-effective `kind`. A matcher can be independently specified, but until production consumes its result G2 tests cannot establish end-to-end move behavior. Do not add G3 revalidation/reconciliation or claim that matching alone proves source-row preservation. Existing focused command is `node --test tests/indexer.test.mjs` from `obsidian-sample-plugin`; tests/build were not run for this strategy.

## move_reconcile

- Commit group: approved G2–G4
- Dependency: move_match
- Acceptance criteria: destination-race case in MOVE-AC-05, MOVE-AC-06, MOVE-AC-07, MOVE-AC-13

Immediately before database reconciliation, non-followingly stat the destination and reject it if it is no longer the matched regular file. On success, update the existing row's path, name, and directory while preserving its file ID and parsed records; refresh derived link resolution, including links to the moved file and previously missing destination. If revalidation finds a regular replacement, use normal deletion plus create/reindex; if it finds a symlink or other non-regular entry, remove the stale old path without indexing the entry or following/indexing its target. Add focused tests for replacement between match and update (both regular and non-regular), preserved IDs/parsed rows, moved-link resolution, and missing-target resolution. Verify with the focused indexer tests.

## move_integration

- Commit group: approved G2–G4
- Dependency: move_reconcile
- Acceptance criteria: MOVE-AC-08, MOVE-AC-09, MOVE-AC-10, MOVE-AC-11, MOVE-AC-13, scan preflight and state preservation in MOVE-AC-14

Integrate reconciliation in the normal plugin indexing flow for file and directory moves. Reconcile eligible files into valid destination directories before stale-directory cleanup can cascade-delete them. Cover directory moves, a subsequent scan with no further work, and foreign-key/derived-data consistency for successful moves and fallback. Ensure focused coverage collectively satisfies MOVE-AC-11 across fresh/migrated schemas, matching, races, preservation, links, moves, subsequent scans, and consistency, including MOVE-AC-13's non-following skip and stale-path removal for a non-regular replacement and normal delete/reindex for a regular replacement. For MOVE-AC-14, detect unsupported no-follow safe reads during preflight, before any batch commit or destructive/incomplete state; abort/defer without losing the old indexed row or parsed records, and assert the candidate is not followed-read or silently omitted. Update affected documentation and `docs/TOC.md` in this group only if existing content no longer matches. Verify via focused plugin schema/indexer integration tests.

# DONEs

- [x] DONE: Enable Save only when the ignore-list draft is valid and has unsaved changes; disable it when unchanged, invalid, or successfully saved. Ignore blank pickers when comparing with saved settings. [enable_save_only](#enable_save_only)
- [x] DONE: Disable Clear when only one blank picker is present; enable it when there are paths or extra rows to clear. [disable_clear_when](#disable_clear_when)

## enable_save_only

## disable_clear_when
