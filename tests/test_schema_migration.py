"""Tests for non-destructive database initialization."""

import sqlite3

import indexer


def test_initialize_database_creates_schema_and_preserves_existing_rows(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute(
            "INSERT INTO vault_directories (path, inode, parent_id) VALUES (?, ?, ?)",
            ("/vault", 1, None),
        )
        cursor.execute(
            """
            INSERT INTO vault_files (directory_id, path, name, inode, mtime_ns, extension, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (1, "/vault/note.md", "note", 2, 123, ".md", "markdown"),
        )

        indexer.initialize_database(cursor)

        assert cursor.execute("SELECT path, mtime_ns FROM vault_files").fetchall() == [
            ("/vault/note.md", 123)
        ]


def test_initialize_database_creates_note_tag_occurrences_table(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)

        columns = {column[1] for column in cursor.execute("PRAGMA table_info(note_tag_occurrences)")}

    assert columns == {
        "id",
        "tag_id",
        "frontmatter_node_id",
        "markdown_node_id",
    }


def test_initialize_database_creates_vault_links_table(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)

        columns = {column[1] for column in cursor.execute("PRAGMA table_info(vault_links)")}

        markdown_node_columns = {column[1] for column in cursor.execute("PRAGMA table_info(markdown_nodes)")}
    assert columns == {
        "id",
        "source_file_id",
        "source_markdown_node_id",
        "source_frontmatter_node_id",
        "target_file_id",
        "target_node_id",
        "missing_target_id",
        "raw_target",
        "display_text",
        "link_syntax",
        "is_embed",
        "resolution_status",
    }
    assert {"value", "block_id"} <= markdown_node_columns
    assert "heading_text" not in markdown_node_columns


def test_initialize_database_migrates_heading_text_to_value(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("ALTER TABLE markdown_nodes ADD COLUMN heading_text TEXT")
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
                end_offset_utf16,
                heading_text
            )
            VALUES (1, NULL, 0, 'heading', NULL, NULL, '{"depth":1}', 1, 1, 0, 1, 5, 4, 'Legacy')
            """
        )

        indexer.initialize_database(cursor)

        columns = {column[1] for column in cursor.execute("PRAGMA table_info(markdown_nodes)")}
        assert "heading_text" not in columns
        assert cursor.execute(
            "SELECT value FROM markdown_nodes WHERE node_type = 'heading'"
        ).fetchall() == [("Legacy",)]


def test_initialize_database_removes_redundant_link_selectors(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("ALTER TABLE vault_links ADD COLUMN target_heading TEXT")
        cursor.execute("ALTER TABLE vault_links ADD COLUMN target_block_id TEXT")

        indexer.initialize_database(cursor)

        columns = {column[1] for column in cursor.execute("PRAGMA table_info(vault_links)")}

    assert "target_heading" not in columns
    assert "target_block_id" not in columns


def test_initialize_database_adds_mtime_to_legacy_notes(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        cursor.execute(
            """
            CREATE TABLE vault_files (
                id INTEGER PRIMARY KEY,
                directory_id INTEGER NOT NULL,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                inode INTEGER NOT NULL,
                extension TEXT NOT NULL,
                kind TEXT NOT NULL
            )
            """
        )
        cursor.execute(
            """
            INSERT INTO vault_files (directory_id, path, name, inode, extension, kind)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (1, "/vault/note.md", "note", 2, ".md", "markdown"),
        )

        indexer.initialize_database(cursor)

        assert cursor.execute("SELECT mtime_ns FROM vault_files").fetchall() == [(0,)]


def test_initialize_database_reindexes_markdown_for_fenced_code_provenance(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("ALTER TABLE vault_index_state DROP COLUMN fenced_code_version")
        cursor.execute("INSERT INTO vault_directories (path, inode, parent_id) VALUES (?, ?, ?)", ("/vault", 1, None))
        cursor.execute(
            """
            INSERT INTO vault_files (directory_id, path, name, inode, mtime_ns, extension, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (1, "/vault/note.md", "note", 2, 123, ".md", "markdown"),
        )

        indexer.initialize_database(cursor)

        assert cursor.execute("SELECT fenced_code_version FROM vault_index_state").fetchall() == [(1,)]
        assert cursor.execute("SELECT mtime_ns FROM vault_files").fetchall() == [(0,)]


def test_initialize_database_reindexes_markdown_for_callout_provenance(tmp_path) -> None:
    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("ALTER TABLE vault_index_state DROP COLUMN callout_version")
        cursor.execute("INSERT INTO vault_directories (path, inode, parent_id) VALUES (?, ?, ?)", ("/vault", 1, None))
        cursor.execute(
            """
            INSERT INTO vault_files (directory_id, path, name, inode, mtime_ns, extension, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (1, "/vault/note.md", "note", 2, 123, ".md", "markdown"),
        )

        indexer.initialize_database(cursor)

        assert cursor.execute("SELECT callout_version FROM vault_index_state").fetchall() == [(1,)]
        assert cursor.execute("SELECT mtime_ns FROM vault_files").fetchall() == [(0,)]
