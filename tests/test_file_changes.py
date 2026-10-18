"""Tests for vault change detection."""

import os
import shutil
import sqlite3
from pathlib import Path

import indexer


def test_find_changes_reports_created_modified_and_deleted_files(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    unchanged = vault / "unchanged.md"
    modified = vault / "modified.md"
    created = vault / "created.md"
    deleted = vault / "deleted.md"
    unchanged.write_text("# Unchanged\n", encoding="utf-8")
    modified.write_text("# Modified\n", encoding="utf-8")
    created.write_text("# Created\n", encoding="utf-8")

    with sqlite3.connect(tmp_path / "index.db") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute(
            "INSERT INTO vault_directories (path, inode, parent_id) VALUES (?, ?, ?)",
            (str(vault), vault.stat().st_ino, None),
        )
        directory_id = cursor.lastrowid
        cursor.executemany(
            """
            INSERT INTO vault_files (directory_id, path, name, inode, mtime_ns, extension, kind)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    directory_id,
                    str(unchanged),
                    unchanged.stem,
                    unchanged.stat().st_ino,
                    unchanged.stat().st_mtime_ns,
                    ".md",
                    "markdown",
                ),
                (
                    directory_id,
                    str(modified),
                    modified.stem,
                    modified.stat().st_ino,
                    modified.stat().st_mtime_ns - 1,
                    ".md",
                    "markdown",
                ),
                (directory_id, str(deleted), deleted.stem, 0, 0, ".md", "markdown"),
            ],
        )

        directory_changes, file_changes = indexer.find_changes(cursor, vault)

    assert directory_changes == []
    assert sorted(file_changes) == sorted([
        ("created", str(created)),
        ("modified", str(modified)),
        ("deleted", str(deleted)),
    ])


def test_find_changes_reports_all_paths_created_without_index(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "new.md"
    note.write_text("# New\n", encoding="utf-8")

    with sqlite3.connect(tmp_path / "index.db") as connection:
        directory_changes, file_changes = indexer.find_changes(connection.cursor(), vault)

    assert directory_changes == [("created", str(vault))]
    assert file_changes == [("created", str(note))]


def test_find_changes_reports_fixture_file_changes(tmp_path: Path, monkeypatch) -> None:
    source_vault = Path(__file__).resolve().parents[1] / "testVault"
    vault = tmp_path / "testVault"
    shutil.copytree(source_vault, vault)
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    modified = vault / "note1.md"
    deleted = vault / "note2.md"
    created = vault / "created.md"
    with sqlite3.connect(database) as connection:
        stored_mtimes = dict(
            connection.execute(
                "SELECT path, mtime_ns FROM vault_files WHERE path IN (?, ?)", (str(modified), str(deleted))
            )
        )

    modified.write_text("# Modified\n", encoding="utf-8")
    os.utime(modified, ns=(modified.stat().st_atime_ns, stored_mtimes[str(modified)] + 1))
    deleted.unlink()
    created.write_text("# Created\n", encoding="utf-8")

    with sqlite3.connect(database) as connection:
        _, file_changes = indexer.find_changes(connection.cursor(), vault)

    assert sorted(file_changes) == sorted([
        ("created", str(created)),
        ("modified", str(modified)),
        ("deleted", str(deleted)),
    ])
