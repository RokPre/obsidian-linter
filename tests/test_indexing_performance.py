"""Behavioral checks for the indexing performance prototype."""

import sqlite3
from contextlib import closing
from pathlib import Path
from threading import Event

import pytest

import indexer


@pytest.mark.parametrize("legacy_indexes", [False, True])
def test_sparse_lookup_indexes_preserve_rows_and_ambiguous_targets(legacy_indexes: bool) -> None:
    with sqlite3.connect(":memory:") as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("INSERT INTO vault_directories (id, path, inode) VALUES (1, '/vault', 1)")
        cursor.execute(
            "INSERT INTO vault_files (id, directory_id, path, name, inode, mtime_ns, extension, kind) "
            "VALUES (1, 1, '/vault/Note.md', 'Note', 2, 0, '.md', 'markdown')"
        )
        tree = {
            "type": "root",
            "children": [
                {"type": "heading", "depth": 1, "children": [{"type": "text", "value": "Unique"}]},
                {"type": "heading", "depth": 2, "children": [{"type": "text", "value": "Repeated"}]},
                {"type": "heading", "depth": 2, "children": [{"type": "text", "value": "Repeated"}]},
                {"type": "paragraph", "block_id": "unique", "children": [{"type": "text", "value": "Café"}]},
                {"type": "paragraph", "block_id": "repeated"},
                {"type": "paragraph", "block_id": "repeated"},
                {"type": "paragraph", "children": [{"type": "text", "value": "No block ID"}]},
            ],
        }
        indexer.insert_markdown_nodes(cursor, 1, tree)
        if legacy_indexes:
            for column in ("value", "block_id"):
                name = f"markdown_nodes_file_{column}_idx"
                cursor.execute(f"DROP INDEX {name}")
                cursor.execute(f"CREATE INDEX {name} ON markdown_nodes(file_id, {column})")
        before = cursor.execute("SELECT * FROM markdown_nodes ORDER BY id").fetchall()

        indexer.initialize_database(cursor)
        indexer.initialize_database(cursor)

        assert cursor.execute("SELECT * FROM markdown_nodes ORDER BY id").fetchall() == before
        for column, value in (("value", "Unique"), ("block_id", "unique")):
            query = "SELECT id FROM markdown_nodes WHERE file_id = ?"
            if column == "value":
                query += " AND node_type = 'heading'"
            query += f" AND {column} = ?"
            plan = cursor.execute("EXPLAIN QUERY PLAN " + query, (1, value)).fetchall()
            assert any(f"markdown_nodes_file_{column}_idx" in row[3] for row in plan)
            assert len(cursor.execute(query, (1, value)).fetchall()) == 1
        targets = ("#Unique", "#Repeated", "#Missing", "#^unique", "#^repeated", "#^missing")
        cursor.executemany(
            "INSERT INTO vault_links (source_file_id, raw_target, link_syntax, is_embed) "
            "VALUES (1, ?, 'wikilink', 0)", ((target,) for target in targets)
        )
        indexer.resolve_vault_links(cursor, Path("/vault"))
        assert cursor.execute(
            "SELECT target_file_id, target_node_id IS NOT NULL FROM vault_links ORDER BY id"
        ).fetchall() == [(1, 1), (1, 0), (1, 0), (1, 1), (1, 0), (1, 0)]
        assert cursor.execute("PRAGMA foreign_key_check").fetchall() == []


