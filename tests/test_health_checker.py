"""Contract tests for SQL-backed health validators."""

import sqlite3
from pathlib import Path

import pytest

from healthChecker import (
    _FOOTNOTE_REFERENCE_CACHE,
    _count_timing_units,
    _has_unbalanced_math_braces,
    find_footnote_definitions_not_at_bottom,
    find_footnote_references_without_exact_definition,
    find_footnote_definitions_not_continuous,
    find_local_pdf_citations_without_original_url,
    find_web_source_footnotes_without_access_dates,
    _is_camel_case,
    ValidationWarning,
    find_aliases_without_non_camel_case,
    find_duplicate_filenames,
    find_duplicate_frontmatter_property_keys,
    find_duplicate_heading_names,
    find_invalid_exercise_types,
    find_invalid_muscle_names,
    find_code_blocks_without_language,
    find_hidden_markdown_notes,
    find_unreferenced_footnote_definitions,
    find_unbalanced_math_braces,
    find_missing_frontmatter_properties,
    find_obsidian_callouts,
    find_unexpected_root_files,
    find_non_camel_case_filenames,
    find_non_camel_case_directories,
    find_raw_html,
    find_tags_containing_hash,
    find_non_camel_case_tag_segments,
)


def create_schema(connection: sqlite3.Connection, root_path: str = "/vault") -> None:
    connection.executescript(
        """
        CREATE TABLE vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            parent_id INTEGER
        );
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        CREATE TABLE frontmatter_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            parent_id INTEGER,
            key TEXT,
            node_type TEXT NOT NULL,
            value TEXT
        );
        CREATE TABLE frontmatter_errors (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            error_output TEXT NOT NULL,
            line INTEGER,
            column INTEGER,
            raw_yaml TEXT NOT NULL
        );
        CREATE TABLE markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            start_line INTEGER,
            node_type TEXT NOT NULL,
            value TEXT
        );
        """
    )
    connection.execute(
        "INSERT INTO vault_directories VALUES (1, ?, NULL)",
        (root_path,),
    )


def create_footnote_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        CREATE TABLE markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            node_type TEXT NOT NULL,
            attributes_json TEXT,
            start_line INTEGER,
            end_line INTEGER,
            start_offset_utf16 INTEGER
        );
        """
    )


def create_full_footnote_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        CREATE TABLE markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            parent_id INTEGER,
            ordinal INTEGER,
            node_type TEXT NOT NULL,
            value TEXT,
            attributes_json TEXT,
            start_line INTEGER,
            start_offset_utf16 INTEGER,
            end_line INTEGER,
            end_offset_utf16 INTEGER
        );
        """
    )


def test_unreferenced_footnotes_only_scans_definition_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = sqlite3.connect(":memory:")
    create_footnote_schema(connection)
    note_a = tmp_path / "noteA.md"
    note_b = tmp_path / "noteB.md"
    note_c = tmp_path / "noteC.md"
    attachment = tmp_path / "drawing.png"
    note_a.write_text(
        "[^a] visible reference\n"
        "[^a] repeated reference\n"
        "[^CASE] different case\n"
        "`[^inline]`\n"
        "```\n"
        "[^fenced]\n"
        "```\n"
        r"\[^escaped]" "\n"
        "[^a]: Definition A\n"
        "[^unused]: Definition unused\n"
        "[^case]: Definition case\n"
        "[^inline]: Definition only referenced in inline code\n"
        "[^fenced]: Definition only referenced in a fenced code block\n"
        "[^escaped]: Definition referenced with an escape\n",
        encoding="utf-8",
    )
    note_b.write_text(
        "[^unused] reference in another note\n"
        "[^a]: Same identifier, no local reference\n",
        encoding="utf-8",
    )
    note_c.write_text("[^a] no definitions here\n", encoding="utf-8")
    attachment.write_text("[^attachment]: not a Markdown note\n", encoding="utf-8")
    connection.executemany(
        "INSERT INTO vault_files VALUES (?, ?, ?)",
        [
            (1, str(note_a), "markdown"),
            (2, str(note_b), "markdown"),
            (3, str(note_c), "markdown"),
            (4, str(attachment), "image"),
        ],
    )
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, "footnoteDefinition", '{"identifier":"a"}', 9, 9, 100),
            (2, 1, "footnoteDefinition", '{"identifier":"unused"}', 10, 10, 200),
            (3, 1, "footnoteDefinition", '{"identifier":"case"}', 11, 11, 300),
            (4, 1, "footnoteDefinition", '{"identifier":"inline"}', 12, 12, 400),
            (5, 1, "footnoteDefinition", '{"identifier":"fenced"}', 13, 13, 500),
            (6, 1, "footnoteDefinition", '{"identifier":"escaped"}', 14, 14, 600),
            (7, 2, "footnoteDefinition", '{"identifier":"a"}', 2, 2, 100),
            (8, 4, "footnoteDefinition", '{"identifier":"attachment"}', 1, 1, 0),
        ],
    )

    read_paths = []

    def read_source(path: str) -> str:
        read_paths.append(path)
        return Path(path).read_text(encoding="utf-8")

    monkeypatch.setattr("healthChecker._read_source", read_source)

    try:
        assert find_unreferenced_footnote_definitions(connection) == [
            ValidationWarning(
                rule="unreferencedFootnoteDefinition",
                path=str(note_a),
                message="Footnote definition `[^unused]` is not referenced.",
                line=10,
            ),
            ValidationWarning(
                rule="unreferencedFootnoteDefinition",
                path=str(note_a),
                message="Footnote definition `[^case]` is not referenced.",
                line=11,
            ),
            ValidationWarning(
                rule="unreferencedFootnoteDefinition",
                path=str(note_a),
                message="Footnote definition `[^inline]` is not referenced.",
                line=12,
            ),
            ValidationWarning(
                rule="unreferencedFootnoteDefinition",
                path=str(note_a),
                message="Footnote definition `[^fenced]` is not referenced.",
                line=13,
            ),
            ValidationWarning(
                rule="unreferencedFootnoteDefinition",
                path=str(note_b),
                message="Footnote definition `[^a]` is not referenced.",
                line=2,
            ),
        ]
        assert read_paths == [str(note_a), str(note_b)]
    finally:
        connection.close()


def test_unreferenced_footnotes_preserves_unreadable_source_behavior(tmp_path: Path) -> None:
    connection = sqlite3.connect(":memory:")
    create_footnote_schema(connection)
    missing_note = tmp_path / "missing.md"
    connection.execute("INSERT INTO vault_files VALUES (1, ?, 'markdown')", (str(missing_note),))
    connection.execute(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?)",
        (1, 1, "footnoteDefinition", '{"identifier":"source"}', 7, 7, 0),
    )

    try:
        assert find_unreferenced_footnote_definitions(connection) == [
            ValidationWarning(
                rule="unreferencedFootnoteDefinition",
                path=str(missing_note),
                message="Footnote definition `[^source]` is not referenced.",
                line=7,
            )
        ]
    finally:
        connection.close()


