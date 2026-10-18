import argparse
import sqlite3
from pathlib import Path


def parse_args() -> tuple[Path, str, str, bool]:
    parser = argparse.ArgumentParser(description="Rename a tag in vault files.")
    parser.add_argument("database", type=Path)
    parser.add_argument("old_tag")
    parser.add_argument("new_tag")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    database_path = args.database.expanduser().resolve()
    if not database_path.exists():
        parser.error(f"Path does not exist: {database_path}")
    if not database_path.is_file():
        parser.error(f"Path is not a file: {database_path}")
    if database_path.suffix.lower() != ".db":
        parser.error(f"Database path must have a .db suffix: {database_path}")
    return database_path, args.old_tag, args.new_tag, args.dry_run


def fetch_vault_root_path(database_path: Path) -> Path:
    with sqlite3.connect(f"{database_path.as_uri()}?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT path FROM vault_directories WHERE parent_id IS NULL").fetchone()

    if row is None:
        raise RuntimeError("Vault root directory is missing from the index.")
    return Path(row[0])


def fetch_tag_id(database_path: Path, tag_name: str) -> int:
    """Return the ID of the exact tag name."""
    with sqlite3.connect(f"{database_path.as_uri()}?mode=ro", uri=True) as connection:
        row = connection.execute("SELECT id FROM vault_tags WHERE name = ?", (tag_name,)).fetchone()

    if row is None:
        raise ValueError(f"Tag not found: {tag_name}")
    return row[0]


def fetch_tag_occurrences(database_path: Path, tag_id: int) -> list[tuple[int, str, str, str, int, int | None]]:
    """Return one flat row per occurrence of a tag."""
    with sqlite3.connect(f"{database_path.as_uri()}?mode=ro", uri=True) as connection:
        return connection.execute(
            """SELECT tags.id, tags.name, files.path,
                      CASE WHEN occurrences.markdown_node_id IS NULL THEN 'yaml' ELSE 'inline' END,
                      COALESCE(occurrences.markdown_node_id, occurrences.frontmatter_node_id),
                      COALESCE(frontmatter.start_line, markdown.start_line) AS start_line
               FROM note_tag_occurrences AS occurrences
               JOIN vault_tags AS tags ON tags.id = occurrences.tag_id
               LEFT JOIN frontmatter_nodes AS frontmatter
                 ON frontmatter.id = occurrences.frontmatter_node_id
               LEFT JOIN markdown_nodes AS markdown
                 ON markdown.id = occurrences.markdown_node_id
               JOIN vault_files AS files
                 ON files.id = COALESCE(frontmatter.file_id, markdown.file_id)
               WHERE tags.id = ?
               ORDER BY files.path,
                        COALESCE(frontmatter.start_line, markdown.start_line),
                        occurrences.id""",
            (tag_id,),
        ).fetchall()


def replace_tag_occurrences(database_path: Path, tag_id: int, old_tag: str, new_tag: str, dry_run: bool) -> None:
    file_lines: dict[str, list[str]] = {}

    for _, _, file_path, _, _, line_number in fetch_tag_occurrences(database_path, tag_id):
        if file_path not in file_lines:
            with Path(file_path).open(encoding="utf-8", newline="") as source_file:
                file_lines[file_path] = source_file.readlines()

        lines = file_lines[file_path]
        original_line = lines[line_number - 1]
        new_line = original_line.replace(old_tag, new_tag)

        print(f"{file_path}:{line_number}")
        print(f"-{original_line}")
        print(f"+{new_line}")

        lines[line_number - 1] = new_line

    if not dry_run:
        for file_path, lines in file_lines.items():
            with Path(file_path).open("w", encoding="utf-8", newline="") as destination_file:
                destination_file.writelines(lines)


def main() -> None:
    database_path, old_tag, new_tag, dry_run = parse_args()
    tag_id = fetch_tag_id(database_path, old_tag)
    replace_tag_occurrences(database_path, tag_id, old_tag, new_tag, dry_run)


if __name__ == "__main__":
    main()
