"""Contract tests for transactional incremental vault indexing."""

import os
import shutil
import sqlite3
from pathlib import Path

import pytest

import indexer
import tagRenamer

TABLES = (
    "vault_directories",
    "vault_files",
    "frontmatter_nodes",
    "frontmatter_errors",
    "markdown_nodes",
    "vault_tags",
    "note_tag_occurrences",
    "vault_links",
    "vault_missing_targets",
)


def run_indexer(vault: Path, database: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()


def rows(database: Path, query: str, parameters: tuple = ()) -> list[tuple]:
    with sqlite3.connect(database) as connection:
        return connection.execute(query, parameters).fetchall()


def database_snapshot(database: Path) -> dict[str, list[tuple]]:
    with sqlite3.connect(database) as connection:
        return {table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall() for table in TABLES}


def advance_mtime(path: Path, previous_mtime_ns: int) -> int:
    stat = path.stat()
    mtime_ns = previous_mtime_ns + 1
    os.utime(path, ns=(stat.st_atime_ns, mtime_ns))
    return mtime_ns


def assert_foreign_keys_are_valid(database: Path) -> None:
    assert rows(database, "PRAGMA foreign_key_check") == []


def test_first_run_indexes_directories_notes_tags_and_parent_links(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    nested = vault / "nested"
    empty = vault / "empty"
    vault.mkdir()
    nested.mkdir()
    empty.mkdir()
    (vault / "root.md").write_text("---\ntags:\n  - project/root\n---\n# Root\n", encoding="utf-8")
    (nested / "child.md").write_text("---\ntags:\n  - project/child\n---\n# Child\n", encoding="utf-8")
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    directory_rows = rows(database, "SELECT id, path, parent_id FROM vault_directories")
    directory_ids = {path: directory_id for directory_id, path, _ in directory_rows}
    directory_parents = {path: parent_id for _, path, parent_id in directory_rows}
    assert set(directory_ids) == {str(vault), str(nested), str(empty)}
    assert directory_parents[str(vault)] is None
    assert directory_parents[str(nested)] == directory_ids[str(vault)]
    assert directory_parents[str(empty)] == directory_ids[str(vault)]

    note_rows = rows(database, "SELECT path, directory_id, kind FROM vault_files")
    assert {(path, kind) for path, _, kind in note_rows} == {
        (str(vault / "root.md"), "markdown"),
        (str(nested / "child.md"), "markdown"),
    }
    assert {(path, directory_id) for path, directory_id, _ in note_rows} == {
        (str(vault / "root.md"), directory_ids[str(vault)]),
        (str(nested / "child.md"), directory_ids[str(nested)]),
    }
    assert set(rows(database, "SELECT key, value FROM frontmatter_nodes")) == {
        ("tags", None),
        (None, "project/root"),
        (None, "project/child"),
    }
    assert rows(database, "SELECT name FROM vault_tags ORDER BY name") == [
        ("project",),
        ("project/child",),
        ("project/root",),
    ]
    assert {value for (value,) in rows(database, "SELECT value FROM markdown_nodes WHERE value IS NOT NULL")} >= {
        "Root",
        "Child",
    }
    assert_foreign_keys_are_valid(database)


def test_first_run_persists_filesystem_device_and_stat_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("---\ntags: stable/tag\n---\n# Stable\n", encoding="utf-8")
    attachment = vault / "image.png"
    attachment.write_bytes(b"image")
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    for path in (note, attachment):
        stat = path.stat()
        assert rows(
            database,
            "SELECT st_dev, inode, mtime_ns FROM vault_files WHERE path = ?",
            (str(path),),
        ) == [(stat.st_dev, stat.st_ino, stat.st_mtime_ns)]


def test_matching_legacy_metadata_backfills_device_without_reindexing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("---\ntags: stable/tag\n---\n# Stable\n\n[[Missing]]\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE vault_files SET st_dev = NULL")
    before = database_snapshot(database)

    def fail_parse(self: indexer.MarkdownTreeParser, source: str) -> dict:
        raise AssertionError("matching legacy rows must be backfilled without parsing")

    monkeypatch.setattr(indexer.MarkdownTreeParser, "parse", fail_parse)
    run_indexer(vault, database, monkeypatch)

    actual = database_snapshot(database)
    expected = before["vault_files"][0]
    assert actual["vault_files"][0][:4] + (None,) + actual["vault_files"][0][5:] == expected
    assert actual["vault_files"][0][4] == note.stat().st_dev
    for table in TABLES:
        if table != "vault_files":
            assert actual[table] == before[table]


def test_unavailable_legacy_path_stat_preserves_failure_and_unknown_device(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("# Stable\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE vault_files SET st_dev = NULL")
    original_stat = Path.stat

    def fail_target_stat(path: Path, *args, **kwargs):
        if path == note:
            raise PermissionError("stat denied")
        return original_stat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", fail_target_stat)
    with pytest.raises(PermissionError, match="stat denied"):
        run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT st_dev FROM vault_files WHERE path = ?", (str(note),)) == [(None,)]


def test_legacy_device_backfill_skips_oserror(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("# Stable\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE vault_files SET st_dev = NULL")

    def fail_stat(path: Path, *args, **kwargs):
        raise PermissionError("auxiliary stat denied")

    monkeypatch.setattr(Path, "stat", fail_stat)
    with sqlite3.connect(database) as connection:
        indexer.backfill_legacy_file_devices(connection.cursor())
    assert rows(database, "SELECT st_dev FROM vault_files WHERE path = ?", (str(note),)) == [(None,)]


def test_inode_mismatch_does_not_backfill_or_reclassify_same_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("# Stable\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    actual_inode = note.stat().st_ino
    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE vault_files SET st_dev = NULL, inode = ? WHERE path = ?",
            (actual_inode + 1, str(note)),
        )

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT st_dev, inode FROM vault_files WHERE path = ?", (str(note),)) == [
        (None, actual_inode + 1)
    ]


def test_mtime_mismatch_uses_normal_reindex_and_refreshes_device(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("# Stable\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    stat = note.stat()
    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE vault_files SET st_dev = NULL, mtime_ns = ? WHERE path = ?",
            (stat.st_mtime_ns + 1, str(note)),
        )

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT st_dev, inode, mtime_ns FROM vault_files WHERE path = ?", (str(note),)) == [
        (stat.st_dev, stat.st_ino, stat.st_mtime_ns)
    ]


def test_missing_legacy_path_is_deleted_not_backfilled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text("# Stable\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    with sqlite3.connect(database) as connection:
        connection.execute("UPDATE vault_files SET st_dev = NULL")
    note.unlink()

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT path FROM vault_files") == []


def test_first_run_stores_full_file_frontmatter_line_coordinates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text(
        "---\n"
        "tags:\n"
        "  - alpha\n"
        "metadata:\n"
        "  nested:\n"
        "    - item\n"
        "description: |-\n"
        "  first\n"
        "  second\n"
        "...\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT key, start_line, end_line FROM frontmatter_nodes ORDER BY id") == [
        ("tags", 3, 4),
        (None, 3, 3),
        ("metadata", 5, 7),
        ("nested", 6, 7),
        (None, 6, 6),
        ("description", 7, 10),
    ]


def test_first_run_indexes_vault_links(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    source = vault / "source.md"
    source.write_text(
        "[[Target]]\n"
        "[[Target|Shown]]\n"
        "![[Asset.png]]\n"
        "[[Target#Section]]\n"
        "[[Target#^block-id]]\n"
        "[External](https://example.com)\n"
        "![Diagram](images/diagram.png)\n",
        encoding="utf-8",
    )
    target = vault / "Target.md"
    target.write_text("# Section\n\nTarget paragraph\n^block-id\n", encoding="utf-8")
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    assert rows(
        database,
        """
        SELECT
            source.path,
            target.path,
            link.raw_target,
            link.display_text,
            link.link_syntax,
            link.is_embed,
            target_node.node_type,
            target_node.value,
            target_node.block_id
        FROM vault_links AS link
        JOIN vault_files AS source ON source.id = link.source_file_id
        LEFT JOIN vault_files AS target ON target.id = link.target_file_id
        LEFT JOIN markdown_nodes AS target_node ON target_node.id = link.target_node_id
        ORDER BY link.id
        """,
    ) == [
        (str(source), str(target), "Target", None, "wikilink", 0, None, None, None),
        (str(source), str(target), "Target", "Shown", "wikilink", 0, None, None, None),
        (str(source), None, "Asset.png", None, "wikilink", 1, None, None, None),
        (str(source), str(target), "Target#Section", None, "wikilink", 0, "heading", "Section", None),
        (str(source), str(target), "Target#^block-id", None, "wikilink", 0, "paragraph", None, "block-id"),
        (str(source), None, "https://example.com", "External", "link", 0, None, None, None),
        (str(source), None, "images/diagram.png", "Diagram", "image", 1, None, None, None),
    ]


def test_frontmatter_links_store_source_node_id(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    source = vault / "source.md"
    source.write_text('---\nrelated:\n  - "[[Target]]"\n---\n# Source\n', encoding="utf-8")
    (vault / "Target.md").write_text("# Target\n", encoding="utf-8")
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    assert rows(
        database,
        """
        SELECT
            link.raw_target,
            link.source_markdown_node_id,
            link.source_frontmatter_node_id,
            frontmatter.value
        FROM vault_links AS link
        LEFT JOIN frontmatter_nodes AS frontmatter
            ON frontmatter.id = link.source_frontmatter_node_id
        """,
    ) == [("Target", None, 2, "[[Target]]")]


def test_block_reference_resolves_after_astral_unicode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "source.md").write_text("[[target#^block-id]]\n", encoding="utf-8")
    (vault / "target.md").write_text(
        "🚀" * 40 + "\n\nTarget paragraph\n^block-id\n", encoding="utf-8"
    )
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    assert rows(
        database,
        """
        SELECT target_node.start_line, target_node.block_id
        FROM vault_links AS link
        JOIN markdown_nodes AS target_node ON target_node.id = link.target_node_id
        """,
    ) == [(3, "block-id")]


def test_first_run_populates_vault_tags_from_frontmatter_and_inline_tags(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text(
        "---\n"
        "tag: project/singular\n"
        "tags:\n"
        "  - project/list\n"
        "  - shared/tag\n"
        "---\n"
        "\n"
        "Inline #inline/tag and #shared/tag.\n",
        encoding="utf-8",
    )
    other_note = vault / "other.md"
    other_note.write_text(
        "---\n"
        "tags:\n"
        "  - shared/tag\n"
        "---\n"
        "\n"
        "Inline #shared/tag and #inline/tag.\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT name FROM vault_tags ORDER BY name") == [
        ("inline",),
        ("inline/tag",),
        ("project",),
        ("project/list",),
        ("project/singular",),
        ("shared",),
        ("shared/tag",),
    ]
    assert rows(
        database,
        """
        SELECT
            note.path,
            tag.name,
            occurrence.frontmatter_node_id IS NOT NULL,
            occurrence.markdown_node_id IS NOT NULL
        FROM note_tag_occurrences AS occurrence
        LEFT JOIN frontmatter_nodes AS frontmatter
            ON frontmatter.id = occurrence.frontmatter_node_id
        LEFT JOIN markdown_nodes AS markdown
            ON markdown.id = occurrence.markdown_node_id
        JOIN vault_files AS note
            ON note.id = COALESCE(frontmatter.file_id, markdown.file_id)
        JOIN vault_tags AS tag ON tag.id = occurrence.tag_id
        ORDER BY note.path, occurrence.id
        """,
    ) == [
        (str(note), "project/singular", 1, 0),
        (str(note), "project/list", 1, 0),
        (str(note), "shared/tag", 1, 0),
        (str(note), "inline/tag", 0, 1),
        (str(note), "shared/tag", 0, 1),
        (str(other_note), "shared/tag", 1, 0),
        (str(other_note), "shared/tag", 0, 1),
        (str(other_note), "inline/tag", 0, 1),
    ]
    shared_tag_id = rows(
        database,
        "SELECT id FROM vault_tags WHERE name = ?",
        ("shared/tag",),
    )[0][0]
    occurrences = tagRenamer.fetch_tag_occurrences(database, shared_tag_id)
    assert [
        (path, source, line)
        for _, _, path, source, _, line in occurrences
    ] == [
        (str(note), "yaml", 5),
        (str(note), "inline", 8),
        (str(other_note), "yaml", 3),
        (str(other_note), "inline", 6),
    ]



def test_empty_vault_links_table_is_backfilled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source_vault = Path(__file__).resolve().parents[1] / "testVault"
    vault = tmp_path / "testVault"
    shutil.copytree(source_vault, vault)
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    with sqlite3.connect(database) as connection:
        connection.execute("DELETE FROM vault_links")

    run_indexer(vault, database, monkeypatch)

    assert rows(
        database,
        """
        SELECT source.path, link.raw_target, link.link_syntax
        FROM vault_links AS link
        JOIN vault_files AS source ON source.id = link.source_file_id
        ORDER BY link.id
        """,
    ) == [
        (str(vault / "note8.md"), "link", "wikilink"),
        (str(vault / "note8.md"), "link", "wikilink"),
    ]


def test_unchanged_rerun_does_not_parse_or_change_rows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text("---\ntags: stable/tag\n---\n# Stable\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)
    before = database_snapshot(database)

    def fail_parse(self: indexer.MarkdownTreeParser, source: str) -> dict:
        raise AssertionError("the parser must not run for an unchanged note")

    monkeypatch.setattr(indexer.MarkdownTreeParser, "parse", fail_parse)
    run_indexer(vault, database, monkeypatch)

    assert database_snapshot(database) == before
    assert_foreign_keys_are_valid(database)


def test_interrupted_batch_resumes_and_rebuilds_derived_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    for index in range(indexer.INDEX_BATCH_SIZE + 1):
        (vault / f"note-{index}.md").write_text(
            "---\ntags: batch/resume\n---\n# Note\n",
            encoding="utf-8",
        )
    database = tmp_path / "index.db"
    original_parse_file = indexer.parse_file
    parsed_files = 0

    def interrupt_after_first_batch(
        path: Path, markdown_parser: indexer.MarkdownTreeParser
    ) -> indexer.ParsedFile:
        nonlocal parsed_files
        parsed_files += 1
        if parsed_files > indexer.INDEX_BATCH_SIZE:
            raise KeyboardInterrupt
        return original_parse_file(path, markdown_parser)

    with monkeypatch.context() as interrupted_run:
        interrupted_run.setattr(indexer, "parse_file", interrupt_after_first_batch)
        run_indexer(vault, database, interrupted_run)

    assert rows(database, "SELECT COUNT(*) FROM vault_files") == [(indexer.INDEX_BATCH_SIZE,)]
    assert rows(database, "SELECT derived_data_dirty FROM vault_index_state") == [(1,)]

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT COUNT(*) FROM vault_files") == [(indexer.INDEX_BATCH_SIZE + 1,)]
    assert rows(database, "SELECT derived_data_dirty FROM vault_index_state") == [(0,)]
    assert rows(database, "SELECT name FROM vault_tags") == [("batch",), ("batch/resume",)]
    assert rows(database, "SELECT COUNT(*) FROM note_tag_occurrences") == [(indexer.INDEX_BATCH_SIZE + 1,)]
    assert_foreign_keys_are_valid(database)


def test_incremental_changes_reparse_delete_and_prune_derived_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    nested = vault / "nested"
    empty = vault / "empty"
    vault.mkdir()
    nested.mkdir()
    empty.mkdir()
    root = vault / "root.md"
    old = nested / "old.md"
    root.write_text("---\ntags: legacy/root\n---\n# Old Root\n\n[[Legacy]]\n", encoding="utf-8")
    old.write_text("---\ntags: legacy/nested\n---\n# Old Nested\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)

    root_id, root_mtime = rows(database, "SELECT id, mtime_ns FROM vault_files WHERE path = ?", (str(root),))[0]
    root.write_text("---\ntags: current/root\n---\n# New Root\n\n[[Current]]\n", encoding="utf-8")
    advance_mtime(root, root_mtime)
    old.unlink()
    new = nested / "new.md"
    new.write_text("---\ntags: current/nested\n---\n# New Nested\n", encoding="utf-8")
    added_empty = vault / "added-empty"
    added_empty.mkdir()

    run_indexer(vault, database, monkeypatch)

    assert rows(database, "SELECT id FROM vault_files WHERE path = ?", (str(root),)) == [(root_id,)]
    assert rows(database, "SELECT path FROM vault_files ORDER BY path") == [(str(new),), (str(root),)]
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(added_empty),)) == [
        (str(added_empty),)
    ]
    root_values = {
        value for (value,) in rows(database, "SELECT value FROM markdown_nodes WHERE file_id = ?", (root_id,))
    }
    assert "New Root" in root_values
    assert "Old Root" not in root_values
    assert rows(database, "SELECT value FROM frontmatter_nodes WHERE file_id = ?", (root_id,)) == [("current/root",)]
    assert rows(database, "SELECT name FROM vault_tags ORDER BY name") == [
        ("current",),
        ("current/nested",),
        ("current/root",),
    ]
    assert rows(
        database,
        """
        SELECT
            note.path,
            tag.name,
            occurrence.frontmatter_node_id IS NOT NULL,
            occurrence.markdown_node_id IS NOT NULL
        FROM note_tag_occurrences AS occurrence
        LEFT JOIN frontmatter_nodes AS frontmatter
            ON frontmatter.id = occurrence.frontmatter_node_id
        LEFT JOIN markdown_nodes AS markdown
            ON markdown.id = occurrence.markdown_node_id
        JOIN vault_files AS note
            ON note.id = COALESCE(frontmatter.file_id, markdown.file_id)
        JOIN vault_tags AS tag ON tag.id = occurrence.tag_id
        ORDER BY note.path, tag.name
        """,
    ) == [
        (str(new), "current/nested", 1, 0),
        (str(root), "current/root", 1, 0),
    ]
    assert rows(
        database,
        """
        SELECT source.path, link.raw_target
        FROM vault_links AS link
        JOIN vault_files AS source ON source.id = link.source_file_id
        """,
    ) == [(str(root), "Current")]


    assert rows(database, "SELECT file_id FROM frontmatter_nodes WHERE value LIKE 'legacy/%'") == []
    assert rows(database, "SELECT file_id FROM markdown_nodes WHERE value IN ('Old Root', 'Old Nested')") == []

    shutil.rmtree(added_empty)
    run_indexer(vault, database, monkeypatch)
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(added_empty),)) == []
    assert_foreign_keys_are_valid(database)


def test_directory_rename_and_delete_remove_old_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    old_directory = vault / "old-dir"
    vault.mkdir()
    old_directory.mkdir()
    old_note = old_directory / "note.md"
    old_note.write_text("# Renamed\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)

    new_directory = vault / "new-dir"
    old_directory.rename(new_directory)
    run_indexer(vault, database, monkeypatch)
    new_note = new_directory / "note.md"
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(old_directory),)) == []
    assert rows(database, "SELECT path FROM vault_files WHERE path = ?", (str(old_note),)) == []
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(new_directory),)) == [
        (str(new_directory),)
    ]
    assert rows(database, "SELECT path FROM vault_files WHERE path = ?", (str(new_note),)) == [(str(new_note),)]

    shutil.rmtree(new_directory)
    run_indexer(vault, database, monkeypatch)
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(new_directory),)) == []
    assert rows(database, "SELECT path FROM vault_files WHERE path = ?", (str(new_note),)) == []
    assert_foreign_keys_are_valid(database)


def test_file_and_folder_replacement_reconciles_same_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    swap = vault / "swap.md"
    swap.write_text("# File\n", encoding="utf-8")
    database = tmp_path / "index.db"
    run_indexer(vault, database, monkeypatch)

    swap.unlink()
    swap.mkdir()
    child = swap / "child.md"
    child.write_text("# Folder\n", encoding="utf-8")
    run_indexer(vault, database, monkeypatch)
    assert rows(database, "SELECT path FROM vault_files WHERE path = ?", (str(swap),)) == []
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(swap),)) == [(str(swap),)]
    assert rows(database, "SELECT path FROM vault_files WHERE path = ?", (str(child),)) == [(str(child),)]

    child.unlink()
    swap.rmdir()
    swap.write_text("# File again\n", encoding="utf-8")
    run_indexer(vault, database, monkeypatch)
    assert rows(database, "SELECT path FROM vault_directories WHERE path = ?", (str(swap),)) == []
    assert rows(database, "SELECT path FROM vault_files WHERE path = ?", (str(swap),)) == [(str(swap),)]
    assert_foreign_keys_are_valid(database)
