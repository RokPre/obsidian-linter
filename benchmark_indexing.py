"""Compare fresh indexing against master at 75b2244 using identical temporary vaults."""

import argparse
import itertools
import json
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from time import perf_counter


BASELINE_COMMIT = "75b2244"
ROOT = Path(__file__).resolve().parent


def run_indexer(script: Path, vault: Path, database: Path) -> dict:
    """Measure a complete indexer run, including parser startup and final commit."""
    started = perf_counter()
    result = subprocess.run(
        [sys.executable, str(script), str(vault), str(database)], capture_output=True, text=True
    )
    elapsed = perf_counter() - started
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    stages = {
        name: float(milliseconds) / 1000
        for name, milliseconds in re.findall(r"^(\S+)\s+([\d.]+) ms total", result.stdout, re.MULTILINE)
    }
    return {"wall_seconds": elapsed, "database_bytes": database.stat().st_size, "stages": stages}


def compare_rows(baseline: Path, candidate: Path) -> dict[str, int]:
    """Compare every stored row in ID order without loading either database into memory."""
    counts = {}
    with sqlite3.connect(baseline) as before, sqlite3.connect(candidate) as after:
        tables = [row[0] for row in before.execute("SELECT name FROM sqlite_master WHERE type = 'table'")]
        assert set(tables) == {row[0] for row in after.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        for table in tables:
            left = before.execute(f'SELECT * FROM "{table}" ORDER BY id')
            right = after.execute(f'SELECT * FROM "{table}" ORDER BY id')
            count = 0
            for old, new in itertools.zip_longest(left, right):
                assert old == new, f"Different {table} row: {old!r} != {new!r}"
                count += 1
            counts[table] = count
        assert after.execute("PRAGMA foreign_key_check").fetchall() == []
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vault", type=Path)
    parser.add_argument("--files", type=int, default=2000)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    paths = sorted(args.vault.rglob("*.md"))
    count = min(args.files, len(paths))
    if count < 1 or args.runs < 1:
        parser.error("The vault must contain Markdown files; --files and --runs must be positive.")
    selected = [paths[i * len(paths) // count] for i in range(count)]
    results = {"baseline_commit": BASELINE_COMMIT, "files": count, "baseline": [], "candidate": []}

    with tempfile.TemporaryDirectory(prefix="indexing-benchmark-") as temporary:
        workspace = Path(temporary)
        baseline = workspace / "baseline"
        baseline.mkdir()
        for filename in ("indexer.py", "markdown_tree_parser.py", "markdown_tree_parser.mjs"):
            source = subprocess.check_output(["git", "show", f"{BASELINE_COMMIT}:{filename}"], cwd=ROOT)
            (baseline / filename).write_bytes(source)
        (baseline / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        vault = workspace / "vault"
        vault.mkdir()
        for path in selected:
            destination = vault / path.relative_to(args.vault)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)

        print(f"Fresh indexing: {count:,} Markdown files, {args.runs} runs per version", flush=True)
        for run in range(args.runs):
            order = ("baseline", "candidate") if run % 2 == 0 else ("candidate", "baseline")
            databases = {name: workspace / f"{name}-{run}.db" for name in order}
            for name in order:
                script = baseline / "indexer.py" if name == "baseline" else ROOT / "indexer.py"
                measurement = run_indexer(script, vault, databases[name])
                results[name].append(measurement)
                print(f"Run {run + 1}: {name:9} {measurement['wall_seconds']:.3f} s", flush=True)
            results["rows"] = compare_rows(databases["baseline"], databases["candidate"])
            print("All table rows match; foreign keys valid.", flush=True)
            for database in databases.values():
                database.unlink()

    print("\nMedian seconds                 baseline  candidate", flush=True)
    for stage in ("wall_seconds", *results["baseline"][0]["stages"]):
        medians = []
        for name in ("baseline", "candidate"):
            values = [run[stage] if stage == "wall_seconds" else run["stages"].get(stage, 0) for run in results[name]]
            medians.append(statistics.median(values))
        print(f"{stage:30} {medians[0]:8.3f}  {medians[1]:8.3f}")
    print("Database bytes:", results["baseline"][0]["database_bytes"], "->", results["candidate"][0]["database_bytes"])
    if args.output:
        args.output.write_text(json.dumps(results, indent=2) + "\n")


if __name__ == "__main__":
    main()
