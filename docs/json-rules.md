# Using JSON rules

## Configure a rules file

1. Copy the repository's [`rules.example.json`](../rules.example.json) into the active vault. Rename it if useful.
2. In plugin settings, enter its vault-relative path in **Rules JSON file**. Path suggestions are available.
3. Edit the JSON using the version 1 schema and checks described in [Linter checks and JSON rules](../CHECKS.md).
4. Use **Read/validate** to validate the configuration and match its rule scopes against indexed files. Use **Run checks** when you are ready to execute enabled rules.

Both actions are explicit settings actions; neither runs on startup or automatically after a file edit. **Read/validate** reads and validates the whole configuration, including disabled rules, then matches rules to indexed files. It does not execute checks or produce findings. Invalid JSON or any invalid rule rejects the entire configuration. Scope selects files by kind and vault-relative `include`/`exclude` patterns; only indexed files can match, and a folder pattern selects files beneath it rather than the folder itself.

## Run checks

**Run checks** reads and strictly validates the complete configuration before executing anything. Only enabled rules execute, independently; disabled rules are still validated. Each finding retains its rule ID, check, configured severity, vault-relative path, message, and a meaningful one-based source line only when indexed. File-level findings and occurrences without indexed line data have no line.

The action uses the existing persisted index only when it is present and `vault_index_state.derived_data_dirty === 0`. It does not start indexing or fall back to indexing. If the index is missing or not ready, the run fails and directs you to **Index vault**. Index the vault, then run checks again. The indexed snapshot may not include filesystem changes made since it was indexed.

## Results and limitations

Findings are logged as structured diagnostics in the console. Index-read/readiness and rule-level failures are reported separately from findings; a failed rule does not become a finding, and other rules continue. Any rule failure makes the run partial/failed rather than clean. The console summary includes finding and failure counts. No findings window or sidebar is opened.

The **Read/validate** matching action and **Run checks** currently require Obsidian desktop; unsupported file-system adapters produce an error. The three supported checks are `requiredFrontmatterProperty`, `filenameCase`, and `unresolvedInternalLinks`. The full reference describes their options and edge cases, including index-relative link resolution and source-vs-target scope.
