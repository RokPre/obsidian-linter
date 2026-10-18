# Linter checks and JSON rules

This document specifies the first configurable linter checks planned for the Obsidian plugin. The JSON rule reader, execution engine, and diagnostics sidebar are not implemented yet. The existing Python health checker contains related checks, but it does not read this configuration.

A **check** is an implemented capability, such as testing whether a frontmatter property exists. A **rule** is one configured use of a check: which files to inspect, which options to use, and how to report violations. Multiple rules can use the same check with different scopes and options.

[rules.example.json](rules.example.json) contains a complete, single-rule configuration for initial reader and engine development.

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
        "property": "aliases"
      }
    }
  ]
}
```

### Required keys and allowed values

All keys listed below are required. There are no implicit defaults in version 1. JSON comments and trailing commas are not allowed.

| Key | Type | Accepted value or meaning |
| --- | --- | --- |
| `version` | Integer | Exactly `1`; other versions are unsupported. |
| `rules` | Array of rule objects | Zero or more rules. An empty array runs no checks. |
| `rules[].id` | String | Non-empty, not whitespace-only, and unique within the configuration. Identifies the configured rule, not a database row. |
| `rules[].check` | String | Exactly `requiredFrontmatterProperty`, `filenameCase`, or `unresolvedInternalLinks`. Names are case-sensitive. |
| `rules[].enabled` | Boolean | `true` executes the rule; `false` disables it without removing it. |
| `rules[].severity` | String | Exactly `info`, `warning`, or `error`. Controls diagnostic severity, not check behavior. |
| `rules[].scope` | Object | Contains `fileKinds`, `include`, and `exclude`, as defined below. |
| `rules[].options` | Object | Contains exactly the options documented for the selected check. |

The future reader must reject missing keys, unknown keys, unknown check names, incorrect types, unsupported values, and duplicate rule IDs. This includes validation of disabled rules. Invalid configuration must prevent execution and produce a configuration error; it must not be silently treated as an empty or successful health check.

### File and folder scope

Version 1 scopes select files. A folder pattern selects its descendant files; it does not execute a check against the folder itself.

| Scope key | Type | Accepted value or meaning |
| --- | --- | --- |
| `fileKinds` | Array of strings | Exactly `["markdown"]` for these initial checks. Other file kinds are not supported in version 1. |
| `include` | Array of pattern strings | At least one pattern. A file must match at least one to be selected. |
| `exclude` | Array of pattern strings | Zero or more patterns. Matching any exclusion removes the file, even if an inclusion matches. |

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

### Execution and reporting

- Enabled rules run independently and contribute diagnostics to the same health-check result. Rule order must not change their meaning; version 1 has no execution edges, dependencies, branches, or automatic fixes.
- Reusing a check with different rule IDs creates separate configured rules. Their findings remain attributed to their respective rule IDs, even if they concern the same file.
- Checks operate on a completed index whose required derived data is ready. An indexing or execution failure must be reported separately from lint violations and must not appear as a clean result.
- Each diagnostic identifies the rule ID, check name, severity, vault-relative file path, and a human-readable message. A source line is included when available and meaningful. Lines are one-based; a file-level finding may have no line.
- Missing fields, parsing failures, and unsupported data must not be converted into fabricated source locations. For malformed frontmatter, report the parsing problem and skip checks that depend on interpreting its properties.
- JSON is the canonical execution configuration. A future node editor must edit the same rule semantics. Node positions and other visual layout data are not part of this version 1 format.

## 1. Required frontmatter property

**Check name:** `requiredFrontmatterProperty`

**Core idea:** selected notes must declare a particular top-level frontmatter property.

### Behavior

For each selected Markdown note, test whether the configured property is present at the frontmatter root. Emit one diagnostic when it is missing.

- A note without frontmatter is missing the property.
- Presence is sufficient: `aliases: null`, `aliases: []`, and `aliases: ""` all satisfy this check. It does not validate the value's type or require a non-empty value.
- Nested properties do not satisfy a top-level requirement. `metadata: {aliases: []}` does not supply a top-level `aliases` property.
- Property names are case-sensitive and matched exactly. `Aliases` does not satisfy `aliases`.
- Malformed frontmatter is a parsing problem, not evidence that the property is absent. Skip this property check for that note and report the parsing problem separately.
- There are no built-in exceptions for folders such as `people` or `diary`; exclusions belong in the rule's scope.

### Options

| Key | Type | Accepted value |
| --- | --- | --- |
| `property` | String | Required. A non-empty, non-whitespace-only top-level property name, such as `aliases`, `tags`, or `related`. The value is not trimmed or interpreted as a nested property path. |

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
    "property": "aliases"
  }
}
```