def test_footnote_placement_validators_preserve_root_child_semantics(tmp_path: Path) -> None:
    connection = sqlite3.connect(":memory:")
    create_full_footnote_schema(connection)
    paths = {
        1: tmp_path / "placement.md",
        2: tmp_path / "placementOnly.md",
        3: tmp_path / "nested.md",
        4: tmp_path / "missingRoot.md",
        5: tmp_path / "ordinalGap.md",
        6: tmp_path / "multipleRoots.md",
    }
    connection.executemany(
        "INSERT INTO vault_files VALUES (?, ?, 'markdown')",
        [(file_id, str(path)) for file_id, path in paths.items()],
    )
    nodes = [
        (1, 1, None, 0, "root", None, "{}", 1, 0, 1, 0),
        (2, 1, 1, 0, "footnoteDefinition", None, '{"identifier":"first"}', 1, 1, 1, 10),
        (3, 1, 1, 1, "paragraph", "content", "{}", 2, 2, 2, 10),
        (4, 1, 1, 2, "footnoteDefinition", None, '{"identifier":"last"}', 3, 3, 3, 10),
        (5, 2, None, 0, "root", None, "{}", 1, 0, 1, 0),
        (6, 2, 5, 0, "footnoteDefinition", None, '{"identifier":"first"}', 1, 1, 1, 10),
        (7, 2, 5, 1, "footnoteDefinition", None, '{"identifier":"last"}', 2, 2, 2, 10),
        (8, 2, 5, 2, "paragraph", "content", "{}", 3, 3, 3, 10),
        (9, 3, None, 0, "root", None, "{}", 1, 0, 1, 0),
        (10, 3, 9, 0, "list", None, "{}", 2, 1, 2, 10),
        (11, 3, 10, 0, "footnoteDefinition", None, '{"identifier":"nested"}', 3, 2, 3, 10),
        (12, 4, None, 0, "footnoteDefinition", None, '{"identifier":"orphan"}', 1, 0, 1, 10),
        (13, 5, None, 0, "root", None, "{}", 1, 0, 1, 0),
        (14, 5, 13, 0, "footnoteDefinition", None, '{"identifier":"one"}', 1, 1, 1, 10),
        (15, 5, 13, 2, "footnoteDefinition", None, '{"identifier":"two"}', 2, 2, 2, 10),
        (16, 6, None, 0, "root", None, "{}", 1, 0, 1, 0),
        (17, 6, 16, 0, "footnoteDefinition", None, '{"identifier":"selected"}', 1, 1, 1, 10),
        (18, 6, 16, 1, "paragraph", "content", "{}", 2, 2, 2, 10),
        (19, 6, None, 1, "root", None, "{}", 10, None, 10, None),
        (20, 6, 19, 0, "footnoteDefinition", None, '{"identifier":"ignored"}', 11, None, 11, None),
    ]
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        nodes,
    )
    try:
        assert find_footnote_definitions_not_at_bottom(connection) == [
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[1]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[2]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[2]),
                message="Footnote definitions must be at the bottom of the note.",
                line=2,
            ),
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[6]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
        ]
        assert find_footnote_definitions_not_continuous(connection) == [
            ValidationWarning(
                rule="footnoteDefinitionsNotContinuous",
                path=str(paths[1]),
                message="Footnote definitions must form one continuous block.",
                line=1,
            )
        ]
    finally:
        connection.close()


