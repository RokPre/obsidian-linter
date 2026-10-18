# About

An Obsidian plugin for creating visual workflows over vault content.

The plugin builds a structured SQLite index of the vault as the foundation for selecting, checking, and modifying its files and Markdown nodes.

The database is infrastructure rather than the product itself. Visual workflows connect folder inputs and filters to checks, then pass their results to tools that modify the selected content.

## Indexer

The indexer creates a SQLite database containing a structured representation of the vault.

By default, the database can live as a hidden file in the root of the vault, although another location can be selected in the settings.

The index contains information about notes, directories, frontmatter, Markdown structure, tags, links, embeds, and other vault metadata. Higher-level features use this database instead of repeatedly reparsing the entire vault.

## Health Checker

The health checker lets you define rules for how your vault should be structured, working as a linter for your markdown notes.

Rules can describe things such as folder structure, note locations, filenames, frontmatter properties, tags, links, Markdown structure, and other conventions.

The goal is to make the health checker configurable enough that every user can describe their own vault conventions instead of relying on a fixed set of opinionated rules.

The first configurable linter is planned to read rules from JSON. Each rule selects a check, its options, and the files or folders it applies to. The JSON reader and execution engine are not implemented yet.

See [Linter checks and JSON rules](CHECKS.md) for the planned checks, required keys, allowed values, and execution semantics. [rules.example.json](rules.example.json) contains one basic rule for developing the reader and engine.

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
