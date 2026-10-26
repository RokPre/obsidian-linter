import os
import stat
import argparse
import json
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

import yaml

from markdown_tree_parser import MarkdownTreeParser


@dataclass(frozen=True, slots=True)
class ParsedFrontmatter:
    properties: yaml.MappingNode
    error: str | None
    error_line: int | None
    error_column: int | None


@dataclass(slots=True)
class ParsedFile:
    path: Path
    st_dev: int
    inode: int
    mtime_ns: int
    kind: str
    frontmatter_source: str = ""
    frontmatter_result: ParsedFrontmatter | None = None
    syntax_tree: dict | None = None


DEFAULT_VAULT_PATH = "/home/rok/sync/vault/"
DEFAULT_DB_PATH = "vault.db"
IGNORED_DIRECTORY_NAMES = {".git", ".obsidian", "templates", "excalidraws", ".diaryTrash"}
FILE_KIND_BY_EXTENSION = {
    ".excalidraw": "excalidraw",
    ".pdf": "pdf",
    ".djvu": "pdf",
    ".djv": "pdf",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".webp": "image",
    ".svg": "image",
    ".gif": "image",
    ".bmp": "image",
    ".tif": "image",
    ".tiff": "image",
    ".avif": "image",
    ".py": "script",
    ".sh": "script",
    ".bash": "script",
    ".zsh": "script",
    ".fish": "script",
    ".lua": "script",
    ".js": "script",
    ".ts": "script",
    ".c": "script",
    ".h": "script",
    ".cpp": "script",
    ".hpp": "script",
    ".java": "script",
    ".rs": "script",
    ".go": "script",
    ".mp4": "video",
    ".mkv": "video",
    ".webm": "video",
    ".mov": "video",
    ".avi": "video",
    ".m4v": "video",
    ".mp3": "recording",
    ".flac": "recording",
    ".ogg": "recording",
    ".wav": "recording",
    ".m4a": "recording",
    ".aac": "recording",
    ".opus": "recording",
    ".md": "markdown",
}
INDEX_BATCH_SIZE = 1_000
FRONTMATTER_BODY_FIRST_FILE_LINE = 2


TIMINGS: dict[str, tuple[float, int, str]] = {}


def record_timing(stage: str, started: float, unit: str = "call") -> None:
    """Record elapsed time and completed units for one indexing stage."""
    total, calls, _ = TIMINGS.get(stage, (0.0, 0, unit))
    TIMINGS[stage] = total + perf_counter() - started, calls + 1, unit


def print_timing_summary() -> None:
    """Print total and average elapsed time for each profiled stage."""
    print("\nTiming summary")
    for stage, (total, calls, unit) in sorted(TIMINGS.items(), key=lambda item: item[1][0], reverse=True):
        plural_unit = unit if calls == 1 else f"{unit}s"
        print(
            f"{stage:28} {total * 1000:9.3f} ms total  {total / calls * 1000:8.3f} ms/{unit}  {calls:4} {plural_unit}"
        )


def find_changes(cursor: sqlite3.Cursor, vault_path: Path) -> tuple[list[tuple[str, str]], list[tuple[str, str]]]:
    """Return (directory changes, file changes) for the vault."""
    has_notes_table = (
        cursor.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_files'").fetchone()
        is not None
    )
    stored_mtimes = dict(cursor.execute("SELECT path, mtime_ns FROM vault_files")) if has_notes_table else {}
    has_directories_table = (
        cursor.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_directories'").fetchone()
        is not None
    )
    stored_inodes = dict(cursor.execute("SELECT path, inode FROM vault_directories")) if has_directories_table else {}
    directory_changes: list[tuple[str, str]] = []
    file_changes: list[tuple[str, str]] = []

    def scan_directory(path: Path) -> None:
        path_string = str(path)
        stored_inode = stored_inodes.pop(path_string, None)

        if stored_inode is None:
            directory_changes.append(("created", path_string))
        elif path.stat().st_ino != stored_inode:
            directory_changes.append(("modified", path_string))

        for child_path in path.iterdir():
            # TODO: Support symlinks safely.
            if child_path.is_symlink():
                continue

            if child_path.is_dir() and child_path.name not in IGNORED_DIRECTORY_NAMES:
                scan_directory(child_path)
            elif child_path.is_file():
                started = perf_counter()
                child_path_string = str(child_path)
                stored_mtime_ns = stored_mtimes.pop(child_path_string, None)

                if stored_mtime_ns is None:
                    file_changes.append(("created", child_path_string))
                elif child_path.stat().st_mtime_ns != stored_mtime_ns:
                    file_changes.append(("modified", child_path_string))

                record_timing("find_changes", started, "file")

    scan_directory(vault_path)

    for path_string in stored_inodes:
        directory_changes.append(("deleted", path_string))
    for path_string in stored_mtimes:
        file_changes.append(("deleted", path_string))

    return directory_changes, file_changes


