import assert from "node:assert/strict";
import test from "node:test";
import { enterAlternateScreen } from "./terminal.js";

test("enters the alternate screen and homes the cursor", () => {
  const writes: string[] = [];

  enterAlternateScreen({
    write: (value: string) => writes.push(value),
  });

  assert.equal(writes[0], "\u001B[?1049h\u001B[H");
});

test("restores the primary screen exactly once", () => {
  const writes: string[] = [];
  const restore = enterAlternateScreen({
    write: (value: string) => writes.push(value),
  });

  restore();
  restore();

  assert.deepEqual(writes, [
    "\u001B[?1049h\u001B[H",
    "\u001B[?25h\u001B[?1049l",
  ]);
});
