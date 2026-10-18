"""Behavioral checks for unresolved local links as graph nodes."""

import sqlite3
from pathlib import Path

import pytest

import indexer


def run_indexer(vault: Path, database: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()


def test_missing_link_is_a_shared_graph_node_and_resolves_later(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "source.md").write_text(
        "[[Future Concept]]\n[[Future Concept#Section]]\n![[Missing Image.png]]\n[web](https://example.com)\n",
        encoding="utf-8",
    )
    (vault / "other.md").write_text("[[Future Concept]]\n", encoding="utf-8")
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT target_type, target FROM vault_missing_targets ORDER BY target_type, target"
        ).fetchall() == [
            ("name", "Future Concept"),
            ("name", "Missing Image.png"),
        ]
        assert connection.execute(
            "SELECT COUNT(*), COUNT(DISTINCT missing_target_id) "
            "FROM vault_links WHERE missing_target_id IS NOT NULL"
        ).fetchone() == (4, 2)
        assert connection.execute(
            "SELECT resolution_status, COUNT(*) FROM vault_links "
            "GROUP BY resolution_status ORDER BY resolution_status"
        ).fetchall() == [("external", 1), ("missing", 4)]

    (vault / "Future Concept.md").write_text("# Section\n", encoding="utf-8")
    run_indexer(vault, database, monkeypatch)

    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT target_type, target FROM vault_missing_targets"
        ).fetchall() == [("name", "Missing Image.png")]
        assert connection.execute(
            "SELECT resolution_status, COUNT(*) FROM vault_links GROUP BY resolution_status"
        ).fetchall() == [("external", 1), ("missing", 1), ("resolved", 3)]
        assert connection.execute(
            "SELECT COUNT(*) FROM vault_links WHERE source_markdown_node_id IS NOT NULL"
        ).fetchone() == (5,)
        assert connection.execute(
            """
            SELECT COUNT(*)
            FROM vault_links
            WHERE raw_target LIKE 'Future Concept%' AND target_file_id IS NOT NULL
            """
        ).fetchone() == (3,)
        assert connection.execute(
            """
            SELECT COUNT(*)
            FROM vault_links AS link
            JOIN markdown_nodes AS node ON node.id = link.target_node_id
            WHERE link.raw_target = 'Future Concept#Section' AND node.value = 'Section'
            """
        ).fetchone() == (1,)



