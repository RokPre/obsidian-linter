"""Correctness checks for Markdown indexing and validation integration."""
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

import indexer
from healthChecker import (
    ValidationWarning,
    find_code_blocks_without_language,
    find_missing_frontmatter_properties,
    find_obsidian_callouts,
    find_tags_containing_hash,
)


def test_pipeline_preserves_yaml_errors_and_nonmarkdown_file_kinds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "broken.md").write_text("---\ntags: [unfinished\n---\n# Still Markdown\n", encoding="utf-8")
    (vault / "image.PNG").write_bytes(b"\xff\x00")
    (vault / "drawing.excalidraw.md").write_bytes(b"\xff\x00")
    (vault / "note.MD").write_text("# Café\n", encoding="utf-8")
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("SELECT name, kind FROM vault_files ORDER BY name").fetchall() == [
            ("broken", "markdown"), ("drawing.excalidraw", "excalidraw"), ("image", "image"), ("note", "markdown")
        ]
        assert connection.execute(
            "SELECT note.name, error.raw_yaml FROM frontmatter_errors AS error "
            "JOIN vault_files AS note ON note.id = error.file_id"
        ).fetchall() == [("broken", "tags: [unfinished\n")]
        assert connection.execute(
            "SELECT COUNT(*) FROM frontmatter_nodes AS node "
            "JOIN vault_files AS note ON note.id = node.file_id "
            "WHERE note.name = 'broken'"
        ).fetchone() == (0,)
        assert not any(
            warning.path == str(vault / "broken.md")
            for warning in find_missing_frontmatter_properties(connection)
        )
        assert connection.execute(
            "SELECT value FROM markdown_nodes WHERE node_type = 'heading' ORDER BY value"
        ).fetchall() == [("Café",), ("Still Markdown",)]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_pipeline_marks_fenced_code_and_excludes_indented_code_from_language_warnings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text(
        "```\n"
        "backtick\n"
        "```\n\n"
        "~~~\n"
        "tilde\n"
        "~~~\n\n"
        "```python\n"
        "labeled\n"
        "```\n\n"
        "    indented\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute(
            """
            SELECT start_line,
                   json_extract(attributes_json, '$.fenced'),
                   json_extract(attributes_json, '$.lang')
            FROM markdown_nodes
            WHERE node_type = 'code'
            ORDER BY start_line
            """
        ).fetchall() == [
            (1, 1, None),
            (5, 1, None),
            (9, 1, "python"),
            (13, 0, None),
        ]
        assert find_code_blocks_without_language(connection) == [
            ValidationWarning(
                rule="codeBlockMissingLanguage",
                path=str(vault / "note.md"),
                message="Fenced code blocks must specify a language.",
                line=line,
            )
            for line in (1, 5)
        ]


def test_pipeline_indexes_callout_provenance_and_warns_only_for_real_callouts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text(
        "---\n"
        "title: Example\n"
        "---\n"
        "> [!NOTE|Metadata]\n"
        "> body\n\n"
        "> \\[!TIP]\n"
        "> literal\n\n"
        "- > [!WARNING]\n"
        "  > body\n\n"
        "> > [!INFO]\n"
        "> > nested\n\n"
        "> ordinary\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute(
            """
            SELECT start_line, json_extract(attributes_json, '$.callout')
            FROM markdown_nodes
            WHERE node_type = 'blockquote'
            ORDER BY start_line, id
            """
        ).fetchall() == [(4, 1), (7, 0), (10, 1), (13, 0), (13, 1), (16, 0)]
        assert find_obsidian_callouts(connection) == [
            ValidationWarning(
                rule="obsidianCallout",
                path=str(vault / "note.md"),
                message="Obsidian callouts must not be used.",
                line=line,
            )
            for line in (4, 10, 13)
        ]


def test_pipeline_indexes_inline_block_and_comment_as_html_nodes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text(
        "# Note\n\nInline <span>text</span>.\n\n<div>\nblock\n</div>\n\n<!-- comment -->\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute(
            "SELECT start_line, value FROM markdown_nodes "
            "WHERE node_type = 'html' ORDER BY id"
        ).fetchall() == [
            (3, "<span>"),
            (3, "</span>"),
            (5, "<div>\nblock\n</div>"),
            (9, "<!-- comment -->"),
        ]


def test_indexer_normalizes_extension_casing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    (vault / "a").mkdir(parents=True)
    (vault / "b").mkdir()
    (vault / "a" / "foo.md").write_text("# Lower\n", encoding="utf-8")
    (vault / "b" / "foo.MD").write_text("# Upper\n", encoding="utf-8")
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute(
            "SELECT path, name, extension FROM vault_files WHERE kind = 'markdown' ORDER BY path"
        ).fetchall() == [
            (str(vault / "a" / "foo.md"), "foo", ".md"),
            (str(vault / "b" / "foo.MD"), "foo", ".md"),
        ]


def test_indexer_preserves_frontmatter_hash_and_strips_inline_tag_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    note = vault / "note.md"
    note.write_text(
        "---\n"
        "tags:\n"
        '  - "#bad"\n'
        "---\n"
        "# Note\n\n"
        "Inline #good/tag\n",
        encoding="utf-8",
    )
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("SELECT name FROM vault_tags ORDER BY name").fetchall() == [
            ("#bad",),
            ("good",),
            ("good/tag",),
        ]
        assert connection.execute(
            "SELECT value FROM markdown_nodes WHERE node_type = 'tag'"
        ).fetchall() == [("good/tag",)]
        assert find_tags_containing_hash(connection) == [
            ValidationWarning(
                rule="tagContainsHash",
                path=str(note),
                message='Tag `#bad` must not contain "#".',
            )
        ]
