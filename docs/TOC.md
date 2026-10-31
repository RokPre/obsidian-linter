# Documentation and code index

## Project overview

- [Project overview and goals](../README.md)
- [General backlog](../TODO.md)

## User documentation

- [Using JSON rules](json-rules.md): configure, validate, and run checks.
- [Linter checks and JSON rules](../CHECKS.md): authoritative version 1 schema and behavior reference.
- [Example rules configuration](../rules.example.json)

## Active Obsidian plugin

- [Plugin entry point](../obsidian-sample-plugin/src/main.ts)
- [Settings and user actions](../obsidian-sample-plugin/src/settings.ts)
- [Indexing and database lifecycle](../obsidian-sample-plugin/src/indexer.ts)
- [Indexer worker](../obsidian-sample-plugin/src/indexer-worker.ts)
- [Rule configuration validation](../obsidian-sample-plugin/src/rules-config.ts)
- [Rule execution](../obsidian-sample-plugin/src/rules-engine.ts)
- [Plugin tests](../obsidian-sample-plugin/tests/)
- [Plugin package scripts](../obsidian-sample-plugin/package.json)

## Legacy Python tools

- [Python indexer](../indexer.py)
- [Python health checker](../healthChecker.py)
- [Python tests](../tests/)

The active Obsidian plugin is implemented in TypeScript under `obsidian-sample-plugin/src/`. Root-level Python tools and tests are separate legacy utilities; they are not the active plugin implementation.
