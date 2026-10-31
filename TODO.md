# TODOs

- [ ] TODO: Detect moves where inode is the same but file is deleted and created. [detect_moves_where](#detect_moves_where)
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

- Children: move_device & move_match & move_reconcile & move_integration

Active feature work: implement inode-based move reconciliation in the TypeScript plugin, not the legacy Python indexer. Commit group: one independently reviewable move-detection change covering the four child tasks; completing a task does not authorize a commit. The existing feature/inode-move-detection branch provides Python design evidence, not a completed plugin implementation. No SPEC.md or approved acceptance criteria are available; this breakdown is a proposed plan and approval remains pending.

### Workflow status

Planned; not implemented, verified, reviewed, or committed.

### Workflow evidence

The plugin's find_changes currently classifies files by path and mtime, while the Python feature branch contains device identity and unchanged-move reconciliation commits 4241f11 and 30b7865.

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

In the active TypeScript plugin indexer, persist filesystem device identity alongside inode. Migrate existing databases idempotently; legacy rows without verified device identity must not qualify for move matching. Verify new and migrated databases with schema and indexing tests.

## move_match

- Dependency: move_device

Match a deleted indexed file and a created regular file only when device and inode uniquely identify the pair, nanosecond mtime is unchanged, and the destination has a compatible effective kind. Test matches and fallback for ambiguous hard links, missing identity, changed mtime and kind changes.

## move_reconcile

- Dependency: move_match

Revalidate the destination with a non-following stat immediately before updating. For a safe move, update the existing file path, name and directory while preserving its ID and parsed data, and refresh derived link resolution. Unsafe or changed destinations use the existing delete-and-reindex path. Test preserved records, link and missing-target resolution, and destination replacement races.

## move_integration

- Dependency: move_reconcile

Exercise file and directory moves through the active plugin indexing flow, including subsequent scans and database foreign-key and derived-data consistency. Verify the behavior with focused integration tests. Update affected documentation and docs/TOC.md only if existing content no longer matches.

# DONEs

- [x] DONE: Enable Save only when the ignore-list draft is valid and has unsaved changes; disable it when unchanged, invalid, or successfully saved. Ignore blank pickers when comparing with saved settings. [enable_save_only](#enable_save_only)
- [x] DONE: Disable Clear when only one blank picker is present; enable it when there are paths or extra rows to clear. [disable_clear_when](#disable_clear_when)

## enable_save_only

## disable_clear_when
