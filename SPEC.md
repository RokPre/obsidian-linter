# Inode-based file move detection in the TypeScript plugin

## Status and authority

**Status:** The user approved this specification and the worktree task plan for implementation. Q1 and Q2 were resolved through user-delegated decisions; the surviving-hard-link fallback was explicitly approved. Publication is not authorized.

## Feature identity and source

- Selected backlog item: `detect_moves_where`, from the original repository's root `TODO.md`, source revision `853c7221a544d2b5d7e02e5efbfc4eaf12b1ef2b`.
- Selected request: **“Detect moves where inode is the same but file is deleted and created.”** Its child items are `move_device`, `move_match`, `move_reconcile`, and `move_integration`.
- Active target: TypeScript plugin indexer at `obsidian-sample-plugin/src/indexer.ts`, not the legacy Python indexer.
- Existing worktree: `/home/rok/offline/tmp/obsidian-linter-plugin-inode-moves`, branch `feature/plugin-inode-moves`, based on `fe1d557ae0f37bf7eb4fb0fbef5c4453a8419836`; fetched `origin/main` is `974a3d606facf559cb4b8ecaea8e0c6421997a87`.
- PR #9 merged Python move detection; that implementation is design evidence only and does not implement this plugin feature.
- The original backlog proposed one commit group; the approved worktree plan decomposes the feature into G0–G4. The Python feature branch is evidence, not a completed plugin implementation.

## Problem and goal

The plugin currently detects file changes by path and nanosecond modification time. A file removed at one path and created at another is therefore handled as a deletion plus a new file even when the filesystem identity and unchanged modification time show that the same file was moved. Re-indexing discards the existing file row and its parsed records, including its database ID.

Detect safe moves in the active TypeScript indexer and reconcile them as moves: preserve the existing indexed file record and parsed records while updating its destination metadata and keeping derived link resolution and database relationships correct. Determining destination kind may require reading and parsing content; move reconciliation must preserve the existing parsed records rather than rebuilding or replacing them merely because the path changed. When identity is missing, ambiguous, incompatible, cannot be classified safely, or is no longer valid at the destination, retain the existing delete-and-index behavior.

## Required behavior

1. Identify file candidates from one indexing scan's deleted indexed files and newly created regular files. A candidate match requires the same filesystem device and inode, unchanged nanosecond mtime, and equal effective kind as persisted/classified by the plugin (including frontmatter-derived `excalidraw`). A match is safe only if the device/inode identifies one deleted record and one created destination, with no other unchanged indexed path sharing that identity; ambiguous matches or destinations whose effective kind cannot be determined safely must not be treated as moves.
2. Persist filesystem device identity with inode identity in the plugin index. Existing databases must migrate idempotently. Existing rows whose device identity was not verified by the migration must not qualify for move matching.
3. Before reconciling a candidate, revalidate its destination with a non-following stat immediately before updating the database. If the destination is unsafe or has changed since matching, use the existing delete-and-reindex path instead of reconciling it as a move.
4. For a safe move, update the existing file's path, name, and directory while preserving its file ID and parsed records. Determining the destination's effective kind may require reading and parsing it, but move reconciliation must not replace the preserved parsed records merely because the path changed. Refresh derived link resolution so links to the moved file and links previously unresolved to its destination reflect the current paths and targets.
5. Integrate move handling into the active plugin indexing flow for both file moves and files moved by directory moves. Subsequent scans and database foreign-key/derived-data state must remain consistent. Non-moves and unsafe candidates continue through existing indexing behavior.

## Acceptance criteria

The IDs below are stable. Each criterion describes an externally observable result; implementation details beyond the explicitly required persistence/revalidation behavior remain open.

