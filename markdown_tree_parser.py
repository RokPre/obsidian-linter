"""Parse and print Markdown syntax trees with Quartz's Obsidian parser."""
import argparse
import json
import subprocess
from pathlib import Path


class MarkdownTreeParser:
    """Send Markdown source to one persistent Node parser process."""

    def __init__(self) -> None:
        self.process = subprocess.Popen(
            ["node", Path(__file__).with_suffix(".mjs")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True
        )

    def parse(self, source: str) -> dict:
        """Return the Markdown syntax tree for one source string."""
        self.process.stdin.write(json.dumps({"source": source}) + "\n")
        self.process.stdin.flush()
        return json.loads(self.process.stdout.readline())["tree"]

    def close(self) -> None:
        """Close the Node parser or terminate it after one second."""
        if self.process.poll() is not None:
            return

        self.process.stdin.close()
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait()


def main() -> None:
    """Parse one Markdown file and print its MDAST as JSON."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="Markdown file to parse")
    args = parser.parse_args()

    markdown_parser = MarkdownTreeParser()
    try:
        tree = markdown_parser.parse(args.path.read_text())
    finally:
        markdown_parser.close()

    print(json.dumps(tree, indent=2))


if __name__ == "__main__":
    main()
