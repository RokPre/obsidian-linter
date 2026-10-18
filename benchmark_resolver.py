"""Compare resolver implementations on a temporary copy of an existing vault database."""

import argparse
import ast
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from time import perf_counter

import indexer


BASELINE_COMMIT = "3188cf2"


def load_baseline():
    """Load the resolver from the pre-prototype snapshot without importing that module."""
    source = subprocess.check_output(
        ["git", "show", f"{BASELINE_COMMIT}:indexer.py"], cwd=Path(__file__).parent, text=True
    )
    function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef)
                    and node.name == "resolve_vault_links")
    namespace = {"sqlite3": sqlite3, "Path": Path, "perf_counter": perf_counter,
                 "record_timing": indexer.record_timing}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "baseline_resolver", "exec"), namespace)
    return namespace["resolve_vault_links"]


def measure(connection, label, resolver):
    """Time the complete resolver from the same state without committing."""
    connection.execute("SAVEPOINT resolver_run")
    indexer.TIMINGS.clear()
    started = perf_counter()
    resolver(connection.cursor())
    elapsed = perf_counter() - started
    targets = connection.execute(
        "SELECT id, target_file_id, target_node_id FROM vault_links ORDER BY id"
    ).fetchall()
    connection.execute("ROLLBACK TO resolver_run")
    connection.execute("RELEASE resolver_run")
    print(f"{label:32} {elapsed:9.3f} s", flush=True)
    return targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--sample-links", type=int, default=2000)
    args = parser.parse_args()
    baseline = load_baseline()

    with tempfile.TemporaryDirectory(prefix="resolver-benchmark-") as temporary:
        with sqlite3.connect(Path(temporary) / "index.db") as connection:
            with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True, timeout=5) as source:
                print("Copying database read-only to temporary storage ...", flush=True)
                source.backup(connection)
            connection.execute("PRAGMA foreign_keys = ON")
            note_count = connection.execute("SELECT COUNT(*) FROM vault_notes").fetchone()[0]
            link_ids = [row[0] for row in connection.execute("SELECT id FROM vault_links ORDER BY id")]
            wiki_count = connection.execute(
                "SELECT COUNT(*) FROM vault_links WHERE link_syntax = 'wikilink'"
            ).fetchone()[0]
            print(f"{note_count:,} notes; {len(link_ids):,} links; {wiki_count:,} wikilinks", flush=True)
            print("Timings exclude database copying, index creation, and transaction commit.", flush=True)
            print("Query plan:", connection.execute(
                "EXPLAIN QUERY PLAN SELECT id FROM vault_notes WHERE name = ?", ("example",)
            ).fetchall(), flush=True)

            connection.execute("SAVEPOINT sample")
            sample_size = min(args.sample_links, len(link_ids))
            connection.execute("CREATE TEMP TABLE sampled_links (id INTEGER PRIMARY KEY)")
            connection.executemany("INSERT INTO sampled_links VALUES (?)", (
                (link_ids[i * len(link_ids) // sample_size],) for i in range(sample_size)
            ))
            connection.execute("DELETE FROM vault_links WHERE id NOT IN (SELECT id FROM sampled_links)")
            print(f"\nEvenly spaced sample: {sample_size:,} links; all notes retained", flush=True)
            expected = measure(connection, "Current / sample", baseline)
            started = perf_counter()
            connection.execute("CREATE INDEX resolver_benchmark_name_idx ON vault_notes(name)")
            print(f"Name index creation: {perf_counter() - started:.3f} s", flush=True)
            assert measure(connection, "Name index / sample", baseline) == expected
            connection.execute("DROP INDEX resolver_benchmark_name_idx")
            assert measure(connection, "Name dictionary / sample", indexer.resolve_vault_links) == expected
            connection.execute("ROLLBACK TO sample")
            connection.execute("RELEASE sample")
            print("Sample targets match for all three implementations.", flush=True)

            print("\nFull database (unindexed baseline omitted):", flush=True)
            connection.execute("CREATE INDEX resolver_benchmark_name_idx ON vault_notes(name)")
            expected = measure(connection, "Name index / full", baseline)
            connection.execute("DROP INDEX resolver_benchmark_name_idx")
            assert measure(connection, "Name dictionary / full", indexer.resolve_vault_links) == expected
            print("Full targets match. Source database was not modified.", flush=True)


if __name__ == "__main__":
    main()
