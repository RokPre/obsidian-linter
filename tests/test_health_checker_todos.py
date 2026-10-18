"""Behavioral coverage for the health checker TODO validators."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

import healthChecker
import indexer


@pytest.fixture
def indexed_todo_vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> sqlite3.Connection:
    vault = tmp_path / "vault"
    for relative_path in (
        "health/exercises",
        "attachments/images/exercises",
        "attachments/images",
        "attachments/imageDescriptions",
        "attachments/pdfs",
        "empty",
        "bad",
        "folder",
    ):
        (vault / relative_path).mkdir(parents=True, exist_ok=True)

    def write(relative_path: str, content: str) -> None:
        path = vault / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def binary(relative_path: str) -> None:
        path = vault / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"image")

    write("Target.md", "# Target\n\n## Section\n\nTarget text\n^block-id\n")
    write("folder/Target.md", "# Target\n")
    write(
        "source.md",
        "# Source\n\n"
        "![[Target#Missing]]\n"
        "![[Target#^missing-block]]\n"
        "![Local](pic.png)\n"
        "![[pic.png]]\n"
        "[[folder/Target]]\n",
    )
    write(
        "health/exercises/good.md",
        "---\n"
        "exerciseType: strength\n"
        "related:\n"
        "  - \"[[Target]]\"\n"
        "---\n"
        "# Good\n\n"
        "![[pic.png]]\n",
    )
    write("outsideExercise.md", "---\nexerciseType: strength\n---\n# Outside\n")
    write("outsideDescription.md", '---\nimage: "[[pic.png]]"\n---\n# Outside\n')
    write(
        "attachments/imageDescriptions/noSource.md",
        '---\nimage: "[[noSource.png]]"\n---\n# No source\n',
    )
    write(
        "attachments/imageDescriptions/wrongName.md",
        '---\nimage: "[[matching.png]]"\n---\n# Wrong name\n\n[^source]: Original source\n',
    )
    write(
        "attachments/imageDescriptions/missingImage.md",
        '---\nimage: "[[missing.png]]"\n---\n# Missing image\n',
    )
    write(
        "syntax.md",
        r"""Paragraph before heading

# First

## Jump

#### Too deep

# Second

## **Formatted**

## Empty section

> quote

[^unused]: Author, Title
Text between footnote definitions.


[^source]: Author, Title

[^pdf]: [[attachments/pdfs/source.pdf]]

[^web]: Author, Title. https://example.com

[^missing-reference]

\begin{bmatrix} a & b \\ c & d \end{bmatrix}

$$
\begin{matrix} a
$$

| A |
| --- |
| [[Target|one]] |