def test_resolver_handles_supported_link_path_forms(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    source_path = vault / "notes" / "source.md"
    absolute_path = vault / "absolute.md"
    home_path = vault / "homeRelative.md"
    source_relative_path = source_path.parent / "sourceRelative.md"
    parent_relative_path = vault / "parentRelative.md"
    vault_relative_path = vault / "attachments" / "images" / "vaultRelative.png"
    vault_relative_note_path = vault / "attachments" / "notes" / "vaultRelative.md"
    unique_filename_path = vault / "uniqueImage.png"
    unique_note_path = vault / "uniqueNote.md"
    dotted_note_path = vault / "foo.bar.md"
    markdown_source_target_path = source_path.parent / "markdownTarget.md"
    markdown_parent_target_path = vault / "markdownTarget.md"
    duplicate_paths = (vault / "one" / "duplicate.png", vault / "two" / "duplicate.png")
    note_paths = (
        source_path,
        absolute_path,
        home_path,
        source_relative_path,
        parent_relative_path,
        vault_relative_path,
        vault_relative_note_path,
        unique_filename_path,
        unique_note_path,
        dotted_note_path,
        *duplicate_paths,
        markdown_source_target_path,
        markdown_parent_target_path,
    )
    monkeypatch.setenv("HOME", str(tmp_path))

    with sqlite3.connect(":memory:") as connection:
        connection.execute("PRAGMA foreign_keys = ON")
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("INSERT INTO vault_directories (id, path, inode) VALUES (1, ?, 1)", (str(vault),))
        cursor.executemany(
            """
            INSERT INTO vault_files (id, directory_id, path, name, inode, mtime_ns, extension, kind)
            VALUES (?, 1, ?, ?, ?, 0, ?, ?)
            """,
            (
                (
                    file_id,
                    str(path),
                    path.stem,
                    file_id,
                    path.suffix,
                    "markdown" if path.suffix == ".md" else "image",
                )
                for file_id, path in enumerate(note_paths, start=1)
            ),
        )
        targets = (
            str(absolute_path),
            "~/vault/homeRelative.md",
            str(absolute_path.with_suffix("")),
            "~/vault/homeRelative",
            "./sourceRelative.md",
            "../parentRelative.md",
            "attachments/images/vaultRelative.png",
            "./sourceRelative",
            "attachments/notes/vaultRelative",
            "uniqueImage.png",
            "uniqueNote",
            "foo.bar",
            "duplicate.png",
            "https://example.com/image.png",
        )
        cursor.executemany(
            """
            INSERT INTO vault_links (source_file_id, raw_target, link_syntax, is_embed)
            VALUES (1, ?, 'wikilink', 1)
            """,
            ((target,) for target in targets),
        )
        cursor.executemany(
            """
            INSERT INTO vault_links (source_file_id, raw_target, link_syntax, is_embed)
            VALUES (1, ?, 'link', 0)
            """,
            ((target,) for target in ("markdownTarget.md", "../markdownTarget")),
        )

        indexer.resolve_vault_links(cursor, vault)

        assert cursor.execute(
            "SELECT target_file_id FROM vault_links WHERE link_syntax = 'wikilink' ORDER BY id"
        ).fetchall() == [(2,), (3,), (2,), (3,), (4,), (5,), (6,), (4,), (7,), (8,), (9,), (10,), (None,), (None,)]
        assert cursor.execute(
            "SELECT target_file_id FROM vault_links WHERE link_syntax = 'link' ORDER BY id"
        ).fetchall() == [(13,), (14,)]


def test_link_resolution_migration_marks_derived_data_dirty() -> None:
    with sqlite3.connect(":memory:") as connection:
        cursor = connection.cursor()
        cursor.execute(
            """
            CREATE TABLE vault_index_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                derived_data_dirty INTEGER NOT NULL CHECK (derived_data_dirty IN (0, 1))
            )
            """
        )
        cursor.execute("INSERT INTO vault_index_state VALUES (1, 0)")

        indexer.initialize_database(cursor)

        assert cursor.execute(
            "SELECT derived_data_dirty, link_resolution_version, tag_occurrence_version FROM vault_index_state"
        ).fetchall() == [(1, 4, 1)]


def test_tag_occurrence_migration_marks_derived_data_dirty_once() -> None:
    with sqlite3.connect(":memory:") as connection:
        cursor = connection.cursor()
        cursor.execute(
            """
            CREATE TABLE vault_index_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                derived_data_dirty INTEGER NOT NULL CHECK (derived_data_dirty IN (0, 1)),
                block_ids_version INTEGER NOT NULL DEFAULT 0,
                link_resolution_version INTEGER NOT NULL DEFAULT 0,
                tag_occurrence_version INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        cursor.execute("INSERT INTO vault_index_state VALUES (1, 0, 1, 4, 0)")

        indexer.initialize_database(cursor)

        assert cursor.execute(
            "SELECT derived_data_dirty, tag_occurrence_version FROM vault_index_state"
        ).fetchall() == [(1, 1)]

        cursor.execute("UPDATE vault_index_state SET derived_data_dirty = 0 WHERE id = 1")
        indexer.initialize_database(cursor)

        assert cursor.execute(
            "SELECT derived_data_dirty, tag_occurrence_version FROM vault_index_state"
        ).fetchall() == [(0, 1)]


def test_pipeline_parses_only_one_file_ahead(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    for index in range(100):
        (vault / f"note-{index}.md").write_text("# Note\n", encoding="utf-8")
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, tmp_path / "index.db"))
    original_parse = indexer.parse_file
    parsed_paths = []
    second_parsed = Event()

    def parse(path, parser):
        parsed = original_parse(path, parser)
        parsed_paths.append(path)
        if len(parsed_paths) == 2:
            second_parsed.set()
        return parsed

    def stop_insertion(cursor, parsed, directory_id):
        assert second_parsed.wait(timeout=5)
        assert parsed_paths[0] == parsed.path
        raise RuntimeError("stop after first file")

    monkeypatch.setattr(indexer, "parse_file", parse)
    monkeypatch.setattr(indexer, "insert_file", stop_insertion)
    with pytest.raises(RuntimeError, match="stop after first file"):
        indexer.main()
    assert len(parsed_paths) == 2


def test_pipeline_inserts_prior_files_before_reporting_parse_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    for index in range(3):
        (vault / f"note-{index}.md").write_text("# Note\n", encoding="utf-8")
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, tmp_path / "index.db"))
    original_parse = indexer.parse_file
    original_insert = indexer.insert_file
    parsed_paths = []
    inserted_paths = []

    def parse(path, parser):
        parsed_paths.append(path)
        if len(parsed_paths) == 2:
            raise RuntimeError("invalid source")
        return original_parse(path, parser)

    def insert(cursor, parsed, directory_id):
        file_id = original_insert(cursor, parsed, directory_id)
        inserted_paths.append(parsed.path)
        return file_id

    monkeypatch.setattr(indexer, "parse_file", parse)
    monkeypatch.setattr(indexer, "insert_file", insert)
    with pytest.raises(RuntimeError, match="invalid source"):
        indexer.main()
    assert len(parsed_paths) == 2
    assert inserted_paths == parsed_paths[:1]


@pytest.mark.parametrize("failure", [RuntimeError, KeyboardInterrupt])
def test_writer_failure_rolls_back_pending_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: type[BaseException]
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("# Original\n", encoding="utf-8")
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()
    with closing(sqlite3.connect(database)) as connection:
        before = list(connection.iterdump())

    note.write_text("# Changed\n\nMore content.\n", encoding="utf-8")
    (vault / "next.md").write_text("# Next\n", encoding="utf-8")

    def fail_insert(*args, **kwargs):
        raise failure("insertion failed")

    monkeypatch.setattr(indexer, "insert_markdown_nodes", fail_insert)
    if failure is KeyboardInterrupt:
        indexer.main()
    else:
        with pytest.raises(failure, match="insertion failed"):
            indexer.main()
    with closing(sqlite3.connect(database)) as connection:
        assert list(connection.iterdump()) == before




def test_pipeline_indexes_empty_frontmatter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text("---\n---\n# Note\n", encoding="utf-8")
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))

    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("SELECT COUNT(*) FROM frontmatter_nodes").fetchone() == (0,)
        assert connection.execute("SELECT COUNT(*) FROM frontmatter_errors").fetchone() == (0,)
        assert connection.execute(
            "SELECT value FROM markdown_nodes WHERE node_type = 'heading'"
        ).fetchall() == [("Note",)]


def test_pipeline_records_unterminated_frontmatter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "broken.md").write_text("---\ntags: [test]\n", encoding="utf-8")
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))

    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute(
            "SELECT error_output, raw_yaml FROM frontmatter_errors"
        ).fetchall() == [
            ("Frontmatter is missing a closing '---' delimiter.", "tags: [test]\n")
        ]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_pipeline_preserves_empty_frontmatter_property_occurrences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text(
        "---\ntags: []\ntags: []\naliases: [first, second]\n---\n", encoding="utf-8"
    )
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))

    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute(
            "SELECT key, value, raw_yaml, ordinal FROM frontmatter_nodes ORDER BY id"
        ).fetchall() == [
            ("tags", None, "[]", 0),
            ("tags", None, "[]", 1),
            ("aliases", None, "[first, second]", 2),
            (None, "first", "first", 0),
            (None, "second", "second", 1),
        ]
        assert connection.execute("SELECT name FROM vault_tags").fetchall() == []
