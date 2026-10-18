import argparse
import json
import re
import sqlite3
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from time import perf_counter
from typing import Any


@dataclass(frozen=True, slots=True)
class ValidationWarning:
    rule: str
    path: str
    message: str
    line: int | None = None
    column: int | None = None


TIMINGS: dict[str, tuple[float, int, str]] = {}
_FOOTNOTE_REFERENCE_CACHE: dict[str, tuple[tuple[str, int], ...]] = {}
# `main()` clears this cache per CLI run; direct callers must clear it when they
# replace or invalidate `_read_source()` and need fresh reference occurrences.


def record_timing(stage: str, started: float, unit: str = "call", count: int = 1) -> None:
    """Record elapsed time and completed units for one health-check stage."""
    total, units, _ = TIMINGS.get(stage, (0.0, 0, unit))
    TIMINGS[stage] = total + perf_counter() - started, units + count, unit


def _plural_unit(unit: str, count: int) -> str:
    if count == 1:
        return unit
    if unit.endswith("y"):
        return f"{unit[:-1]}ies"
    if unit.endswith(("s", "x", "z", "ch", "sh")):
        return f"{unit}es"
    return f"{unit}s"


def print_timing_summary() -> None:
    """Print total and average elapsed time for each profiled health-check stage."""
    print("\nTiming summary")
    for stage, (total, units, unit) in sorted(TIMINGS.items(), key=lambda item: item[1][0], reverse=True):
        average = total / units * 1000 if units else 0.0
        print(
            f"{stage:28} {total * 1000:9.3f} ms total  {average:8.3f} ms/{unit}  {units:4} {_plural_unit(unit, units)}"
        )


_CAMEL_CASE_RE = re.compile(r"^[a-z][a-zA-Z0-9]*$")
_VALID_EXERCISE_TYPES = ("strength", "cardio", "stretching", "mobility", "stability")
_VALID_MUSCLE_NAMES = (
    "chest",
    "shoulders",
    "traps",
    "lats",
    "middle back",
    "lower back",
    "biceps",
    "triceps",
    "forearms",
    "abs",
    "quads",
    "hamstrings",
    "glutes",
    "abductors",
    "adductors",
    "calves",
)
_MISSING_FRONTMATTER_PROPERTY_EXCEPTION_DIRECTORIES = ("people", "diary")
_ALLOWED_VAULT_ROOT_FILENAMES = ("README.md", "TODO.md", "tmp.md")
_FILENAME_CASE_EXCEPTIONS = ("README.md", "TODO.md")
_FILENAME_CASE_EXCEPTION_DIRECTORIES = ("people",)

_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif", ".bmp", ".tif", ".tiff", ".avif"})
_REQUIRED_DIRECTORY_BY_KIND = {
    "excalidraw": "attachments/excalidraws",
    "pdf": "attachments/pdfs",
    "image": "attachments/images",
    "recording": "attachments/recordings",
    "script": "attachments/scripts",
    "video": "attachments/videos",
}
_EXERCISE_PROPERTY_KEYS = ("related", "tags", "aliases", "primaryMuscle", "secondaryMuscle", "exerciseType")
_WEB_URL_RE = re.compile(r"https?://[^\s<>()]+", re.IGNORECASE)
_NON_WEB_SOURCE_RE = re.compile(r"\b(?:screenshot|personalPhoto)\b|aiGenerated\s*:", re.IGNORECASE)
_FOOTNOTE_ACCESS_DATE_RE = re.compile(r"date accessed:\s+\d{4}-\d{2}-\d{2}$")
_FENCE_RE = re.compile(r"^(?:\s*>\s*)*\s*(`{3,}|~{3,})(.*)$")
_FOOTNOTE_DEFINITION_RE = re.compile(r"^\s*\[\^([^\]]+)\]:")
_FOOTNOTE_REFERENCE_RE = re.compile(r"\[\^([^\]]+)\](?!:)")


def _dict_rows(cursor: sqlite3.Cursor) -> list[dict[str, Any]]:
    columns = [description[0] for description in cursor.description or ()]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _table_columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {column[1] for column in connection.execute(f"PRAGMA table_info({table})")}


def _sqlite_variable_limit(connection: sqlite3.Connection) -> int:
    getlimit = getattr(connection, "getlimit", None)
    if getlimit is None:
        return 900
    return max(1, getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER))


def _table_rows(
    connection: sqlite3.Connection, table: str, columns: tuple[str, ...], order_by: tuple[str, ...]
) -> list[dict[str, Any]]:
    available = _table_columns(connection, table)
    selected = ", ".join(column if column in available else f"NULL AS {column}" for column in columns)
    ordering = ", ".join(column if column in available else "NULL" for column in order_by)
    return _dict_rows(connection.execute(f"SELECT {selected} FROM {table} ORDER BY {ordering}"))


def _vault_file_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return _table_rows(
        connection, "vault_files", ("id", "path", "name", "directory_id", "kind", "extension"), ("path", "id")
    )


def _markdown_node_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return _table_rows(
        connection,
        "markdown_nodes",
        (
            "id",
            "file_id",
            "parent_id",
            "ordinal",
            "node_type",
            "value",
            "block_id",
            "attributes_json",
            "start_line",
            "start_offset_utf16",
            "end_line",
            "end_offset_utf16",
        ),
        ("file_id", "start_offset_utf16", "id"),
    )


def _frontmatter_node_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return _table_rows(
        connection,
        "frontmatter_nodes",
        ("id", "file_id", "parent_id", "ordinal", "key", "node_type", "value", "raw_yaml"),
        ("file_id", "id"),
    )


