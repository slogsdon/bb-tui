import assert from "node:assert/strict";
import test from "node:test";
import { enableMouse, isMouseInput, parseMouse } from "./mouse.js";
import { hitTest } from "./layout.js";

const ESC = "\u001B";

test("parses an SGR press and drops its release", () => {
  assert.deepEqual(parseMouse(`${ESC}[<0;12;7M`), [{ kind: "press", button: 0, x: 12, y: 7 }]);
  assert.deepEqual(parseMouse(`${ESC}[<0;12;7m`), []);
});

test("parses wheel reports in both directions, with or without the escape", () => {
  assert.deepEqual(parseMouse(`${ESC}[<64;3;9M`), [
    { kind: "wheel", direction: "up", x: 3, y: 9 },
  ]);
  // Ink strips the leading escape before a data handler sees the chunk.
  assert.deepEqual(parseMouse("[<65;3;9M"), [{ kind: "wheel", direction: "down", x: 3, y: 9 }]);
});

test("recognises mouse chunks so the key handler can skip them", () => {
  assert.equal(isMouseInput(`${ESC}[<0;1;1M`), true);
  assert.equal(isMouseInput("[<0;1;1M"), true);
  assert.equal(isMouseInput("hello"), false);
  assert.equal(isMouseInput(`${ESC}[A`), false);
});

test("enable writes tracking on, and the returned disable runs once", () => {
  const written: string[] = [];
  const stop = enableMouse({ write: (v: string) => written.push(v) });
  assert.match(written[0] ?? "", /\?1006h/);
  stop();
  stop();
  assert.equal(written.length, 2);
  assert.match(written[1] ?? "", /\?1006l/);
});

test("hit test maps columns to panes and rows to the list window", () => {
  // 120 columns: a 36-column list pane, detail to its right.
  assert.deepEqual(hitTest(120, 40, "list", 5, 3), { pane: "list", row: 0 });
  assert.deepEqual(hitTest(120, 40, "list", 5, 8), { pane: "list", row: 5 });
  assert.deepEqual(hitTest(120, 40, "list", 90, 8), { pane: "detail" });
  // The top bar, the pane border and the footer are not rows.
  assert.equal(hitTest(120, 40, "list", 5, 1), null);
  assert.equal(hitTest(120, 40, "list", 5, 2), null);
  assert.equal(hitTest(120, 40, "list", 5, 39), null);
});

test("hit test follows focus when only one pane is drawn", () => {
  assert.deepEqual(hitTest(60, 40, "detail", 5, 8), { pane: "detail" });
  assert.deepEqual(hitTest(60, 40, "list", 5, 8), { pane: "list", row: 5 });
});