def test_footnote_placement_supports_null_offsets_and_optional_columns(tmp_path: Path) -> None:
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        CREATE TABLE markdown_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            parent_id INTEGER,
            node_type TEXT NOT NULL,
            attributes_json TEXT,
            start_line INTEGER,
            end_line INTEGER
        );
        """
    )
    note = tmp_path / "optionalColumns.md"
    connection.execute("INSERT INTO vault_files VALUES (1, ?, 'markdown')", (str(note),))
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, None, "root", "{}", 1, 1),
            (2, 1, 1, "footnoteDefinition", '{"identifier":"first"}', 1, 1),
            (3, 1, 1, "paragraph", "{}", 2, 2),
            (4, 1, 1, "footnoteDefinition", '{"identifier":"last"}', 3, 3),
        ],
    )

    try:
        assert find_footnote_definitions_not_at_bottom(connection) == [
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(note),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            )
        ]
        assert find_footnote_definitions_not_continuous(connection) == [
            ValidationWarning(
                rule="footnoteDefinitionsNotContinuous",
                path=str(note),
                message="Footnote definitions must form one continuous block.",
                line=1,
            )
        ]
    finally:
        connection.close()


def test_footnote_placement_batches_sql_variables(tmp_path: Path) -> None:
    connection = sqlite3.connect(":memory:")
    create_full_footnote_schema(connection)
    paths = {file_id: tmp_path / f"note{file_id}.md" for file_id in range(1, 5)}
    connection.executemany(
        "INSERT INTO vault_files VALUES (?, ?, 'markdown')",
        [(file_id, str(path)) for file_id, path in paths.items()],
    )
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, None, 0, "root", None, "{}", 1, 0, 1, 0),
            (2, 1, 1, 0, "footnoteDefinition", None, '{"identifier":"first"}', 1, 1, 1, 10),
            (3, 1, 1, 1, "paragraph", "content", "{}", 2, 2, 2, 10),
            (4, 1, 1, 2, "footnoteDefinition", None, '{"identifier":"last"}', 3, 3, 3, 10),
            (5, 2, None, 0, "root", None, "{}", 1, 0, 1, 0),
            (6, 2, 5, 0, "footnoteDefinition", None, '{"identifier":"only"}', 1, 1, 1, 10),
            (7, 2, 5, 1, "paragraph", "content", "{}", 2, 2, 2, 10),
            (8, 3, None, 0, "root", None, "{}", 1, 0, 1, 0),
            (9, 3, 8, 0, "footnoteDefinition", None, '{"identifier":"only"}', 1, 1, 1, 10),
            (10, 3, 8, 1, "paragraph", "content", "{}", 2, 2, 2, 10),
            (11, 4, None, 0, "root", None, "{}", 1, 0, 1, 0),
            (12, 4, 11, 0, "footnoteDefinition", None, '{"identifier":"only"}', 1, 1, 1, 10),
            (13, 4, 11, 1, "paragraph", "content", "{}", 2, 2, 2, 10),
        ],
    )
    connection.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 3)

    try:
        assert find_footnote_definitions_not_at_bottom(connection) == [
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[1]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[2]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[3]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
            ValidationWarning(
                rule="footnoteDefinitionNotAtBottom",
                path=str(paths[4]),
                message="Footnote definitions must be at the bottom of the note.",
                line=1,
            ),
        ]
        assert find_footnote_definitions_not_continuous(connection) == [
            ValidationWarning(
                rule="footnoteDefinitionsNotContinuous",
                path=str(paths[1]),
                message="Footnote definitions must form one continuous block.",
                line=1,
            )
        ]
    finally:
        connection.close()


def test_exact_footnote_references_preserve_file_scope_and_definition_counts(tmp_path: Path) -> None:
    connection = sqlite3.connect(":memory:")
    create_full_footnote_schema(connection)
    definitions_note = tmp_path / "definitions.md"
    reference_only_note = tmp_path / "referenceOnly.md"
    script = tmp_path / "script.py"
    definitions_note.write_text(
        "[^ok] repeated [^fallback]\n"
        "[^ok]\n"
        "[^missing]\n"
        "[^duplicate]\n"
        "[^other]\n"
        "[^fallback]: definition\n",
        encoding="utf-8",
    )
    reference_only_note.write_text("[^only]\n", encoding="utf-8")
    script.write_text("[^script]\n", encoding="utf-8")
    connection.executemany(
        "INSERT INTO vault_files VALUES (?, ?, ?)",
        [
            (1, str(definitions_note), "markdown"),
            (2, str(reference_only_note), "markdown"),
            (3, str(script), "other"),
        ],
    )
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, None, 0, "root", None, "{}", 1, 0, 1, 0),
            (2, 1, 1, 0, "footnoteDefinition", None, '{"identifier":"ok"}', 1, 1, 1, 10),
            (3, 1, 1, 1, "footnoteDefinition", None, '{"identifier":"duplicate"}', 2, 2, 2, 10),
            (4, 1, 1, 2, "footnoteDefinition", None, '{"identifier":"duplicate"}', 3, 3, 3, 10),
            (5, 1, 1, 3, "footnoteDefinition", None, "{}", 6, 5, 6, 15),
        ],
    )

    try:
        assert find_footnote_references_without_exact_definition(connection) == [
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=str(definitions_note),
                message="Footnote reference `[^missing]` does not resolve to exactly one definition.",
                line=3,
            ),
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=str(definitions_note),
                message="Footnote reference `[^duplicate]` does not resolve to exactly one definition.",
                line=4,
            ),
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=str(definitions_note),
                message="Footnote reference `[^other]` does not resolve to exactly one definition.",
                line=5,
            ),
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=str(reference_only_note),
                message="Footnote reference `[^only]` does not resolve to exactly one definition.",
                line=1,
            ),
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=str(script),
                message="Footnote reference `[^script]` does not resolve to exactly one definition.",
                line=1,
            ),
        ]
    finally:
        connection.close()


def test_exact_reference_timing_reuses_scanned_occurrences(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = sqlite3.connect(":memory:")
    create_full_footnote_schema(connection)
    reference_only_note = tmp_path / "referenceOnly.md"
    reference_only_note.write_text("[^missing]\n", encoding="utf-8")
    connection.execute(
        "INSERT INTO vault_files VALUES (1, ?, 'markdown')",
        (str(reference_only_note),),
    )
    reads = []

    def read_source(path: str) -> str:
        reads.append(path)
        return Path(path).read_text(encoding="utf-8")

    monkeypatch.setattr("healthChecker._read_source", read_source)
    _FOOTNOTE_REFERENCE_CACHE.clear()

    try:
        assert _count_timing_units(connection, "footnote reference") == 1
        assert find_footnote_references_without_exact_definition(connection) == [
            ValidationWarning(
                rule="footnoteReferenceUnresolved",
                path=str(reference_only_note),
                message="Footnote reference `[^missing]` does not resolve to exactly one definition.",
                line=1,
            )
        ]
        assert reads == [str(reference_only_note)]
    finally:
        connection.close()


def test_citation_validators_preserve_source_and_ast_fallback_semantics(tmp_path: Path) -> None:
    connection = sqlite3.connect(":memory:")
    create_full_footnote_schema(connection)
    source_note = tmp_path / "citations.md"
    empty_note = tmp_path / "empty.md"
    missing_note = tmp_path / "missing.md"
    positionless_note = tmp_path / "positionless.md"
    source_note.write_text(
        "[^local]:\n"
        "  [[paper.pdf]]\n"
        "[^withUrl]: paper.pdf https://example.com date accessed: 2026-01-01\n"
        "[^webMissing]: https://example.org\n"
        "[^webDated]: https://example.net date accessed: 2026-01-01\n"
        "[^webBefore]: https://example.net date accessed: 2026-01-01 trailing\n",
        encoding="utf-8",
    )
    empty_note.write_text("", encoding="utf-8")
    positionless_note.write_text("", encoding="utf-8")
    connection.executemany(
        "INSERT INTO vault_files VALUES (?, ?, 'markdown')",
        [
            (1, str(source_note)),
            (2, str(empty_note)),
            (3, str(missing_note)),
            (4, str(positionless_note)),
        ],
    )
    connection.executemany(
        "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (1, 1, None, 0, "footnoteDefinition", None, '{"identifier":"local"}', 1, 0, 2, 20),
            (2, 1, None, 1, "footnoteDefinition", None, '{"identifier":"withUrl"}', 3, 21, 3, 80),
            (3, 1, None, 2, "footnoteDefinition", None, '{"identifier":"webMissing"}', 4, 81, 4, 120),
            (4, 1, None, 3, "footnoteDefinition", None, '{"identifier":"webDated"}', 5, 121, 5, 180),
            (5, 1, None, 4, "footnoteDefinition", None, '{"identifier":"webBefore"}', 6, 181, 6, 250),
            (6, 2, None, 0, "footnoteDefinition", None, '{"identifier":"fallbackLocal"}', 1, 0, 1, 0),
            (7, 2, 6, 0, "paragraph", None, "{}", 1, 0, 1, 0),
            (8, 2, 7, 0, "text", "[[fallback.pdf]]", "{}", 1, 0, 1, 15),
            (9, 3, None, 0, "footnoteDefinition", None, '{"identifier":"fallbackWeb"}', 1, 0, 1, 0),
            (10, 3, 9, 0, "text", "https://fallback.example", "{}", 1, 0, 1, 24),
            (11, 4, None, 0, "footnoteDefinition", None, '{"identifier":"positionless"}', None, 0, None, 0),
            (12, 4, 11, 0, "text", "[[positionless.pdf]]", "{}", None, 0, None, 18),
        ],
    )

    try:
        assert find_local_pdf_citations_without_original_url(connection) == [
            ValidationWarning(
                rule="localPdfCitationMissingOriginalUrl",
                path=str(source_note),
                message="A citation with a local PDF URI must also contain the original URL.",
                line=1,
            ),
            ValidationWarning(
                rule="localPdfCitationMissingOriginalUrl",
                path=str(empty_note),
                message="A citation with a local PDF URI must also contain the original URL.",
                line=1,
            ),
            ValidationWarning(
                rule="localPdfCitationMissingOriginalUrl",
                path=str(positionless_note),
                message="A citation with a local PDF URI must also contain the original URL.",
                line=None,
            ),
        ]
        assert find_web_source_footnotes_without_access_dates(connection) == [
            ValidationWarning(
                rule="webSourceFootnoteMissingAccessDate",
                path=str(source_note),
                message="Web-source footnotes must end with `date accessed: YYYY-MM-DD`.",
                line=4,
            ),
            ValidationWarning(
                rule="webSourceFootnoteMissingAccessDate",
                path=str(source_note),
                message="Web-source footnotes must end with `date accessed: YYYY-MM-DD`.",
                line=6,
            ),
            ValidationWarning(
                rule="webSourceFootnoteMissingAccessDate",
                path=str(missing_note),
                message="Web-source footnotes must end with `date accessed: YYYY-MM-DD`.",
                line=1,
            ),
        ]
    finally:
        connection.close()


def create_tag_occurrence_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_tags (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            parent_id INTEGER
        );
        CREATE TABLE note_tag_occurrences (
            id INTEGER PRIMARY KEY,
            tag_id INTEGER NOT NULL,
            frontmatter_node_id INTEGER,
            markdown_node_id INTEGER
        );
        """
    )