def initialize_database(cursor: sqlite3.Cursor) -> None:
    """Create the schema and migrate known older database versions."""
    for statement in (
        """
        CREATE TABLE IF NOT EXISTS vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            inode INTEGER NOT NULL,
            parent_id INTEGER REFERENCES vault_directories(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS vault_files (
            id INTEGER PRIMARY KEY,
            directory_id INTEGER NOT NULL REFERENCES vault_directories(id) ON DELETE CASCADE,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            st_dev INTEGER,
            inode INTEGER NOT NULL,
            mtime_ns INTEGER NOT NULL,
            extension TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (
                kind IN (
                    'excalidraw',
                    'pdf',
                    'image',
                    'script',
                    'video',
                    'recording',
                    'markdown',
                    'other'
                )
            )
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS frontmatter_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            key TEXT,
            node_type TEXT NOT NULL CHECK (
                node_type IN ('mapping', 'sequence', 'scalar')
            ),
            value TEXT,
            raw_yaml TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS frontmatter_errors (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            error_output TEXT NOT NULL,
            line INTEGER,
            column INTEGER,
            raw_yaml BLOB NOT NULL
        )
        """,
        # TODO: Update the insert_vault_links function to use the new columns.
        # TODO: Place the block_id into the attributes_json column.
        # TODO: Update the links resolution code to use the attributes_json column.
        """
        CREATE TABLE IF NOT EXISTS markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            parent_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            node_type TEXT NOT NULL,
            value TEXT,
            block_id TEXT,
            attributes_json TEXT NOT NULL,
            start_line INTEGER,
            start_column INTEGER,
            start_offset_utf16 INTEGER,
            end_line INTEGER,
            end_column INTEGER,
            end_offset_utf16 INTEGER
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS vault_tags (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            parent_id INTEGER REFERENCES vault_tags(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS note_tag_occurrences (
            id INTEGER PRIMARY KEY,
            tag_id INTEGER NOT NULL REFERENCES vault_tags(id) ON DELETE CASCADE,
            frontmatter_node_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
            markdown_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
            CHECK (
                (frontmatter_node_id IS NOT NULL AND markdown_node_id IS NULL)
                OR
                (frontmatter_node_id IS NULL AND markdown_node_id IS NOT NULL)
            )
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS vault_missing_targets (
            id INTEGER PRIMARY KEY,
            target_type TEXT NOT NULL CHECK (target_type IN ('name', 'path', 'heading', 'block')),
            target TEXT NOT NULL,
            target_file_id INTEGER REFERENCES vault_files(id) ON DELETE CASCADE
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS vault_links (
            id INTEGER PRIMARY KEY,
            source_file_id INTEGER NOT NULL REFERENCES vault_files(id) ON DELETE CASCADE,
            source_markdown_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
            source_frontmatter_node_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
            target_file_id INTEGER REFERENCES vault_files(id) ON DELETE SET NULL,
            target_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE SET NULL,
            missing_target_id INTEGER REFERENCES vault_missing_targets(id) ON DELETE SET NULL,
            raw_target TEXT NOT NULL,
            display_text TEXT,
            link_syntax TEXT NOT NULL CHECK (link_syntax IN ('wikilink', 'link', 'image')),
            is_embed INTEGER NOT NULL CHECK (is_embed IN (0, 1)),
            resolution_status TEXT NOT NULL DEFAULT 'missing' CHECK (
                resolution_status IN ('resolved', 'missing', 'ambiguous', 'external', 'missing_fragment')
            )
        )
        """,
        # TODO: Get rid of vault_index_state. (https://chatgpt.com/share/6ab2770b-8d14-83eb-9363-6123f54b0348)
        """
        CREATE TABLE IF NOT EXISTS vault_index_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            derived_data_dirty INTEGER NOT NULL CHECK (derived_data_dirty IN (0, 1)),
            block_ids_version INTEGER NOT NULL DEFAULT 0,
            link_resolution_version INTEGER NOT NULL DEFAULT 0,
            tag_occurrence_version INTEGER NOT NULL DEFAULT 0,
            fenced_code_version INTEGER NOT NULL DEFAULT 0,
            callout_version INTEGER NOT NULL DEFAULT 0
        )
        """,
        "CREATE INDEX IF NOT EXISTS vault_directories_parent_idx ON vault_directories(parent_id)",
        "CREATE INDEX IF NOT EXISTS vault_files_directory_idx ON vault_files(directory_id)",
        """
        CREATE INDEX IF NOT EXISTS note_tag_occurrences_tag_idx
        ON note_tag_occurrences(tag_id)
        """,
        """
        CREATE INDEX IF NOT EXISTS frontmatter_nodes_file_parent_ordinal_idx
        ON frontmatter_nodes(file_id, parent_id, ordinal)
        """,
        """
        CREATE INDEX IF NOT EXISTS vault_links_target_source_idx
        ON vault_links(target_file_id, source_file_id)
        """,
        "CREATE INDEX IF NOT EXISTS markdown_nodes_parent_idx ON markdown_nodes(parent_id)",
        """
        CREATE INDEX IF NOT EXISTS markdown_nodes_file_parent_ordinal_idx
        ON markdown_nodes(file_id, parent_id, ordinal)
        """,
    ):
        cursor.execute(statement)
    tag_occurrence_columns = {column[1] for column in cursor.execute("PRAGMA table_info(note_tag_occurrences)")}
    if "source" in tag_occurrence_columns or "file_id" in tag_occurrence_columns:
        cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_tag_idx")
        cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_tag_file_idx")
        cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_frontmatter_node_idx")
        cursor.execute("DROP INDEX IF EXISTS note_tag_occurrences_markdown_node_idx")
        cursor.execute("DROP TABLE note_tag_occurrences")
        cursor.execute(
            """
            CREATE TABLE note_tag_occurrences (
                id INTEGER PRIMARY KEY,
                tag_id INTEGER NOT NULL REFERENCES vault_tags(id) ON DELETE CASCADE,
                frontmatter_node_id INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE,
                markdown_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE,
                CHECK (
                    (frontmatter_node_id IS NOT NULL AND markdown_node_id IS NULL)
                    OR
                    (frontmatter_node_id IS NULL AND markdown_node_id IS NOT NULL)
                )
            )
            """
        )
        cursor.execute("UPDATE vault_index_state SET derived_data_dirty = 1 WHERE id = 1")

    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS note_tag_occurrences_frontmatter_node_idx
        ON note_tag_occurrences(frontmatter_node_id)
        WHERE frontmatter_node_id IS NOT NULL
        """
    )
    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS note_tag_occurrences_markdown_node_idx
        ON note_tag_occurrences(markdown_node_id)
        WHERE markdown_node_id IS NOT NULL
        """
    )
    cursor.execute("INSERT OR IGNORE INTO vault_index_state (id, derived_data_dirty) VALUES (1, 0)")

    note_columns = {column[1] for column in cursor.execute("PRAGMA table_info(vault_files)")}
    if "st_dev" not in note_columns:
        cursor.execute("ALTER TABLE vault_files ADD COLUMN st_dev INTEGER")
    if "mtime_ns" not in note_columns:
        cursor.execute("ALTER TABLE vault_files ADD COLUMN mtime_ns INTEGER NOT NULL DEFAULT 0")

    state_columns = {column[1] for column in cursor.execute("PRAGMA table_info(vault_index_state)")}
    if "block_ids_version" not in state_columns:
        cursor.execute("ALTER TABLE vault_index_state ADD COLUMN block_ids_version INTEGER NOT NULL DEFAULT 0")
    if cursor.execute("SELECT block_ids_version FROM vault_index_state WHERE id = 1").fetchone()[0] < 1:
        cursor.execute("UPDATE vault_files SET mtime_ns = 0 WHERE kind = 'markdown'")
        cursor.execute("UPDATE vault_index_state SET block_ids_version = 1 WHERE id = 1")

    if "link_resolution_version" not in state_columns:
        cursor.execute("ALTER TABLE vault_index_state ADD COLUMN link_resolution_version INTEGER NOT NULL DEFAULT 0")
    if cursor.execute("SELECT link_resolution_version FROM vault_index_state WHERE id = 1").fetchone()[0] < 4:
        cursor.execute("UPDATE vault_index_state SET link_resolution_version = 4, derived_data_dirty = 1 WHERE id = 1")

    if "tag_occurrence_version" not in state_columns:
        cursor.execute("ALTER TABLE vault_index_state ADD COLUMN tag_occurrence_version INTEGER NOT NULL DEFAULT 0")
    if cursor.execute("SELECT tag_occurrence_version FROM vault_index_state WHERE id = 1").fetchone()[0] < 1:
        cursor.execute("UPDATE vault_index_state SET tag_occurrence_version = 1, derived_data_dirty = 1 WHERE id = 1")
    if "fenced_code_version" not in state_columns:
        cursor.execute("ALTER TABLE vault_index_state ADD COLUMN fenced_code_version INTEGER NOT NULL DEFAULT 0")
    if cursor.execute("SELECT fenced_code_version FROM vault_index_state WHERE id = 1").fetchone()[0] < 1:
        cursor.execute("UPDATE vault_files SET mtime_ns = 0 WHERE kind = 'markdown'")
        cursor.execute("UPDATE vault_index_state SET fenced_code_version = 1 WHERE id = 1")
    if "callout_version" not in state_columns:
        cursor.execute("ALTER TABLE vault_index_state ADD COLUMN callout_version INTEGER NOT NULL DEFAULT 0")
    if cursor.execute("SELECT callout_version FROM vault_index_state WHERE id = 1").fetchone()[0] < 1:
        cursor.execute("UPDATE vault_files SET mtime_ns = 0 WHERE kind = 'markdown'")
        cursor.execute("UPDATE vault_index_state SET callout_version = 1 WHERE id = 1")

    markdown_node_columns = {column[1] for column in cursor.execute("PRAGMA table_info(markdown_nodes)")}
    if "heading_text" in markdown_node_columns:
        cursor.execute("UPDATE markdown_nodes SET value = heading_text WHERE node_type = 'heading'")
        cursor.execute("DROP INDEX IF EXISTS markdown_nodes_file_heading_text_idx")
        cursor.execute("ALTER TABLE markdown_nodes DROP COLUMN heading_text")
    if "block_id" not in markdown_node_columns:
        cursor.execute("ALTER TABLE markdown_nodes ADD COLUMN block_id TEXT")

    markdown_indexes = {row[1]: row[4] for row in cursor.execute("PRAGMA index_list(markdown_nodes)")}
    for index_name, columns, predicate in (
        ("markdown_nodes_file_value_idx", "file_id, node_type, value", "node_type = 'heading' AND value IS NOT NULL"),
        ("markdown_nodes_file_block_id_idx", "file_id, block_id", "block_id IS NOT NULL"),
    ):
        if markdown_indexes.get(index_name) == 0:
            cursor.execute(f"DROP INDEX {index_name}")
        cursor.execute(f"CREATE INDEX IF NOT EXISTS {index_name} ON markdown_nodes({columns}) WHERE {predicate}")

    link_columns = {column[1] for column in cursor.execute("PRAGMA table_info(vault_links)")}
    if "source_node_id" in link_columns:
        cursor.execute("ALTER TABLE vault_links RENAME COLUMN source_node_id TO source_markdown_node_id")
        link_columns.remove("source_node_id")
        link_columns.add("source_markdown_node_id")
    if "source_markdown_node_id" not in link_columns:
        cursor.execute(
            "ALTER TABLE vault_links ADD COLUMN source_markdown_node_id "
            "INTEGER REFERENCES markdown_nodes(id) ON DELETE CASCADE"
        )
    if "source_frontmatter_node_id" not in link_columns:
        cursor.execute(
            "ALTER TABLE vault_links ADD COLUMN source_frontmatter_node_id "
            "INTEGER REFERENCES frontmatter_nodes(id) ON DELETE CASCADE"
        )
    if "target_node_id" not in link_columns:
        cursor.execute(
            "ALTER TABLE vault_links ADD COLUMN target_node_id INTEGER REFERENCES markdown_nodes(id) ON DELETE SET NULL"
        )
    if "missing_target_id" not in link_columns:
        cursor.execute(
            "ALTER TABLE vault_links ADD COLUMN missing_target_id INTEGER "
            "REFERENCES vault_missing_targets(id) ON DELETE SET NULL"
        )
    if "resolution_status" not in link_columns:
        cursor.execute(
            "ALTER TABLE vault_links ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'resolved' "
            "CHECK (resolution_status IN ('resolved', 'missing', 'ambiguous', 'external', 'missing_fragment'))"
        )
    for column in ("target_heading", "target_block_id"):
        if column in link_columns:
            cursor.execute(f"ALTER TABLE vault_links DROP COLUMN {column}")

    cursor.execute(
        "CREATE INDEX IF NOT EXISTS vault_links_missing_target_idx ON vault_links(missing_target_id, source_file_id)"
    )

    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS vault_missing_targets_without_file_idx
        ON vault_missing_targets(target_type, target)
        WHERE target_file_id IS NULL
        """
    )
    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS vault_missing_targets_with_file_idx
        ON vault_missing_targets(target_type, target, target_file_id)
        WHERE target_file_id IS NOT NULL
        """
    )


