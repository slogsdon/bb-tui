// The event buffer against a real SQLite database. These cover the properties
// the drain loop assumes and that a per-event autocommit used to give for free:
// a page is one commit, the cursor it advances is durable, and a rolled-back
// page leaves nothing behind.
import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createEventBuffer, MIGRATIONS, storedPayload, type SourceRow } from "./buffer.js";

function freshBuffer() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return { db, buffer: createEventBuffer(db) };
}

const row = (seq: number, threadId = "thr_a", data: unknown = { delta: "x" }): SourceRow =>
  ({ id: `ev_${seq}`, scope: "thread", threadId, type: "item/agentMessage/delta", seq, createdAt: seq, data }) as unknown as SourceRow;

test("a page is stored and read back oldest first", () => {
  const { buffer } = freshBuffer();
  const res = buffer.writeBatch("thr_a", [row(1), row(2), row(3)]);
  assert.equal(res.stored, 3);
  assert.equal(res.last, 3);

  const page = buffer.read(0, 500);
  assert.deepEqual(
    page.events.map((e) => e.seq),
    [1, 2, 3],
  );
  assert.equal(page.nextCursor, 3);
});

test("the cursor a page advances survives losing the in-memory map", () => {
  const { db, buffer } = freshBuffer();
  buffer.writeBatch("thr_a", [row(7), row(8)]);
  buffer.writeBatch("thr_b", [row(4, "thr_b")]);

  // What a plugin reload does: same file, brand new EventBuffer.
  const reloaded = createEventBuffer(db);
  assert.deepEqual([...reloaded.cursors()], [
    ["thr_a", 8],
    ["thr_b", 4],
  ]);
});

test("a failed page commits nothing, so the drain re-runs it rather than skipping it", () => {
  const { db, buffer } = freshBuffer();
  buffer.writeBatch("thr_a", [row(1)]);

  // A row that makes the INSERT itself fail, mid-page.
  const poison = { ...row(3), threadId: null } as unknown as SourceRow;
  assert.throws(() => buffer.writeBatch("thr_a", [row(2), poison, row(4)]));

  // The good row ahead of the poison must not have landed, and the cursor must
  // not have moved — both would silently drop events on the next drain.
  assert.deepEqual(
    buffer.read(0, 500).events.map((e) => e.seq),
    [1],
  );
  assert.equal(createEventBuffer(db).cursors().get("thr_a"), 1);
});

test("an unencodable row is skipped without rolling back its page", () => {
  const { buffer } = freshBuffer();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const res = buffer.writeBatch("thr_a", [row(1), row(2, "thr_a", cyclic), row(3)]);

  assert.equal(res.stored, 2);
  assert.equal(res.skipped, 1);
  // The cursor clears the skipped row: stalling on it would retry it forever.
  assert.equal(res.last, 3);
});

test("the stored payload drops what the columns already carry", () => {
  const stored = storedPayload(row(1)) as Record<string, unknown>;
  assert.equal(stored.threadId, undefined);
  assert.equal(stored.type, undefined);
  assert.equal(stored.scope, undefined);
  // The one field the client actually reads has to survive intact.
  assert.deepEqual(stored.data, { delta: "x" });
});

test("reading one thread ignores the rest, and an empty page holds the cursor", () => {
  const { buffer } = freshBuffer();
  buffer.writeBatch("thr_a", [row(1), row(2)]);
  buffer.writeBatch("thr_b", [row(1, "thr_b"), row(2, "thr_b")]);

  const mine = buffer.read(0, 500, "thr_a");
  assert.equal(mine.events.length, 2);
  assert.ok(mine.events.every((e) => e.threadId === "thr_a"));

  // Nothing new past the cursor: the client must get its own cursor back, not 0.
  assert.equal(buffer.read(mine.nextCursor, 500, "thr_a").nextCursor, mine.nextCursor);
});

test("prune drops events past the window and leaves the rest", () => {
  const { db, buffer } = freshBuffer();
  buffer.writeBatch("thr_a", [row(1), row(2)]);
  db.prepare(`UPDATE events SET ts = ? WHERE seq = 1`).run(1_000);

  assert.equal(buffer.prune(10_000), 1);
  assert.deepEqual(
    buffer.read(0, 500).events.map((e) => e.seq),
    [2],
  );
});

test("the cursor seed recovers a high-water mark from already-buffered rows", () => {
  // The upgrade path: a database that predates the cursors table must not make
  // the first drain after it re-ingest from zero.
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS.slice(0, 3)) db.exec(statement);
  const insert = db.prepare(`INSERT INTO events (thread_id, type, payload, ts) VALUES (?, ?, ?, ?)`);
  for (const [threadId, seq] of [["thr_a", 10], ["thr_a", 42], ["thr_b", 7]] as const) {
    insert.run(threadId, "item/agentMessage/delta", JSON.stringify({ seq, data: {} }), 1);
  }
  // A row from before the payload carried a seq at all must not break the seed.
  insert.run("thr_c", "legacy", "not json", 1);

  for (const statement of MIGRATIONS.slice(3)) db.exec(statement);

  const seeded = createEventBuffer(db).cursors();
  assert.equal(seeded.get("thr_a"), 42);
  assert.equal(seeded.get("thr_b"), 7);
  assert.equal(seeded.get("thr_c"), undefined);
});