def create_exercise_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            parent_id INTEGER
        );
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            directory_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        CREATE TABLE frontmatter_nodes (
            id INTEGER PRIMARY KEY,
            file_id INTEGER NOT NULL,
            parent_id INTEGER,
            key TEXT,
            node_type TEXT NOT NULL,
            value TEXT
        );
        """
    )


def create_hidden_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            parent_id INTEGER
        );
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        """
    )


def create_root_file_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            parent_id INTEGER
        );
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            directory_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        """
    )


def create_filename_schema(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            extension TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        """
    )


def create_filename_case_schema(connection: sqlite3.Connection, root_path: str = "/vault") -> None:
    connection.executescript(
        """
        CREATE TABLE vault_directories (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            parent_id INTEGER
        );
        CREATE TABLE vault_files (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL
        );
        """
    )
    connection.execute(
        "INSERT INTO vault_directories VALUES (42, ?, NULL)",
        (root_path,),
    )


def test_missing_frontmatter_properties_reports_all_properties_without_frontmatter() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/README.md', 'markdown')")

        assert find_missing_frontmatter_properties(connection) == [
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/README.md",
                message="Required frontmatter property `aliases` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/README.md",
                message="Required frontmatter property `related` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/README.md",
                message="Required frontmatter property `tags` is missing.",
            ),
        ]


def test_missing_frontmatter_properties_excludes_people_and_diary_directories() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/vault/people/person.md", "markdown"),
                (2, "/vault/people/nested/person.md", "markdown"),
                (3, "/vault/diary/diary2026d213.md", "markdown"),
                (4, "/vault/diary/2026/entry.md", "markdown"),
                (5, "/vault/diary-notes/entry.md", "markdown"),
                (6, "/vault/note.md", "markdown"),
                (7, "/vault/archive/people/person.md", "markdown"),
            ],
        )

        assert find_missing_frontmatter_properties(connection) == [
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/archive/people/person.md",
                message="Required frontmatter property `aliases` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/archive/people/person.md",
                message="Required frontmatter property `related` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/archive/people/person.md",
                message="Required frontmatter property `tags` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/diary-notes/entry.md",
                message="Required frontmatter property `aliases` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/diary-notes/entry.md",
                message="Required frontmatter property `related` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/diary-notes/entry.md",
                message="Required frontmatter property `tags` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/note.md",
                message="Required frontmatter property `aliases` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/note.md",
                message="Required frontmatter property `related` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/note.md",
                message="Required frontmatter property `tags` is missing.",
            ),
        ]


def test_missing_frontmatter_properties_uses_vault_relative_directory_names() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection, root_path="/tmp/people/vault")
        connection.execute(
            "INSERT INTO vault_files VALUES (1, '/tmp/people/vault/note.md', 'markdown')"
        )

        assert find_missing_frontmatter_properties(connection) == [
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/tmp/people/vault/note.md",
                message="Required frontmatter property `aliases` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/tmp/people/vault/note.md",
                message="Required frontmatter property `related` is missing.",
            ),
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/tmp/people/vault/note.md",
                message="Required frontmatter property `tags` is missing.",
            ),
        ]


def test_missing_frontmatter_properties_skips_invalid_frontmatter() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/broken.md', 'markdown')")
        connection.execute(
            "INSERT INTO frontmatter_errors VALUES (1, 1, 'mapping values are not allowed here', 2, 8, 'tags: [')"
        )

        assert find_missing_frontmatter_properties(connection) == []


def test_missing_frontmatter_properties_ignores_note_with_all_properties() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, 1, NULL, ?, 'sequence', NULL)",
            [(1, "aliases"), (2, "tags"), (3, "related")],
        )

        assert find_missing_frontmatter_properties(connection) == []


def test_missing_frontmatter_properties_treats_empty_lists_and_null_as_present() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, 1, NULL, ?, ?, ?)",
            [
                (1, "aliases", "sequence", None),
                (2, "tags", "sequence", None),
                (3, "related", "scalar", None),
            ],
        )

        assert find_missing_frontmatter_properties(connection) == []


def test_missing_frontmatter_properties_checks_top_level_markdown_properties_only() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [(1, "/vault/note.md", "markdown"), (2, "/vault/image.png", "image")],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "aliases", "sequence", None),
                (2, 1, None, "tags", "scalar", "robot"),
                (3, 1, None, "metadata", "mapping", None),
                (4, 1, 3, "related", "sequence", None),
                (5, 2, None, "aliases", "scalar", "ignored"),
            ],
        )

        assert find_missing_frontmatter_properties(connection) == [
            ValidationWarning(
                rule="missingFrontmatterProperty",
                path="/vault/note.md",
                message="Required frontmatter property `related` is missing.",
            )
        ]