- **MOVE-AC-01 — Identity persistence:** A newly initialized plugin database stores the filesystem device identity needed for file move matching alongside inode identity.
- **MOVE-AC-02 — Idempotent migration:** Initializing an existing database adds the required identity storage without losing existing rows; repeating initialization preserves data and schema correctness.
- **MOVE-AC-03 — Legacy identity is ineligible:** Rows migrated without a verified device identity are not eligible to match a newly created file, even if a default or placeholder value exists in the new column.
- **MOVE-AC-04 — Unique safe match:** A deleted indexed file and a created regular file are treated as the same moved file only when device and inode uniquely identify the pair among the scan's deleted, created, and unchanged indexed paths, nanosecond mtime is unchanged, and the source and destination have exactly equal effective kinds as classified by the plugin, including frontmatter-derived `excalidraw`. If destination kind cannot be established safely, the candidate is not a move.
- **MOVE-AC-05 — Unsafe candidates fall back:** Ambiguous hard-link candidates, including a candidate device/inode also shared by another unchanged indexed path, missing/unverified identity, changed mtime, incompatible effective kind, an effective kind that could not be determined safely, a non-regular destination, or a destination whose identity changes before reconciliation do not preserve the source row as a move; the destination is indexed through the existing create/reindex path and the old path is removed as appropriate.
- **MOVE-AC-06 — Reconciliation preserves indexed content:** A safe move changes the existing row's path, name, and directory, preserves its file ID and parsed file records, and does not replace those parsed records merely because the path changed. Reading/parsing needed to determine the destination's effective kind is permitted and is not a failure of this criterion.
- **MOVE-AC-07 — Derived links reflect the move:** After reconciliation, links to the moved file and links that previously targeted a missing destination are resolved against the current indexed inventory; removed/missing targets and link-derived rows are consistent with the current vault.
- **MOVE-AC-08 — Directory-move integration:** Moving a directory through the normal plugin index flow results in all eligible moved files being reconciled safely, and the resulting file rows, directory references, and derived data remain consistent. Directory-row IDs need not be preserved; eligible files must be reconciled to valid destination directory references before stale-directory cleanup.
- **MOVE-AC-09 — Subsequent scan stability:** A scan after a successful move reports no further create/delete/reconcile work for the already reconciled file, absent additional filesystem changes.
- **MOVE-AC-10 — Foreign-key consistency:** After file moves, directory moves, and unsafe-candidate fallback, the index has no broken foreign-key references and reaches a clean derived-data state after indexing completes.
- **MOVE-AC-11 — Focused coverage:** Schema and indexing tests exercise fresh and migrated databases; unique safe matches; ambiguous hard links; a deleted/created candidate whose device/inode is also shared by another unchanged indexed path; missing identity; changed mtime and kind; destination replacement between match and update; preservation of file IDs and parsed rows; link resolution including a missing destination; file and directory moves; subsequent scans; and foreign-key/derived-data consistency.

- **MOVE-AC-12 — Surviving hard-link fallback:** When one deleted indexed path and one newly created path share device/inode but another unchanged indexed path also shares that identity, do not reconcile the deleted and created paths as a move. Keep the unchanged path indexed, remove the deleted path through normal deletion, and index the created path through normal create/reindex behavior.

## Scope, exclusions, and constraints

- Change target is the TypeScript plugin indexer and its relevant schema/indexer tests. Do not implement move detection in the root-level Python indexer.
- Include file moves and directory-move integration as stated in the selected backlog children. Preserve eligible moved file IDs and valid directory references; preservation of directory-row identity is not required. Reconcile eligible files before stale-directory removal because directory deletion cascades to files.
- The Python feature branch and its commits `4241f11` and `30b7865` are evidence for prior design work only, not acceptance or a substitute for plugin behavior.
- No commit is authorized by this request. No publication authorization is present.
- The original checkout `/home/rok/sync/obsidian-linter` and unrelated work remain read-only and must be preserved.
- Only this worktree-root `SPEC.md` is changed during this requirements task. Do not run tests/build or begin implementation as part of this task.

## Current project evidence

- In `obsidian-sample-plugin/src/indexer.ts`, `find_changes` (lines 87–125) compares stored files by path and `mtime_ns`; for files it does not currently compare inode or device. Directory identity currently includes inode but the directory table has no device column.
- `vault_files` currently stores `path`, `name`, `inode`, `mtime_ns`, `extension`, and `kind`; it has no device identity. Schema initialization already performs column-presence checks and `ALTER TABLE` migrations, providing the existing idempotent migration pattern.
- `parse_file` (lines 922–955) uses a bigint stat, derives effective kind from the filename extension and, for Markdown with an `excalidraw` frontmatter tag, can change that kind to `excalidraw`. Thus “effective kind” is not necessarily determined only by extension.
- `insert_file` (lines 957–991) upserts by path, updates path-related metadata, then deletes and recreates that file's parsed node/link records. Move reconciliation must avoid invoking the ordinary insertion path for the matched source if parsed data is to be preserved.
- `index_vault_once` (lines 1824–1900) gathers changes, indexes created/modified files, deletes old file/directory paths, then refreshes tags and link resolution when relevant file changes occur. Directory deletion cascades to its files. Reconciliation ordering must therefore account for moved-file foreign keys before stale directories are removed.
- `resolve_vault_links` updates resolved/missing targets from the current indexed files and removes orphan missing-target rows (around lines 1315–1598). Existing link resolution is the relevant derived-data refresh path.
- `obsidian-sample-plugin/tests/schema.test.mjs` already exercises fresh schema, repeat initialization, and legacy schema migrations. `tests/indexer.test.mjs` has an incremental mutation test for modifications, deletions, directory rename, file/folder replacement, and shared missing links, but does not assert inode-based move preservation.
- `docs/TOC.md` distinguishes the active TypeScript plugin from legacy Python utilities. Its current content and the carried setup files are uncommitted initialization work with recorded hashes in the source backlog. No documentation changes are required by this specification.