def get_frontmatter(source_bytes: bytes) -> tuple[list[str], bool] | None:
    """Return frontmatter source and whether it has a closing delimiter."""
    lines = source_bytes.decode("utf-8").splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "---":
        return None

    source_frontmatter = []
    for line in lines[1:]:
        if line.rstrip("\r\n") in {"---", "..."}:
            return source_frontmatter, True
        source_frontmatter.append(line)

    return source_frontmatter, False


def parse_frontmatter(source: list[str]) -> ParsedFrontmatter:
    """Parse frontmatter from YAML source."""
    fallback_properties = yaml.MappingNode("", [], None, None, None)
    properties = fallback_properties
    try:
        parsed_properties = yaml.compose("".join(source))
        if parsed_properties is not None:
            properties = parsed_properties
        return ParsedFrontmatter(properties, None, None, None)
    except yaml.YAMLError as error:
        mark = getattr(error, "problem_mark", None)
        return ParsedFrontmatter(
            properties, str(error), mark.line + 1 if mark else None, mark.column + 1 if mark else None
        )


def _has_frontmatter_tag(frontmatter: ParsedFrontmatter, tag: str) -> bool:
    for key_node, value_node in frontmatter.properties.value:
        if key_node.value not in {"tag", "tags"}:
            continue

        values = value_node.value if isinstance(value_node, yaml.SequenceNode) else (value_node,)
        if any(isinstance(value, yaml.ScalarNode) and value.value == tag for value in values):
            return True

    return False


