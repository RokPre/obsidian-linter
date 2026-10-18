import { createInterface } from "node:readline";

import remarkGfm from "remark-gfm";
import remarkObsidian from "@quartz-community/remark-obsidian";
import remarkParse from "remark-parse";
import { unified } from "unified";

async function readStdin() {
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
  }
  return source;
}

function splitFrontmatter(source) {
  const firstLineEnd = source.indexOf("\n");
  const firstLine = source.slice(0, firstLineEnd === -1 ? source.length : firstLineEnd).replace(/\r$/, "");
  if (firstLineEnd === -1 || firstLine !== "---") {
    return { markdown: source, offset: 0, lineOffset: 0 };
  }

  let cursor = firstLineEnd + 1;
  while (cursor <= source.length) {
    const nextLineEnd = source.indexOf("\n", cursor);
    const lineEnd = nextLineEnd === -1 ? source.length : nextLineEnd;
    const line = source.slice(cursor, lineEnd).replace(/\r$/, "");
    const nextCursor = nextLineEnd === -1 ? source.length : nextLineEnd + 1;

    if (line === "---") {
      return {
        markdown: source.slice(nextCursor),
        offset: nextCursor,
        lineOffset: source.slice(0, nextCursor).split("\n").length - 1,
      };
    }

    if (nextLineEnd === -1) {
      break;
    }
    cursor = nextCursor;
  }

  return { markdown: source, offset: 0, lineOffset: 0 };
}

function shiftPositions(node, offset, lineOffset) {
  if (node.position) {
    node.position.start.offset += offset;
    node.position.end.offset += offset;
    node.position.start.line += lineOffset;
    node.position.end.line += lineOffset;
  }

  for (const child of node.children ?? []) {
    shiftPositions(child, offset, lineOffset);
  }
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkObsidian);
function markFencedCodeNodes(node, source) {
  if (node.type === "code") {
    const offset = node.position?.start?.offset;
    const marker = typeof offset === "number" ? source[offset] : null;
    node.fenced =
      (marker === "`" || marker === "~") &&
      source.slice(offset, offset + 3) === marker.repeat(3);
  }

  for (const child of node.children ?? []) {
    markFencedCodeNodes(child, source);
  }
}

function markCalloutNodes(node, source) {
  if (node.type === "blockquote") {
    const offset = node.position?.start?.offset;
    const lineEnd = typeof offset === "number" ? source.indexOf("\n", offset) : -1;
    const line = typeof offset === "number"
      ? source.slice(offset, lineEnd === -1 ? source.length : lineEnd).replace(/\r$/, "")
      : "";
    const firstChild = node.children?.[0];
    const hasCalloutMarker = /^>[ \t]*\[![A-Za-z0-9_-]+(?:\|[^\]]*)?\](?:[+-])?.*[ \t]*$/i.test(line);
    node.callout =
      hasCalloutMarker &&
      (firstChild?.type === "paragraph" || firstChild?.type === "heading");
  }

  for (const child of node.children ?? []) {
    markCalloutNodes(child, source);
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  const { source } = JSON.parse(line);
  const { markdown, offset, lineOffset } = splitFrontmatter(source);
  const tree = processor.parse(markdown);
  markFencedCodeNodes(tree, markdown);
  markCalloutNodes(tree, markdown);
  shiftPositions(tree, offset, lineOffset);
  process.stdout.write(`${JSON.stringify({ tree })}\n`);
}