## Decisions and proposals

### Explicitly established

- The selected feature is plugin move detection, not Python implementation.
- Device/inode uniqueness, unchanged nanosecond mtime, compatible effective kind, destination revalidation via non-following stat, preserved file ID and parsed data, link refresh, and safe fallback are required as written in the selected child backlog items.
- A candidate with missing or unverified legacy device identity cannot qualify.
- If another unchanged indexed path shares a candidate device/inode, the deleted/created pair is ambiguous and must use delete-and-reindex; the unchanged path remains indexed. This conservative fallback is explicitly user-approved.

### Resolved delegated decisions

- **Q1 — Effective-kind compatibility:** The user delegated this decision to MoveDecisions. The decision is exact equality of the plugin's effective `kind`; no broader compatibility relation is in scope. Effective kind includes classification from Markdown frontmatter (for example, `excalidraw`), so extension-only comparison is insufficient. If the destination kind cannot be determined safely, fall back to delete-and-index. Determining it may require reading/parsing the destination; reuse classification from the normal parse where practical.
- **Q2 — Directory identity:** The user delegated this decision to MoveDecisions. Preserve eligible moved file IDs and valid parent/file foreign-key references, but do not require a directory row to retain its ID. Reconcile eligible files to destination directories before stale-directory cleanup, since deleting a stale directory first would cascade-delete its files and violate file-ID preservation.

### Explicit user decision

- **Surviving hard-link ambiguity:** The user approved a conservative fallback when another unchanged indexed path shares a candidate device/inode: do not reconcile the ambiguous deleted/created pair; delete the old path and index the created destination through the existing fallback. The unchanged indexed path survives. This decision narrows the safe-match uniqueness check and is testable in MOVE-AC-12.

### Other open implementation details

- The precise stat comparison used to detect destination changes between candidate matching and reconciliation is not prescribed beyond a fresh non-following stat; architecture review should specify the smallest check that guarantees the candidate is still the same regular file.
- Whether filesystem device identity is also needed on directory rows is not required by file matching as currently described; revisit only if the chosen directory-move design uses directory identity for matching.

## Clarification record (resolved)

The user delegated both decisions to MoveDecisions; the selected outcomes are recorded above. The original questions and options are retained here as history, not as open questions.

**Q1 — Effective-kind compatibility (resolved):** Which effective-kind policy should determine whether a deleted file and destination are compatible?

- **A. Exact effective `kind` equality (recommended):** match only if both classify to the same persisted kind (including `excalidraw` classification from Markdown frontmatter). This avoids preserving parsed state under a different file classification.
- **B. A broader compatibility relation:** define which kind pairs may move together, such as Markdown-related classes. This permits more moves but needs an explicit pairwise rule and tests.

**Q2 — Directory identity (resolved):** When a directory is renamed/moved, must the directory database row retain its ID, or is it sufficient to preserve eligible file IDs while updating their directory references and recreating the directory row as needed?

- **A. Preserve file IDs only (recommended from the selected file-focused request):** directory-row identity is not durable; require valid parent/file foreign keys and correct paths after the move.
- **B. Preserve directory IDs too:** treat directory rename/move as identity-preserving and specify directory device/inode matching and reconciliation explicitly.

## Approval record

The user approved this specification and the worktree task plan for implementation. Q1 and Q2 were delegated by the user to MoveDecisions; the surviving-hard-link fallback was separately approved. Publication authorization has not been given.
