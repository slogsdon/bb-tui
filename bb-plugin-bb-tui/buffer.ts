// The event buffer's storage layer, kept apart from the plugin wiring so it can
// be exercised against a real SQLite file without a bb server.
//
// Everything here runs synchronously inside the bb server's event loop — the
// plugin is in-process and better-sqlite3 has no async mode — so the shape of
// this module is set by one rule: a drained page costs one commit, not one per
// event. Measured, that rule is worth 37ms -> 0.9ms per 500-event page, all of
// it event-loop time the whole bb server was not serving anything else.
import type { Database } from "better-sqlite3";

/** Rows per `events.list` call. The drain keeps asking until a page comes back
 * short, so this bounds one round trip, not one turn. */
export const DRAIN_PAGE = 500;

/** Retention runs on this cadence instead of per insert. The window is measured
 * in days; sweeping it hundreds of times a second bought nothing and put a
 * DELETE in front of every streamed delta. */
export const PRUNE_INTERVAL_MS = 3_600_000;

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     thread_id TEXT NOT NULL,
     type TEXT NOT NULL,
     payload TEXT NOT NULL,
     ts INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_events_thread_seq ON events(thread_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
  // Drain position per thread. In memory alone it reset to zero on every
  // reload, and the next drain re-ingested the whole retained history under
  // fresh plugin seqs — duplicate rows, and a replayed conversation on every
  // connected client.
  `CREATE TABLE IF NOT EXISTS cursors (
     thread_id TEXT PRIMARY KEY,
     last_seq INTEGER NOT NULL
   )`,
  // Seed the cursors from what is already buffered, so the upgrade itself does
  // not trigger the re-ingest it exists to prevent. The source seq survives in
  // the stored payload (it is not one of the fields storedPayload drops), which
  // makes the high-water mark per thread recoverable exactly.
  `INSERT INTO cursors (thread_id, last_seq)
     SELECT thread_id, MAX(CAST(json_extract(payload, '$.seq') AS INTEGER))
       FROM events
      WHERE json_valid(payload) AND json_extract(payload, '$.seq') IS NOT NULL
      GROUP BY thread_id
     ON CONFLICT(thread_id) DO NOTHING`,
];

/** The fields of a bb event row this layer needs. Structural rather than the
 * SDK's union, so a test can hand it a plain object. */
export interface SourceRow {
  threadId: string;
  type: string;
  seq: number;
}

export interface BufferedRow {
  seq: number;
  threadId: string;
  type: string;
  payload: unknown;
  ts: number;
}

export interface EventsPage {
  events: BufferedRow[];
  nextCursor: number;
}

export interface BatchResult {
  stored: number;
  skipped: number;
  /** Source seq the batch advanced the thread's cursor to, or 0 for an empty page. */
  last: number;
}

/** What is worth storing of an event row. `threadId` and `type` are already
 * columns and `scope` is read by nothing — together they outweighed the delta
 * they wrapped on most rows, and every byte here is written, fsynced, kept for
 * the retention window and parsed again on each poll. */
export function storedPayload(row: SourceRow): unknown {
  const { threadId: _threadId, type: _type, scope: _scope, ...rest } = row as SourceRow &
    Record<string, unknown>;
  return rest;
}

export interface EventBuffer {
  /** Persist one drained page and the cursor it advances, in a single commit. */
  writeBatch(threadId: string, rows: SourceRow[]): BatchResult;
  /** Events past `afterSeq`, oldest first, optionally for one thread. */
  read(afterSeq: number, limit: number, threadId?: string): EventsPage;
  /** Drain cursors as persisted, for restoring the in-memory map on load. */
  cursors(): Map<string, number>;
  /** Delete events older than the retention window. Returns rows removed. */
  prune(olderThanMs: number): number;
}

export function createEventBuffer(db: Database): EventBuffer {
  // Deliberately no `synchronous` pragma. The fsync cost that made the old path
  // slow was per *commit*, and batching a page into one commit already removes
  // ~500 of them: measured on a 500-event page, batching alone takes 37ms down
  // to 0.9ms, and dropping to synchronous=NORMAL on top of that buys 0.1ms.
  // Not worth trading crash durability for.
  const insertEvent = db.prepare(
    `INSERT INTO events (thread_id, type, payload, ts) VALUES (?, ?, ?, ?)`,
  );
  const pruneStmt = db.prepare(`DELETE FROM events WHERE ts < ?`);
  const upsertCursor = db.prepare(
    `INSERT INTO cursors (thread_id, last_seq) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET last_seq = excluded.last_seq`,
  );
  const selectCursors = db.prepare(`SELECT thread_id AS threadId, last_seq AS lastSeq FROM cursors`);
  // Hoisted: these ran through db.prepare on every client poll, recompiling the
  // same two statements a few times a second.
  const selectAll = db.prepare(
    `SELECT seq, thread_id AS threadId, type, payload, ts
       FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
  );
  const selectThread = db.prepare(
    `SELECT seq, thread_id AS threadId, type, payload, ts
       FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  );

  const writeBatch = db.transaction((threadId: string, rows: SourceRow[]): BatchResult => {
    const now = Date.now();
    let last = 0;
    let stored = 0;
    let skipped = 0;
    for (const row of rows) {
      let json: string;
      try {
        json = JSON.stringify(storedPayload(row));
      } catch {
        // One unencodable row must not roll back the page it arrived in, and
        // must not stall the cursor behind it either.
        skipped += 1;
        last = row.seq;
        continue;
      }
      insertEvent.run(row.threadId, row.type, json, now);
      last = row.seq;
      stored += 1;
    }
    if (last > 0) upsertCursor.run(threadId, last);
    return { stored, skipped, last };
  });

  return {
    writeBatch: (threadId, rows) => writeBatch(threadId, rows),

    read(afterSeq, limit, threadId) {
      const rows = (
        threadId ? selectThread.all(threadId, afterSeq, limit) : selectAll.all(afterSeq, limit)
      ) as { seq: number; threadId: string; type: string; payload: string; ts: number }[];
      const events = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown }));
      const nextCursor = events.length > 0 ? events[events.length - 1]!.seq : afterSeq;
      return { events, nextCursor };
    },

    cursors() {
      const rows = selectCursors.all() as { threadId: string; lastSeq: number }[];
      return new Map(rows.map((r) => [r.threadId, r.lastSeq]));
    },

    prune(olderThanMs) {
      return pruneStmt.run(olderThanMs).changes;
    },
  };
}
