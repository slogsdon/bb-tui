import assert from "node:assert/strict";
import test from "node:test";
import { parseInline, renderBlocks, renderMarkdown, wrapSpans, type MdLine } from "./markdown.js";

/** Plain text of a rendered line, as the terminal would show it. */
const flat = (line: MdLine): string => line.spans.map((s) => s.text).join("");
const flatten = (lines: MdLine[]): string[] => lines.map(flat);

test("headings render bold without the hash markers", () => {
  const lines = renderMarkdown("## Revised ranked plan", 40);
  assert.deepEqual(flatten(lines), ["Revised ranked plan"]);
  assert.equal(lines[0]!.spans[0]!.bold, true);
});

test("bullets get a marker and a hanging indent on continuation lines", () => {
  const lines = renderMarkdown("- alpha beta gamma delta epsilon", 16);
  assert.deepEqual(flatten(lines), ["• alpha beta", "  gamma delta", "  epsilon"]);
});

test("nested bullets indent by depth and change marker", () => {
  const lines = renderMarkdown("- top\n  - nested", 40);
  assert.deepEqual(flatten(lines), ["• top", "  ◦ nested"]);
});

test("ordered list markers are preserved", () => {
  assert.deepEqual(flatten(renderMarkdown("1. first\n2. second", 40)), ["1. first", "2. second"]);
});

test("inline code, bold and italic become styled spans", () => {
  const spans = parseInline("run `npm test` for **bold** and *soft* text");
  assert.equal(spans.find((s) => s.text === "npm test")?.color, "cyan");
  assert.equal(spans.find((s) => s.text === "bold")?.bold, true);
  assert.equal(spans.find((s) => s.text === "soft")?.italic, true);
});

test("snake_case identifiers are not italicised", () => {
  const spans = parseInline("call some_long_name now");
  assert.deepEqual(
    spans.map((s) => s.text),
    ["call some_long_name now"],
  );
  assert.equal(spans[0]!.italic, undefined);
});

test("links keep the label and dim the target", () => {
  const spans = parseInline("see [the docs](https://x.dev)");
  assert.equal(spans.find((s) => s.text === "the docs")?.text, "the docs");
  assert.equal(spans.find((s) => s.text.includes("https://x.dev"))?.dim, true);
});

test("code fences are gutter-marked and truncated, never word-wrapped", () => {
  const lines = renderMarkdown("```\nconst averylongidentifier = compute(alpha, beta)\n```", 20);
  assert.equal(lines.length, 1);
  const text = flat(lines[0]!);
  assert.ok(text.startsWith("│ "));
  assert.ok(text.endsWith("›"));
  assert.ok(text.length <= 20);
});

test("an unterminated fence keeps the remainder as code (streaming tolerance)", () => {
  const lines = renderMarkdown("intro\n```\nconst a = 1\nconst b = 2", 40);
  assert.deepEqual(flatten(lines), ["intro", "│ const a = 1", "│ const b = 2"]);
});

test("a dangling emphasis delimiter stays literal", () => {
  const lines = renderMarkdown("finished **half a bold", 40);
  assert.deepEqual(flatten(lines), ["finished **half a bold"]);
  assert.ok(lines[0]!.spans.every((s) => !s.bold));
});

test("blockquotes and rules get their own treatment", () => {
  assert.deepEqual(flatten(renderMarkdown("> quoted", 40)), ["│ quoted"]);
  assert.deepEqual(flatten(renderMarkdown("---", 6)), ["──────"]);
});

test("table rows are kept intact and the separator row is dimmed", () => {
  const lines = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |", 40);
  assert.deepEqual(flatten(lines), ["| a | b |", "| --- | --- |", "| 1 | 2 |"]);
  assert.equal(lines[1]!.spans[0]!.dim, true);
});

test("ANSI escapes and control bytes are stripped before layout", () => {
  const esc = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const dirty = [esc, "[31mred", esc, "[0m", bell, " text"].join("");
  assert.deepEqual(flatten(renderMarkdown(dirty, 40)), ["red text"]);
});

test("a token wider than the pane hard-breaks instead of overflowing", () => {
  const lines = renderMarkdown("/very/long/path/that/never/ends/at/all", 10);
  assert.ok(lines.every((l) => flat(l).length <= 10));
  assert.equal(flatten(lines).join(""), "/very/long/path/that/never/ends/at/all");
});

test("blank lines separate paragraphs but never lead or trail", () => {
  assert.deepEqual(flatten(renderMarkdown("\n\nfirst\n\n\nsecond\n\n", 40)), ["first", "", "second"]);
});

test("wrapSpans preserves styling across a break", () => {
  const rows = wrapSpans([{ text: "alpha beta", bold: true }], 6);
  assert.deepEqual(
    rows.map((r) => r.map((s) => s.text).join("")),
    ["alpha", "beta"],
  );
  assert.ok(rows.every((r) => r.every((s) => s.bold)));
});

test("transcript blocks are separated by a blank line and gutter only the first line", () => {
  const lines = renderBlocks(
    [
      { role: "user", text: "improve the thread view" },
      { role: "agent", text: "one two three four five six" },
    ],
    14,
  );
  assert.deepEqual(flatten(lines), ["› improve the", "  thread view", "", "one two three", "four five six"]);
});

test("work children are rendered with a tree gutter", () => {
  const lines = renderBlocks(
    [
      { role: "work", text: "Explored" },
      { role: "work", text: "Read SKILL.md", depth: 1 },
    ],
    40,
  );
  assert.deepEqual(flatten(lines), ["· Explored", "", "  └ Read SKILL.md"]);
});

test("agent blocks use the full pane width (no gutter)", () => {
  const lines = renderBlocks([{ role: "agent", text: "abcdefgh ijklmnop" }], 8);
  assert.deepEqual(flatten(lines), ["abcdefgh", "ijklmnop"]);
});