def test_nested_heading_links_resolve_heading_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "source.md").write_text(
        "[[target#Parent/Child]]\n"
        "[[target#Parent/Child/Grandchild]]\n"
        "[[target#Parent#Child#Grandchild]]\n"
        "[[target#Literal / Heading]]\n"
        "[[target#Parent/Missing]]\n",
        encoding="utf-8",
    )
    (vault / "target.md").write_text(
        "# Parent\n"
        "## Child\n"
        "### Grandchild\n"
        "## Literal / Heading\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    with sqlite3.connect(database) as connection:
        assert connection.execute(
            """
            SELECT link.raw_target, link.resolution_status, node.value
            FROM vault_links AS link
            LEFT JOIN markdown_nodes AS node ON node.id = link.target_node_id
            ORDER BY link.id
            """
        ).fetchall() == [
            ("target#Parent/Child", "resolved", "Child"),
            ("target#Parent/Child/Grandchild", "resolved", "Grandchild"),
            ("target#Parent#Child#Grandchild", "resolved", "Grandchild"),
            ("target#Literal / Heading", "resolved", "Literal / Heading"),
            ("target#Parent/Missing", "missing_fragment", None),
        ]
        assert connection.execute(
            """
            SELECT target_type,
                   target,
                   target_file.path
            FROM vault_missing_targets
            LEFT JOIN vault_files AS target_file
              ON target_file.id = vault_missing_targets.target_file_id
            """
        ).fetchall() == [("heading", "Parent/Missing", str(vault / "target.md"))]

def test_link_states_preserve_ambiguity_fragments_and_image_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    (vault / "one").mkdir(parents=True)
    (vault / "two").mkdir()
    (vault / "source.md").write_text(
        "[[Foo]]\n[[Existing#Missing Heading]]\n[[Existing#^missing-block]]\n"
        "[missing](assets/missing.png)\n![missing](assets/missing.png)\n"
        "![external](https://example.com/a.png)\n[ftp](ftp://example.com/a.png)\n",
    )
    (vault / "one" / "Foo.md").write_text("# Foo\n", encoding="utf-8")
    (vault / "two" / "Foo.md").write_text("# Foo\n", encoding="utf-8")
    (vault / "Existing.md").write_text("# Existing\n", encoding="utf-8")
    database = tmp_path / "index.db"

    run_indexer(vault, database, monkeypatch)

    with sqlite3.connect(database) as connection:
        assert connection.execute(
            "SELECT resolution_status, COUNT(*) FROM vault_links GROUP BY resolution_status "
            "ORDER BY resolution_status"
        ).fetchall() == [("ambiguous", 1), ("external", 2), ("missing", 2), ("missing_fragment", 2)]
        assert connection.execute(
            """
            SELECT target_type,
                   target,
                   target_file.path
            FROM vault_missing_targets
            LEFT JOIN vault_files AS target_file
              ON target_file.id = vault_missing_targets.target_file_id
            ORDER BY target_type, target
            """
        ).fetchall() == [
            ("block", "missing-block", str(vault / "Existing.md")),
            ("heading", "Missing Heading", str(vault / "Existing.md")),
            ("path", "assets/missing.png", None),
        ]
        assert connection.execute(
            "SELECT COUNT(*) FROM vault_links WHERE link_syntax = 'image' AND resolution_status = 'missing'"
        ).fetchone() == (1,)


def test_existing_database_adds_link_columns_before_missing_target_index() -> None:
    with sqlite3.connect(":memory:") as connection:
        connection.execute(
            """
            CREATE TABLE vault_links (
                id INTEGER PRIMARY KEY,
                source_file_id INTEGER NOT NULL,
                target_file_id INTEGER,
                raw_target TEXT NOT NULL,
                display_text TEXT,
                link_syntax TEXT NOT NULL,
                is_embed INTEGER NOT NULL
            )
            """
        )
        indexer.initialize_database(connection.cursor())

        columns = {row[1] for row in connection.execute("PRAGMA table_info(vault_links)")}
        indexes = {row[1] for row in connection.execute("PRAGMA index_list(vault_links)")}
        missing_target_indexes = {
            row[1] for row in connection.execute("PRAGMA index_list(vault_missing_targets)")
        }
        foreign_keys = {
            row[3]: row[6] for row in connection.execute("PRAGMA foreign_key_list(vault_links)")
        }
        connection.execute(
            "INSERT INTO vault_missing_targets (target_type, target) VALUES ('name', 'Foo')"
        )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                "INSERT INTO vault_missing_targets (target_type, target) VALUES ('name', 'Foo')"
            )

    assert {
        "source_markdown_node_id",
        "source_frontmatter_node_id",
        "missing_target_id",
        "resolution_status",
    } <= columns
    assert "vault_links_missing_target_idx" in indexes
    assert {
        "vault_missing_targets_without_file_idx",
        "vault_missing_targets_with_file_idx",
    } <= missing_target_indexes
    assert foreign_keys["source_markdown_node_id"] == "CASCADE"
    assert foreign_keys["source_frontmatter_node_id"] == "CASCADE"


def test_positionless_link_nodes_are_indexed_without_source_node_id() -> None:
    with sqlite3.connect(":memory:") as connection:
        cursor = connection.cursor()
        indexer.initialize_database(cursor)
        cursor.execute("INSERT INTO vault_directories (id, path, inode) VALUES (1, '/vault', 1)")
        cursor.execute(
            """
            INSERT INTO vault_files (id, directory_id, path, name, inode, mtime_ns, extension, kind)
            VALUES (1, 1, '/vault/source.md', 'source', 1, 0, '.md', 'markdown')
            """
        )
        indexer.insert_vault_links(
            cursor,
            1,
            {
                "type": "root",
                "children": [
                    {
                        "type": "wikilink",
                        "path": "Future",
                        "heading": None,
                        "alias": None,
                        "embedded": False,
                    }
                ],
            },
        )

        assert cursor.execute(
            "SELECT raw_target, source_markdown_node_id, source_frontmatter_node_id, resolution_status "
            "FROM vault_links"
        ).fetchall() == [("Future", None, None, "missing")]