def insert_frontmatter_node(
    cursor: sqlite3.Cursor,
    file_id: int,
    node: yaml.Node,
    source: str,
    key: str | None,
    parent_id: int | None,
    ordinal: int,
) -> None:
    if isinstance(node, yaml.MappingNode):
        node_type = "mapping"
        value = None
    elif isinstance(node, yaml.SequenceNode):
        node_type = "sequence"
        value = None
    else:
        node_type = "scalar"
        value = node.value

    raw_yaml = source[node.start_mark.index: node.end_mark.index]
    start_line = node.start_mark.line + FRONTMATTER_BODY_FIRST_FILE_LINE
    end_line = node.end_mark.line + FRONTMATTER_BODY_FIRST_FILE_LINE

    cursor.execute(
        """
        INSERT INTO frontmatter_nodes (
            file_id,
            parent_id,
            ordinal,
            key,
            node_type,
            value,
            raw_yaml,
            start_line,
            end_line
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (file_id, parent_id, ordinal, key, node_type, value, raw_yaml, start_line, end_line),
    )

    node_id = cursor.lastrowid
    if node_id is None:
        raise RuntimeError("Failed to insert frontmatter node")

    if isinstance(node, yaml.MappingNode):
        for child_ordinal, (key_node, value_node) in enumerate(node.value):
            insert_frontmatter_node(cursor, file_id, value_node, source, key_node.value, node_id, child_ordinal)

    elif isinstance(node, yaml.SequenceNode):
        for child_ordinal, child in enumerate(node.value):
            insert_frontmatter_node(cursor, file_id, child, source, None, node_id, child_ordinal)


def insert_frontmatter_nodes(
    cursor: sqlite3.Cursor, frontmatter_result: ParsedFrontmatter, file_id: int, source: str
) -> None:
    for ordinal, (key_node, value_node) in enumerate(frontmatter_result.properties.value):
        insert_frontmatter_node(cursor, file_id, value_node, source, key_node.value, None, ordinal)


def insert_vault_tags(cursor: sqlite3.Cursor) -> None:
    """Insert all tags and their parent tags."""
    tags = cursor.execute(
        """
        WITH RECURSIVE tag_nodes(id, node_type, value) AS (
            SELECT id, node_type, value
            FROM frontmatter_nodes
            WHERE parent_id IS NULL
              AND key IN ('tag', 'tags')

            UNION ALL

            SELECT child.id, child.node_type, child.value
            FROM frontmatter_nodes AS child
            JOIN tag_nodes AS parent
                ON child.parent_id = parent.id
        )
        SELECT value
        FROM tag_nodes
        WHERE node_type = 'scalar'
          AND value IS NOT NULL

        UNION

        SELECT value
        FROM markdown_nodes
        WHERE node_type = 'tag'
        """
    ).fetchall()

    required_tags: set[str] = set()

    for (tag,) in tags:
        started = perf_counter()
        parts = tag.split("/")
        parent_tag_id = None

        for index in range(len(parts)):
            normalized_name = "/".join(parts[: index + 1])
            required_tags.add(normalized_name)

            cursor.execute(
                """
                INSERT OR IGNORE INTO vault_tags (name, parent_id)
                VALUES (?, ?)
                """,
                (normalized_name, parent_tag_id),
            )

            parent_tag_id = cursor.execute(
                """
                SELECT id
                FROM vault_tags
                WHERE name = ?
                """,
                (normalized_name,),
            ).fetchone()[0]

        record_timing("insert_vault_tags-insert", started, "tag")

    for tag_id, name in cursor.execute("SELECT id, name FROM vault_tags").fetchall():
        started = perf_counter()

        if name not in required_tags:
            cursor.execute("DELETE FROM vault_tags WHERE id = ?", (tag_id,))

        record_timing("insert_vault_tags-delete", started, "tag")


def insert_note_tags(cursor: sqlite3.Cursor, file_ids: list[int]) -> None:
    """Insert direct tag occurrences for reindexed notes."""
    tag_ids = dict(cursor.execute("SELECT name, id FROM vault_tags"))

    for file_id in file_ids:
        cursor.execute(
            """
            DELETE FROM note_tag_occurrences
            WHERE frontmatter_node_id IN (
                SELECT id FROM frontmatter_nodes WHERE file_id = ?
            )
               OR markdown_node_id IN (
                SELECT id FROM markdown_nodes WHERE file_id = ?
            )
            """,
            (file_id, file_id),
        )
        tag_occurrences = cursor.execute(
            """
            WITH RECURSIVE frontmatter_tag_nodes(id) AS (
                SELECT id
                FROM frontmatter_nodes
                WHERE file_id = ?
                  AND parent_id IS NULL
                  AND key IN ('tag', 'tags')

                UNION ALL

                SELECT child.id
                FROM frontmatter_nodes AS child
                JOIN frontmatter_tag_nodes AS parent
                  ON child.parent_id = parent.id
            )
            SELECT frontmatter_tag_nodes.id AS frontmatter_node_id,
                   NULL AS markdown_node_id,
                   frontmatter_nodes.value,
                   frontmatter_nodes.id AS source_position,
                   0 AS source_order
            FROM frontmatter_tag_nodes
            JOIN frontmatter_nodes
              ON frontmatter_nodes.id = frontmatter_tag_nodes.id
            WHERE frontmatter_nodes.node_type = 'scalar'
              AND frontmatter_nodes.value IS NOT NULL

            UNION ALL

            SELECT
                NULL AS frontmatter_node_id,
                id AS markdown_node_id,
                value,
                start_offset_utf16 AS source_position,
                1 AS source_order
            FROM markdown_nodes
            WHERE file_id = ? AND node_type = 'tag'
            ORDER BY source_order, source_position
            """,
            (file_id, file_id),
        ).fetchall()

        for frontmatter_node_id, markdown_node_id, tag_name, _, _ in tag_occurrences:
            started = perf_counter()
            cursor.execute(
                """
                INSERT INTO note_tag_occurrences (
                    tag_id,
                    frontmatter_node_id,
                    markdown_node_id
                )
                VALUES (?, ?, ?)
                """,
                (tag_ids[tag_name], frontmatter_node_id, markdown_node_id),
            )

            record_timing("insert_note_tags", started, "tags")


def get_node_text(node: dict) -> str:
    """Return the concatenated text values below one Markdown node."""
    value = node.get("value")
    if value is not None:
        return value
    return "".join(get_node_text(child) for child in node.get("children", []))


def add_block_ids(node: dict, source: str) -> None:
    """Annotate paragraph nodes with their trailing Obsidian block IDs."""
    source_utf16 = source.encode("utf-16-le")

    def visit(node: dict) -> None:
        position = node.get("position")
        if node["type"] == "paragraph" and position is not None:
            start = position["start"]["offset"]
            end = position["end"]["offset"]
            paragraph_source = source_utf16[start * 2: end * 2].decode("utf-16-le")
            match = re.search(r"(?:^|\s)\^([A-Za-z0-9_-]+)\s*$", paragraph_source)
            if match is not None:
                node["block_id"] = match.group(1)

        for child in node.get("children", []):
            visit(child)

    visit(node)


def get_frontmatter_links(cursor: sqlite3.Cursor, file_id: int) -> list[dict]:
    """Return wikilinks found in scalar frontmatter values."""
    links = []

    values = cursor.execute(
        """
        SELECT id, value
        FROM frontmatter_nodes
        WHERE file_id = ?
          AND node_type = 'scalar'
          AND value IS NOT NULL
        ORDER BY id
        """,
        (file_id,),
    )

    pattern = re.compile(r"!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")

    for source_frontmatter_node_id, value in values:
        for match in pattern.finditer(value):
            raw_target = match.group(1)
            display_text = match.group(2)

            links.append(
                {
                    "source_frontmatter_node_id": source_frontmatter_node_id,
                    "raw_target": raw_target,
                    "display_text": display_text,
                    "link_syntax": "wikilink",
                    "is_embed": match.group(0).startswith("!"),
                }
            )

    return links


def insert_vault_links(cursor: sqlite3.Cursor, source_file_id: int, tree: dict) -> None:
    """Insert raw link occurrences from frontmatter and Markdown."""
    started = perf_counter()

    links = get_frontmatter_links(cursor, source_file_id)

    def visit(node: dict) -> None:
        node_type = node["type"]
        position = node.get("position") or {}
        start_position = position.get("start") or {}
        end_position = position.get("end") or {}
        source_start_offset_utf16 = start_position.get("offset")
        source_end_offset_utf16 = end_position.get("offset")

        if node_type == "wikilink":
            fragment = node["heading"] or None
            links.append(
                {
                    "raw_target": node["path"] + (f"#{fragment}" if fragment is not None else ""),
                    "display_text": node["alias"] or None,
                    "link_syntax": "wikilink",
                    "is_embed": node["embedded"],
                    "source_start_offset_utf16": source_start_offset_utf16,
                    "source_end_offset_utf16": source_end_offset_utf16,
                }
            )

        elif node_type == "link":
            links.append(
                {
                    "raw_target": node["url"],
                    "display_text": get_node_text(node) or None,
                    "link_syntax": "link",
                    "is_embed": False,
                    "source_start_offset_utf16": source_start_offset_utf16,
                    "source_end_offset_utf16": source_end_offset_utf16,
                }
            )

        elif node_type == "image":
            links.append(
                {
                    "raw_target": node["url"],
                    "display_text": node["alt"] or None,
                    "link_syntax": "image",
                    "is_embed": True,
                    "source_start_offset_utf16": source_start_offset_utf16,
                    "source_end_offset_utf16": source_end_offset_utf16,
                }
            )

        for child in node.get("children", []):
            visit(child)

    visit(tree)

    for link in links:
        source_markdown_node_id = None
        source_frontmatter_node_id = link.get("source_frontmatter_node_id")
        if link.get("source_start_offset_utf16") is not None:
            source_markdown_node_id = cursor.execute(
                """
                SELECT id
                FROM markdown_nodes
                WHERE file_id = ?
                  AND node_type = ?
                  AND start_offset_utf16 = ?
                  AND end_offset_utf16 = ?
                """,
                (
                    source_file_id,
                    link["link_syntax"],
                    link["source_start_offset_utf16"],
                    link["source_end_offset_utf16"],
                ),
            ).fetchone()
            source_markdown_node_id = source_markdown_node_id[0] if source_markdown_node_id is not None else None

        cursor.execute(
            """
            INSERT INTO vault_links (
                source_file_id,
                source_markdown_node_id,
                source_frontmatter_node_id,
                target_file_id,
                target_node_id,
                missing_target_id,
                raw_target,
                display_text,
                link_syntax,
                is_embed,
                resolution_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_file_id,
                source_markdown_node_id,
                source_frontmatter_node_id,
                None,
                None,
                None,
                link["raw_target"],
                link["display_text"],
                link["link_syntax"],
                link["is_embed"],
                "missing",
            ),
        )

    record_timing("insert_vault_links", started, "file")


