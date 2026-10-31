# About

An Obsidian plugin for creating visual workflows over vault content.

The plugin builds a structured SQLite index of the vault as the foundation for selecting, checking, and modifying its files and Markdown nodes.

The database is infrastructure rather than the product itself. Visual workflows connect folder inputs and filters to checks, then pass their results to tools that modify the selected content.

## Project navigation

See the [documentation and source index](docs/TOC.md) for the project guide, rule reference, and code entry points.

## Main entry points

- Active Obsidian plugin: [`obsidian-sample-plugin/src/main.ts`](obsidian-sample-plugin/src/main.ts) and its indexer in [`obsidian-sample-plugin/src/indexer.ts`](obsidian-sample-plugin/src/indexer.ts).
- Rule configuration, validation, and execution: [`rules-config.ts`](obsidian-sample-plugin/src/rules-config.ts), [`rules-engine.ts`](obsidian-sample-plugin/src/rules-engine.ts), and [`settings.ts`](obsidian-sample-plugin/src/settings.ts).
- Legacy Python indexing and related tools: [`indexer.py`](indexer.py), [`healthChecker.py`](healthChecker.py), and [`tests/`](tests/).

## Indexer

The indexer creates a SQLite database containing a structured representation of the vault.

By default, the database can live as a hidden file in the root of the vault, although another location can be selected in the settings.

The index contains information about notes, directories, frontmatter, Markdown structure, tags, links, embeds, and other vault metadata. Higher-level features use this database instead of repeatedly reparsing the entire vault.

## Health Checker

The health checker supports version 1 rules from a JSON file. In plugin settings, configure a vault-relative path and choose **Read/Validate** to validate the complete configuration and match rule scopes against indexed files, or choose **Run checks** to manually execute enabled rules and log findings.

Runs require an existing persisted index whose derived data is ready; **Run checks** does not index the vault. Index-readiness or rule-execution failures are reported separately from findings. Results are logged to the console; the plugin does not open a findings window or sidebar.

See the [JSON rules guide](docs/json-rules.md) for setup and workflow, [Linter checks and JSON rules](CHECKS.md) for the authoritative version 1 schema and check semantics, and [rules.example.json](rules.example.json) for a valid example.

A future node-based editor and shared workflow system remain long-term project goals; they are not part of this JSON check execution feature.

A future node-based editor will visualize and edit the same configuration; it will not define a separate rule system.

A health check produces a set of diagnostics. Depending on the rule, these can later be connected to automatic fixes or other actions.

## Tools

Obsidian’s GUI and CLI already provide powerful tools for working with notes, so this project does not aim to reimplement functionality that Obsidian already handles well.

Instead, it focuses on vault-wide operations that are missing, difficult, or unsafe to perform with plain search and replace.

| Tool               | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| Rename tag         | Rename a tag across frontmatter and inline tag occurrences.          |
| Property migration | Rename, move, or transform frontmatter properties across many notes. |
| Tag migration      | Convert or normalize tag structures across the vault.                |
| Structural cleanup | Apply safe vault-wide changes based on indexed note structure.       |
| Rule-based fixes   | Apply automatic fixes to files returned by health-check rules.       |

INSERT OR EXPAND LIST OF TOOLS

The long-term goal is for health checks and tools to share the same workflow system. A rule can identify a set of files or nodes, and that result can either become a diagnostic or be passed into a transformation.

For example:

Vault
↓
Markdown files
↓
Files directly inside the vault root
↓
Move to /workspace/

The same selection could instead end in a warning:

Vault
↓
Markdown files
↓
Files directly inside the vault root
↓
Warning: files should not be stored in the vault root

This makes health checks, automatic fixes, and refactoring operations different outputs of the same underlying workflow engine.