def test_find_hidden_markdown_notes_checks_hidden_relative_path_components() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_hidden_schema(connection)
        connection.execute(
            "INSERT INTO vault_directories VALUES (1, '/home/.hidden/vault', NULL)"
        )
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/home/.hidden/vault/note.md", "markdown"),
                (2, "/home/.hidden/vault/.note.md", "markdown"),
                (3, "/home/.hidden/vault/.hidden/note.md", "markdown"),
                (4, "/home/.hidden/vault/folder/.note.md", "markdown"),
                (5, "/home/.hidden/vault/folder/note.md", "markdown"),
                (6, "/home/.hidden/vault/folder.with.dots/note.md", "markdown"),
                (7, "/home/.hidden/vault/.asset.png", "image"),
            ],
        )

        assert find_hidden_markdown_notes(connection) == [
            ValidationWarning(
                rule="hiddenMarkdownNote",
                path="/home/.hidden/vault/.hidden/note.md",
                message="Markdown notes must not be hidden.",
            ),
            ValidationWarning(
                rule="hiddenMarkdownNote",
                path="/home/.hidden/vault/.note.md",
                message="Markdown notes must not be hidden.",
            ),
            ValidationWarning(
                rule="hiddenMarkdownNote",
                path="/home/.hidden/vault/folder/.note.md",
                message="Markdown notes must not be hidden.",
            ),
        ]


def test_find_hidden_markdown_notes_fails_when_vault_root_is_missing() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_hidden_schema(connection)
        connection.execute(
            "INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')"
        )

        with pytest.raises(RuntimeError, match="Vault root directory is missing from the index."):
            find_hidden_markdown_notes(connection)


def test_find_unexpected_root_files_uses_root_directory_and_filename_whitelist() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_root_file_schema(connection)
        connection.executemany(
            "INSERT INTO vault_directories VALUES (?, ?, ?)",
            [
                (42, "/vault", None),
                (43, "/vault/notes", 42),
            ],
        )
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?)",
            [
                (1, 42, "/vault/README.md", "markdown"),
                (2, 42, "/vault/TODO.md", "markdown"),
                (3, 42, "/vault/tmp.md", "markdown"),
                (4, 42, "/vault/README.md.bak", "other"),
                (5, 42, "/vault/extra.md", "markdown"),
                (6, 43, "/vault/notes/note.md", "markdown"),
            ],
        )

        assert find_unexpected_root_files(connection) == [
            ValidationWarning(
                rule="unexpectedRootFile",
                path="/vault/README.md.bak",
                message="Only README.md, TODO.md, and tmp.md may be stored directly in the vault root.",
            ),
            ValidationWarning(
                rule="unexpectedRootFile",
                path="/vault/extra.md",
                message="Only README.md, TODO.md, and tmp.md may be stored directly in the vault root.",
            ),
        ]


def test_find_invalid_exercise_types_scopes_to_direct_exercise_notes_and_reports_invalid_values() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_exercise_schema(connection)
        connection.executemany(
            "INSERT INTO vault_directories VALUES (?, ?, ?)",
            [
                (1, "/vault", None),
                (2, "/vault/health", 1),
                (3, "/vault/health/exercises", 2),
                (4, "/vault/health/exercises/archive", 3),
                (5, "/vault/something", 1),
                (6, "/vault/something/health", 5),
                (7, "/vault/something/health/exercises", 6),
            ],
        )
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?)",
            [
                (1, 3, "/vault/health/exercises/strength.md", "markdown"),
                (2, 3, "/vault/health/exercises/cardio.md", "markdown"),
                (3, 3, "/vault/health/exercises/stretching.md", "markdown"),
                (4, 3, "/vault/health/exercises/mobility.md", "markdown"),
                (5, 3, "/vault/health/exercises/stability.md", "markdown"),
                (6, 3, "/vault/health/exercises/invalid.md", "markdown"),
                (7, 3, "/vault/health/exercises/null.md", "markdown"),
                (8, 3, "/vault/health/exercises/list.md", "markdown"),
                (9, 3, "/vault/health/exercises/nested.md", "markdown"),
                (10, 1, "/vault/other.md", "markdown"),
                (11, 3, "/vault/health/exercises/ignored.png", "image"),
                (12, 4, "/vault/health/exercises/archive/foo.md", "markdown"),
                (13, 7, "/vault/something/health/exercises/foo.md", "markdown"),
            ],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "exerciseType", "scalar", "strength"),
                (2, 2, None, "exerciseType", "scalar", "cardio"),
                (3, 3, None, "exerciseType", "scalar", "stretching"),
                (4, 4, None, "exerciseType", "scalar", "mobility"),
                (5, 5, None, "exerciseType", "scalar", "stability"),
                (6, 6, None, "exerciseType", "scalar", "endurance"),
                (7, 7, None, "exerciseType", "scalar", None),
                (8, 8, None, "exerciseType", "sequence", None),
                (9, 9, None, "metadata", "mapping", None),
                (10, 9, 9, "exerciseType", "scalar", "endurance"),
                (11, 10, None, "exerciseType", "scalar", "endurance"),
                (12, 11, None, "exerciseType", "scalar", "endurance"),
                (13, 12, None, "exerciseType", "scalar", "endurance"),
                (14, 13, None, "exerciseType", "scalar", "endurance"),
            ],
        )

        assert find_invalid_exercise_types(connection) == [
            ValidationWarning(
                rule="invalidExerciseType",
                path="/vault/health/exercises/invalid.md",
                message=(
                    "Frontmatter property `exerciseType` must be a scalar with one of these values: "
                    "strength, cardio, stretching, mobility, stability."
                ),
            ),
            ValidationWarning(
                rule="invalidExerciseType",
                path="/vault/health/exercises/list.md",
                message=(
                    "Frontmatter property `exerciseType` must be a scalar with one of these values: "
                    "strength, cardio, stretching, mobility, stability."
                ),
            ),
            ValidationWarning(
                rule="invalidExerciseType",
                path="/vault/health/exercises/null.md",
                message=(
                    "Frontmatter property `exerciseType` must be a scalar with one of these values: "
                    "strength, cardio, stretching, mobility, stability."
                ),
            ),
        ]