def _vault_link_rows(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return _table_rows(
        connection,
        "vault_links",
        (
            "id",
            "source_file_id",
            "source_markdown_node_id",
            "source_frontmatter_node_id",
            "target_file_id",
            "target_node_id",
            "raw_target",
            "link_syntax",
            "is_embed",
            "resolution_status",
        ),
        ("source_file_id", "id"),
    )


def _node_attributes(node: dict[str, Any]) -> dict[str, Any]:
    raw_attributes = node.get("attributes_json")
    if not raw_attributes:
        return {}
    try:
        attributes = json.loads(raw_attributes)
    except (TypeError, json.JSONDecodeError):
        return {}
    return attributes if isinstance(attributes, dict) else {}


def _nodes_by_file(nodes: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    grouped: dict[int, list[dict[str, Any]]] = {}
    for node in nodes:
        grouped.setdefault(node["file_id"], []).append(node)
    for file_nodes in grouped.values():
        file_nodes.sort(key=_node_position_key)
    return grouped


def _nodes_by_id(nodes: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {node["id"]: node for node in nodes}


def _children_by_parent(nodes: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    children: dict[int, list[dict[str, Any]]] = {}
    for node in nodes:
        if node["parent_id"] is not None:
            children.setdefault(node["parent_id"], []).append(node)
    for child_nodes in children.values():
        child_nodes.sort(key=lambda node: (node["ordinal"] is None, node["ordinal"] or 0, node["id"]))
    return children


def _node_position_key(node: dict[str, Any]) -> tuple[int, int, int]:
    offset = node.get("start_offset_utf16")
    if offset is not None:
        return (0, offset, node["id"])
    line = node.get("start_line")
    return (1, line if line is not None else 0, node["id"])


def _node_descendants(node_id: int, children_by_parent: dict[int, list[dict[str, Any]]]) -> list[dict[str, Any]]:
    descendants: list[dict[str, Any]] = []
    pending = list(children_by_parent.get(node_id, ()))
    while pending:
        child = pending.pop(0)
        descendants.append(child)
        pending[0:0] = children_by_parent.get(child["id"], ())
    return descendants


def _node_text(
    node_id: int, nodes_by_id: dict[int, dict[str, Any]], children_by_parent: dict[int, list[dict[str, Any]]]
) -> str:
    node = nodes_by_id[node_id]
    if node["value"] is not None:
        return str(node["value"])
    return "".join(
        _node_text(child["id"], nodes_by_id, children_by_parent) for child in children_by_parent.get(node_id, ())
    )


@lru_cache(maxsize=None)
def _read_source(path: str) -> str | None:
    try:
        return Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None


def _node_source(node: dict[str, Any], file_paths: dict[int, str]) -> str | None:
    source = _read_source(file_paths[node["file_id"]])
    if source is None or node["start_line"] is None:
        return None
    lines = source.splitlines(keepends=True)
    start = max(node["start_line"] - 1, 0)
    end = node["end_line"] if node["end_line"] is not None else node["start_line"]
    return "".join(lines[start:end])


def _node_depth(node: dict[str, Any], file_paths: dict[int, str]) -> int | None:
    depth = _node_attributes(node).get("depth")
    if isinstance(depth, int):
        return depth
    source = _node_source(node, file_paths)
    if source is None:
        return None
    match = re.match(r"\s*(#+)(?:\s|$)", source)
    return len(match.group(1)) if match else None


def _node_identifier(node: dict[str, Any], file_paths: dict[int, str]) -> str | None:
    attributes = _node_attributes(node)
    identifier = attributes.get("identifier") or attributes.get("label")
    if identifier is not None:
        return str(identifier)
    source = _node_source(node, file_paths) or ""
    if node["node_type"] == "footnoteDefinition":
        match = _FOOTNOTE_DEFINITION_RE.search(source)
    else:
        match = _FOOTNOTE_REFERENCE_RE.search(source)
    return match.group(1) if match else None


def _path_is_within(path: Path, directory: Path) -> bool:
    return path.is_relative_to(directory)


def _is_system_path(path: Path, root_path: Path) -> bool:
    try:
        relative_parts = path.relative_to(root_path).parts
    except ValueError:
        return False
    return any(part in {".obsidian", ".git"} for part in relative_parts)


def _is_image_file(file_row: dict[str, Any]) -> bool:
    return file_row["kind"] == "image" or Path(file_row["path"]).suffix.lower() in _IMAGE_EXTENSIONS


def _is_image_target(raw_target: str, target_kind: str | None = None) -> bool:
    target_path = raw_target.partition("#")[0].strip()
    return target_kind == "image" or Path(target_path).suffix.lower() in _IMAGE_EXTENSIONS


def _link_source_line(link: dict[str, Any], nodes_by_id: dict[int, dict[str, Any]]) -> int | None:
    source_node_id = link.get("source_markdown_node_id")
    source_node = nodes_by_id.get(source_node_id) if source_node_id is not None else None
    return source_node["start_line"] if source_node is not None else None


def _is_double_quoted_scalar(raw_yaml: str | None) -> bool:
    value = (raw_yaml or "").strip()
    return len(value) >= 2 and value.startswith('"') and value.endswith('"')


def _frontmatter_link_is_unquoted(node: dict[str, Any]) -> bool:
    raw_yaml = (node["raw_yaml"] or "").strip()
    if node["node_type"] == "scalar":
        value = node["value"]
        return (
            isinstance(value, str)
            and ("[[" in value or re.search(r"\[[^\]]+\]\(", value))
            and not _is_double_quoted_scalar(raw_yaml)
        )
    if raw_yaml.startswith(("[[", "![")):
        return True
    return bool(re.match(r"\[[^\]]+\]\(", raw_yaml))


def _is_web_source_footnote(identifier: str | None, text: str) -> bool:
    normalized_identifier = (identifier or "").casefold()
    normalized_text = text.casefold()
    if _WEB_URL_RE.search(text) or "date accessed:" in normalized_text:
        return True
    if _NON_WEB_SOURCE_RE.search(text) or re.search(r"\[\[[^\]]+\]\]", text):
        return False
    if re.search(r"\b[\w./-]+\.(?:pdf|py|js|ts|sh|c|cpp|h|rs)\b", text, re.IGNORECASE):
        return False
    return normalized_identifier in {"source", "citation", "reference", "web", "websource", "url", "website"}


def _definition_records(
    connection: sqlite3.Connection,
) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]], dict[int, list[dict[str, Any]]], dict[int, str]]:
    nodes = _markdown_node_rows(connection)
    nodes_by_id = _nodes_by_id(nodes)
    children_by_parent = _children_by_parent(nodes)
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    definitions = []
    for node in nodes:
        if node["node_type"] != "footnoteDefinition":
            continue
        identifier = _node_identifier(node, file_paths)
        text = _node_text(node["id"], nodes_by_id, children_by_parent)
        definitions.append({**node, "identifier": identifier, "text": text})
    return definitions, nodes_by_id, children_by_parent, file_paths


def _footnote_definition_rows(connection: sqlite3.Connection, *, markdown_only: bool = True) -> list[dict[str, Any]]:
    available_columns = _table_columns(connection, "markdown_nodes")
    selected_columns = (
        "id",
        "file_id",
        "parent_id",
        "ordinal",
        "node_type",
        "attributes_json",
        "start_line",
        "end_line",
        "start_offset_utf16",
    )
    selected = ", ".join(
        f"node.{column}" if column in available_columns else f"NULL AS {column}" for column in selected_columns
    )
    order_column = "node.start_offset_utf16" if "start_offset_utf16" in available_columns else "node.id"
    file_kind_filter = "AND file.kind = 'markdown'" if markdown_only else ""
    return _dict_rows(
        connection.execute(
            f"""
            SELECT {selected},
                   file.path
            FROM markdown_nodes AS node
            JOIN vault_files AS file ON file.id = node.file_id
            WHERE node.node_type = 'footnoteDefinition'
              {file_kind_filter}
            ORDER BY node.file_id, {order_column}, node.id
            """
        )
    )


def _root_children_for_definition_files(
    connection: sqlite3.Connection, definition_file_ids: set[int]
) -> tuple[dict[int, int], dict[int, list[dict[str, Any]]]]:
    if not definition_file_ids:
        return {}, {}

    available_columns = _table_columns(connection, "markdown_nodes")
    if "file_id" not in available_columns or "node_type" not in available_columns:
        return {}, {}

    variable_limit = _sqlite_variable_limit(connection)
    root_columns = ("id", "file_id", "node_type", "start_line", "start_offset_utf16")
    root_selected = ", ".join(
        f"node.{column}" if column in available_columns else f"NULL AS {column}" for column in root_columns
    )
    root_order = "node.start_offset_utf16" if "start_offset_utf16" in available_columns else "NULL"
    selected_roots: dict[int, dict[str, Any]] = {}
    ordered_file_ids = sorted(definition_file_ids)
    for start in range(0, len(ordered_file_ids), variable_limit):
        file_batch = ordered_file_ids[start : start + variable_limit]
        file_placeholders = ", ".join("?" for _ in file_batch)
        roots = _dict_rows(
            connection.execute(
                f"""
                SELECT {root_selected}
                FROM markdown_nodes AS node
                WHERE node.node_type = 'root'
                  AND node.file_id IN ({file_placeholders})
                ORDER BY node.file_id, {root_order}, node.id
                """,
                file_batch,
            )
        )
        for root in roots:
            current = selected_roots.get(root["file_id"])
            if current is None or _node_position_key(root) < _node_position_key(current):
                selected_roots[root["file_id"]] = root

    if not selected_roots:
        return {}, {}

    root_ids_by_file = dict(sorted((file_id, root["id"]) for file_id, root in selected_roots.items()))
    if "parent_id" not in available_columns:
        return root_ids_by_file, {}

    selected_root_ids = tuple(root_ids_by_file.values())
    ordinal_order = "child.ordinal" if "ordinal" in available_columns else "NULL"
    child_columns = ("id", "file_id", "parent_id", "ordinal", "node_type", "start_line", "start_offset_utf16")
    child_selected = ", ".join(
        f"child.{column}" if column in available_columns else f"NULL AS {column}" for column in child_columns
    )
    children: list[dict[str, Any]] = []
    for start in range(0, len(selected_root_ids), variable_limit):
        root_batch = selected_root_ids[start : start + variable_limit]
        root_placeholders = ", ".join("?" for _ in root_batch)
        children.extend(
            _dict_rows(
                connection.execute(
                    f"""
                    SELECT {child_selected}
                    FROM markdown_nodes AS child
                    WHERE child.parent_id IN ({root_placeholders})
                      AND child.parent_id IN (
                          SELECT parent_id
                          FROM markdown_nodes
                          WHERE node_type = 'footnoteDefinition'
                            AND parent_id IS NOT NULL
                      )
                    ORDER BY child.parent_id,
                             {ordinal_order} IS NULL,
                             {ordinal_order},
                             child.id
                    """,
                    root_batch,
                )
            )
        )
    return root_ids_by_file, _children_by_parent(children)


def _source_footnote_references(file_paths: dict[int, str]) -> list[tuple[int, str, int]]:
    references = []
    for file_id, path in file_paths.items():
        cached_references = _FOOTNOTE_REFERENCE_CACHE.get(path)
        if cached_references is None:
            source = _read_source(path)
            if source is None:
                cached_references = ()
            else:
                path_references = []
                fence: tuple[str, int] | None = None
                for line_number, line in enumerate(source.splitlines(), start=1):
                    fence_match = _FENCE_RE.match(line)
                    if fence is not None:
                        if (
                            fence_match is not None
                            and not fence_match.group(2).strip()
                            and fence_match.group(1)[0] == fence[0]
                            and len(fence_match.group(1)) >= fence[1]
                        ):
                            fence = None
                        continue
                    if fence_match is not None:
                        fence = (fence_match.group(1)[0], len(fence_match.group(1)))
                        continue
                    visible_line = re.sub(r"`+[^`\n]*`+", "", line)
                    for match in _FOOTNOTE_REFERENCE_RE.finditer(visible_line):
                        path_references.append((match.group(1), line_number))
                cached_references = tuple(path_references)
            _FOOTNOTE_REFERENCE_CACHE[path] = cached_references
        references.extend((file_id, identifier, line) for identifier, line in cached_references)
    return references


def find_invalid_frontmatter(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               frontmatter_errors.error_output,
               frontmatter_errors.line,
               frontmatter_errors.column
        FROM frontmatter_errors
        JOIN vault_files ON vault_files.id = frontmatter_errors.file_id
        ORDER BY vault_files.path, frontmatter_errors.id
        """
    )

    return [
        ValidationWarning(rule="invalidFrontmatter", path=path, message=error_output, line=line, column=column)
        for path, error_output, line, column in rows
    ]


def find_duplicate_frontmatter_property_keys(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               node.key
        FROM frontmatter_nodes AS node
        JOIN vault_files
          ON vault_files.id = node.file_id
        WHERE node.key IS NOT NULL
        GROUP BY node.file_id,
                 node.parent_id,
                 node.key
        HAVING COUNT(*) > 1
        ORDER BY vault_files.path, node.parent_id, node.key
        """
    )

    return [
        ValidationWarning(
            rule="duplicateFrontmatterPropertyKey",
            path=path,
            message=f"Frontmatter property key `{key}` occurs more than once.",
        )
        for path, key in rows
    ]


def find_raw_html(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               markdown_nodes.start_line
        FROM markdown_nodes
        JOIN vault_files ON vault_files.id = markdown_nodes.file_id
        WHERE markdown_nodes.node_type = 'html'
        ORDER BY vault_files.path, markdown_nodes.start_line, markdown_nodes.id
        """
    )

    return [
        ValidationWarning(rule="rawHtml", path=path, message="Raw HTML must not be used.", line=line)
        for path, line in rows
    ]


def find_duplicate_filenames(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        WITH duplicate_filenames(name, extension) AS (
            SELECT name,
                   extension
            FROM vault_files
            GROUP BY name, extension
            HAVING COUNT(*) > 1
        )
        SELECT vault_files.path
        FROM vault_files
        JOIN duplicate_filenames
          ON duplicate_filenames.name = vault_files.name
         AND duplicate_filenames.extension = vault_files.extension
        ORDER BY vault_files.name, vault_files.extension, vault_files.path
        """
    )

    return [
        ValidationWarning(
            rule="duplicateFilename", path=path, message=f"Filename `{Path(path).name}` is duplicated in the vault."
        )
        for (path,) in rows
    ]


def find_duplicate_heading_names(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               markdown_nodes.value
        FROM markdown_nodes
        JOIN vault_files
          ON vault_files.id = markdown_nodes.file_id
        WHERE markdown_nodes.node_type = 'heading'
          AND markdown_nodes.value IS NOT NULL
        GROUP BY markdown_nodes.file_id,
                 markdown_nodes.value
        HAVING COUNT(*) > 1
        ORDER BY vault_files.path, markdown_nodes.value
        """
    )

    return [
        ValidationWarning(
            rule="duplicateHeadingName", path=path, message=f"Heading `{heading}` occurs more than once in the note."
        )
        for path, heading in rows
    ]


def _is_camel_case(value: str) -> bool:
    return _CAMEL_CASE_RE.fullmatch(value) is not None


def find_non_camel_case_filenames(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    rows = connection.execute(
        """
        SELECT path,
               name,
               kind
        FROM vault_files
        ORDER BY path
        """
    )

    return [
        ValidationWarning(rule="nonCamelCaseFilename", path=path, message=f"Filename stem `{name}` must use camelCase.")
        for path, name, kind in rows
        if Path(path).name not in _FILENAME_CASE_EXCEPTIONS
        and not (
            kind == "markdown" and Path(path).relative_to(root_path).parts[0] in _FILENAME_CASE_EXCEPTION_DIRECTORIES
        )
        and not _is_camel_case(name)
    ]


def find_non_camel_case_directories(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT path
        FROM vault_directories
        WHERE parent_id IS NOT NULL
        ORDER BY path
        """
    )

    return [
        ValidationWarning(
            rule="nonCamelCaseDirectory", path=path, message=f"Folder name `{Path(path).name}` must use camelCase."
        )
        for (path,) in rows
        if not _is_camel_case(Path(path).name)
    ]


def find_aliases_without_non_camel_case(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               item.value
        FROM frontmatter_nodes AS parent
        JOIN vault_files
          ON vault_files.id = parent.file_id
        LEFT JOIN frontmatter_nodes AS item
          ON item.parent_id = parent.id
         AND item.node_type = 'scalar'
        WHERE parent.parent_id IS NULL
          AND parent.key = 'aliases'
          AND parent.node_type = 'sequence'
        ORDER BY vault_files.path, item.id
        """
    )

    aliases_by_path: dict[str, list[str]] = {}
    for path, value in rows:
        aliases_by_path.setdefault(path, [])
        if value is not None:
            aliases_by_path[path].append(value)

    return [
        ValidationWarning(
            rule="aliasMissingNonCamelCase", path=path, message="Aliases must contain at least one non-camelCase value."
        )
        for path, aliases in aliases_by_path.items()
        if not any(not _is_camel_case(alias) for alias in aliases)
    ]


def find_tags_containing_hash(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        WITH frontmatter_tag_values(file_id, value) AS (
            SELECT node.file_id,
                   node.value
            FROM frontmatter_nodes AS node
            WHERE node.parent_id IS NULL
              AND node.key = 'tags'
              AND node.node_type = 'scalar'

            UNION ALL

            SELECT item.file_id,
                   item.value
            FROM frontmatter_nodes AS item
            JOIN frontmatter_nodes AS parent
              ON parent.id = item.parent_id
            WHERE parent.parent_id IS NULL
              AND parent.node_type = 'sequence'
              AND parent.key = 'tags'
              AND item.node_type = 'scalar'
        )
        SELECT DISTINCT
               vault_files.path,
               frontmatter_tag_values.value
        FROM frontmatter_tag_values
        JOIN vault_files
          ON vault_files.id = frontmatter_tag_values.file_id
        WHERE instr(frontmatter_tag_values.value, '#') > 0
        ORDER BY vault_files.path, frontmatter_tag_values.value
        """
    )

    return [
        ValidationWarning(rule="tagContainsHash", path=path, message=f'Tag `{value}` must not contain "#".')
        for path, value in rows
    ]


def find_non_camel_case_tag_segments(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT DISTINCT
               vault_files.path,
               vault_tags.name
        FROM note_tag_occurrences
        JOIN vault_tags
          ON vault_tags.id = note_tag_occurrences.tag_id
        LEFT JOIN frontmatter_nodes
          ON frontmatter_nodes.id = note_tag_occurrences.frontmatter_node_id
        LEFT JOIN markdown_nodes
          ON markdown_nodes.id = note_tag_occurrences.markdown_node_id
        JOIN vault_files
          ON vault_files.id = COALESCE(frontmatter_nodes.file_id, markdown_nodes.file_id)
        ORDER BY vault_files.path, vault_tags.name
        """
    )

    return [
        ValidationWarning(
            rule="nonCamelCaseTagSegment", path=path, message=f"Every segment of tag `{tag}` must use camelCase."
        )
        for path, tag in rows
        if any(not _is_camel_case(segment) for segment in tag.split("/"))
    ]


def _has_unbalanced_math_braces(value: str) -> bool:
    depth = 0
    for index, character in enumerate(value):
        if character not in "{}":
            continue

        backslash_count = 0
        previous_index = index - 1
        while previous_index >= 0 and value[previous_index] == "\\":
            backslash_count += 1
            previous_index -= 1

        if backslash_count % 2 == 1:
            continue

        if character == "{":
            depth += 1
        elif depth == 0:
            return True
        else:
            depth -= 1

    return depth != 0


def find_unbalanced_math_braces(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               markdown_nodes.start_line,
               markdown_nodes.value
        FROM markdown_nodes
        JOIN vault_files
          ON vault_files.id = markdown_nodes.file_id
        WHERE markdown_nodes.node_type IN ('math', 'inlineMath')
        ORDER BY vault_files.path, markdown_nodes.start_line, markdown_nodes.id
        """
    )

    return [
        ValidationWarning(
            rule="unbalancedMathBraces", path=path, message="MathJax contains unbalanced braces.", line=line
        )
        for path, line, value in rows
        if _has_unbalanced_math_braces(value)
    ]


def find_obsidian_callouts(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               markdown_nodes.start_line
        FROM markdown_nodes
        JOIN vault_files ON vault_files.id = markdown_nodes.file_id
        WHERE markdown_nodes.node_type = 'blockquote'
          AND json_extract(markdown_nodes.attributes_json, '$.callout') = 1
        ORDER BY vault_files.path, markdown_nodes.start_line, markdown_nodes.id
        """
    )

    return [
        ValidationWarning(rule="obsidianCallout", path=path, message="Obsidian callouts must not be used.", line=line)
        for path, line in rows
    ]


def find_mermaid_diagrams(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               markdown_nodes.start_line
        FROM markdown_nodes
        JOIN vault_files ON vault_files.id = markdown_nodes.file_id
        WHERE markdown_nodes.node_type = 'code'
          AND lower(json_extract(markdown_nodes.attributes_json, '$.lang')) = 'mermaid'
        ORDER BY vault_files.path, markdown_nodes.start_line, markdown_nodes.id
        """
    )

    return [
        ValidationWarning(rule="mermaidDiagram", path=path, message="Mermaid diagrams must not be used.", line=line)
        for path, line in rows
    ]


def find_code_blocks_without_language(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               markdown_nodes.start_line,
               json_extract(markdown_nodes.attributes_json, '$.lang')
        FROM markdown_nodes
        JOIN vault_files
          ON vault_files.id = markdown_nodes.file_id
        WHERE markdown_nodes.node_type = 'code'
          AND json_extract(markdown_nodes.attributes_json, '$.fenced') = 1
        ORDER BY vault_files.path, markdown_nodes.start_line, markdown_nodes.id
        """
    )

    return [
        ValidationWarning(
            rule="codeBlockMissingLanguage", path=path, message="Fenced code blocks must specify a language.", line=line
        )
        for path, line, language in rows
        if language is None or not isinstance(language, str) or not language.strip()
    ]


def find_duplicate_list_values(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               parent.key,
               item.value
        FROM frontmatter_nodes AS item
        JOIN frontmatter_nodes AS parent
          ON parent.id = item.parent_id
        JOIN vault_files
          ON vault_files.id = item.file_id
        WHERE parent.node_type = 'sequence'
          AND item.node_type = 'scalar'
        GROUP BY item.file_id,
                 item.parent_id,
                 parent.key,
                 item.value
        HAVING COUNT(*) > 1
        ORDER BY vault_files.path, parent.key, item.value
        """
    )

    return [
        ValidationWarning(
            rule="duplicateFrontmatterListValue",
            path=path,
            message=(f"Frontmatter property `{property_key}` contains duplicate value `{value}`."),
        )
        for path, property_key, value in rows
    ]


def find_related_not_wikilinks(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               item.value
        FROM frontmatter_nodes AS item
        JOIN frontmatter_nodes AS parent
          ON parent.id = item.parent_id
        JOIN vault_files
          ON vault_files.id = item.file_id
        WHERE parent.node_type = 'sequence'
          AND parent.key = 'related'
          AND item.node_type = 'scalar'
          AND (
              item.value IS NULL
              OR item.value NOT LIKE '[[%'
              OR item.value NOT LIKE '%]]'
          )
        ORDER BY vault_files.path, item.ordinal
        """
    )

    return [
        ValidationWarning(
            rule="relatedNotWikilink",
            path=path,
            message=f"Related value `{value if value is not None else ''}` must be a wikilink.",
        )
        for path, value in rows
    ]


def find_missing_embeds(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               vault_links.raw_target
        FROM vault_links
        JOIN vault_files
          ON vault_files.id = vault_links.source_file_id
        WHERE vault_links.is_embed = 1
          AND vault_links.resolution_status = 'missing'
        ORDER BY vault_files.path, vault_links.id
        """
    )

    return [
        ValidationWarning(rule="missingEmbed", path=path, message=f"Embed target `{raw_target}` does not exist.")
        for path, raw_target in rows
    ]


def find_properties_not_lists(connection: sqlite3.Connection) -> list[ValidationWarning]:
    rows = connection.execute(
        """
        SELECT vault_files.path,
               frontmatter_nodes.key,
               frontmatter_nodes.node_type
        FROM frontmatter_nodes
        JOIN vault_files
          ON vault_files.id = frontmatter_nodes.file_id
        WHERE frontmatter_nodes.parent_id IS NULL
          AND frontmatter_nodes.key IN ('aliases', 'tags', 'related')
          AND frontmatter_nodes.node_type != 'sequence'
        ORDER BY vault_files.path, frontmatter_nodes.key
        """
    )

    return [
        ValidationWarning(
            rule="frontmatterPropertyNotList",
            path=path,
            message=f"Frontmatter property `{key}` must be a list, not `{node_type}`.",
        )
        for path, key, node_type in rows
    ]


def _find_vault_root_path(connection: sqlite3.Connection) -> Path:
    root_row = connection.execute("SELECT path FROM vault_directories WHERE parent_id IS NULL").fetchone()
    if root_row is None:
        raise RuntimeError("Vault root directory is missing from the index.")
    return Path(root_row[0])


def _find_exercise_directory_id(connection: sqlite3.Connection) -> int | None:
    # Resolve the vault's `health/exercises` directory.
    exercise_directory_path = _find_vault_root_path(connection) / "health" / "exercises"
    directory_row = connection.execute(
        "SELECT id FROM vault_directories WHERE path = ?", (str(exercise_directory_path),)
    ).fetchone()
    return directory_row[0] if directory_row is not None else None


def find_invalid_exercise_types(connection: sqlite3.Connection) -> list[ValidationWarning]:
    exercise_directory_id = _find_exercise_directory_id(connection)
    if exercise_directory_id is None:
        return []

    rows = connection.execute(
        """
        SELECT vault_files.path,
               node.node_type,
               node.value
        FROM frontmatter_nodes AS node
        JOIN vault_files
          ON vault_files.id = node.file_id
        WHERE vault_files.kind = 'markdown'
          AND vault_files.directory_id = ?
          AND node.parent_id IS NULL
          AND node.key = 'exerciseType'
        ORDER BY vault_files.path, node.id
        """,
        (exercise_directory_id,),
    )

    return [
        ValidationWarning(
            rule="invalidExerciseType",
            path=path,
            message=(
                "Frontmatter property `exerciseType` must be a scalar with one of these values: "
                f"{', '.join(_VALID_EXERCISE_TYPES)}."
            ),
        )
        for path, node_type, value in rows
        if node_type != "scalar" or value not in _VALID_EXERCISE_TYPES
    ]


def find_invalid_muscle_names(connection: sqlite3.Connection) -> list[ValidationWarning]:
    exercise_directory_id = _find_exercise_directory_id(connection)
    if exercise_directory_id is None:
        return []

    rows = connection.execute(
        """
        SELECT vault_files.path,
               node.key,
               node.node_type,
               node.value
        FROM frontmatter_nodes AS node
        JOIN vault_files
          ON vault_files.id = node.file_id
        WHERE vault_files.kind = 'markdown'
          AND vault_files.directory_id = ?
          AND node.parent_id IS NULL
          AND node.key IN ('primaryMuscle', 'secondaryMuscle')
        ORDER BY vault_files.path, node.key, node.id
        """,
        (exercise_directory_id,),
    )

    return [
        ValidationWarning(
            rule="invalidMuscleName",
            path=path,
            message=(
                f"Frontmatter property `{property_key}` must be a scalar with one of these values: "
                f"{', '.join(_VALID_MUSCLE_NAMES)}."
            ),
        )
        for path, property_key, node_type, value in rows
        if node_type != "scalar" or value not in _VALID_MUSCLE_NAMES
    ]


def find_hidden_markdown_notes(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    rows = connection.execute(
        """
        SELECT path
        FROM vault_files
        WHERE kind = 'markdown'
        ORDER BY path
        """
    )

    # A dot-prefixed filename or ancestor directory makes the note hidden.
    return [
        ValidationWarning(rule="hiddenMarkdownNote", path=path, message="Markdown notes must not be hidden.")
        for (path,) in rows
        if any(part.startswith(".") for part in Path(path).relative_to(root_path).parts)
    ]


def find_unexpected_root_files(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    rows = connection.execute(
        """
        SELECT vault_files.path
        FROM vault_files
        JOIN vault_directories AS directory
          ON directory.id = vault_files.directory_id
        WHERE directory.path = ?
        ORDER BY vault_files.path
        """,
        (str(root_path),),
    )

    return [
        ValidationWarning(
            rule="unexpectedRootFile",
            path=path,
            message="Only README.md, TODO.md, and tmp.md may be stored directly in the vault root.",
        )
        for (path,) in rows
        if Path(path).name not in _ALLOWED_VAULT_ROOT_FILENAMES
    ]


def find_missing_frontmatter_properties(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    rows = connection.execute(
        """
        WITH required_properties(property_name) AS (
            VALUES ('aliases'), ('tags'), ('related')
        )
        SELECT vault_files.path,
               required_properties.property_name
        FROM vault_files
        CROSS JOIN required_properties
        WHERE vault_files.kind = 'markdown'
          AND NOT EXISTS (
              SELECT 1
              FROM frontmatter_errors AS error
              WHERE error.file_id = vault_files.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM frontmatter_nodes AS node
              WHERE node.file_id = vault_files.id
                AND node.parent_id IS NULL
                AND node.key = required_properties.property_name
          )
        ORDER BY vault_files.path, required_properties.property_name
        """
    )

    return [
        ValidationWarning(
            rule="missingFrontmatterProperty",
            path=path,
            message=f"Required frontmatter property `{property_name}` is missing.",
        )
        for path, property_name in rows
        if Path(path).relative_to(root_path).parts[0] not in _MISSING_FRONTMATTER_PROPERTY_EXCEPTION_DIRECTORIES
    ]


def find_missing_embedded_block_references(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    nodes_by_id = _nodes_by_id(_markdown_node_rows(connection))
    warnings = []

    for link in _vault_link_rows(connection):
        raw_target = link["raw_target"] or ""
        fragment = raw_target.partition("#")[2]
        if (
            link["link_syntax"] != "wikilink"
            or not link["is_embed"]
            or not fragment.startswith("^")
            or _WEB_URL_RE.match(raw_target)
        ):
            continue
        if link["resolution_status"] == "resolved" and link["target_node_id"] is not None:
            continue
        warnings.append(
            ValidationWarning(
                rule="embeddedBlockReferenceMissing",
                path=file_paths[link["source_file_id"]],
                message=f"Embedded block reference `{raw_target}` does not resolve to an existing block.",
                line=_link_source_line(link, nodes_by_id),
            )
        )

    return sorted(warnings, key=lambda warning: (warning.path, warning.line or 0, warning.message))


def find_missing_embedded_heading_references(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    nodes_by_id = _nodes_by_id(_markdown_node_rows(connection))
    warnings = []

    for link in _vault_link_rows(connection):
        raw_target = link["raw_target"] or ""
        fragment = raw_target.partition("#")[2]
        if (
            link["link_syntax"] != "wikilink"
            or not link["is_embed"]
            or not fragment
            or fragment.startswith("^")
            or _WEB_URL_RE.match(raw_target)
        ):
            continue
        if link["resolution_status"] == "resolved" and link["target_node_id"] is not None:
            continue
        warnings.append(
            ValidationWarning(
                rule="embeddedHeadingReferenceMissing",
                path=file_paths[link["source_file_id"]],
                message=f"Embedded heading reference `{raw_target}` does not resolve to an existing heading.",
                line=_link_source_line(link, nodes_by_id),
            )
        )

    return sorted(warnings, key=lambda warning: (warning.path, warning.line or 0, warning.message))


def _exercise_file_ids(file_rows: list[dict[str, Any]], root_path: Path, exercise_directory: Path) -> set[int]:
    return {
        row["id"] for row in file_rows if row["kind"] == "markdown" and Path(row["path"]).parent == exercise_directory
    }


def find_exercise_descriptions_outside_directory(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    exercise_directory = root_path / "health" / "exercises"
    file_rows = _vault_file_rows(connection)
    frontmatter_nodes = _frontmatter_node_rows(connection)
    exercise_keys = {"exerciseType", "primaryMuscle", "secondaryMuscle", "primary-muscle", "secondary-muscle"}
    exercise_file_ids = {
        node["file_id"] for node in frontmatter_nodes if node["parent_id"] is None and node["key"] in exercise_keys
    }

    return [
        ValidationWarning(
            rule="exerciseDescriptionWrongFolder",
            path=row["path"],
            message="Exercise description notes must be stored in `health/exercises`.",
        )
        for row in file_rows
        if row["id"] in exercise_file_ids
        and row["kind"] == "markdown"
        and Path(row["path"]).parent != exercise_directory
    ]


def find_exercise_images_outside_directory(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    exercise_directory = root_path / "health" / "exercises"
    exercise_image_directory = root_path / "attachments" / "images" / "exercises"
    file_rows = _vault_file_rows(connection)
    exercise_file_ids = _exercise_file_ids(file_rows, root_path, exercise_directory)
    exercise_stems = {Path(row["path"]).stem for row in file_rows if row["id"] in exercise_file_ids}
    target_image_ids = {
        link["target_file_id"]
        for link in _vault_link_rows(connection)
        if link["source_file_id"] in exercise_file_ids
        and link["is_embed"]
        and link["target_file_id"] is not None
        and any(row["id"] == link["target_file_id"] and _is_image_file(row) for row in file_rows)
    }
    warnings = []

    for row in file_rows:
        if not _is_image_file(row):
            continue
        is_exercise_image = (
            _path_is_within(Path(row["path"]), exercise_image_directory)
            or row["id"] in target_image_ids
            or Path(row["path"]).stem in exercise_stems
        )
        if is_exercise_image and not _path_is_within(Path(row["path"]), exercise_image_directory):
            warnings.append(
                ValidationWarning(
                    rule="exerciseImageWrongFolder",
                    path=row["path"],
                    message="Exercise images must be stored in `attachments/images/exercises`.",
                )
            )
    return warnings


def find_image_descriptions_outside_directory(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    description_directory = root_path / "attachments" / "imageDescriptions"
    exercise_directory = root_path / "health" / "exercises"
    file_rows = _vault_file_rows(connection)
    image_stems = {Path(row["path"]).stem for row in file_rows if _is_image_file(row)}
    frontmatter_nodes = _frontmatter_node_rows(connection)
    description_file_ids = {
        node["file_id"] for node in frontmatter_nodes if node["parent_id"] is None and node["key"] == "image"
    }
    warnings = []

    for row in file_rows:
        path = Path(row["path"])
        if row["kind"] != "markdown" or path.parent == exercise_directory:
            continue
        is_description = (
            _path_is_within(path, description_directory)
            or row["id"] in description_file_ids
            or path.stem in image_stems
        )
        if is_description and not _path_is_within(path, description_directory):
            warnings.append(
                ValidationWarning(
                    rule="imageDescriptionWrongFolder",
                    path=row["path"],
                    message="Image description notes must be stored in `attachments/imageDescriptions`.",
                )
            )

    return warnings


def find_images_outside_directory(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    image_directory = root_path / "attachments" / "images"
    return [
        ValidationWarning(
            rule="imageWrongFolder", path=row["path"], message="Images must be stored in `attachments/images`."
        )
        for row in _vault_file_rows(connection)
        if _is_image_file(row) and not _path_is_within(Path(row["path"]), image_directory)
    ]


def _definition_source(definition: dict[str, Any], file_paths: dict[int, str]) -> str:
    return _node_source(definition, file_paths) or definition["text"]


def _definition_fallback_texts(connection: sqlite3.Connection, definition_ids: list[int]) -> dict[int, str]:
    texts: dict[int, str] = {}
    unique_ids = list(dict.fromkeys(definition_ids))
    if not unique_ids:
        return texts

    available_columns = _table_columns(connection, "markdown_nodes")
    variable_limit = _sqlite_variable_limit(connection)
    for start in range(0, len(unique_ids), variable_limit):
        batch = unique_ids[start : start + variable_limit]
        placeholders = ", ".join("?" for _ in batch)
        if "value" not in available_columns:
            texts.update({definition_id: "" for definition_id in batch})
            continue
        if "parent_id" not in available_columns:
            rows = _dict_rows(
                connection.execute(f"SELECT id, value FROM markdown_nodes WHERE id IN ({placeholders})", batch)
            )
            values_by_id = {row["id"]: row["value"] for row in rows}
            texts.update(
                {
                    definition_id: str(values_by_id[definition_id])
                    if values_by_id.get(definition_id) is not None
                    else ""
                    for definition_id in batch
                }
            )
            continue

        ordinal = "node.ordinal" if "ordinal" in available_columns else "NULL"
        child_ordinal = "child.ordinal" if "ordinal" in available_columns else "NULL"
        rows = _dict_rows(
            connection.execute(
                f"""
                WITH RECURSIVE definition_tree(definition_id, id, parent_id, ordinal, value) AS (
                    SELECT node.id, node.id, node.parent_id, {ordinal}, node.value
                    FROM markdown_nodes AS node
                    WHERE node.id IN ({placeholders})
                    UNION ALL
                    SELECT tree.definition_id, child.id, child.parent_id, {child_ordinal}, child.value
                    FROM markdown_nodes AS child
                    JOIN definition_tree AS tree ON tree.id = child.parent_id
                )
                SELECT definition_id, id, parent_id, ordinal, value
                FROM definition_tree
                """,
                batch,
            )
        )
        nodes_by_id = {row["id"]: row for row in rows}
        children_by_parent = _children_by_parent(list(nodes_by_id.values()))
        for definition_id in batch:
            if definition_id not in nodes_by_id:
                texts[definition_id] = ""
                continue
            texts[definition_id] = _node_text(definition_id, nodes_by_id, children_by_parent)
    return texts


def _definition_source_texts(connection: sqlite3.Connection, definitions: list[dict[str, Any]]) -> dict[int, str]:
    lines_by_path: dict[str, list[str] | None] = {}
    texts: dict[int, str] = {}
    fallback_ids = []
    for definition in definitions:
        path = definition["path"]
        if path not in lines_by_path:
            source = _read_source(path)
            lines_by_path[path] = source.splitlines(keepends=True) if source is not None else None

        lines = lines_by_path[path]
        source_text = None
        if lines is not None and definition["start_line"] is not None:
            start = max(definition["start_line"] - 1, 0)
            end = definition["end_line"] if definition["end_line"] is not None else definition["start_line"]
            source_text = "".join(lines[start:end])
        if source_text:
            texts[definition["id"]] = source_text
        else:
            fallback_ids.append(definition["id"])

    texts.update(_definition_fallback_texts(connection, fallback_ids))
    return texts


def _contains_local_pdf(text: str) -> bool:
    for match in re.finditer(r"(?i)(?:[A-Za-z][A-Za-z0-9+.-]*://)?[^\s<>()\[\]|`]+\.pdf", text):
        token = match.group(0)
        if not token.casefold().startswith(("http://", "https://")):
            return True
    return False


def find_local_pdf_citations_without_original_url(connection: sqlite3.Connection) -> list[ValidationWarning]:
    definitions = _footnote_definition_rows(connection, markdown_only=False)
    texts = _definition_source_texts(connection, definitions)
    return [
        ValidationWarning(
            rule="localPdfCitationMissingOriginalUrl",
            path=definition["path"],
            message="A citation with a local PDF URI must also contain the original URL.",
            line=definition["start_line"],
        )
        for definition in definitions
        if _contains_local_pdf(texts[definition["id"]]) and _WEB_URL_RE.search(texts[definition["id"]]) is None
    ]


def find_empty_directories(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    directories = _dict_rows(connection.execute("SELECT id, path, parent_id FROM vault_directories ORDER BY path, id"))
    file_rows = _vault_file_rows(connection)
    nonempty_directory_ids = {row["directory_id"] for row in file_rows if row["directory_id"] is not None}
    nonempty_directory_ids.update(row["parent_id"] for row in directories if row["parent_id"] is not None)

    return [
        ValidationWarning(
            rule="emptyDirectory", path=row["path"], message="Folders outside `.obsidian` and `.git` must not be empty."
        )
        for row in directories
        if row["id"] not in nonempty_directory_ids and not _is_system_path(Path(row["path"]), root_path)
    ]


def find_empty_files(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    warnings = []
    for row in _vault_file_rows(connection):
        path = Path(row["path"])
        if _is_system_path(path, root_path):
            continue
        try:
            is_empty = path.is_file() and path.stat().st_size == 0
        except OSError:
            is_empty = False
        if is_empty:
            warnings.append(
                ValidationWarning(
                    rule="emptyFile",
                    path=row["path"],
                    message="Files outside `.obsidian` and `.git` must not be empty.",
                )
            )
    return warnings


def find_unreferenced_footnote_definitions(connection: sqlite3.Connection) -> list[ValidationWarning]:
    definitions = _footnote_definition_rows(connection)
    file_paths = {definition["file_id"]: definition["path"] for definition in definitions}
    for definition in definitions:
        definition["identifier"] = _node_identifier(definition, file_paths)

    references_by_file: dict[int, set[str]] = {}
    for file_id, identifier, _ in _source_footnote_references(file_paths):
        references_by_file.setdefault(file_id, set()).add(identifier)

    return [
        ValidationWarning(
            rule="unreferencedFootnoteDefinition",
            path=definition["path"],
            message=f"Footnote definition `[^{definition['identifier']}]` is not referenced.",
            line=definition["start_line"],
        )
        for definition in definitions
        if definition["identifier"] is not None
        and definition["identifier"] not in references_by_file.get(definition["file_id"], set())
    ]


def find_headings_with_markup(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    children_by_parent = _children_by_parent(nodes)
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    warnings = []

    for heading in (node for node in nodes if node["node_type"] == "heading"):
        if any(
            descendant["node_type"] != "text" for descendant in _node_descendants(heading["id"], children_by_parent)
        ):
            warnings.append(
                ValidationWarning(
                    rule="headingContainsMarkup",
                    path=file_paths[heading["file_id"]],
                    message="Headings must contain text only.",
                    line=heading["start_line"],
                )
            )
    return warnings


def find_heading_level_jumps(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    headings_by_file = _nodes_by_file(nodes)
    warnings = []

    for file_id, file_nodes in headings_by_file.items():
        previous_depth = None
        for heading in (node for node in file_nodes if node["node_type"] == "heading"):
            depth = _node_depth(heading, file_paths)
            if depth is None:
                continue
            if previous_depth is not None and depth > previous_depth + 1:
                warnings.append(
                    ValidationWarning(
                        rule="headingLevelJump",
                        path=file_paths[file_id],
                        message=f"Heading level increases from {previous_depth} to {depth}.",
                        line=heading["start_line"],
                    )
                )
            previous_depth = depth
    return warnings


def _description_candidate_ids(
    file_rows: list[dict[str, Any]], frontmatter_nodes: list[dict[str, Any]], root_path: Path
) -> set[int]:
    description_directory = root_path / "attachments" / "imageDescriptions"
    exercise_directory = root_path / "health" / "exercises"
    image_stems = {Path(row["path"]).stem for row in file_rows if _is_image_file(row)}
    properties_by_file: dict[int, set[str]] = {}
    for node in frontmatter_nodes:
        if node["parent_id"] is None:
            properties_by_file.setdefault(node["file_id"], set()).add(node["key"])

    candidates = set()
    for row in file_rows:
        if row["kind"] != "markdown" or Path(row["path"]).parent == exercise_directory:
            continue
        path = Path(row["path"])
        properties = properties_by_file.get(row["id"], set())
        if (
            _path_is_within(path, description_directory)
            or "image" in properties
            or ("source" in properties and path.stem in image_stems)
        ):
            candidates.add(row["id"])
    return candidates


def _exercise_image_ids(
    file_rows: list[dict[str, Any]], links: list[dict[str, Any]], root_path: Path
) -> tuple[set[int], set[int]]:
    exercise_directory = root_path / "health" / "exercises"
    exercise_image_directory = root_path / "attachments" / "images" / "exercises"
    file_by_id = {row["id"]: row for row in file_rows}
    exercise_file_ids = _exercise_file_ids(file_rows, root_path, exercise_directory)
    exercise_stems = {Path(file_by_id[file_id]["path"]).stem for file_id in exercise_file_ids}
    linked_image_ids = {
        link["target_file_id"]
        for link in links
        if link["source_file_id"] in exercise_file_ids
        and link["is_embed"]
        and link["target_file_id"] in file_by_id
        and _is_image_file(file_by_id[link["target_file_id"]])
    }
    exercise_image_ids = {
        row["id"]
        for row in file_rows
        if _is_image_file(row)
        and (
            _path_is_within(Path(row["path"]), exercise_image_directory)
            or row["id"] in linked_image_ids
            or Path(row["path"]).stem in exercise_stems
        )
    }
    return exercise_file_ids, exercise_image_ids


def _frontmatter_image_targets(
    frontmatter_nodes: list[dict[str, Any]], links: list[dict[str, Any]], candidate_ids: set[int]
) -> dict[int, set[int]]:
    image_node_ids = {
        node["id"]
        for node in frontmatter_nodes
        if node["file_id"] in candidate_ids and node["parent_id"] is None and node["key"] == "image"
    }
    targets_by_description: dict[int, set[int]] = {}
    for link in links:
        source_node_id = link["source_frontmatter_node_id"]
        if source_node_id in image_node_ids and link["target_file_id"] is not None:
            targets_by_description.setdefault(link["source_file_id"], set()).add(link["target_file_id"])
    return targets_by_description


def find_local_image_embeds_not_wikilinks(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    nodes_by_id = _nodes_by_id(_markdown_node_rows(connection))
    file_paths = {row["id"]: row["path"] for row in file_rows}
    warnings = []
    for link in _vault_link_rows(connection):
        if link["link_syntax"] != "image":
            continue
        target_row = file_by_id.get(link["target_file_id"])
        if not _is_image_target(link["raw_target"] or "", target_row["kind"] if target_row else None):
            continue
        if _WEB_URL_RE.match(link["raw_target"] or ""):
            continue
        warnings.append(
            ValidationWarning(
                rule="localImageEmbedNotWikilink",
                path=file_paths[link["source_file_id"]],
                message=f"Local image embed `{link['raw_target']}` must use a wikilink.",
                line=_link_source_line(link, nodes_by_id),
            )
        )
    return sorted(warnings, key=lambda warning: (warning.path, warning.line or 0, warning.message))


def find_images_without_descriptions(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    frontmatter_nodes = _frontmatter_node_rows(connection)
    links = _vault_link_rows(connection)
    candidates = _description_candidate_ids(file_rows, frontmatter_nodes, root_path)
    targets_by_description = _frontmatter_image_targets(frontmatter_nodes, links, candidates)
    described_image_ids = {target_id for targets in targets_by_description.values() for target_id in targets}
    described_stems = {Path(file_by_id[file_id]["path"]).stem for file_id in candidates if file_id in file_by_id}
    _, exercise_image_ids = _exercise_image_ids(file_rows, links, root_path)

    return [
        ValidationWarning(
            rule="imageMissingDescription",
            path=row["path"],
            message="Each non-exercise image must have a description note.",
        )
        for row in file_rows
        if _is_image_file(row)
        and row["id"] not in exercise_image_ids
        and row["id"] not in described_image_ids
        and Path(row["path"]).stem not in described_stems
    ]


def find_multiple_h1_headings(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    headings_by_file = _nodes_by_file(nodes)
    warnings = []

    for file_id, file_nodes in headings_by_file.items():
        seen_heading = False
        for heading in (node for node in file_nodes if node["node_type"] == "heading"):
            depth = _node_depth(heading, file_paths)
            if seen_heading and depth == 1:
                warnings.append(
                    ValidationWarning(
                        rule="multipleH1Headings",
                        path=file_paths[file_id],
                        message="A note must not contain an H1 heading after its first heading.",
                        line=heading["start_line"],
                    )
                )
            seen_heading = True
    return warnings


def find_internal_links_without_filename_stems(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    nodes_by_id = _nodes_by_id(_markdown_node_rows(connection))
    warnings = []

    for link in _vault_link_rows(connection):
        target_row = file_by_id.get(link["target_file_id"])
        if (
            target_row is None
            or target_row["kind"] != "markdown"
            or link["link_syntax"] not in {"wikilink", "link"}
            or link["resolution_status"] != "resolved"
        ):
            continue
        target_path = (link["raw_target"] or "").partition("#")[0].strip()
        target_name = target_row["name"] or Path(target_row["path"]).stem
        if not target_path or target_path == target_name:
            continue
        source_path = next(row["path"] for row in file_rows if row["id"] == link["source_file_id"])
        warnings.append(
            ValidationWarning(
                rule="internalLinkUsesFilenameStem",
                path=source_path,
                message=f"Internal note link `{link['raw_target']}` must use `{target_name}`.",
                line=_link_source_line(link, nodes_by_id),
            )
        )
    return sorted(warnings, key=lambda warning: (warning.path, warning.line or 0, warning.message))


def find_web_source_footnotes_without_urls(connection: sqlite3.Connection) -> list[ValidationWarning]:
    definitions, _, _, file_paths = _definition_records(connection)
    return [
        ValidationWarning(
            rule="webSourceFootnoteMissingUrl",
            path=file_paths[definition["file_id"]],
            message="Web-source footnotes must contain an HTTP or HTTPS URL.",
            line=definition["start_line"],
        )
        for definition in definitions
        if _is_web_source_footnote(definition["identifier"], _definition_source(definition, file_paths))
        and _WEB_URL_RE.search(_definition_source(definition, file_paths)) is None
    ]


def find_web_source_footnotes_without_access_dates(connection: sqlite3.Connection) -> list[ValidationWarning]:
    definitions = _footnote_definition_rows(connection, markdown_only=False)
    texts = _definition_source_texts(connection, definitions)
    return [
        ValidationWarning(
            rule="webSourceFootnoteMissingAccessDate",
            path=definition["path"],
            message="Web-source footnotes must end with `date accessed: YYYY-MM-DD`.",
            line=definition["start_line"],
        )
        for definition in definitions
        if _WEB_URL_RE.search(texts[definition["id"]]) is not None
        and _FOOTNOTE_ACCESS_DATE_RE.search(texts[definition["id"]].strip()) is None
    ]


def find_exercise_related_targets_outside_exercises(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    exercise_directory = root_path / "health" / "exercises"
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    exercise_file_ids = _exercise_file_ids(file_rows, root_path, exercise_directory)
    frontmatter_nodes = _frontmatter_node_rows(connection)
    frontmatter_by_id = {node["id"]: node for node in frontmatter_nodes}
    links_by_source_node: dict[int, list[dict[str, Any]]] = {}
    for link in _vault_link_rows(connection):
        if link["source_frontmatter_node_id"] is not None:
            links_by_source_node.setdefault(link["source_frontmatter_node_id"], []).append(link)
    warnings = []

    for node in frontmatter_nodes:
        parent = frontmatter_by_id.get(node["parent_id"])
        if (
            node["file_id"] not in exercise_file_ids
            or parent is None
            or parent["key"] != "related"
            or parent["node_type"] != "sequence"
            or node["node_type"] != "scalar"
        ):
            continue
        target_links = links_by_source_node.get(node["id"], ())
        if not target_links or any(
            link["resolution_status"] != "resolved"
            or link["target_file_id"] not in file_by_id
            or Path(file_by_id[link["target_file_id"]]["path"]).parent != exercise_directory
            or file_by_id[link["target_file_id"]]["kind"] != "markdown"
            for link in target_links
        ):
            source_path = file_by_id[node["file_id"]]["path"]
            warnings.append(
                ValidationWarning(
                    rule="exerciseRelatedTargetNotExercise",
                    path=source_path,
                    message=f"Exercise related value `{node['value'] or ''}` must resolve to an exercise note.",
                )
            )
    return warnings


def find_exercise_descriptions_without_required_properties(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    exercise_directory = root_path / "health" / "exercises"
    file_rows = _vault_file_rows(connection)
    exercise_file_ids = _exercise_file_ids(file_rows, root_path, exercise_directory)
    frontmatter_nodes = _frontmatter_node_rows(connection)
    keys_by_file = {
        file_id: {node["key"] for node in frontmatter_nodes if node["file_id"] == file_id and node["parent_id"] is None}
        for file_id in exercise_file_ids
    }
    file_by_id = {row["id"]: row for row in file_rows}
    invalid_frontmatter_ids = set()
    if _table_columns(connection, "frontmatter_errors"):
        invalid_frontmatter_ids = {
            row[0] for row in connection.execute("SELECT DISTINCT file_id FROM frontmatter_errors")
        }
    return [
        ValidationWarning(
            rule="exerciseDescriptionMissingProperty",
            path=file_by_id[file_id]["path"],
            message=f"Exercise description is missing required property `{property_key}`.",
        )
        for file_id in sorted(exercise_file_ids)
        if file_id not in invalid_frontmatter_ids
        for property_key in _EXERCISE_PROPERTY_KEYS
        if property_key not in keys_by_file[file_id]
    ]


def find_exercise_images_without_descriptions(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    links = _vault_link_rows(connection)
    exercise_file_ids, exercise_image_ids = _exercise_image_ids(file_rows, links, root_path)
    described_image_ids = {
        link["target_file_id"]
        for link in links
        if link["source_file_id"] in exercise_file_ids
        and link["is_embed"]
        and link["target_file_id"] in file_by_id
        and _is_image_file(file_by_id[link["target_file_id"]])
    }
    exercise_stems = {Path(file_by_id[file_id]["path"]).stem for file_id in exercise_file_ids}
    return [
        ValidationWarning(
            rule="exerciseImageMissingDescription",
            path=file_by_id[image_id]["path"],
            message="Exercise images must have an exercise description note in `health/exercises`.",
        )
        for image_id in sorted(exercise_image_ids)
        if image_id not in described_image_ids and Path(file_by_id[image_id]["path"]).stem not in exercise_stems
    ]


def find_image_descriptions_without_source_footnotes(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    candidates = _description_candidate_ids(file_rows, _frontmatter_node_rows(connection), root_path)
    definition_file_ids = {
        node["file_id"] for node in _markdown_node_rows(connection) if node["node_type"] == "footnoteDefinition"
    }
    return [
        ValidationWarning(
            rule="imageDescriptionMissingSourceFootnote",
            path=file_by_id[file_id]["path"],
            message="Image description notes must contain a source footnote.",
        )
        for file_id in sorted(candidates)
        if file_id not in definition_file_ids
    ]


def find_image_descriptions_without_images(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    image_rows = {row["id"]: row for row in file_rows if _is_image_file(row)}
    frontmatter_nodes = _frontmatter_node_rows(connection)
    links = _vault_link_rows(connection)
    candidates = _description_candidate_ids(file_rows, frontmatter_nodes, root_path)
    targets_by_description = _frontmatter_image_targets(frontmatter_nodes, links, candidates)
    return [
        ValidationWarning(
            rule="imageDescriptionMissingImage",
            path=file_by_id[file_id]["path"],
            message="Image description notes must have a corresponding image.",
        )
        for file_id in sorted(candidates)
        if not any(target_id in image_rows for target_id in targets_by_description.get(file_id, set()))
        and not any(
            row["id"] in image_rows and Path(row["path"]).stem == Path(file_by_id[file_id]["path"]).stem
            for row in file_rows
        )
    ]


def find_image_description_stem_mismatches(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    file_rows = _vault_file_rows(connection)
    file_by_id = {row["id"]: row for row in file_rows}
    frontmatter_nodes = _frontmatter_node_rows(connection)
    links = _vault_link_rows(connection)
    candidates = _description_candidate_ids(file_rows, frontmatter_nodes, root_path)
    targets_by_description = _frontmatter_image_targets(frontmatter_nodes, links, candidates)
    warnings = []
    for description_id, target_ids in targets_by_description.items():
        description_stem = Path(file_by_id[description_id]["path"]).stem
        for target_id in target_ids:
            target = file_by_id.get(target_id)
            if target is None or not _is_image_file(target) or description_stem == Path(target["path"]).stem:
                continue
            warnings.append(
                ValidationWarning(
                    rule="imageDescriptionStemMismatch",
                    path=file_by_id[description_id]["path"],
                    message=(
                        f"Image description stem `{description_stem}` must match "
                        f"image stem `{Path(target['path']).stem}`."
                    ),
                )
            )
    return warnings


def find_notes_without_first_h1(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    children_by_parent = _children_by_parent(nodes)
    nodes_by_file = _nodes_by_file(nodes)
    warnings = []
    invisible_types = {"root", "footnoteDefinition", "definition", "comment"}

    for file_id, file_nodes in nodes_by_file.items():
        root = next((node for node in file_nodes if node["node_type"] == "root"), None)
        rendered_nodes = (
            [node for node in children_by_parent.get(root["id"], ()) if node["node_type"] not in invisible_types]
            if root is not None
            else []
        )
        first_node = rendered_nodes[0] if rendered_nodes else None
        if first_node is None:
            warnings.append(
                ValidationWarning(
                    rule="firstRenderedLineNotH1",
                    path=file_paths[file_id],
                    message="The first rendered line after frontmatter must be an H1 heading.",
                )
            )
            continue
        if first_node["node_type"] != "heading" or _node_depth(first_node, file_paths) != 1:
            warnings.append(
                ValidationWarning(
                    rule="firstRenderedLineNotH1",
                    path=file_paths[file_id],
                    message="The first rendered line after frontmatter must be an H1 heading.",
                    line=first_node["start_line"],
                )
            )
    return warnings


def find_blockquotes_without_attributions(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    warnings = []
    attribution_pattern = re.compile(r"^>\s*\\-\s+.+\[\^[^\]]+\]\s*$")

    for blockquote in (node for node in nodes if node["node_type"] == "blockquote"):
        source = _node_source(blockquote, file_paths)
        if source is None:
            continue
        final_line = next((line.strip() for line in reversed(source.splitlines()) if line.strip()), "")
        if not attribution_pattern.fullmatch(final_line):
            warnings.append(
                ValidationWarning(
                    rule="blockquoteMissingAttribution",
                    path=file_paths[blockquote["file_id"]],
                    message=r"Block quotations must end with `> \- Name[^footnote]`.",
                    line=blockquote["start_line"],
                )
            )
    return warnings


def find_files_outside_required_directories(connection: sqlite3.Connection) -> list[ValidationWarning]:
    root_path = _find_vault_root_path(connection)
    warnings = []
    for row in _vault_file_rows(connection):
        required_directory_name = _REQUIRED_DIRECTORY_BY_KIND.get(row["kind"])
        if required_directory_name is None and Path(row["path"]).suffix.casefold() == ".canvas":
            required_directory_name = "attachments/canvases"
        if required_directory_name is None:
            continue
        if not _path_is_within(Path(row["path"]), root_path / required_directory_name):
            warnings.append(
                ValidationWarning(
                    rule="fileTypeWrongFolder",
                    path=row["path"],
                    message=f"Files of kind `{row['kind']}` must be stored in `{required_directory_name}`.",
                )
            )
    return warnings


def find_footnote_definitions_not_at_bottom(connection: sqlite3.Connection) -> list[ValidationWarning]:
    definitions = _footnote_definition_rows(connection, markdown_only=False)
    root_ids_by_file, children_by_parent = _root_children_for_definition_files(
        connection, {definition["file_id"] for definition in definitions}
    )
    misplaced_ids: set[int] = set()
    for root_id, root_children in children_by_parent.items():
        content_seen_after = False
        for child in reversed(root_children):
            if child["node_type"] != "footnoteDefinition":
                content_seen_after = True
            elif content_seen_after:
                misplaced_ids.add(child["id"])

    return [
        ValidationWarning(
            rule="footnoteDefinitionNotAtBottom",
            path=definition["path"],
            message="Footnote definitions must be at the bottom of the note.",
            line=definition["start_line"],
        )
        for definition in definitions
        if definition["file_id"] in root_ids_by_file
        and definition["parent_id"] == root_ids_by_file[definition["file_id"]]
        and definition["id"] in misplaced_ids
    ]


def find_footnote_references_without_exact_definition(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    definitions = _footnote_definition_rows(connection, markdown_only=False)
    definition_counts: dict[tuple[int, str], int] = {}
    for definition in definitions:
        identifier = _node_identifier(definition, file_paths)
        if identifier is not None:
            key = (definition["file_id"], identifier)
            definition_counts[key] = definition_counts.get(key, 0) + 1
    warnings = []
    for file_id, identifier, line in _source_footnote_references(file_paths):
        if definition_counts.get((file_id, identifier), 0) == 1:
            continue
        warnings.append(
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=file_paths[file_id],
                message=f"Footnote reference `[^{identifier}]` does not resolve to exactly one definition.",
                line=line,
            )
        )
    return warnings


def find_frontmatter_colons_without_double_quotes(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    return [
        ValidationWarning(
            rule="frontmatterColonNotQuoted",
            path=file_paths[node["file_id"]],
            message=f"Frontmatter value for `{node['key'] or ''}` contains a colon and must use double quotes.",
        )
        for node in _frontmatter_node_rows(connection)
        if node["node_type"] == "scalar"
        and isinstance(node["value"], str)
        and ":" in node["value"]
        and not _is_double_quoted_scalar(node["raw_yaml"])
    ]


def find_frontmatter_links_without_double_quotes(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    return [
        ValidationWarning(
            rule="frontmatterLinkNotQuoted",
            path=file_paths[node["file_id"]],
            message=f"Frontmatter link value for `{node['key'] or ''}` must use double quotes.",
        )
        for node in _frontmatter_node_rows(connection)
        if _frontmatter_link_is_unquoted(node)
    ]


def find_matrices_without_dimensions(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    matrix_pattern = re.compile(r"\\begin\s*\{([A-Za-z]*matrix|array)\}")
    warnings = []

    for node in _markdown_node_rows(connection):
        if node["node_type"] not in {"math", "inlineMath"} or not isinstance(node["value"], str):
            continue
        value = node["value"]
        missing_dimensions = False
        for match in matrix_pattern.finditer(value):
            environment = match.group(1)
            end_match = re.search(rf"\\end\s*\{{{re.escape(environment)}\}}", value[match.end() :])
            end = match.end() + end_match.start() if end_match else len(value)
            wrapped = re.search(r"\\underset\s*\{[^{}]*\}\s*\{\s*$", value[: match.start()])
            if wrapped is None and r"\underset" not in value[match.end() : end]:
                missing_dimensions = True
                break
        if missing_dimensions:
            warnings.append(
                ValidationWarning(
                    rule="matrixMissingDimensions",
                    path=file_paths[node["file_id"]],
                    message=r"Matrix expressions must use `\underset` to specify their dimensions.",
                    line=node["start_line"],
                )
            )
    return warnings


def _unescaped_pipe_positions(value: str) -> list[int]:
    positions = []
    for index, character in enumerate(value):
        if character != "|":
            continue
        backslash_count = 0
        previous_index = index - 1
        while previous_index >= 0 and value[previous_index] == "\\":
            backslash_count += 1
            previous_index -= 1
        if backslash_count % 2 == 0:
            positions.append(index)
    return positions


def find_table_aliases_with_unescaped_pipes(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    warnings = []
    wikilink_pattern = re.compile(r"!?\[\[([^\]\n]+)\]\]")

    for table in (node for node in nodes if node["node_type"] == "table"):
        source = _node_source(table, file_paths)
        if source is None:
            continue
        for line_offset, line in enumerate(source.splitlines()):
            for match in wikilink_pattern.finditer(line):
                content = match.group(1)
                pipe_positions = _unescaped_pipe_positions(content)
                if not pipe_positions:
                    continue
                warnings.append(
                    ValidationWarning(
                        rule="tableWikilinkAliasUnescapedPipe",
                        path=file_paths[table["file_id"]],
                        message="Wikilink aliases in tables must escape pipes as `\\|`.",
                        line=(table["start_line"] or 1) + line_offset,
                    )
                )
    return warnings


def find_footnote_definitions_not_continuous(connection: sqlite3.Connection) -> list[ValidationWarning]:
    definitions = _footnote_definition_rows(connection, markdown_only=False)
    definition_file_ids = {definition["file_id"] for definition in definitions}
    root_ids_by_file, children_by_parent = _root_children_for_definition_files(connection, definition_file_ids)
    paths_by_file = {definition["file_id"]: definition["path"] for definition in definitions}
    warnings = []

    for file_id, root_id in root_ids_by_file.items():
        root_children = children_by_parent.get(root_id, ())
        definition_indices = [
            index for index, child in enumerate(root_children) if child["node_type"] == "footnoteDefinition"
        ]
        if not definition_indices:
            continue
        first_index, last_index = definition_indices[0], definition_indices[-1]
        if len(definition_indices) != last_index - first_index + 1:
            warnings.append(
                ValidationWarning(
                    rule="footnoteDefinitionsNotContinuous",
                    path=paths_by_file[file_id],
                    message="Footnote definitions must form one continuous block.",
                    line=root_children[first_index]["start_line"],
                )
            )
    return warnings


def find_unclosed_fenced_code_blocks(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    warnings = []

    for code in (node for node in nodes if node["node_type"] == "code"):
        attributes = _node_attributes(code)
        if attributes.get("fenced") is not True:
            continue
        source = _read_source(file_paths[code["file_id"]])
        if source is None or code["start_line"] is None:
            continue
        lines = source.splitlines()
        opening_line = lines[code["start_line"] - 1] if code["start_line"] <= len(lines) else ""
        opening_match = _FENCE_RE.match(opening_line)
        closed = False
        if opening_match:
            marker = opening_match.group(1)[0]
            marker_length = len(opening_match.group(1))
            closing_pattern = re.compile(rf"^(?:\s*>\s*)*\s*{re.escape(marker)}{{{marker_length},}}\s*$")
            closed = any(closing_pattern.match(line) for line in lines[code["start_line"] :])
        if not closed:
            warnings.append(
                ValidationWarning(
                    rule="unclosedFencedCodeBlock",
                    path=file_paths[code["file_id"]],
                    message="Fenced code blocks must have a matching closing fence.",
                    line=code["start_line"],
                )
            )
    return warnings


def find_h2_sections_without_images(connection: sqlite3.Connection) -> list[ValidationWarning]:
    nodes = _markdown_node_rows(connection)
    file_rows = _vault_file_rows(connection)
    file_paths = {row["id"]: row["path"] for row in file_rows}
    file_by_id = {row["id"]: row for row in file_rows}
    nodes_by_file = _nodes_by_file(nodes)
    nodes_by_id = _nodes_by_id(nodes)
    image_positions_by_file: dict[int, list[tuple[int, int, int]]] = {}
    for node in nodes:
        if node["node_type"] in {"image", "imageReference"}:
            image_positions_by_file.setdefault(node["file_id"], []).append(_node_position_key(node))

    for link in _vault_link_rows(connection):
        if not link["is_embed"] or link["source_markdown_node_id"] is None:
            continue
        target = file_by_id.get(link["target_file_id"])
        if target is None or not _is_image_file(target):
            continue
        source_node = nodes_by_id.get(link["source_markdown_node_id"])
        if source_node is not None:
            image_positions_by_file.setdefault(source_node["file_id"], []).append(_node_position_key(source_node))

    warnings = []
    for file_id, file_nodes in nodes_by_file.items():
        headings = [node for node in file_nodes if node["node_type"] == "heading"]
        for index, heading in enumerate(headings):
            if _node_depth(heading, file_paths) != 2:
                continue
            next_boundary = None
            for later_heading in headings[index + 1 :]:
                later_depth = _node_depth(later_heading, file_paths)
                if later_depth is not None and later_depth <= 2:
                    next_boundary = _node_position_key(later_heading)
                    break
            heading_position = _node_position_key(heading)
            if any(
                image_position > heading_position and (next_boundary is None or image_position < next_boundary)
                for image_position in image_positions_by_file.get(file_id, ())
            ):
                continue
            warnings.append(
                ValidationWarning(
                    rule="h2SectionMissingImage",
                    path=file_paths[file_id],
                    message="Each H2 section must contain an image.",
                    line=heading["start_line"],
                )
            )
    return warnings


def _has_invalid_mathjax(value: str) -> bool:
    environment_stack: list[str] = []
    for match in re.finditer(r"\\(begin|end)\s*\{([^{}]+)\}", value):
        command, environment = match.groups()
        if command == "begin":
            environment_stack.append(environment)
        elif not environment_stack or environment_stack.pop() != environment:
            return True

    if environment_stack:
        return True
    return value.count(r"\left") != value.count(r"\right")


def find_invalid_mathjax(connection: sqlite3.Connection) -> list[ValidationWarning]:
    file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
    return [
        ValidationWarning(
            rule="invalidMathJax",
            path=file_paths[node["file_id"]],
            message="MathJax contains invalid syntax.",
            line=node["start_line"],
        )
        for node in _markdown_node_rows(connection)
        if node["node_type"] in {"math", "inlineMath"}
        and isinstance(node["value"], str)
        and _has_invalid_mathjax(node["value"])
    ]


VALIDATORS = [
    find_invalid_frontmatter,
    find_duplicate_frontmatter_property_keys,
    find_raw_html,
    find_duplicate_filenames,
    find_duplicate_heading_names,
    find_aliases_without_non_camel_case,
    find_tags_containing_hash,
    find_non_camel_case_tag_segments,
    find_unbalanced_math_braces,
    find_obsidian_callouts,
    find_mermaid_diagrams,
    find_code_blocks_without_language,
    find_duplicate_list_values,
    find_related_not_wikilinks,
    find_missing_embeds,
    find_properties_not_lists,
    find_invalid_exercise_types,
    find_invalid_muscle_names,
    find_hidden_markdown_notes,
    find_unexpected_root_files,
    find_non_camel_case_filenames,
    find_non_camel_case_directories,
    find_missing_frontmatter_properties,
    find_missing_embedded_block_references,
    find_missing_embedded_heading_references,
    find_exercise_descriptions_outside_directory,
    find_exercise_images_outside_directory,
    find_image_descriptions_outside_directory,
    find_images_outside_directory,
    find_local_pdf_citations_without_original_url,
    find_empty_directories,
    find_empty_files,
    find_unreferenced_footnote_definitions,
    find_headings_with_markup,
    find_heading_level_jumps,
    find_local_image_embeds_not_wikilinks,
    find_images_without_descriptions,
    find_multiple_h1_headings,
    find_internal_links_without_filename_stems,
    find_web_source_footnotes_without_urls,
    find_web_source_footnotes_without_access_dates,
    find_exercise_related_targets_outside_exercises,
    find_exercise_descriptions_without_required_properties,
    find_exercise_images_without_descriptions,
    find_image_descriptions_without_source_footnotes,
    find_image_descriptions_without_images,
    find_image_description_stem_mismatches,
    find_notes_without_first_h1,
    find_blockquotes_without_attributions,
    find_files_outside_required_directories,
    find_footnote_definitions_not_at_bottom,
    find_footnote_references_without_exact_definition,
    find_frontmatter_colons_without_double_quotes,
    find_frontmatter_links_without_double_quotes,
    find_matrices_without_dimensions,
    find_table_aliases_with_unescaped_pipes,
    find_footnote_definitions_not_continuous,
    find_unclosed_fenced_code_blocks,
    find_h2_sections_without_images,
    find_invalid_mathjax,
]
_VALIDATOR_TIMING_KINDS = dict.fromkeys((validator.__name__ for validator in VALIDATORS), "file")
_VALIDATOR_TIMING_KINDS.update(
    {
        **dict.fromkeys(("find_invalid_frontmatter",), "frontmatter error"),
        **dict.fromkeys(
            ("find_duplicate_frontmatter_property_keys", "find_frontmatter_links_without_double_quotes"),
            "frontmatter node",
        ),
        **dict.fromkeys(("find_raw_html",), "HTML node"),
        **dict.fromkeys(
            (
                "find_duplicate_heading_names",
                "find_headings_with_markup",
                "find_heading_level_jumps",
                "find_multiple_h1_headings",
                "find_h2_sections_without_images",
            ),
            "heading",
        ),
        **dict.fromkeys(
            (
                "find_aliases_without_non_camel_case",
                "find_hidden_markdown_notes",
                "find_missing_frontmatter_properties",
                "find_notes_without_first_h1",
            ),
            "note",
        ),
        **dict.fromkeys(("find_tags_containing_hash", "find_non_camel_case_tag_segments"), "tag"),
        **dict.fromkeys(
            ("find_unbalanced_math_braces", "find_matrices_without_dimensions", "find_invalid_mathjax"), "math node"
        ),
        **dict.fromkeys(("find_obsidian_callouts", "find_blockquotes_without_attributions"), "blockquote"),
        **dict.fromkeys(("find_mermaid_diagrams",), "Mermaid code block"),
        **dict.fromkeys(("find_code_blocks_without_language", "find_unclosed_fenced_code_blocks"), "fenced code block"),
        **dict.fromkeys(("find_duplicate_list_values",), "frontmatter list item"),
        **dict.fromkeys(
            ("find_related_not_wikilinks", "find_exercise_related_targets_outside_exercises"), "related item"
        ),
        **dict.fromkeys(("find_missing_embeds",), "embed"),
        **dict.fromkeys(("find_missing_embedded_block_references",), "block-reference embed"),
        **dict.fromkeys(("find_missing_embedded_heading_references",), "heading-reference embed"),
        **dict.fromkeys(("find_properties_not_lists",), "frontmatter property"),
        **dict.fromkeys(("find_invalid_exercise_types", "find_invalid_muscle_names"), "exercise property"),
        **dict.fromkeys(("find_non_camel_case_directories", "find_empty_directories"), "directory"),
        **dict.fromkeys(
            ("find_exercise_descriptions_outside_directory", "find_exercise_descriptions_without_required_properties"),
            "exercise note",
        ),
        **dict.fromkeys(
            ("find_exercise_images_outside_directory", "find_exercise_images_without_descriptions"), "exercise image"
        ),
        **dict.fromkeys(
            (
                "find_image_descriptions_outside_directory",
                "find_image_descriptions_without_source_footnotes",
                "find_image_descriptions_without_images",
            ),
            "image-description note",
        ),
        **dict.fromkeys(("find_images_outside_directory", "find_images_without_descriptions"), "image"),
        **dict.fromkeys(
            (
                "find_local_pdf_citations_without_original_url",
                "find_unreferenced_footnote_definitions",
                "find_web_source_footnotes_without_urls",
                "find_web_source_footnotes_without_access_dates",
                "find_footnote_definitions_not_at_bottom",
                "find_footnote_definitions_not_continuous",
            ),
            "footnote",
        ),
        **dict.fromkeys(
            ("find_local_image_embeds_not_wikilinks", "find_image_description_stem_mismatches"), "image link"
        ),
        **dict.fromkeys(("find_internal_links_without_filename_stems",), "link"),
        **dict.fromkeys(("find_footnote_references_without_exact_definition",), "footnote reference"),
        **dict.fromkeys(("find_frontmatter_colons_without_double_quotes",), "frontmatter scalar"),
        **dict.fromkeys(("find_table_aliases_with_unescaped_pipes",), "table"),
        **dict.fromkeys(("find_files_outside_required_directories",), "typed file"),
    }
)


def _count_index_rows(connection: sqlite3.Connection, table: str, condition: str = "1") -> int:
    row = connection.execute(f"SELECT COUNT(*) FROM {table} WHERE {condition}").fetchone()
    return int(row[0] or 0)


def _count_timing_units(connection: sqlite3.Connection, unit: str) -> int:
    if unit == "file":
        return _count_index_rows(connection, "vault_files")
    if unit == "note":
        return _count_index_rows(connection, "vault_files", "kind = 'markdown'")
    if unit == "directory":
        return _count_index_rows(connection, "vault_directories", "parent_id IS NOT NULL")
    if unit == "frontmatter error":
        return _count_index_rows(connection, "frontmatter_errors")
    if unit == "frontmatter node":
        return _count_index_rows(connection, "frontmatter_nodes")
    if unit == "frontmatter scalar":
        return _count_index_rows(connection, "frontmatter_nodes", "node_type = 'scalar'")
    if unit == "frontmatter property":
        return _count_index_rows(
            connection, "frontmatter_nodes", "parent_id IS NULL AND key IN ('aliases', 'tags', 'related')"
        )
    if unit == "frontmatter list item":
        return _count_index_rows(
            connection,
            "frontmatter_nodes",
            "node_type = 'scalar' AND parent_id IN (SELECT id FROM frontmatter_nodes WHERE node_type = 'sequence')",
        )
    if unit == "heading":
        return _count_index_rows(connection, "markdown_nodes", "node_type = 'heading'")
    if unit == "math node":
        return _count_index_rows(connection, "markdown_nodes", "node_type IN ('math', 'inlineMath')")
    if unit == "blockquote":
        return _count_index_rows(connection, "markdown_nodes", "node_type = 'blockquote'")
    if unit == "Mermaid code block":
        return _count_index_rows(
            connection,
            "markdown_nodes",
            "node_type = 'code' AND lower(json_extract(attributes_json, '$.lang')) = 'mermaid'",
        )
    if unit == "fenced code block":
        return _count_index_rows(
            connection, "markdown_nodes", "node_type = 'code' AND json_extract(attributes_json, '$.fenced') = 1"
        )
    if unit == "tag":
        return _count_index_rows(connection, "vault_tags")
    if unit == "related item":
        return _count_index_rows(
            connection,
            "frontmatter_nodes",
            "node_type = 'scalar' AND parent_id IN "
            "(SELECT id FROM frontmatter_nodes "
            "WHERE parent_id IS NULL AND key = 'related' AND node_type = 'sequence')",
        )
    if unit == "embed":
        return _count_index_rows(connection, "vault_links", "is_embed = 1")
    if unit == "block-reference embed":
        return _count_index_rows(
            connection, "vault_links", "is_embed = 1 AND link_syntax = 'wikilink' AND raw_target LIKE '%#^%'"
        )
    if unit == "heading-reference embed":
        return _count_index_rows(
            connection,
            "vault_links",
            "is_embed = 1 AND link_syntax = 'wikilink' AND raw_target LIKE '%#%' AND raw_target NOT LIKE '%#^%'",
        )
    if unit == "link":
        return _count_index_rows(connection, "vault_links")
    if unit == "image link":
        return _count_index_rows(connection, "vault_links", "link_syntax = 'image'")
    if unit == "footnote":
        row = connection.execute(
            """
            SELECT COUNT(*)
            FROM markdown_nodes AS node
            JOIN vault_files AS file ON file.id = node.file_id
            WHERE node.node_type = 'footnoteDefinition'
              AND file.kind = 'markdown'
            """
        ).fetchone()
        return int(row[0] or 0)
    if unit == "footnote reference":
        file_paths = {row["id"]: row["path"] for row in _vault_file_rows(connection)}
        return len(_source_footnote_references(file_paths))
    if unit == "exercise property":
        exercise_directory_id = _find_exercise_directory_id(connection)
        if exercise_directory_id is None:
            return 0
        row = connection.execute(
            """
            SELECT COUNT(*)
            FROM frontmatter_nodes AS node
            JOIN vault_files ON vault_files.id = node.file_id
            WHERE vault_files.kind = 'markdown'
              AND vault_files.directory_id = ?
              AND node.parent_id IS NULL
              AND node.key IN ('exerciseType', 'primaryMuscle', 'secondaryMuscle')
            """,
            (exercise_directory_id,),
        ).fetchone()
        return int(row[0] or 0)
    if unit == "exercise note":
        root_path = _find_vault_root_path(connection)
        exercise_directory = root_path / "health" / "exercises"
        return len(_exercise_file_ids(_vault_file_rows(connection), root_path, exercise_directory))
    if unit == "exercise image":
        root_path = _find_vault_root_path(connection)
        file_rows = _vault_file_rows(connection)
        _, exercise_image_ids = _exercise_image_ids(file_rows, _vault_link_rows(connection), root_path)
        return len(exercise_image_ids)
    if unit == "image-description note":
        root_path = _find_vault_root_path(connection)
        return len(
            _description_candidate_ids(_vault_file_rows(connection), _frontmatter_node_rows(connection), root_path)
        )
    if unit == "image":
        return sum(_is_image_file(row) for row in _vault_file_rows(connection))
    if unit == "typed file":
        return sum(
            _REQUIRED_DIRECTORY_BY_KIND.get(row["kind"]) is not None or Path(row["path"]).suffix.casefold() == ".canvas"
            for row in _vault_file_rows(connection)
        )
    return 1


def _timing_for_validator(connection: sqlite3.Connection, validator: Any) -> tuple[str, int]:
    unit = _VALIDATOR_TIMING_KINDS.get(validator.__name__)
    if unit is None:
        return "call", 1
    return unit, _count_timing_units(connection, unit)


def _resolve_target_file_path(connection: sqlite3.Connection, target_file: Path) -> str:
    root_path = _find_vault_root_path(connection)
    candidate = target_file.expanduser()
    candidates = (candidate,) if candidate.is_absolute() else (root_path / candidate, Path.cwd() / candidate)
    resolved_candidates = {path.resolve() for path in candidates}
    indexed_paths = {Path(row["path"]).resolve(): row["path"] for row in _vault_file_rows(connection)}
    matches = {path: indexed_paths[path] for path in resolved_candidates if path in indexed_paths}
    if not matches:
        raise ValueError(f"File is not present in the SQLite index: {target_file}")
    if len(matches) > 1:
        raise ValueError(f"File path is ambiguous; provide an absolute path: {target_file}")
    return next(iter(matches.values()))


def _warnings_for_file(warnings: list[ValidationWarning], target_path: str) -> list[ValidationWarning]:
    resolved_target = Path(target_path).resolve()
    return [warning for warning in warnings if Path(warning.path).resolve() == resolved_target]


def main() -> int:
    parser = argparse.ArgumentParser(description="Check vault health from its SQLite index.")
    parser.add_argument("database", type=Path, nargs="?", default=Path("vault.db"))
    parser.add_argument(
        "--file", dest="target_file", type=Path, help="Only report warnings for this vault-relative or absolute file."
    )
    args = parser.parse_args()
    TIMINGS.clear()
    _FOOTNOTE_REFERENCE_CACHE.clear()

    with sqlite3.connect(args.database) as connection:
        target_path = None
        if args.target_file is not None:
            try:
                target_path = _resolve_target_file_path(connection, args.target_file)
            except ValueError as error:
                parser.error(str(error))
        warnings = []
        for validator in VALIDATORS:
            unit, count = _timing_for_validator(connection, validator)
            started = perf_counter()
            warnings.extend(validator(connection))
            record_timing(validator.__name__, started, unit, count)
        if target_path is not None:
            warnings = _warnings_for_file(warnings, target_path)
    for warning in warnings:
        location = warning.path
        if warning.line is not None:
            location += f":{warning.line}"
        if warning.column is not None:
            location += f":{warning.column}"
        print(f"WARNING [{warning.rule}]: {location}: {warning.message}")

    print_timing_summary()
    return 1 if warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())

# Difficulty scale: D1 = direct indexed check; D2 = simple joins or path logic;
# D3 = ordered, tree, or source reconstruction; D4 = indexer or raw-syntax work;
# D5 = broad syntax or provenance work.
# Progress: 59/59 TODOs complete. Sorted from easiest to hardest.
# - [x] [D1] TODO: Warn when `aliases`, `tags`, or `related` is missing.
# - [x] [D1] TODO: Warn when `aliases`, `tags`, or `related` is not a list.
# - [x] [D1] TODO: Warn when `exerciseType` is not `strength`, `cardio`, `stretching`, `mobility`, or `stability`.
# - [x] [D1] TODO: Warn when `primaryMuscle` or `secondaryMuscle` contains a value outside the allowed muscle names.
# - [x] [D1] TODO: Warn when a Markdown note is hidden.
# - [x] [D1] TODO: Warn when a Mermaid diagram is used.
# - [x] [D1] TODO: Warn when a `related` value is not a wikilink.
# - [x] [D1] TODO: Warn when a fenced code block does not specify a language.
# - [x] [D1] TODO: Warn when a file other than `README.md`, `TODO.md`, or `tmp.md` is stored directly in the vault root.
# - [x] [D1] TODO: Warn when a filename is duplicated anywhere in the vault.
# - [x] [D1] TODO: Warn when a filename stem is not camelCase, except for `README.md`, `TODO.md`, and notes inside `people`.
# - [x] [D1] TODO: Warn when a folder name is not camelCase.
# - [x] [D1] TODO: Warn when a frontmatter list property contains duplicate values.
# - [x] [D1] TODO: Warn when a frontmatter property key occurs more than once.
# - [x] [D1] TODO: Warn when a heading name is duplicated within a note.
# - [x] [D1] TODO: Warn when a tag contains `#`.
# - [x] [D1] TODO: Warn when an Obsidian callout is used.
# - [x] [D1] TODO: Warn when an embed points to a file that does not exist.
# - [x] [D1] TODO: Warn when an embedded block reference does not resolve to an existing block.
# - [x] [D1] TODO: Warn when an embedded heading reference does not resolve to an existing heading.
# - [x] [D1] TODO: Warn when an exercise description note is stored outside `health/exercises`.
# - [x] [D1] TODO: Warn when an exercise image is stored outside `attachments/images/exercises`.
# - [x] [D1] TODO: Warn when an image description note is stored outside `attachments/imageDescriptions`.
# - [x] [D1] TODO: Warn when an image is stored outside `attachments/images`.
# - [x] [D1] TODO: Warn when frontmatter contains invalid YAML.
# - [x] [D1] TODO: Warn when raw HTML is used in a Markdown note.
# - [x] [D2] Subcheck: Warn when MathJax contains unbalanced braces.
# - [x] [D2] TODO: Warn when `aliases` contains no non-camelCase value.
# - [x] [D2] TODO: Warn when a citation containing a local PDF URI does not also contain the original URL.
# - [x] [D2] TODO: Warn when a directory outside `.obsidian` or `.git` is empty.
# - [x] [D2] TODO: Warn when a file outside `.obsidian` or `.git` is empty.
# - [x] [D2] TODO: Warn when a footnote definition is not referenced.
# - [x] [D2] TODO: Warn when a heading contains Markdown or Obsidian elements instead of text only.
# - [x] [D2] TODO: Warn when a heading level increases by more than one.
# - [x] [D2] TODO: Warn when a local image embed does not use a wikilink.
# - [x] [D2] TODO: Warn when a nested tag segment is not camelCase.
# - [x] [D2] TODO: Warn when a non-exercise image does not have an image description note.
# - [x] [D2] TODO: Warn when a note contains an H1 heading after the first heading.
# - [x] [D2] TODO: Warn when a resolved internal note link does not use the target note's filename stem.
# - [x] [D2] TODO: Warn when a web source footnote does not contain a URL.
# - [x] [D2] TODO: Warn when a web source footnote does not end with `date accessed: YYYY-MM-DD`.
# - [x] [D2] TODO: Warn when an exercise description note contains a `related` value that does not resolve to an exercise note.
# - [x] [D2] TODO: Warn when an exercise description note is missing `related`, `tags`, `aliases`, `primaryMuscle`, `secondaryMuscle`, or `exerciseType`.
# - [x] [D2] TODO: Warn when an exercise image does not have an exercise description note in `health/exercises`.
# - [x] [D2] TODO: Warn when an image description note does not contain a source footnote.
# - [x] [D2] TODO: Warn when an image description note does not have a corresponding image.
# - [x] [D2] TODO: Warn when an image description note's filename stem does not match the corresponding image's filename stem.
# - [x] [D2] TODO: Warn when the first non-blank rendered line after frontmatter is not an H1 heading.
# - [x] [D3] TODO: Warn when a block quotation does not end with an attribution matching `> \- Name[^footnote]`.
# - [x] [D3] TODO: Warn when a file is stored outside the required folder for its file type.
# - [x] [D3] TODO: Warn when a footnote definition is not at the bottom of the note.
# - [x] [D3] TODO: Warn when a footnote reference does not resolve to exactly one footnote definition.
# - [x] [D3] TODO: Warn when a frontmatter value containing a colon is not enclosed in double quotes.
# - [x] [D3] TODO: Warn when a link in frontmatter is not enclosed in double quotes.
# - [x] [D3] TODO: Warn when a matrix does not use `\underset` to specify its dimensions.
# - [x] [D3] TODO: Warn when a wikilink alias inside a table uses `|` instead of `\|`.
# - [x] [D3] TODO: Warn when footnote definitions do not form one continuous block.
# - [x] [D4] TODO: Warn when a fenced code block does not have a matching closing fence.
# - [x] [D4] TODO: Warn when an H2 section does not contain an image, either directly or within one of its subsections.
# - [x] [D5] TODO: Warn when MathJax is invalid.
