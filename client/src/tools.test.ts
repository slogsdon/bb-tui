import assert from "node:assert/strict";
import test from "node:test";
import type { BufferedEvent } from "./api.js";
import { assembleToolItems, toolItemText, type ToolItem } from "./tools.js";

const event = (type: string, item: unknown, ts = 1): BufferedEvent =>
  ({ seq: ts, threadId: "thr_a", type, ts, payload: { data: { item } } }) as unknown as BufferedEvent;

test("renders one line per tool item kind", () => {
  assert.equal(toolItemText({ type: "toolCall", tool: "read", arguments: { path: "/tmp/a.ts" } }), "⚒ read /tmp/a.ts");
  assert.equal(toolItemText({ type: "commandExecution", command: "ls -la\nmore" }), "$ ls -la");
  assert.equal(
    toolItemText({ type: "fileChange", changes: [{ path: "/a/b/README.md", kind: "add" }] }),
    "✎ add README.md",
  );
  assert.equal(toolItemText({ type: "backgroundTask", description: "npm test" }), "⚙ npm test");
  // Text items have their own layers.
  assert.equal(toolItemText({ type: "agentMessage" }), null);
  assert.equal(toolItemText({ type: "reasoning" }), null);
});

test("marks failures", () => {
  assert.equal(toolItemText({ type: "commandExecution", command: "false", status: "failed" }), "$ false ✗");
});

test("completion replaces the started line rather than adding one", () => {
  const map = new Map<string, ToolItem>();
  assembleToolItems(map, [
    event("item/started", { type: "commandExecution", id: "call_1", command: "ls", status: "pending" }, 10),
    event("item/completed", { type: "commandExecution", id: "call_1", command: "ls", status: "failed" }, 20),
    event("item/completed", { type: "agentMessage", id: "msg_1", text: "hi" }, 30),
  ]);
  assert.deepEqual([...map.entries()], [["thr_a::call_1", { text: "$ ls ✗", ts: 20 }]]);
});