```python
x
""",
    )
    write("unquotedColon.md", "---\ncitation: foo:bar\n---\n# Citation\n")
    write("unquotedLink.md", "---\nrelated: [[Target]]\n---\n# Link\n")
    binary("pic.png")
    binary("attachments/images/orphan.png")
    binary("attachments/images/noSource.png")
    binary("attachments/images/matching.png")
    binary("attachments/images/exercises/orphanExercise.gif")
    binary("attachments/pdfs/source.pdf")
    (vault / "bad" / "script.py").write_text("print(1)\n", encoding="utf-8")
    (vault / "emptyFile.txt").write_text("", encoding="utf-8")

    database = tmp_path / "index.db"
    monkeypatch.setattr(indexer, "parse_args", lambda: (vault, database))
    indexer.main()
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    yield connection
    connection.close()


def rules(warnings: list[healthChecker.ValidationWarning]) -> set[str]:
    return {warning.rule for warning in warnings}


def test_d1_embeds_and_storage_rules(indexed_todo_vault: sqlite3.Connection) -> None:
    assert rules(healthChecker.find_missing_embedded_block_references(indexed_todo_vault)) == {
        "embeddedBlockReferenceMissing"
    }
    assert rules(healthChecker.find_missing_embedded_heading_references(indexed_todo_vault)) == {
        "embeddedHeadingReferenceMissing"
    }
    assert rules(healthChecker.find_exercise_descriptions_outside_directory(indexed_todo_vault)) == {
        "exerciseDescriptionWrongFolder"
    }
    assert rules(healthChecker.find_exercise_images_outside_directory(indexed_todo_vault)) == {
        "exerciseImageWrongFolder"
    }
    assert rules(healthChecker.find_image_descriptions_outside_directory(indexed_todo_vault)) == {
        "imageDescriptionWrongFolder"
    }
    assert rules(healthChecker.find_images_outside_directory(indexed_todo_vault)) == {"imageWrongFolder"}


def test_d2_citations_files_footnotes_and_headings(indexed_todo_vault: sqlite3.Connection) -> None:
    assert rules(healthChecker.find_empty_directories(indexed_todo_vault)) == {"emptyDirectory"}
    assert rules(healthChecker.find_empty_files(indexed_todo_vault)) == {"emptyFile"}
    assert rules(healthChecker.find_unreferenced_footnote_definitions(indexed_todo_vault)) == {
        "unreferencedFootnoteDefinition"
    }
    assert rules(healthChecker.find_headings_with_markup(indexed_todo_vault)) == {"headingContainsMarkup"}
    assert rules(healthChecker.find_heading_level_jumps(indexed_todo_vault)) == {"headingLevelJump"}
    assert rules(healthChecker.find_local_image_embeds_not_wikilinks(indexed_todo_vault)) == {
        "localImageEmbedNotWikilink"
    }
    assert rules(healthChecker.find_images_without_descriptions(indexed_todo_vault)) == {"imageMissingDescription"}
    assert rules(healthChecker.find_multiple_h1_headings(indexed_todo_vault)) == {"multipleH1Headings"}
    assert rules(healthChecker.find_internal_links_without_filename_stems(indexed_todo_vault)) == {
        "internalLinkUsesFilenameStem"
    }
    assert rules(healthChecker.find_web_source_footnotes_without_urls(indexed_todo_vault)) == {
        "webSourceFootnoteMissingUrl"
    }
    syntax_path = indexed_todo_vault.execute(
        "SELECT path FROM vault_files WHERE path LIKE '%/syntax.md'"
    ).fetchone()[0]
    assert healthChecker.find_local_pdf_citations_without_original_url(indexed_todo_vault) == [
        healthChecker.ValidationWarning(
            rule="localPdfCitationMissingOriginalUrl",
            path=syntax_path,
            message="A citation with a local PDF URI must also contain the original URL.",
            line=23,
        )
    ]
    assert healthChecker.find_web_source_footnotes_without_access_dates(indexed_todo_vault) == [
        healthChecker.ValidationWarning(
            rule="webSourceFootnoteMissingAccessDate",
            path=syntax_path,
            message="Web-source footnotes must end with `date accessed: YYYY-MM-DD`.",
            line=25,
        )
    ]
    assert rules(healthChecker.find_exercise_related_targets_outside_exercises(indexed_todo_vault)) == {
        "exerciseRelatedTargetNotExercise"
    }
    assert rules(healthChecker.find_exercise_descriptions_without_required_properties(indexed_todo_vault)) == {
        "exerciseDescriptionMissingProperty"
    }
    assert rules(healthChecker.find_exercise_images_without_descriptions(indexed_todo_vault)) == {
        "exerciseImageMissingDescription"
    }
    assert rules(healthChecker.find_image_descriptions_without_source_footnotes(indexed_todo_vault)) == {
        "imageDescriptionMissingSourceFootnote"
    }
    assert rules(healthChecker.find_image_descriptions_without_images(indexed_todo_vault)) == {
        "imageDescriptionMissingImage"
    }
    assert rules(healthChecker.find_image_description_stem_mismatches(indexed_todo_vault)) == {
        "imageDescriptionStemMismatch"
    }
    assert rules(healthChecker.find_notes_without_first_h1(indexed_todo_vault)) == {"firstRenderedLineNotH1"}


def test_d3_structure_and_frontmatter_rules(indexed_todo_vault: sqlite3.Connection) -> None:
    assert rules(healthChecker.find_blockquotes_without_attributions(indexed_todo_vault)) == {
        "blockquoteMissingAttribution"
    }
    assert rules(healthChecker.find_files_outside_required_directories(indexed_todo_vault)) == {
        "fileTypeWrongFolder"
    }
    syntax_path = indexed_todo_vault.execute(
        "SELECT path FROM vault_files WHERE path LIKE '%/syntax.md'"
    ).fetchone()[0]
    assert healthChecker.find_footnote_definitions_not_at_bottom(indexed_todo_vault) == [
        healthChecker.ValidationWarning(
            rule="footnoteDefinitionNotAtBottom",
            path=syntax_path,
            message="Footnote definitions must be at the bottom of the note.",
            line=17,
        ),
        healthChecker.ValidationWarning(
            rule="footnoteDefinitionNotAtBottom",
            path=syntax_path,
            message="Footnote definitions must be at the bottom of the note.",
            line=21,
        ),
        healthChecker.ValidationWarning(
            rule="footnoteDefinitionNotAtBottom",
            path=syntax_path,
            message="Footnote definitions must be at the bottom of the note.",
            line=23,
        ),
        healthChecker.ValidationWarning(
            rule="footnoteDefinitionNotAtBottom",
            path=syntax_path,
            message="Footnote definitions must be at the bottom of the note.",
            line=25,
        ),
    ]
    assert healthChecker.find_footnote_references_without_exact_definition(indexed_todo_vault) == [
        healthChecker.ValidationWarning(
            rule="footnoteReferenceUnresolved",
            path=syntax_path,
            message="Footnote reference `[^missing-reference]` does not resolve to exactly one definition.",
            line=27,
        )
    ]
    assert rules(healthChecker.find_frontmatter_colons_without_double_quotes(indexed_todo_vault)) == {
        "frontmatterColonNotQuoted"
    }
    assert rules(healthChecker.find_frontmatter_links_without_double_quotes(indexed_todo_vault)) == {
        "frontmatterLinkNotQuoted"
    }
    assert rules(healthChecker.find_matrices_without_dimensions(indexed_todo_vault)) == {"matrixMissingDimensions"}
    assert rules(healthChecker.find_table_aliases_with_unescaped_pipes(indexed_todo_vault)) == {
        "tableWikilinkAliasUnescapedPipe"
    }



def test_footnote_definitions_must_be_contiguous() -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE vault_files (id INTEGER PRIMARY KEY, path TEXT, kind TEXT);
        CREATE TABLE markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER,
            parent_id INTEGER,
            ordinal INTEGER,
            node_type TEXT,
            value TEXT,
            block_id TEXT,
            attributes_json TEXT,
            start_line INTEGER,
            start_offset_utf16 INTEGER,
            end_line INTEGER,
            end_offset_utf16 INTEGER
        );
        """
    )
    connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, 1, ?, ?, ?, NULL, NULL, '{}', ?, ?, ?, ?)",
        [
            (1, None, 0, "root", 1, 0, 1, 0),
            (2, 1, 0, "footnoteDefinition", 2, 0, 2, 0),
            (3, 1, 1, "paragraph", 3, 0, 3, 0),
            (4, 1, 2, "footnoteDefinition", 4, 0, 4, 0),
        ],
    )
    try:
        assert healthChecker.find_footnote_definitions_not_continuous(connection) == [
            healthChecker.ValidationWarning(
                rule="footnoteDefinitionsNotContinuous",
                path="/vault/note.md",
                message="Footnote definitions must form one continuous block.",
                line=2,
            )
        ]
    finally:
        connection.close()

def test_d4_and_d5_syntax_rules(indexed_todo_vault: sqlite3.Connection) -> None:
    assert rules(healthChecker.find_unclosed_fenced_code_blocks(indexed_todo_vault)) == {
        "unclosedFencedCodeBlock"
    }
    assert rules(healthChecker.find_h2_sections_without_images(indexed_todo_vault)) == {"h2SectionMissingImage"}
    assert rules(healthChecker.find_invalid_mathjax(indexed_todo_vault)) == {"invalidMathJax"}


def test_cli_filters_warnings_to_selected_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    database = tmp_path / "index.db"
    note_path = vault / "note.md"
    other_path = vault / "other.md"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE vault_directories (id INTEGER PRIMARY KEY, path TEXT, parent_id INTEGER);
            CREATE TABLE vault_files (id INTEGER PRIMARY KEY, path TEXT);
            """
        )
        connection.execute("INSERT INTO vault_directories VALUES (1, ?, NULL)", (str(vault),))
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?)",
            [(1, str(note_path)), (2, str(other_path))],
        )

    warning_list = [
        healthChecker.ValidationWarning("noteRule", str(note_path), "selected"),
        healthChecker.ValidationWarning("otherRule", str(other_path), "not selected"),
    ]
    monkeypatch.setattr(healthChecker, "VALIDATORS", [lambda connection: warning_list])
    monkeypatch.chdir(tmp_path)
    for file_argument in ("note.md", str(note_path), "vault/note.md"):
        monkeypatch.setattr(
            sys, "argv", ["healthChecker.py", str(database), "--file", file_argument]
        )

        assert healthChecker.main() == 1
        output = capsys.readouterr().out
        assert "noteRule" in output
        assert "otherRule" not in output


def test_cli_prints_validator_timing_summary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    database = tmp_path / "index.db"
    sqlite3.connect(database).close()

    def slow_validator(connection: sqlite3.Connection) -> list[healthChecker.ValidationWarning]:
        return []

    def fast_validator(connection: sqlite3.Connection) -> list[healthChecker.ValidationWarning]:
        return []

    monkeypatch.setattr(healthChecker, "VALIDATORS", [slow_validator, fast_validator])
    monkeypatch.setattr(sys, "argv", ["healthChecker.py", str(database)])
    timestamps = iter((0.0, 2.0, 2.0, 3.5))
    monkeypatch.setattr(healthChecker, "perf_counter", lambda: next(timestamps))

    assert healthChecker.main() == 0
    output = capsys.readouterr().out
    assert "\nTiming summary\n" in output
    assert "slow_validator" in output
    assert "2000.000 ms total" in output
    assert "1500.000 ms total" in output
    assert output.index("slow_validator") < output.index("fast_validator")


def test_validator_timing_uses_indexed_collection_counts(
    indexed_todo_vault: sqlite3.Connection,
) -> None:
    note_count = indexed_todo_vault.execute("SELECT COUNT(*) FROM vault_files WHERE kind = 'markdown'").fetchone()[0]
    footnote_count = indexed_todo_vault.execute(
        """
        SELECT COUNT(*)
        FROM markdown_nodes AS node
        JOIN vault_files AS file ON file.id = node.file_id
        WHERE node.node_type = 'footnoteDefinition'
          AND file.kind = 'markdown'
        """
    ).fetchone()[0]

    assert healthChecker._timing_for_validator(
        indexed_todo_vault, healthChecker.find_notes_without_first_h1
    ) == ("note", note_count)
    assert healthChecker._timing_for_validator(
        indexed_todo_vault, healthChecker.find_unreferenced_footnote_definitions
    ) == ("footnote", footnote_count)


def test_timing_summary_formats_collection_counts(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(healthChecker, "TIMINGS", {})
    monkeypatch.setattr(healthChecker, "perf_counter", lambda: 1.0)

    healthChecker.record_timing("footnoteCheck", 0.0, "footnote", 500)
    healthChecker.print_timing_summary()

    output = capsys.readouterr().out
    assert "2.000 ms/footnote" in output
    assert "500 footnotes" in output


def test_every_new_validator_is_registered() -> None:
    registered = {validator.__name__ for validator in healthChecker.VALIDATORS}
    expected = {
        name
        for name in dir(healthChecker)
        if name.startswith("find_")
        and name
        not in {
            "find_invalid_frontmatter",
            "find_invalid_exercise_types",
            "find_invalid_muscle_names",
            "find_unbalanced_math_braces",
        }
        and name
        in {
            "find_missing_embedded_block_references",
            "find_missing_embedded_heading_references",
            "find_exercise_descriptions_outside_directory",
            "find_exercise_images_outside_directory",
            "find_image_descriptions_outside_directory",
            "find_images_outside_directory",
            "find_local_pdf_citations_without_original_url",
            "find_empty_directories",
            "find_empty_files",
            "find_unreferenced_footnote_definitions",
            "find_headings_with_markup",
            "find_heading_level_jumps",
            "find_local_image_embeds_not_wikilinks",
            "find_images_without_descriptions",
            "find_multiple_h1_headings",
            "find_internal_links_without_filename_stems",
            "find_web_source_footnotes_without_urls",
            "find_web_source_footnotes_without_access_dates",
            "find_exercise_related_targets_outside_exercises",
            "find_exercise_descriptions_without_required_properties",
            "find_exercise_images_without_descriptions",
            "find_image_descriptions_without_source_footnotes",
            "find_image_descriptions_without_images",
            "find_image_description_stem_mismatches",
            "find_notes_without_first_h1",
            "find_blockquotes_without_attributions",
            "find_files_outside_required_directories",
            "find_footnote_definitions_not_at_bottom",
            "find_footnote_references_without_exact_definition",
            "find_frontmatter_colons_without_double_quotes",
            "find_frontmatter_links_without_double_quotes",
            "find_matrices_without_dimensions",
            "find_table_aliases_with_unescaped_pipes",
            "find_footnote_definitions_not_continuous",
            "find_unclosed_fenced_code_blocks",
            "find_h2_sections_without_images",
            "find_invalid_mathjax",
        }
    }
    assert expected <= registered
