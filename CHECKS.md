# Linter checks and JSON rules

This document is the authoritative version 1 reference for the JSON rule format and the three checks available in the Obsidian plugin. To configure a rules file, see the [JSON rules guide](docs/json-rules.md). The root [rules.example.json](rules.example.json) is a complete example configuration.

A **check** names a validation, and a **rule** configures one use of a check: which indexed files it applies to, which options it uses, and how its findings are reported. The settings action **Run checks** executes enabled rules manually. **Read/validate** validates the whole configuration and matches rule scopes against indexed files only; it does not execute checks or produce findings.
The root [rules.example.json](rules.example.json) contains a complete, single-rule configuration accepted by the current reader. For setup, see the [JSON rules guide](docs/json-rules.md).

## Configuration format

A configuration is a UTF-8 JSON file with this structure:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "require-aliases",
      "check": "requiredFrontmatterProperty",
      "enabled": true,
      "severity": "warning",
      "scope": {
        "fileKinds": ["markdown"],
        "include": ["**"],
        "exclude": []
      },
      "options": {
        "properties": ["aliases"],
        "caseSensitive": true
      }
    }
  ]
}
```

### Required keys and allowed values

All top-level fields shown below are required; `scope.exclude` is optional. There are no implicit defaults for required fields in version 1. JSON comments and trailing commas are not allowed.

| Key | Type | Accepted value or meaning |
| --- | --- | --- |
| `version` | Integer | Exactly `1`; other versions are unsupported. |
| `rules` | Array of rule objects | Zero or more rules. An empty array contains no configured rules. |
| `rules[].id` | String | Non-empty, not whitespace-only, and unique within the configuration. Identifies the configured rule, not a database row. |
| `rules[].check` | String | Exactly `requiredFrontmatterProperty`, `filenameCase`, or `unresolvedInternalLinks`. Names are case-sensitive. |
| `rules[].enabled` | Boolean | Required and validated. Only enabled rules execute. |
| `rules[].severity` | String | Exactly `info`, `warning`, or `error`; included in findings and does not alter check behavior. |
| `rules[].scope` | Object | Contains `fileKinds` and `include`, plus optional `exclude`, as defined below. |
| `rules[].options` | Object | Contains exactly the options documented for the selected check. |

The reader rejects missing or unknown keys, unknown check names, incorrect types, unsupported values, invalid patterns, and duplicate rule IDs. It validates the entire configuration, including disabled rules, before returning scope matches or running any check. If any part is invalid, no rules execute.

### File and folder scope

Version 1 scopes select files. A folder pattern selects its descendant files; it does not execute a check against the folder itself.

| Scope key | Type | Accepted value or meaning |
| --- | --- | --- |
| `fileKinds` | Array of strings | Known indexed kinds: `markdown`, `excalidraw`, `pdf`, `image`, `script`, `video`, `recording`, and `other`. An empty array selects no files. `filenameCase` accepts any indexed kind; the other checks accept only `markdown`. |
| `include` | Array of pattern strings | Required and non-empty. A file must match at least one pattern to be selected. |
| `exclude` | Array of pattern strings | Optional; when present, zero or more patterns. Matching any exclusion removes the file, even if an inclusion matches. |

Patterns match the entire vault-relative file path, including its extension. Use `/` separators on every platform. Matching is case-sensitive, including extensions. Patterns also match hidden path components; there is no additional hidden-file exclusion at the rule layer.

Supported syntax:

| Pattern syntax | Meaning | Example |
| --- | --- | --- |
| Literal path | One exact file | `knowledge/cameraModel.md` |
| `*` | Zero or more characters within one path segment; never `/` | `knowledge/*.md` selects direct child Markdown files. |
| `?` | Exactly one character within one path segment; never `/` | `notes/note?.md` matches `notes/note1.md`. |
| `**` as a complete segment | Zero or more path segments | `knowledge/**` selects files at any depth inside `knowledge`; `**/*.md` also matches a root-level `note.md`. |

`**` by itself selects every indexed file of the selected kind. A literal `knowledge` selects a file named `knowledge`, not the folder's contents; use `knowledge/**` for those contents.

Patterns must be non-empty and must not contain a leading/trailing `/`, a Windows drive prefix, backslashes, repeated `/` separators, or `.`/`..` path segments. Adjacent `**` characters are allowed only as a complete segment. Regular expressions, bracket expressions, brace expansion, and leading `!` negation are not supported. Use `exclude` instead of negation. Patterns are not trimmed or expanded relative to the process working directory.

A file is selected only when its kind matches, at least one inclusion matches, and no exclusion matches. For example:

```json
{
  "fileKinds": ["markdown"],
  "include": ["knowledge/**"],
  "exclude": ["knowledge/templates/**"]
}
```

This selects indexed Markdown files below `knowledge`, including nested folders, except those below `knowledge/templates`.

**Index exclusions and rule exclusions are different.** Rule scope cannot select files omitted by the indexer. Excluding a source file from one rule does not remove it from the index or make it invisible to other checks.

## Execution and reporting

**Run checks** is a manual settings action. It reads the configured JSON file and strictly validates the entire configuration before execution. Invalid JSON or any invalid rule blocks the whole run; disabled rules are validated too. Only enabled rules execute, independently. Rule order does not change meaning, and reusing a check under different rule IDs preserves separate attribution for each rule.

Each rule applies only to indexed files whose kind matches and whose vault-relative path matches at least one `include` pattern and no `exclude` pattern. Scope selects source files; only indexed files can be selected. A folder pattern selects descendant files, not the folder itself. For `unresolvedInternalLinks`, scope selects the Markdown source files; target resolution searches the available index independently of that source scope.

Run checks requires an existing persisted index with `vault_index_state.derived_data_dirty === 0`. It does not start indexing or fall back to indexing. If the index is absent or its derived data is dirty, the run fails and directs the user to **Index vault**. A ready index is a snapshot and may not reflect filesystem changes that have not been indexed. Running and matching checks currently require Obsidian desktop; unsupported adapters are reported as errors.

Each finding is logged as a structured diagnostic with `ruleId`, `check`, configured `severity`, vault-relative `path`, and a human-readable `message`. A one-based `line` is included only when meaningful indexed source-line data exists; file-level findings and occurrences without an indexed line omit it. Lines are never invented. Failures are logged separately from diagnostics. Index-read/readiness errors fail the run as a whole; a rule-level failure is not a finding and does not stop other rules. A run with any rule failure is partial/failed, never clean. The console summary reports finding and failure counts and distinguishes an empty successful run from failures. The exact object serialization and summary wording are not contractual. No results window or sidebar is opened.

JSON defines the canonical rule configuration. Existing long-term plans for a node-based editor or shared visual workflow are separate from these three implemented checks; this format contains no visual layout, execution branches, dependencies, or automatic fixes.

## 1. Required frontmatter property


**Check name:** `requiredFrontmatterProperty`

**Core idea:** selected notes must declare configured top-level frontmatter properties.

### Behavior

For each enabled, in-scope Markdown file, emit one diagnostic for each distinct effective configured property name absent from the frontmatter root. Distinctness follows `caseSensitive`: identical names are one effective name, and case-equivalent names are one when comparison is case-insensitive. Repeated entries remain valid configuration but do not duplicate findings.

- A note without frontmatter is missing each required property.
- Presence at the root is sufficient, including `null`, an empty list, or an empty string. The check does not validate value type or non-emptiness.
- Nested properties do not satisfy a top-level requirement. `metadata: {aliases: []}` does not supply a top-level `aliases` property.
- Property-name comparison is controlled by the required `caseSensitive` option.
- For malformed frontmatter, each applicable required-property rule reports its own parse-problem diagnostic, optionally including indexed parser detail and line. It skips missing-property checks for that note under that rule.
- There are no built-in exceptions for folders such as `people` or `diary`; exclusions belong in the rule's scope.

The missing-property diagnostic is file-level and has no line because the absent property has no source location.

### Options

| Key | Type | Accepted value |
| --- | --- | --- |
| `properties` | Array of strings | Required. Every listed name is a required top-level property; values are not trimmed or interpreted as nested property paths. |
| `caseSensitive` | Boolean | Required. Controls whether property-name matching is case-sensitive. |

### Rule JSON

This is a rule object to place inside the configuration's `rules` array:

```json
{
  "id": "knowledge-requires-aliases",
  "check": "requiredFrontmatterProperty",
  "enabled": true,
  "severity": "warning",
  "scope": {
    "fileKinds": ["markdown"],
    "include": ["knowledge/**"],
    "exclude": ["knowledge/templates/**"]
  },
  "options": {
    "properties": ["aliases"],
    "caseSensitive": true
  }
}
```

For `knowledge/cameraModel.md` without this property, the message is `Required frontmatter property \`aliases\` is missing.` This file-level finding has no source line because the missing property has no existing location.

## 2. Filename case

**Check name:** `filenameCase`

**Core idea:** selected files must follow the configured filename convention.

### Behavior

Validate only the indexed file's basename stem: remove only its final extension and inspect what remains. For example, `Camera.Model.md` has stem `Camera.Model`; its earlier suffix is not stripped. Do not validate directory names or extension casing, and do not modify files.

Version 1 supports exactly four filename conventions. The selected convention applies to the stem:

| Convention | Rule | Valid stems |
| --- | --- | --- |
| `camelCase` | Starts with an ASCII lowercase letter, followed by ASCII letters or digits. | `cameraModel`, `note2`, `myHTTP2` |
| `PascalCase` | Starts with an ASCII uppercase letter, followed by ASCII letters or digits. Acronym runs are allowed. | `CameraModel`, `XMLParser2` |
| `snake_case` | Starts with a lowercase ASCII letter; lowercase ASCII alphanumeric parts are separated by single underscores. | `camera_model`, `camera2_model` |
| `kebab-case` | Starts with a lowercase ASCII letter; lowercase ASCII alphanumeric parts are separated by single hyphens. | `camera-model`, `camera2-model` |

There are no built-in filename exceptions; exclude files such as `README.md` explicitly if needed.

### Options

| Key | Type | Accepted value |
| --- | --- | --- |
| `case` | String | Required. Exactly `camelCase`, `PascalCase`, `snake_case`, or `kebab-case`. |

### Rule JSON

```json
{
  "id": "knowledge-filename-case",
  "check": "filenameCase",
  "enabled": true,
  "severity": "warning",
  "scope": {
    "fileKinds": ["markdown"],
    "include": ["knowledge/**"],
    "exclude": ["**/README.md", "**/TODO.md"]
  },
  "options": {
    "case": "camelCase"
  }
}
```

For `knowledge/CameraModel.md`, the file-level finding has no source line. The message identifies the selected convention:

> Filename `CameraModel.md` does not match `camelCase`.

## 3. Unresolved internal links

**Check name:** `unresolvedInternalLinks`

**Core idea:** selected notes should not contain internal references that cannot be resolved in the indexed vault.

### Behavior

Inspect indexed link occurrences originating in enabled, in-scope Markdown source files, including links indexed from frontmatter. Emit one diagnostic per matching occurrence, not one per distinct target. Repeated links to the same target therefore remain separate findings.

Scope selects the **source files**, not the target search space. A target may resolve anywhere in the available index, including a file excluded from this rule's source scope.

- `missing`: the target cannot be resolved in the available index. This is not proof that the target is absent from disk; index exclusions can hide existing targets.
- `missing_fragment`: the target file resolves, but its referenced heading or block does not.
- `ambiguous`: the target matches multiple candidates and cannot be resolved uniquely.
- `resolved` and `external` links never produce findings from this check.
- When `includeEmbeds` is `true`, inspect embeds as well as ordinary links, including indexed image references. When it is `false`, ignore embed occurrences and inspect ordinary links only.
- Include the occurrence's one-based source line only when indexed; otherwise omit it. Do not invent a line.

Messages identify the unresolved condition (missing target, missing fragment, or ambiguity) and include the raw target. For `missing`, the example message is `Internal link \`missingNote\` could not be resolved in the indexed vault.` Its wording reflects unresolved status in the available index, not confirmed absence on disk.

### Options

| Key | Type | Accepted value |
| --- | --- | --- |
| `statuses` | Array of strings | Required. A non-empty array of unique values chosen from `missing`, `missing_fragment`, and `ambiguous`. |
| `includeEmbeds` | Boolean | Required. `true` includes ordinary links and embeds; `false` includes only ordinary links. |

### Rule JSON

```json
{
  "id": "knowledge-unresolved-links",
  "check": "unresolvedInternalLinks",
  "enabled": true,
  "severity": "warning",
  "scope": {
    "fileKinds": ["markdown"],
    "include": ["knowledge/**"],
    "exclude": []
  },
  "options": {
    "statuses": ["missing", "missing_fragment", "ambiguous"],
    "includeEmbeds": true
  }
}
```

Messages for the other statuses identify the missing fragment or ambiguity explicitly and include the raw target. Repeated occurrences can have separate diagnostics and source lines.
