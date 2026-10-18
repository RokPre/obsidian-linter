"""Regression coverage for atomic rebuilds and the Markdown parser command."""

import json
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path

import pytest

import indexer

from markdown_tree_parser import MarkdownTreeParser

@pytest.fixture
def indexed_vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "original.md").write_text("---\ntags: original/note\n---\n# Original\n", encoding="utf-8")
    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()
    return vault, database


@pytest.mark.parametrize("failure", [RuntimeError, KeyboardInterrupt])
def test_failed_rebuild_preserves_previous_index(
    indexed_vault: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch, failure: type[BaseException]
) -> None:
    vault, database = indexed_vault
    with closing(sqlite3.connect(database)) as connection:
        previous_index = list(connection.iterdump())

    (vault / "original.md").write_text("---\ntags: changed\n---\n# Changed\n", encoding="utf-8")

    def fail_parse(self: indexer.MarkdownTreeParser, source: str) -> dict:
        raise failure("Injected parser failure")

    monkeypatch.setattr(indexer.MarkdownTreeParser, "parse", fail_parse)
    if failure is KeyboardInterrupt:
        indexer.main()
    else:
        with pytest.raises(failure, match="Injected parser failure"):
            indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert list(connection.iterdump()) == previous_index


def test_successful_rebuild_replaces_previous_index(indexed_vault: tuple[Path, Path]) -> None:
    vault, database = indexed_vault
    (vault / "original.md").unlink()
    replacement = vault / "replacement.md"
    replacement.write_text("---\ntags: replacement/note\n---\n# Replacement\n", encoding="utf-8")

    indexer.main()

    with closing(sqlite3.connect(database)) as connection:
        assert connection.execute("SELECT path FROM vault_files").fetchall() == [(str(replacement),)]
        assert connection.execute("SELECT key, value FROM frontmatter_nodes").fetchall() == [
            ("tags", "replacement/note")
        ]
        assert connection.execute("SELECT value FROM markdown_nodes WHERE node_type = 'text'").fetchall() == [
            ("Replacement",)
        ]
        assert connection.execute("SELECT name FROM vault_tags ORDER BY name").fetchall() == [
            ("replacement",),
            ("replacement/note",),
        ]
        assert connection.execute("PRAGMA foreign_key_check").fetchall() == []


def test_markdown_tree_parser_command_prints_ast(tmp_path: Path) -> None:
    note = tmp_path / "note.md"
    note.write_text("---\ntitle: Example\n---\n# Café\n", encoding="utf-8")
    command = Path(__file__).resolve().parents[1] / "markdown_tree_parser.py"

    result = subprocess.run(
        [sys.executable, str(command), str(note)],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=10,
        check=True,
    )

    tree = json.loads(result.stdout)
    assert tree["type"] == "root"
    heading = tree["children"][0]
    assert heading["type"] == "heading"
    assert heading["depth"] == 1
    assert heading["children"][0]["value"] == "Café"
    assert heading["position"]["start"]["line"] == 4


def test_markdown_parser_marks_real_callouts_and_preserves_positions(tmp_path: Path) -> None:
    source = (
        "---\n"
        "title: Example\n"
        "---\n"
        "> [!NOTE]\n"
        "> body\n\n"
        "> \\[!TIP]\n"
        "> literal\n\n"
        "- > [!WARNING]\n"
        "  > body\n\n"
        "> > [!INFO]\n"
        "> > nested\n"
    )
    parser = MarkdownTreeParser()
    try:
        tree = parser.parse(source)
    finally:
        parser.close()

    blockquotes: list[dict] = []

    def collect(node: dict) -> None:
        if node["type"] == "blockquote":
            blockquotes.append(node)
        for child in node.get("children", []):
            collect(child)

    collect(tree)
    assert blockquotes[0]["position"]["start"]["offset"] == 23
    assert [(node["position"]["start"]["line"], node["callout"]) for node in blockquotes] == [
        (4, True),
        (7, False),
        (10, True),
        (13, False),
        (13, True),
    ]


def test_markdown_parser_marks_callouts_with_unspaced_and_collapsed_titles() -> None:
    parser = MarkdownTreeParser()
    try:
        tree = parser.parse("> [!NOTE]Title\n> body\n\n> [!TIP]-Title\n> body\n")
    finally:
        parser.close()

    blockquotes = [node for node in tree["children"] if node["type"] == "blockquote"]
    assert [node["callout"] for node in blockquotes] == [True, True]


def test_markdown_parser_marks_callout_with_setext_body() -> None:
    parser = MarkdownTreeParser()
    try:
        tree = parser.parse("> [!NOTE]\n> ---\n")
    finally:
        parser.close()

    blockquote = tree["children"][0]
    assert blockquote["children"][0]["type"] == "heading"
    assert blockquote["children"][0]["depth"] == 2
    assert blockquote["callout"] is True


def test_markdown_parser_marks_callout_with_depth_one_setext_body() -> None:
    parser = MarkdownTreeParser()
    try:
        tree = parser.parse("> [!NOTE]\n> ===\n")
    finally:
        parser.close()

    blockquote = tree["children"][0]
    assert blockquote["children"][0]["type"] == "heading"
    assert blockquote["children"][0]["depth"] == 1
    assert blockquote["callout"] is True


def test_markdown_parser_does_not_mark_indented_code_as_callout() -> None:
    parser = MarkdownTreeParser()
    try:
        tree = parser.parse(">     [!NOTE]\n>     body\n")
    finally:
        parser.close()

    blockquote = tree["children"][0]
    assert blockquote["type"] == "blockquote"
    assert blockquote["children"][0]["type"] == "code"
    assert blockquote["callout"] is False
