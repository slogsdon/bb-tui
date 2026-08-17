import assert from "node:assert/strict";
import test from "node:test";
import { BB_COMMAND_NAMES, buildCatalog, matchEntries, resolveSlash } from "./commands.js";

test("a message that is exactly a bb command runs it", () => {
  assert.deepEqual(resolveSlash("/compact"), { kind: "command", name: "compact", args: "" });
  assert.deepEqual(resolveSlash("  /compact  "), { kind: "command", name: "compact", args: "" });
  assert.deepEqual(resolveSlash("/compact keep the plan"), {
    kind: "command",
    name: "compact",
    args: "keep the plan",
  });
});

test("a command mentioned mid-sentence is ordinary text", () => {
  assert.deepEqual(resolveSlash("run /compact when done"), {
    kind: "text",
    text: "run /compact when done",
  });
});

test("skills and provider commands pass through untouched", () => {
  // bb injects skills and the agent resolves them; the TUI must not intercept.
  assert.deepEqual(resolveSlash("/repo-map"), { kind: "text", text: "/repo-map" });
  assert.deepEqual(resolveSlash("/agent-skills:code-review"), {
    kind: "text",
    text: "/agent-skills:code-review",
  });
  // Unknown names are never blocked — the provider may define them.
  assert.deepEqual(resolveSlash("/review"), { kind: "text", text: "/review" });
});

test("cancel-plan is a bb command; entering plan mode is not", () => {
  // bb exposes only the exit: `claudeCodePermissionMode: "plan"` is a
  // host-to-provider field no client can set, so /plan is passthrough text
  // that the provider itself acts on.
  assert.deepEqual(resolveSlash("/cancel-plan"), { kind: "command", name: "cancel-plan", args: "" });
  assert.deepEqual(resolveSlash("/plan"), { kind: "text", text: "/plan" });
});

test("a doubled slash escapes to a literal one", () => {
  assert.deepEqual(resolveSlash("//compact"), { kind: "text", text: "/compact" });
});

test("plain text is untouched", () => {
  assert.deepEqual(resolveSlash("hello"), { kind: "text", text: "hello" });
  assert.deepEqual(resolveSlash("/Users/shane/notes"), {
    kind: "text",
    text: "/Users/shane/notes",
  });
});

/** Two of the three fixture skills survive the catalog merge; the third
 * collides with a command name. Counting off BB_COMMAND_NAMES keeps these
 * assertions honest when a command is added. */
const COMMAND_COUNT = BB_COMMAND_NAMES.length;

const skills = [
  { name: "repo-map", description: "Identify a repo" },
  { name: "agent-skills:code-review-and-quality", description: "Conducts multi-axis code review" },
  { name: "compact", description: "a skill colliding with the command" },
];

test("the catalog merges commands and skills, commands winning a name clash", () => {
  const catalog = buildCatalog(skills);
  assert.equal(catalog.filter((e) => e.name === "compact").length, 1);
  assert.equal(catalog.find((e) => e.name === "compact")?.kind, "command");
  assert.equal(catalog.length, COMMAND_COUNT + 2);
});

test("a bare slash matches everything, commands first", () => {
  const matches = matchEntries(buildCatalog(skills), "/");
  assert.equal(matches.length, COMMAND_COUNT + 2);
  assert.equal(matches[0]?.kind, "command");
  assert.equal(matches.filter((m) => m.kind === "command").length, COMMAND_COUNT);
});

test("matching is case-insensitive and prefers prefix matches", () => {
  const matches = matchEntries(buildCatalog(skills), "/CODE");
  assert.deepEqual(
    matches.map((m) => m.name),
    ["agent-skills:code-review-and-quality"],
  );
});

test("a token matching nothing yields nothing, which is what hides the menu", () => {
  assert.deepEqual(matchEntries(buildCatalog(skills), "/Users"), []);
});