def test_find_invalid_muscle_names_scopes_to_documented_exercise_properties() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_exercise_schema(connection)
        connection.executemany(
            "INSERT INTO vault_directories VALUES (?, ?, ?)",
            [
                (1, "/vault", None),
                (2, "/vault/health", 1),
                (3, "/vault/health/exercises", 2),
                (4, "/vault/health/exercises/archive", 3),
            ],
        )
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?)",
            [
                (1, 3, "/vault/health/exercises/valid.md", "markdown"),
                (2, 3, "/vault/health/exercises/invalid.md", "markdown"),
                (3, 3, "/vault/health/exercises/list.md", "markdown"),
                (4, 3, "/vault/health/exercises/null.md", "markdown"),
                (5, 3, "/vault/health/exercises/nested.md", "markdown"),
                (6, 3, "/vault/health/exercises/legacy.md", "markdown"),
                (7, 1, "/vault/other.md", "markdown"),
                (8, 4, "/vault/health/exercises/archive/foo.md", "markdown"),
            ],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "primaryMuscle", "scalar", "middle back"),
                (2, 1, None, "secondaryMuscle", "scalar", "calves"),
                (3, 2, None, "primaryMuscle", "scalar", "obliques"),
                (4, 2, None, "secondaryMuscle", "scalar", "obliques"),
                (5, 3, None, "primaryMuscle", "sequence", None),
                (6, 4, None, "secondaryMuscle", "scalar", None),
                (7, 5, None, "metadata", "mapping", None),
                (8, 5, 7, "primaryMuscle", "scalar", "obliques"),
                (9, 6, None, "primary-muscle", "scalar", "obliques"),
                (10, 7, None, "primaryMuscle", "scalar", "obliques"),
                (11, 8, None, "primaryMuscle", "scalar", "obliques"),
            ],
        )

        assert find_invalid_muscle_names(connection) == [
            ValidationWarning(
                rule="invalidMuscleName",
                path="/vault/health/exercises/invalid.md",
                message=(
                    "Frontmatter property `primaryMuscle` must be a scalar with one of these values: "
                    "chest, shoulders, traps, lats, middle back, lower back, biceps, triceps, forearms, "
                    "abs, quads, hamstrings, glutes, abductors, adductors, calves."
                ),
            ),
            ValidationWarning(
                rule="invalidMuscleName",
                path="/vault/health/exercises/invalid.md",
                message=(
                    "Frontmatter property `secondaryMuscle` must be a scalar with one of these values: "
                    "chest, shoulders, traps, lats, middle back, lower back, biceps, triceps, forearms, "
                    "abs, quads, hamstrings, glutes, abductors, adductors, calves."
                ),
            ),
            ValidationWarning(
                rule="invalidMuscleName",
                path="/vault/health/exercises/list.md",
                message=(
                    "Frontmatter property `primaryMuscle` must be a scalar with one of these values: "
                    "chest, shoulders, traps, lats, middle back, lower back, biceps, triceps, forearms, "
                    "abs, quads, hamstrings, glutes, abductors, adductors, calves."
                ),
            ),
            ValidationWarning(
                rule="invalidMuscleName",
                path="/vault/health/exercises/null.md",
                message=(
                    "Frontmatter property `secondaryMuscle` must be a scalar with one of these values: "
                    "chest, shoulders, traps, lats, middle back, lower back, biceps, triceps, forearms, "
                    "abs, quads, hamstrings, glutes, abductors, adductors, calves."
                ),
            ),
        ]


def test_duplicate_frontmatter_property_keys_reports_top_level_and_nested_duplicates() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "aliases", "sequence", None),
                (2, 1, None, "aliases", "sequence", None),
                (3, 1, None, "metadata", "mapping", None),
                (4, 1, 3, "name", "scalar", "first"),
                (5, 1, 3, "name", "scalar", "second"),
            ],
        )

        assert find_duplicate_frontmatter_property_keys(connection) == [
            ValidationWarning(
                rule="duplicateFrontmatterPropertyKey",
                path="/vault/note.md",
                message="Frontmatter property key `aliases` occurs more than once.",
            ),
            ValidationWarning(
                rule="duplicateFrontmatterPropertyKey",
                path="/vault/note.md",
                message="Frontmatter property key `name` occurs more than once.",
            ),
        ]


def test_duplicate_frontmatter_property_keys_respects_mapping_boundaries_and_list_items() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "tags", "sequence", None),
                (2, 1, 1, None, "scalar", "same"),
                (3, 1, 1, None, "scalar", "same"),
                (4, 1, None, "first", "mapping", None),
                (5, 1, 4, "name", "scalar", "one"),
                (6, 1, None, "second", "mapping", None),
                (7, 1, 6, "name", "scalar", "two"),
            ],
        )

        assert find_duplicate_frontmatter_property_keys(connection) == []


def test_duplicate_frontmatter_property_keys_keeps_files_separate() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [(1, "/vault/first.md", "markdown"), (2, "/vault/second.md", "markdown")],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, NULL, ?, 'sequence', NULL)",
            [(1, 1, "aliases"), (2, 2, "aliases"), (3, 2, "aliases")],
        )

        assert find_duplicate_frontmatter_property_keys(connection) == [
            ValidationWarning(
                rule="duplicateFrontmatterPropertyKey",
                path="/vault/second.md",
                message="Frontmatter property key `aliases` occurs more than once.",
            )
        ]


def test_duplicate_frontmatter_property_keys_treats_keys_as_case_sensitive() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, 1, NULL, ?, 'scalar', ?)",
            [(1, "name", "first"), (2, "Name", "second")],
        )

        assert find_duplicate_frontmatter_property_keys(connection) == []


def test_find_raw_html_reports_compact_warning_without_source_text() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.execute(
            "INSERT INTO markdown_nodes VALUES (1, 1, 12, 'html', ?)",
            ("<div>\nline 1\nline 2\n</div>",),
        )

        assert find_raw_html(connection) == [
            ValidationWarning(
                rule="rawHtml",
                path="/vault/note.md",
                message="Raw HTML must not be used.",
                line=12,
            )
        ]


def test_duplicate_filenames_reports_each_affected_path_in_filename_order() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_filename_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?, ?)",
            [
                (1, "/vault/zeta/report.md", "report", ".md", "markdown"),
                (2, "/vault/alpha/report.md", "report", ".md", "markdown"),
                (3, "/vault/report.txt", "report", ".txt", "other"),
                (4, "/vault/unique.md", "unique", ".md", "markdown"),
            ],
        )

        assert find_duplicate_filenames(connection) == [
            ValidationWarning(
                rule="duplicateFilename",
                path="/vault/alpha/report.md",
                message="Filename `report.md` is duplicated in the vault.",
            ),
            ValidationWarning(
                rule="duplicateFilename",
                path="/vault/zeta/report.md",
                message="Filename `report.md` is duplicated in the vault.",
            ),
        ]


def test_duplicate_filenames_distinguishes_extensions_and_unique_files() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_filename_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?, ?)",
            [
                (1, "/vault/one/note.md", "note", ".md", "markdown"),
                (2, "/vault/two/note.txt", "note", ".txt", "other"),
                (3, "/vault/unique.md", "unique", ".md", "markdown"),
            ],
        )

        assert find_duplicate_filenames(connection) == []


def test_duplicate_filenames_treats_stem_casing_as_distinct() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_filename_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?, ?)",
            [
                (1, "/vault/foo.md", "foo", ".md", "markdown"),
                (2, "/vault/Foo.md", "Foo", ".md", "markdown"),
            ],
        )

        assert find_duplicate_filenames(connection) == []


def test_duplicate_filenames_reports_extensionless_files() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_filename_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?, ?)",
            [
                (1, "/vault/LICENSE", "LICENSE", "", "other"),
                (2, "/vault/docs/LICENSE", "LICENSE", "", "other"),
            ],
        )

        assert find_duplicate_filenames(connection) == [
            ValidationWarning(
                rule="duplicateFilename",
                path="/vault/LICENSE",
                message="Filename `LICENSE` is duplicated in the vault.",
            ),
            ValidationWarning(
                rule="duplicateFilename",
                path="/vault/docs/LICENSE",
                message="Filename `LICENSE` is duplicated in the vault.",
            ),
        ]