def get_markdown_node_attributes(node: dict) -> dict:
    """Return allowed semantic attributes for one Markdown AST node."""
    node_type = node["type"]
    if node_type == "heading":
        fields = ("depth",)
    elif node_type == "list":
        fields = ("ordered", "start", "spread")
    elif node_type == "listItem":
        fields = ("checked", "spread")
    elif node_type == "blockquote":
        fields = ("callout",)
    elif node_type == "code":
        fields = ("lang", "meta", "fenced")
    elif node_type == "math":
        fields = ("meta",)
    elif node_type == "table":
        fields = ("align",)
    elif node_type in {"footnoteDefinition", "footnoteReference"}:
        fields = ("identifier", "label")
    elif node_type == "definition":
        fields = ("identifier", "label", "url", "title")
    elif node_type == "wikilink":
        fields = ("path", "alias", "heading")
    elif node_type == "link":
        fields = ("url", "title")
    elif node_type == "linkReference":
        fields = ("identifier", "label", "referenceType")
    elif node_type == "image":
        fields = ("url", "alt", "title")
    else:
        return {}

    return {field: node[field] for field in fields if field in node}


def insert_markdown_nodes(
    cursor: sqlite3.Cursor, file_id: int, node: dict, parent_id: int | None = None, ordinal: int = 0
) -> None:
    """Insert one Markdown AST node and all of its descendants."""
    position = node.get("position")
    if position is None:
        start_line = start_column = start_offset_utf16 = None
        end_line = end_column = end_offset_utf16 = None
    else:
        start = position["start"]
        end = position["end"]
        start_line = start["line"]
        start_column = start["column"]
        start_offset_utf16 = start["offset"]
        end_line = end["line"]
        end_column = end["column"]
        end_offset_utf16 = end["offset"]
    attributes = get_markdown_node_attributes(node)
    attributes_json = json.dumps(attributes, separators=(",", ":")) if attributes else "{}"

    cursor.execute(
        """
        INSERT INTO markdown_nodes (
            file_id,
            parent_id,
            ordinal,
            node_type,
            value,
            block_id,
            attributes_json,
            start_line,
            start_column,
            start_offset_utf16,
            end_line,
            end_column,
            end_offset_utf16
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            file_id,
            parent_id,
            ordinal,
            node["type"],
            get_node_text(node) if node["type"] == "heading" else node.get("value"),
            node.get("block_id"),
            attributes_json,
            start_line,
            start_column,
            start_offset_utf16,
            end_line,
            end_column,
            end_offset_utf16,
        ),
    )
    node_id = cursor.lastrowid
    if node_id is None:
        raise RuntimeError(f"Failed to insert Markdown node: {node['type']}")

    for child_ordinal, child in enumerate(node.get("children", [])):
        insert_markdown_nodes(cursor, file_id, child, node_id, child_ordinal)


def parse_file(path: Path, markdown_parser: MarkdownTreeParser) -> ParsedFile:
    """Read and parse one file without accessing the database."""
    file_stat = path.stat()
    suffix = path.suffix.lower()
    kind = "excalidraw" if path.name.lower().endswith("excalidraw.md") else FILE_KIND_BY_EXTENSION.get(suffix, "other")
    parsed = ParsedFile(path, file_stat.st_dev, file_stat.st_ino, file_stat.st_mtime_ns, kind)
    if kind != "markdown":
        return parsed

    started = perf_counter()
    source_bytes = path.read_bytes()
    record_timing("read_bytes", started, "file")

    started = perf_counter()
    frontmatter = get_frontmatter(source_bytes)
    record_timing("get_frontmatter", started, "file")
    if frontmatter is not None:
        frontmatter_source, has_closing_delimiter = frontmatter
        parsed.frontmatter_source = "".join(frontmatter_source)
        started = perf_counter()
        parsed.frontmatter_result = parse_frontmatter(frontmatter_source)
        if not has_closing_delimiter and parsed.frontmatter_result.error is None:
            parsed.frontmatter_result = ParsedFrontmatter(
                parsed.frontmatter_result.properties, "Frontmatter is missing a closing '---' delimiter.", None, None
            )
        record_timing("parse_frontmatter", started, "file")
        if parsed.frontmatter_result.error is None and _has_frontmatter_tag(parsed.frontmatter_result, "excalidraw"):
            parsed.kind = "excalidraw"
            return parsed

    source = source_bytes.decode("utf-8")
    started = perf_counter()
    parsed.syntax_tree = markdown_parser.parse(source)
    record_timing("parse_markdown_tree", started, "file")
    add_block_ids(parsed.syntax_tree, source)
    return parsed


def backfill_legacy_file_devices(cursor: sqlite3.Cursor) -> None:
    """Persist device identity for legacy rows whose path metadata still matches."""
    legacy_rows = cursor.execute(
        "SELECT path, inode, mtime_ns FROM vault_files WHERE st_dev IS NULL"
    ).fetchall()
    for path_string, inode, mtime_ns in legacy_rows:
        try:
            file_stat = Path(path_string).stat()
        except OSError:
            continue
        if file_stat.st_ino == inode and file_stat.st_mtime_ns == mtime_ns:
            cursor.execute(
                """
                UPDATE vault_files SET st_dev = ?
                WHERE path = ? AND st_dev IS NULL AND inode = ? AND mtime_ns = ?
                """,
                (file_stat.st_dev, path_string, inode, mtime_ns),
            )


def insert_file(cursor: sqlite3.Cursor, parsed: ParsedFile, directory_id: int) -> int:
    """Replace one file's indexed rows in the caller's transaction."""
    cursor.execute(
        """
        INSERT INTO vault_files (directory_id, path, name, st_dev, inode, mtime_ns, extension, kind)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            directory_id = excluded.directory_id,
            name = excluded.name,
            st_dev = excluded.st_dev,
            inode = excluded.inode,
            mtime_ns = excluded.mtime_ns,
            extension = excluded.extension,
            kind = excluded.kind
        RETURNING id
        """,
        (
            directory_id,
            str(parsed.path),
            parsed.path.stem,
            parsed.st_dev,
            parsed.inode,
            parsed.mtime_ns,
            parsed.path.suffix.lower(),
            parsed.kind,
        ),
    )
    file_id = cursor.fetchone()[0]
    started = perf_counter()
    cursor.execute("DELETE FROM frontmatter_nodes WHERE file_id = ?", (file_id,))
    cursor.execute("DELETE FROM frontmatter_errors WHERE file_id = ?", (file_id,))
    cursor.execute("DELETE FROM markdown_nodes WHERE file_id = ?", (file_id,))
    cursor.execute("DELETE FROM vault_links WHERE source_file_id = ?", (file_id,))
    record_timing("delete_file_nodes", started, "file")

    if parsed.frontmatter_result is not None:
        frontmatter_result = parsed.frontmatter_result
        if frontmatter_result.error is not None:
            cursor.execute(
                """
                INSERT INTO frontmatter_errors (file_id, error_output, line, column, raw_yaml )
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    file_id,
                    frontmatter_result.error,
                    frontmatter_result.error_line,
                    frontmatter_result.error_column,
                    parsed.frontmatter_source,
                ),
            )
        else:
            started = perf_counter()
            insert_frontmatter_nodes(cursor, frontmatter_result, file_id, parsed.frontmatter_source)
            record_timing("insert_frontmatter_nodes", started, "file")

    if parsed.syntax_tree is not None:
        started = perf_counter()
        insert_markdown_nodes(cursor, file_id, parsed.syntax_tree)
        record_timing("insert_markdown_nodes", started, "file")
        insert_vault_links(cursor, file_id, parsed.syntax_tree)

    return file_id


