import assert from "node:assert/strict";
import test from "node:test";
import {
  applyKey,
  EMPTY,
  layoutComposer,
  replaceToken,
  slashTokenAt,
  type Composer,
} from "./composer.js";

const at = (text: string, cursor = text.length): Composer => ({ text, cursor });
const type = (state: Composer, data: string): Composer => applyKey(state, data, {});
const ctrl = (state: Composer, letter: string): Composer => applyKey(state, letter, { ctrl: true });

test("typing inserts at the cursor, not the end", () => {
  const state = type(at("helloworld", 5), " brave ");
  assert.deepEqual(state, { text: "hello brave world", cursor: 12 });
});

test("a paste arrives as one chunk and lands whole", () => {
  const state = type(EMPTY, "a whole pasted line");
  assert.equal(state.text, "a whole pasted line");
  assert.equal(state.cursor, 19);
});

test("control bytes are dropped but newlines survive", () => {
  const state = type(EMPTY, `a${String.fromCharCode(7)}b\nc`);
  assert.equal(state.text, "ab\nc");
});

test("Ink backspace and delete flags both erase before the cursor", () => {
  assert.deepEqual(applyKey(at("abc", 2), "", { backspace: true }), { text: "ac", cursor: 1 });
  assert.deepEqual(applyKey(at("abc"), "", { delete: true }), { text: "ab", cursor: 2 });
  assert.deepEqual(applyKey(at("abc", 2), "", { delete: true }), { text: "ac", cursor: 1 });
});

test("erase bytes in the data chunk are honoured too", () => {
  const state = applyKey(at("abc"), String.fromCharCode(127), {});
  assert.deepEqual(state, { text: "ab", cursor: 2 });
});

test("cursor movement clamps at both ends", () => {
  assert.equal(applyKey(at("abc", 0), "", { leftArrow: true }).cursor, 0);
  assert.equal(applyKey(at("abc", 3), "", { rightArrow: true }).cursor, 3);
  assert.equal(ctrl(at("abc", 1), "a").cursor, 0);
  assert.equal(ctrl(at("abc", 1), "e").cursor, 3);
});

test("ctrl-u and ctrl-k kill to the line edges", () => {
  assert.deepEqual(ctrl(at("hello world", 6), "u"), { text: "world", cursor: 0 });
  assert.deepEqual(ctrl(at("hello world", 6), "k"), { text: "hello ", cursor: 6 });
});

test("ctrl-w deletes the word before the cursor, trailing space included", () => {
  assert.deepEqual(ctrl(at("stop the thread "), "w"), { text: "stop the ", cursor: 9 });
  assert.deepEqual(ctrl(at("one"), "w"), { text: "", cursor: 0 });
});

test("unhandled control chords never leak into the text", () => {
  assert.deepEqual(ctrl(at("abc"), "x"), { text: "abc", cursor: 3 });
  assert.deepEqual(ctrl(at("abc"), "l"), { text: "abc", cursor: 3 });
});

test("a slash token opens at index 0 or after a space", () => {
  assert.deepEqual(slashTokenAt(at("/comp")), { text: "/comp", start: 0, end: 5 });
  assert.deepEqual(slashTokenAt(at("to match /")), { text: "/", start: 9, end: 10 });
  assert.deepEqual(slashTokenAt(at("run /compact now", 12)), { text: "/compact", start: 4, end: 12 });
});

test("a slash inside a word never opens the menu", () => {
  assert.equal(slashTokenAt(at("http://host")), null);
  assert.equal(slashTokenAt(at("and/or")), null);
  assert.equal(slashTokenAt(at("plain text")), null);
});

test("an absolute path is a slash token, and stays one", () => {
  // It opens the menu; zero matches is what hides it again.
  assert.deepEqual(slashTokenAt(at("/usr/local")), { text: "/usr/local", start: 0, end: 10 });
});

test("accepting an entry replaces the token in place, without doubling the space", () => {
  const state = at("look at /api here", 12);
  const token = slashTokenAt(state);
  assert.ok(token);
  assert.deepEqual(replaceToken(state, token, "agent-skills:api-and-interface-design"), {
    text: "look at /agent-skills:api-and-interface-design here",
    cursor: 47,
  });
});

test("accepting at the end of the input adds the trailing space itself", () => {
  const state = at("/comp");
  const token = slashTokenAt(state);
  assert.ok(token);
  assert.deepEqual(replaceToken(state, token, "compact"), { text: "/compact ", cursor: 9 });
});

test("layout wraps hard and keeps every character", () => {
  const layout = layoutComposer(at("aaaabbbbcc"), 4, 5);
  assert.deepEqual(layout.rows, ["aaaa", "bbbb", "cc"]);
  assert.equal(layout.rows.join(""), "aaaabbbbcc");
});

test("layout preserves the user's own spaces", () => {
  const layout = layoutComposer(at("a  b"), 10, 3);
  assert.deepEqual(layout.rows, ["a  b"]);
});

test("the cursor maps to the right row and column", () => {
  assert.deepEqual(
    { ...layoutComposer(at("aaaabbbb", 5), 4, 5) },
    { rows: ["aaaa", "bbbb"], cursorRow: 1, cursorCol: 1, scrolled: false },
  );
});

test("a cursor past a full row moves to a fresh row below", () => {
  const layout = layoutComposer(at("aaaa"), 4, 5);
  assert.deepEqual(layout.rows, ["aaaa", ""]);
  assert.equal(layout.cursorRow, 1);
  assert.equal(layout.cursorCol, 0);
});

test("newlines start a new row", () => {
  const layout = layoutComposer(at("ab\ncd", 4), 10, 5);
  assert.deepEqual(layout.rows, ["ab", "cd"]);
  assert.equal(layout.cursorRow, 1);
  assert.equal(layout.cursorCol, 1);
});

test("the window scrolls to keep the cursor visible", () => {
  const layout = layoutComposer(at("aaaabbbbccccdddd"), 4, 2);
  assert.deepEqual(layout.rows, ["dddd", ""]);
  assert.equal(layout.cursorRow, 1);
  assert.equal(layout.scrolled, true);
});

test("an empty composer still yields one row", () => {
  assert.deepEqual(layoutComposer(EMPTY, 10, 3), {
    rows: [""],
    cursorRow: 0,
    cursorCol: 0,
    scrolled: false,
  });
});