def test_duplicate_filenames_treats_extension_casing_as_insensitive() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_filename_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?, ?)",
            [
                (1, "/vault/a/foo.md", "foo", ".md", "markdown"),
                (2, "/vault/b/foo.MD", "foo", ".md", "markdown"),
            ],
        )

        assert find_duplicate_filenames(connection) == [
            ValidationWarning(
                rule="duplicateFilename",
                path="/vault/a/foo.md",
                message="Filename `foo.md` is duplicated in the vault.",
            ),
            ValidationWarning(
                rule="duplicateFilename",
                path="/vault/b/foo.MD",
                message="Filename `foo.MD` is duplicated in the vault.",
            ),
        ]



def test_find_duplicate_heading_names_groups_by_note() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/vault/first.md", "markdown"),
                (2, "/vault/second.md", "markdown"),
            ],
        )
        connection.executemany(
            """
            INSERT INTO markdown_nodes
                (id, file_id, start_line, node_type, value)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (1, 1, 1, "heading", "Repeated"),
                (2, 1, 4, "heading", "Repeated"),
                (3, 1, 7, "heading", "Unique"),
                (4, 2, 1, "heading", "Repeated"),
                (5, 1, 10, "heading", "Results"),
                (6, 1, 13, "heading", "results"),
            ],
        )

        assert find_duplicate_heading_names(connection) == [
            ValidationWarning(
                rule="duplicateHeadingName",
                path="/vault/first.md",
                message="Heading `Repeated` occurs more than once in the note.",
            ),
        ]



def test_find_non_camel_case_filenames_checks_all_file_kinds_and_people_exception() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_filename_case_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?, ?)",
            [
                (1, "/vault/README.md", "README", "markdown"),
                (2, "/vault/TODO.md", "TODO", "markdown"),
                (3, "/vault/people/John Doe.md", "John Doe", "markdown"),
                (4, "/vault/people/John Doe.png", "John Doe", "image"),
                (5, "/vault/validName.py", "validName", "script"),
                (6, "/vault/bad-name.py", "bad-name", "script"),
                (7, "/vault/README.md.bak", "README.md", "other"),
                (8, "/vault/archive/people/Other Name.md", "Other Name", "markdown"),
            ],
        )

        assert find_non_camel_case_filenames(connection) == [
            ValidationWarning(
                rule="nonCamelCaseFilename",
                path="/vault/README.md.bak",
                message="Filename stem `README.md` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseFilename",
                path="/vault/archive/people/Other Name.md",
                message="Filename stem `Other Name` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseFilename",
                path="/vault/bad-name.py",
                message="Filename stem `bad-name` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseFilename",
                path="/vault/people/John Doe.png",
                message="Filename stem `John Doe` must use camelCase.",
            ),
        ]


def test_find_non_camel_case_directories_checks_child_directories_only() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_hidden_schema(connection)
        connection.executemany(
            "INSERT INTO vault_directories VALUES (?, ?, ?)",
            [
                (1, "/Vault Root", None),
                (2, "/Vault Root/validFolder", 1),
                (3, "/Vault Root/invalid-folder", 1),
                (4, "/Vault Root/diary", 1),
                (5, "/Vault Root/diary/Navade", 4),
                (6, "/Vault Root/__pycache__", 1),
                (7, "/Vault Root/folder2", 1),
            ],
        )

        assert find_non_camel_case_directories(connection) == [
            ValidationWarning(
                rule="nonCamelCaseDirectory",
                path="/Vault Root/__pycache__",
                message="Folder name `__pycache__` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseDirectory",
                path="/Vault Root/diary/Navade",
                message="Folder name `Navade` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseDirectory",
                path="/Vault Root/invalid-folder",
                message="Folder name `invalid-folder` must use camelCase.",
            ),
        ]


def test_find_tags_containing_hash_reports_distinct_top_level_tag_values() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/vault/note.md", "markdown"),
                (2, "/vault/scalar.md", "markdown"),
            ],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "tags", "sequence", None),
                (2, 1, 1, None, "scalar", "#bad"),
                (3, 1, 1, None, "scalar", "#bad"),
                (4, 1, 1, None, "scalar", "also#bad"),
                (5, 1, 1, None, "scalar", "good/tag"),
                (6, 1, None, "tag", "scalar", "#single"),
                (7, 1, None, "aliases", "sequence", None),
                (8, 1, 7, None, "scalar", "#alias"),
                (9, 1, None, "metadata", "mapping", None),
                (10, 1, 9, "tags", "sequence", None),
                (11, 1, 10, None, "scalar", "#nested"),
                (12, 2, None, "tags", "scalar", "#single"),
            ],
        )

        assert find_tags_containing_hash(connection) == [
            ValidationWarning(
                rule="tagContainsHash",
                path="/vault/note.md",
                message='Tag `#bad` must not contain "#".',
            ),
            ValidationWarning(
                rule="tagContainsHash",
                path="/vault/note.md",
                message='Tag `also#bad` must not contain "#".',
            ),
            ValidationWarning(
                rule="tagContainsHash",
                path="/vault/scalar.md",
                message='Tag `#single` must not contain "#".',
            ),
        ]


def test_find_non_camel_case_tag_segments_uses_indexed_frontmatter_and_inline_occurrences() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        create_tag_occurrence_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/vault/frontmatter.md", "markdown"),
                (2, "/vault/inline.md", "markdown"),
                (3, "/vault/valid.md", "markdown"),
                (4, "/vault/single.md", "markdown"),
            ],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "tags", "scalar", "goodTag/bad-tag"),
                (2, 1, None, "tags", "scalar", "goodTag/bad-tag"),
                (3, 3, None, "tags", "scalar", "goodTag/validTag"),
                (4, 4, None, "tags", "scalar", "bad-tag"),
            ],
        )
        connection.executemany(
            "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?)",
            [
                (4, 2, 10, "tag", "goodTag/validTag"),
                (5, 2, 11, "tag", "goodTag/bad-tag"),
            ],
        )
        connection.executemany(
            "INSERT INTO vault_tags VALUES (?, ?, ?)",
            [
                (1, "goodTag/bad-tag", None),
                (2, "goodTag/validTag", None),
                (3, "bad-tag", None),
            ],
        )
        connection.executemany(
            "INSERT INTO note_tag_occurrences VALUES (?, ?, ?, ?)",
            [
                (1, 1, 1, None),
                (2, 1, 2, None),
                (3, 2, 3, None),
                (4, 2, None, 4),
                (5, 1, None, 5),
                (6, 3, 4, None),
            ],
        )

        assert find_non_camel_case_tag_segments(connection) == [
            ValidationWarning(
                rule="nonCamelCaseTagSegment",
                path="/vault/frontmatter.md",
                message="Every segment of tag `goodTag/bad-tag` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseTagSegment",
                path="/vault/inline.md",
                message="Every segment of tag `goodTag/bad-tag` must use camelCase.",
            ),
            ValidationWarning(
                rule="nonCamelCaseTagSegment",
                path="/vault/single.md",
                message="Every segment of tag `bad-tag` must use camelCase.",
            ),
        ]


def test_find_unbalanced_math_braces_reports_unbalanced_math_nodes() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?)",
            [
                (1, 1, 4, "math", r"\frac{1}{2}"),
                (2, 1, 8, "inlineMath", r"\{literal\}"),
                (3, 1, 12, "math", r"\frac{1}{2"),
                (4, 1, 15, "inlineMath", "x}"),
                (5, 1, 20, "text", "{"),
            ],
        )

        assert find_unbalanced_math_braces(connection) == [
            ValidationWarning(
                rule="unbalancedMathBraces",
                path="/vault/note.md",
                message="MathJax contains unbalanced braces.",
                line=12,
            ),
            ValidationWarning(
                rule="unbalancedMathBraces",
                path="/vault/note.md",
                message="MathJax contains unbalanced braces.",
                line=15,
            ),
        ]


def test_find_code_blocks_without_language_reports_only_unlabeled_fenced_code() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("ALTER TABLE markdown_nodes ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '{}'")
        connection.execute("INSERT INTO vault_files VALUES (1, '/vault/note.md', 'markdown')")
        connection.executemany(
            "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, 4, "code", "code", '{"fenced": true}'),
                (2, 1, 8, "code", "code", '{"fenced": true, "lang": null}'),
                (3, 1, 12, "code", "code", '{"fenced": true, "lang": ""}'),
                (4, 1, 16, "code", "code", '{"fenced": true, "lang": "  "}'),
                (5, 1, 20, "code", "code", '{"fenced": true, "lang": "\\t"}'),
                (6, 1, 24, "code", "code", '{"fenced": true, "lang": "\\u00a0"}'),
                (7, 1, 28, "code", "code", '{"fenced": true, "lang": "python"}'),
                (8, 1, 32, "code", "code", '{"fenced": false}'),
                (9, 1, 36, "inlineCode", "code", "{}"),
                (10, 1, 40, "text", "text", "{}"),
            ],
        )

        assert find_code_blocks_without_language(connection) == [
            ValidationWarning(
                rule="codeBlockMissingLanguage",
                path="/vault/note.md",
                message="Fenced code blocks must specify a language.",
                line=line,
            )
            for line in (4, 8, 12, 16, 20, 24)
        ]


def test_find_obsidian_callouts_reports_real_callouts_in_path_and_line_order() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.execute("ALTER TABLE markdown_nodes ADD COLUMN attributes_json TEXT NOT NULL DEFAULT '{}'")
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/vault/zeta.md", "markdown"),
                (2, "/vault/alpha.md", "markdown"),
            ],
        )
        connection.executemany(
            "INSERT INTO markdown_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, 20, "blockquote", None, '{"callout": true}'),
                (2, 1, 4, "blockquote", None, '{"callout": true}'),
                (3, 1, 8, "blockquote", None, '{"callout": false}'),
                (4, 2, 12, "blockquote", None, '{"callout": true}'),
            ],
        )

        assert find_obsidian_callouts(connection) == [
            ValidationWarning(
                rule="obsidianCallout",
                path="/vault/alpha.md",
                message="Obsidian callouts must not be used.",
                line=12,
            ),
            ValidationWarning(
                rule="obsidianCallout",
                path="/vault/zeta.md",
                message="Obsidian callouts must not be used.",
                line=4,
            ),
            ValidationWarning(
                rule="obsidianCallout",
                path="/vault/zeta.md",
                message="Obsidian callouts must not be used.",
                line=20,
            ),
        ]


def test_has_unbalanced_math_braces_handles_nesting_and_escaping() -> None:
    valid_values = (
        "{}",
        "{{}}",
        r"\frac{1}{2}",
    )
    invalid_values = (
        "}{",
        "{",
        "}",
        r"\{\frac{1}{2",
    )

    for value in valid_values:
        assert not _has_unbalanced_math_braces(value), value
    for value in invalid_values:
        assert _has_unbalanced_math_braces(value), value
    assert not _has_unbalanced_math_braces(r"\{")  # escaped brace
    assert _has_unbalanced_math_braces(r"\\{")  # structural opening brace
    assert not _has_unbalanced_math_braces(r"\\\{")  # escaped brace after \\ command


def test_is_camel_case_uses_the_filename_style_predicate() -> None:
    assert _is_camel_case("stateSpace")
    assert _is_camel_case("smb")
    assert not _is_camel_case("!!!")
    assert not _is_camel_case("State space")
    assert not _is_camel_case("state-space")
    assert not _is_camel_case("")


def test_find_aliases_without_non_camel_case_reports_notes_without_any_non_camel_case_value() -> None:
    with sqlite3.connect(":memory:") as connection:
        create_schema(connection)
        connection.executemany(
            "INSERT INTO vault_files VALUES (?, ?, ?)",
            [
                (1, "/vault/camel.md", "markdown"),
                (2, "/vault/readable.md", "markdown"),
                (3, "/vault/empty.md", "markdown"),
                (4, "/vault/nested.md", "markdown"),
                (5, "/vault/scalar.md", "markdown"),
            ],
        )
        connection.executemany(
            "INSERT INTO frontmatter_nodes VALUES (?, ?, ?, ?, ?, ?)",
            [
                (1, 1, None, "aliases", "sequence", None),
                (2, 1, 1, None, "scalar", "stateSpace"),
                (3, 2, None, "aliases", "sequence", None),
                (4, 2, 3, None, "scalar", "stateSpace"),
                (5, 2, 3, None, "scalar", "State space"),
                (6, 2, 3, None, "scalar", "!!!"),
                (7, 3, None, "aliases", "sequence", None),
                (8, 4, None, "metadata", "mapping", None),
                (9, 4, 8, "aliases", "sequence", None),
                (10, 4, 9, None, "scalar", "Readable Alias"),
                (11, 5, None, "aliases", "scalar", "stateSpace"),
            ],
        )

        assert find_aliases_without_non_camel_case(connection) == [
            ValidationWarning(
                rule="aliasMissingNonCamelCase",
                path="/vault/camel.md",
                message="Aliases must contain at least one non-camelCase value.",
            ),
            ValidationWarning(
                rule="aliasMissingNonCamelCase",
                path="/vault/empty.md",
                message="Aliases must contain at least one non-camelCase value.",
            ),
        ]