For `knowledge/cameraModel.md` without this property, the message is `Required frontmatter property \`aliases\` is missing.` This is a file-level finding without a source line because the missing property has no existing location.

## 2. Filename case

**Check name:** `filenameCase`

**Core idea:** selected notes must follow the configured filename convention.

### Behavior

Validate the file's stem: remove only the final extension and inspect the remaining filename. Do not validate folder names or change any files.

Version 1 supports only `camelCase`, using the existing check's predicate `^[a-z][a-zA-Z0-9]*$`: the first character must be an ASCII lowercase letter; subsequent characters must be ASCII letters or digits.

| Filename | Result | Reason |
| --- | --- | --- |
| `cameraModel.md` | Pass | Lowercase initial letter, followed by letters. |
| `note2.md` | Pass | Digits are allowed after the initial letter. |
| `myHTTP2.md` | Pass | Consecutive uppercase letters are allowed by this predicate. |
| `CameraModel.md` | Finding | Initial letter is uppercase. |
| `camera_model.md` | Finding | Underscores are not allowed. |
| `camera.model.md` | Finding | The stem contains a dot. |
| `2notes.md` | Finding | Initial character is a digit. |

This predicate does not infer word boundaries or enforce acronym capitalization. There are no built-in filename exceptions; exclude files such as `README.md` explicitly if needed.

### Options

| Key | Type | Accepted value |
| --- | --- | --- |
| `case` | String | Required. Exactly `camelCase` in version 1. Other naming conventions are unsupported. |

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

For `knowledge/CameraModel.md`, the message is `Filename \`CameraModel.md\` does not match \`camelCase\`.` This is a file-level finding without a source line.

## 3. Unresolved internal links

**Check name:** `unresolvedInternalLinks`

**Core idea:** selected notes should not contain internal references that cannot be resolved in the indexed vault.

### Behavior

Inspect indexed link occurrences originating in selected Markdown files, including links indexed from their frontmatter. Compare each occurrence's resolution status with the configured statuses. Emit one diagnostic per matching occurrence, rather than one per distinct target.

Scope selects the **source files**, not the target search space. Targets may resolve anywhere in the indexed vault, including files excluded from this particular rule's scope.

- `missing`: the target file or name cannot be resolved in the available index.
- `missing_fragment`: the target file resolves, but its referenced heading or block does not.
- `ambiguous`: the target matches multiple candidates and cannot be resolved uniquely.
- `resolved` and `external` links never produce findings from this check.
- When `includeEmbeds` is `true`, inspect embeds as well as ordinary links, including indexed image references. When it is `false`, ignore occurrences marked as embeds.
- Include the source occurrence's line when available. If only the source file is known, emit a file-level diagnostic without inventing a line.

A `missing` status means unresolved **in the index**, not proof that the target is absent from disk. Index exclusions can hide existing targets. Diagnostics must retain that distinction; known indexing limitations must not be presented as confirmed nonexistent files.

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

For an unresolved `[[missingNote]]` occurrence, the message is `Internal link \`missingNote\` could not be resolved in the indexed vault.` For the other statuses, explain the missing fragment or ambiguity explicitly and include the raw target. Repeated occurrences can have separate diagnostics and source lines.
