import argparse
import sqlite3
from pathlib import Path

import requests

MODEL = "nimble"
ADD_THRESHOLD = 0.75
REMOVE_THRESHOLD = 0.75


def parse_args() -> tuple[Path, Path]:
    parser = argparse.ArgumentParser(description="Pick tags for a note.")
    parser.add_argument("database", type=Path)
    parser.add_argument("file_path", type=Path)
    args = parser.parse_args()

    file_path = args.file_path.expanduser().resolve()
    database_path = args.database.expanduser().resolve()

    for path in (file_path, database_path):
        if not path.exists():
            parser.error(f"Path does not exist: {path}")
        if not path.is_file():
            parser.error(f"Path is not a file: {path}")

    if database_path.suffix.lower() != ".db":
        parser.error(f"Database path must have a .db suffix: {database_path}")

    return file_path, database_path


def find_file_id(file_path: Path, database_path: Path) -> int:
    with sqlite3.connect(database_path) as connection:
        row = connection.execute("SELECT id FROM vault_files WHERE path = ?", (str(file_path),)).fetchone()

    if row is None:
        raise ValueError(f"File is not present in the SQLite index: {file_path}")

    return row[0]


def fetch_file_tags(file_id: int, database_path: Path) -> list[str]:
    with sqlite3.connect(database_path) as connection:
        rows = connection.execute(
            "SELECT DISTINCT tags.name "
            "FROM note_tag_occurrences AS occurrences "
            "JOIN vault_tags AS tags ON tags.id = occurrences.tag_id "
            "WHERE occurrences.frontmatter_node_id IN "
            "(SELECT id FROM frontmatter_nodes WHERE file_id = ?) "
            "OR occurrences.markdown_node_id IN "
            "(SELECT id FROM markdown_nodes WHERE file_id = ?) "
            "ORDER BY tags.name",
            (file_id, file_id),
        ).fetchall()

    return [tag_name for (tag_name,) in rows]


def fetch_vault_tags(database_path: Path) -> list[str]:
    with sqlite3.connect(database_path) as connection:
        rows = connection.execute("SELECT name FROM vault_tags ORDER BY name").fetchall()

    return [tag_name for (tag_name,) in rows]


def fetch_file_content(file_id: int, database_path: Path, file_path: Path) -> str:
    with sqlite3.connect(database_path) as connection:
        row = connection.execute(
            "SELECT start_line FROM markdown_nodes WHERE file_id = ? AND parent_id IS NULL AND node_type = 'root'",
            (file_id,),
        ).fetchone()

    if row is None or row[0] is None:
        raise ValueError(f"Root Markdown node is not present for file ID: {file_id}")

    start_line = row[0]
    with open(file_path) as f:
        lines = f.readlines()

    return "".join(lines[start_line - 1:])


def ask_decision_model(note_content: str, vault_tags: list[str]):
    rated_tags = {}

    for start in range(0, len(vault_tags), 16):
        batch = vault_tags[start: start + 16]
        questions = {
            f"'{tag}'": {"type": "noul", "instructions": f"Does this note meaningfully fit the vault tag `{tag}`?"}
            for index, tag in enumerate(batch)
        }
        response = requests.post(
            "http://100.81.70.64:11434/v1/systemone",
            json={"model": "tev1:0.8b", "state": {"note": note_content}, "questions": questions},
            timeout=300,
        )
        response.raise_for_status()
        rated_tags.update({tag[1:-1]: answer for tag, answer in response.json()["answers"].items()})

    return dict(sorted(rated_tags.items(), key=lambda item: item[1]["noul"], reverse=True))


def ask_modify_tag_model(note_content: str, add_tags_candidates: list, remove_tags_candidates: list):
    add_questions = {
        f"'{tag}'": {"type": "noul", "instructions": f"Should tag `{tag}` be added to the note?"}
        for tag in add_tags_candidates
    }

    remove_questions = {
        f"'{tag}'": {"type": "noul", "instructions": f"Should tag `{tag}` be removed from the note?"}
        for tag in remove_tags_candidates
    }

    add_response = requests.post(
        "http://100.81.70.64:11434/v1/systemone",
        json={
            "model": MODEL,
            "state": {"note": note_content, "current_tags": add_questions},
            "questions": add_questions,
        },
        timeout=300,
    )
    add_response.raise_for_status()

    remove_response = requests.post(
        "http://100.81.70.64:11434/v1/systemone",
        json={
            "model": MODEL,
            "state": {"note": note_content, "current_tags": remove_questions},
            "questions": remove_questions,
        },
        timeout=300,
    )
    remove_response.raise_for_status()

    return add_response.json()["answers"], remove_response.json()["answers"]


def filter_decisions(decisions: dict, threshold: float) -> dict:
    return {tag: answer for tag, answer in decisions.items() if answer["noul"] > threshold}


def main() -> None:
    file_path, database_path = parse_args()

    file_id = find_file_id(file_path, database_path)
    current_tags = fetch_file_tags(file_id, database_path)
    vault_tags = fetch_vault_tags(database_path)

    print(current_tags)

    note_content = fetch_file_content(file_id, database_path, file_path)
    rated_tags = ask_decision_model(note_content, vault_tags)

    add_tags_candidates = list(rated_tags)[:5]
    remove_tags_candidates = list(set(current_tags) - set(add_tags_candidates))
    add_tag_decisions, remove_tag_decisions = ask_modify_tag_model(
        note_content, add_tags_candidates, remove_tags_candidates
    )

    print("add tags:", list(filter_decisions(add_tag_decisions, ADD_THRESHOLD)))
    print("remove tags:", list(filter_decisions(remove_tag_decisions, REMOVE_THRESHOLD)))


if __name__ == "__main__":
    main()