def resolve_vault_links(cursor: sqlite3.Cursor, vault_path: Path) -> None:
    """Resolve local links and retain unresolved targets as graph nodes."""
    vault_path = vault_path.resolve()
    unique_note_ids = dict(cursor.execute("SELECT name, MIN(id) FROM vault_files GROUP BY name HAVING COUNT(*) = 1"))
    unique_filename_ids = dict(
        cursor.execute(
            "SELECT name || extension, MIN(id) FROM vault_files GROUP BY name, extension HAVING COUNT(*) = 1"
        )
    )
    name_counts = dict(cursor.execute("SELECT name, COUNT(*) FROM vault_files GROUP BY name"))
    filename_counts = dict(
        cursor.execute("SELECT name || extension, COUNT(*) FROM vault_files GROUP BY name, extension")
    )
    indexed_paths = {
        Path(path).resolve(): file_id for file_id, path in cursor.execute("SELECT id, path FROM vault_files")
    }

    def resolve_path(path: Path) -> int | None:
        path = path.resolve()
        target_file_id = indexed_paths.get(path)
        if target_file_id is None and not path.suffix:
            target_file_id = indexed_paths.get(path.with_suffix(".md"))
        return target_file_id

    def path_target(path: Path) -> str:
        path = path.resolve()
        try:
            return str(path.relative_to(vault_path))
        except ValueError:
            return str(path)

    def get_missing_target_id(target_type: str, target: str, target_file_id: int | None = None) -> int:
        row = cursor.execute(
            """
            SELECT id
            FROM vault_missing_targets
            WHERE target_type = ? AND target = ? AND target_file_id IS ?
            """,
            (target_type, target, target_file_id),
        ).fetchone()
        if row is not None:
            return row[0]
        cursor.execute(
            """
            INSERT INTO vault_missing_targets (target_type, target, target_file_id)
            VALUES (?, ?, ?)
            """,
            (target_type, target, target_file_id),
        )
        return cursor.lastrowid

    heading_matches_by_file: dict[int, tuple[dict[str, list[int]], dict[str, list[int]]]] = {}

    def get_heading_matches(file_id: int, fragment: str) -> list[int]:
        cached = heading_matches_by_file.get(file_id)
        if cached is None:
            exact_matches: dict[str, list[int]] = {}
            path_matches: dict[str, list[int]] = {}
            heading_stack: list[tuple[int, str]] = []

            rows = cursor.execute(
                """
                SELECT id, value, attributes_json
                FROM markdown_nodes
                WHERE file_id = ? AND node_type = 'heading'
                ORDER BY start_offset_utf16, id
                """,
                (file_id,),
            ).fetchall()

            for node_id, heading, attributes_json in rows:
                depth = json.loads(attributes_json).get("depth")
                if not heading or depth is None:
                    continue

                while heading_stack and heading_stack[-1][0] >= depth:
                    heading_stack.pop()

                heading_stack.append((depth, heading))
                heading_path = "/".join(text for _, text in heading_stack)

                exact_matches.setdefault(heading, []).append(node_id)
                path_matches.setdefault(heading_path, []).append(node_id)

            cached = exact_matches, path_matches
            heading_matches_by_file[file_id] = cached

        exact_matches, path_matches = cached
        exact_node_ids = exact_matches.get(fragment)
        if exact_node_ids:
            return exact_node_ids
        nested_fragment = fragment.replace("#", "/")
        return path_matches.get(fragment) or path_matches.get(nested_fragment, [])

    cursor.execute(
        """
        UPDATE vault_links
        SET target_file_id = NULL,
            target_node_id = NULL,
            missing_target_id = NULL,
            resolution_status = 'missing'
        """
    )
    links = cursor.execute(
        """
        SELECT vault_links.id, vault_links.source_file_id, vault_links.raw_target,
               vault_links.link_syntax, vault_files.path
        FROM vault_links
        JOIN vault_files ON vault_files.id = vault_links.source_file_id
        WHERE vault_links.link_syntax IN ('wikilink', 'link', 'image')
        """
    ).fetchall()

    for link_id, source_file_id, raw_target, link_syntax, source_path in links:
        started = perf_counter()
        target_path, separator, fragment = raw_target.partition("#")
        target_path = target_path.strip()
        fragment = fragment.strip()
        target_file_id = None
        target_node_id = None
        missing_id = None
        status = "missing"
        target_type = None
        target_value = None

        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target_path):
            status = "external"
        elif not target_path:
            target_file_id = source_file_id
        elif (
            link_syntax == "wikilink" and not target_path.startswith(("./", "../", "/", "~")) and "/" not in target_path
        ):
            target_file_id = unique_note_ids.get(target_path) or unique_filename_ids.get(target_path)
            if target_file_id is None:
                candidate_count = max(name_counts.get(target_path, 0), filename_counts.get(target_path, 0))
                status = "ambiguous" if candidate_count else "missing"
                if status == "missing":
                    target_type, target_value = "name", target_path
        else:
            candidate_path = Path(target_path).expanduser() if target_path.startswith("~") else Path(target_path)
            if not candidate_path.is_absolute():
                if link_syntax == "wikilink" and not target_path.startswith(("./", "../")):
                    candidate_path = vault_path / candidate_path
                else:
                    candidate_path = Path(source_path).parent / candidate_path
            target_file_id = resolve_path(candidate_path)
            if target_file_id is None:
                target_type, target_value = (
                    "path",
                    path_target(candidate_path if candidate_path.suffix else candidate_path.with_suffix(".md")),
                )

        if target_file_id is not None and separator and fragment:
            if fragment.startswith("^"):
                target_nodes = cursor.execute(
                    "SELECT id FROM markdown_nodes WHERE file_id = ? AND block_id = ?", (target_file_id, fragment[1:])
                ).fetchall()
                target_type, target_value = "block", fragment[1:]
            else:
                target_node_ids = get_heading_matches(target_file_id, fragment)
                target_nodes = [(node_id,) for node_id in target_node_ids]
                target_type, target_value = "heading", fragment
            if len(target_nodes) == 1:
                target_node_id = target_nodes[0][0]
                target_type = target_value = None
                status = "resolved"
            elif len(target_nodes) > 1:
                status = "ambiguous"
                target_type = target_value = None
            else:
                status = "missing_fragment"
                missing_id = get_missing_target_id(target_type, target_value, target_file_id)
        elif target_file_id is not None:
            status = "resolved"
        elif target_type is not None:
            missing_id = get_missing_target_id(target_type, target_value)

        cursor.execute(
            """
            UPDATE vault_links
            SET target_file_id = ?, target_node_id = ?, missing_target_id = ?, resolution_status = ?
            WHERE id = ?
            """,
            (target_file_id, target_node_id, missing_id, status, link_id),
        )
        record_timing("resolve_vault_links", started, "link")

    cursor.execute(
        """
        DELETE FROM vault_missing_targets
        WHERE NOT EXISTS (
            SELECT 1 FROM vault_links WHERE vault_links.missing_target_id = vault_missing_targets.id
        )
        """
    )


def move_path_kind(path: str) -> str:
    """Return the file kind determined by the path alone."""
    candidate = Path(path)
    if candidate.name.lower().endswith("excalidraw.md"):
        return "excalidraw"
    return FILE_KIND_BY_EXTENSION.get(candidate.suffix.lower(), "other")


def move_kind_is_compatible(old_path: str, new_path: str, old_kind: str) -> bool:
    """Allow moves whose indexed kind remains compatible with both paths."""
    old_path_kind = move_path_kind(old_path)
    new_path_kind = move_path_kind(new_path)
    old_kind_matches_path = old_kind == old_path_kind or (
        old_path_kind == "markdown" and old_kind == "excalidraw"
    )
    return old_kind_matches_path and (
        new_path_kind == old_kind
        or (old_path_kind == new_path_kind == "markdown" and old_kind == "excalidraw")
    )


def pair_unchanged_file_moves(
    cursor: sqlite3.Cursor,
    file_changes: list[tuple[str, str]],
) -> list[tuple[str, str, tuple[int, int, int, int, str]]]:
    """Find unique regular-file moves whose destination metadata can be refreshed in place."""
    deleted = {path for action, path in file_changes if action == "deleted"}
    created = [path for action, path in file_changes if action == "created"]
    if not deleted or not created:
        return []

    deleted_rows: dict[tuple[int, int], list[tuple[str, tuple[int, int, int, int, str]]]] = {}
    for path, file_id, st_dev, inode, mtime_ns, kind in cursor.execute(
        "SELECT path, id, st_dev, inode, mtime_ns, kind FROM vault_files"
    ):
        if path in deleted and st_dev is not None:
            deleted_rows.setdefault((st_dev, inode), []).append((path, (file_id, mtime_ns, st_dev, inode, kind)))

    created_rows: dict[tuple[int, int], list[tuple[str, os.stat_result]]] = {}
    for path_string in created:
        path = Path(path_string)
        try:
            file_stat = path.lstat()
        except OSError:
            continue
        if stat.S_ISREG(file_stat.st_mode):
            created_rows.setdefault((file_stat.st_dev, file_stat.st_ino), []).append((path_string, file_stat))

    moves: list[tuple[str, str, tuple[int, int, int, int, str]]] = []
    for identity, old_candidates in deleted_rows.items():
        new_candidates = created_rows.get(identity, [])
        if len(old_candidates) != 1 or len(new_candidates) != 1:
            continue
        old_path, old_row = old_candidates[0]
        new_path, new_stat = new_candidates[0]
        file_id, old_mtime_ns, st_dev, inode, old_kind = old_row
        if new_stat.st_mtime_ns == old_mtime_ns and move_kind_is_compatible(old_path, new_path, old_kind):
            moves.append((old_path, new_path, (file_id, old_mtime_ns, st_dev, inode, old_kind)))
    return moves


def final_move_stat_matches(
    old_path: str, path_string: str, expected: tuple[int, int, int, int, str]
) -> bool:
    """Revalidate a move candidate immediately before its database update."""
    _file_id, mtime_ns, st_dev, inode, expected_kind = expected
    try:
        file_stat = Path(path_string).lstat()
    except OSError:
        return False
    return (
        stat.S_ISREG(file_stat.st_mode)
        and file_stat.st_dev == st_dev
        and file_stat.st_ino == inode
        and file_stat.st_mtime_ns == mtime_ns
        and move_kind_is_compatible(old_path, path_string, expected_kind)
    )


def apply_file_move(
    cursor: sqlite3.Cursor, old_path: str, new_path: str, expected: tuple[int, int, int, int, str]
) -> bool:
    """Update a uniquely matched file row in place after final stat validation."""
    if not final_move_stat_matches(old_path, new_path, expected):
        return False
    file_id = expected[0]
    directory = cursor.execute("SELECT id FROM vault_directories WHERE path = ?", (str(Path(new_path).parent),)).fetchone()
    if directory is None:
        return False
    cursor.execute(
        """
        UPDATE vault_files
        SET path = ?, name = ?, directory_id = ?, st_dev = ?, inode = ?, mtime_ns = ?,
            extension = ?, kind = ?
        WHERE id = ? AND path = ? AND mtime_ns = ? AND st_dev = ? AND inode = ? AND kind = ?
        """,
        (
            new_path,
            Path(new_path).stem,
            directory[0],
            expected[2],
            expected[3],
            expected[1],
            Path(new_path).suffix.lower(),
            expected[4],
            file_id,
            old_path,
            expected[1],
            expected[2],
            expected[3],
            expected[4],
        ),
    )
    return cursor.rowcount == 1


def parse_args() -> tuple[Path, Path]:
    parser = argparse.ArgumentParser(description="Parse a vault into a SQLite database.")

    parser.add_argument("input", type=Path, nargs="?", default=DEFAULT_VAULT_PATH, help="Path to the vault to parse.")

    parser.add_argument(
        "output", type=Path, nargs="?", default=DEFAULT_DB_PATH, help="Path to the output SQLite database."
    )

    args = parser.parse_args()

    input_path = args.input.expanduser().resolve()
    output_path = args.output.expanduser().resolve()

    if not input_path.exists():
        parser.error(f"Path does not exist: {input_path}")

    if not input_path.is_dir():
        parser.error(f"Path is not a directory: {input_path}")

    return input_path, output_path


def main():
    vault_path, db_path = parse_args()

    vault_path = Path(vault_path)
    connection = sqlite3.connect(db_path)
    started = perf_counter()
    markdown_parser = MarkdownTreeParser()
    record_timing("launch_markdown_parser", started)

    try:
        connection.execute("PRAGMA foreign_keys = ON")

        with connection as con:
            con.execute("BEGIN")
            cursor = con.cursor()
            initialize_database(cursor)
            derived_data_dirty = bool(
                cursor.execute("SELECT derived_data_dirty FROM vault_index_state WHERE id = 1").fetchone()[0]
            )

            changed_directories, changed_files = find_changes(cursor, vault_path)
            backfill_legacy_file_devices(cursor)
            move_candidates = pair_unchanged_file_moves(cursor, changed_files)
            directories_to_insert = [
                Path(path_string) for action, path_string in changed_directories if action in ("created", "modified")
            ]

            files_to_index = [
                Path(path_string) for action, path_string in changed_files if action in ("created", "modified")
            ]
            if not derived_data_dirty and cursor.execute("SELECT 1 FROM vault_links LIMIT 1").fetchone() is None:
                link_file_paths = cursor.execute(
                    """
                    SELECT DISTINCT vault_files.path
                    FROM vault_files
                    JOIN markdown_nodes ON markdown_nodes.file_id = vault_files.id
                    WHERE markdown_nodes.node_type IN ('wikilink', 'link', 'image')
                    """
                ).fetchall()
                indexed_paths = set(files_to_index)
                files_to_index.extend(Path(path) for (path,) in link_file_paths if Path(path) not in indexed_paths)
            indexed_file_ids: list[int] = []

            file_paths_to_delete = [Path(path_string) for action, path_string in changed_files if action == "deleted"]

            directory_paths_to_delete = [
                Path(path_string) for action, path_string in changed_directories if action == "deleted"
            ]
            has_file_changes = bool(files_to_index or file_paths_to_delete)

            if has_file_changes:
                cursor.execute("UPDATE vault_index_state SET derived_data_dirty = 1 WHERE id = 1")

            for directory in directories_to_insert:
                parent_id = None
                if directory != vault_path:
                    parent_id = cursor.execute(
                        "SELECT id FROM vault_directories WHERE path = ?", (str(directory.parent),)
                    ).fetchone()[0]
                cursor.execute(
                    """
                    INSERT INTO vault_directories (path, inode, parent_id)
                    VALUES (?, ?, ?)
                    ON CONFLICT(path) DO UPDATE SET
                        inode = excluded.inode,
                        parent_id = excluded.parent_id
                    """,
                    (str(directory), directory.stat().st_ino, parent_id),
                )
            applied_moves: list[tuple[str, str]] = []
            for old_path, new_path, expected in move_candidates:
                if apply_file_move(cursor, old_path, new_path, expected):
                    applied_moves.append((old_path, new_path))
                    # Moved files retain their existing tag occurrences.
            if applied_moves:
                moved_old_paths = {old for old, _new in applied_moves}
                moved_new_paths = {new for _old, new in applied_moves}
                files_to_index = [path for path in files_to_index if str(path) not in moved_new_paths]
                file_paths_to_delete = [path for path in file_paths_to_delete if str(path) not in moved_old_paths]


            if files_to_index:
                print(f"Indexing {len(files_to_index)} files", flush=True)
                with ThreadPoolExecutor(max_workers=1) as executor:
                    pending = executor.submit(parse_file, files_to_index[0], markdown_parser)
                    for index, file_path in enumerate(files_to_index, start=1):
                        parsed_file = pending.result()
                        if index < len(files_to_index):
                            pending = executor.submit(parse_file, files_to_index[index], markdown_parser)
                        directory_id = cursor.execute(
                            "SELECT id FROM vault_directories WHERE path = ?", (str(file_path.parent),)
                        ).fetchone()[0]
                        indexed_file_ids.append(insert_file(cursor, parsed_file, directory_id))
                        if index % INDEX_BATCH_SIZE == 0:
                            con.commit()
                            if index < len(files_to_index):
                                cursor.execute("UPDATE vault_index_state SET derived_data_dirty = 1 WHERE id = 1")
                        if index % 1_000 == 0 or index == len(files_to_index):
                            print(f"Indexed {index}/{len(files_to_index)} files", flush=True)

            for path_string in file_paths_to_delete:
                cursor.execute("DELETE FROM vault_files WHERE path = ?", (str(path_string),))

            for path_string in directory_paths_to_delete:
                cursor.execute("DELETE FROM vault_directories WHERE path = ?", (str(path_string),))

            if has_file_changes:
                con.commit()

            if has_file_changes or derived_data_dirty:
                if derived_data_dirty:
                    tag_file_ids = [row[0] for row in cursor.execute("SELECT id FROM vault_files")]
                else:
                    tag_file_ids = indexed_file_ids
                print("Inserting vault tags ...")
                insert_vault_tags(cursor)
                print("Inserted vault tags")
                print("Inserting note tags ...")
                insert_note_tags(cursor, tag_file_ids)
                print("Inserted note tags")
                print("Resolving wikilinks ...")
                resolve_vault_links(cursor, vault_path)
                print("Resolved wikilinks")
                cursor.execute("UPDATE vault_index_state SET derived_data_dirty = 0 WHERE id = 1")
            print_timing_summary()

    except KeyboardInterrupt:
        return
    finally:
        markdown_parser.close()
        connection.close()


if __name__ == "__main__":
    main()
