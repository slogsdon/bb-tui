// bb-plugin-bb-tui — server backend for the bb-tui terminal client.
//
// Surfaces:
//   rpc   getClientInfo, listThreads, getTimeline, eventsSince
//   cli   `bb tui info` — server discovery for the client
//   bg    buffering service: lifecycle + message delta events -> SQLite
//   cfg   retentionDays (days) via `bb plugin config bb-tui set ...`
//
// The buffer is the client's live-update channel: the service wakes on
// bb.sdk realtime `thread:changed`, drains bb.sdk.threads.events.list per hot
// thread, and appends rows with a plugin-local monotonic seq the client can
// cursor over (rpc/eventsSince). Content deltas (item/agentMessage/delta,
// item/reasoning/textDelta) are included, so the TUI gets near-streaming text,
// not just state.
//
// Learned in Phase-1 spike: bb.sdk.threads.events.wait rejects an empty event
// type (HTTP 400 "expected string to have >=1 characters") and lists events
// via a per-thread server seq cursor, so the drain uses events.list instead.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Kept in step with package.json `version` by hand; the manifest is the
 * source of truth for installs, this is only what the client displays. */
const PLUGIN_VERSION = "0.1.0";

const rpcContract = defineRpcContract({
  getClientInfo: {
    input: z.null(),
    output: z.object({
      serverUrl: z.string(),
      dataDir: z.string(),
      version: z.string(),
      pluginVersion: z.string(),
      retentionDays: z.number(),
      prefs: z.object({
        hideReasoning: z.boolean(),
        pollMs: z.number(),
      }),
      // Optional spawn target for the client's alternate new-thread shortcut.
      // Null means "use the project's own defaults".
      spawn: z
        .object({ provider: z.string().nullable(), model: z.string().nullable() })
        .nullable(),
    }),
  },
  listThreads: {
    input: z
      .object({
        projectId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    output: z.object({ threads: z.array(z.unknown()) }),
  },
  getTimeline: {
    // `before` requests the page of rows older than a cursor the previous
    // response handed back; omitted, the response is the latest page.
    input: z
      .object({
        threadId: z.string(),
        before: z.object({ anchorSeq: z.number(), anchorId: z.string() }).strict().optional(),
      })
      .strict(),
    output: z.object({
      items: z.array(z.unknown()),
      nextTs: z.number().optional(),
      // The timeline is windowed by an event budget, not by row count, so a
      // long thread returns a single turn. This is how the client learns there
      // is more above, and where to ask for it.
      page: z
        .object({
          hasOlderRows: z.boolean(),
          olderCursor: z.object({ anchorSeq: z.number(), anchorId: z.string() }).nullable(),
        })
        .optional(),
      // Plan mode is the provider's state, not a bb setting: bb reports it and
      // can cancel it, but nothing client-side can enter it.
      planMode: z.object({ prompt: z.string() }).nullable().optional(),
      // Execution options the thread's next turn will use. Absent from the
      // thread row; this resolver is the only place they exist.
      execution: z
        .object({ model: z.string(), permissionMode: z.string(), reasoningLevel: z.string() })
        .nullable()
        .optional(),
    }),
  },
  eventsSince: {
    input: z
      .object({
        afterSeq: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(2000).optional(),
        threadId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      events: z.array(
        z.object({
          seq: z.number().int(),
          threadId: z.string(),
          type: z.string(),
          payload: z.unknown(),
          ts: z.number().int(),
        }),
      ),
      nextCursor: z.number().int().nonnegative(),
    }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("bb-tui backend loaded");

  const settings = bb.settings.define({
    retentionDays: { type: "string", label: "Event buffer retention (days)", default: "7" },
    hideReasoning: { type: "boolean", label: "Suppress reasoning deltas in TUI", default: false },
    pollMs: { type: "string", label: "Client poll interval (ms)", default: "800" },
    // The client reaches bb over loopback by default. Set this when the TUI
    // runs somewhere the server's own loopback URL does not resolve — another
    // machine, a container, a tunnel.
    serverUrl: {
      type: "string",
      label: "Server URL advertised to the TUI (blank = this server's loopback URL)",
      default: "",
    },
    // Spawn target for the client's alternate new-thread shortcut. Blank falls
    // back to the project's own defaults, which is what most setups want.
    spawnProvider: { type: "string", label: "Alternate spawn provider (blank = project default)", default: "" },
    spawnModel: { type: "string", label: "Alternate spawn model (blank = project default)", default: "" },
  });
  const cfg = await settings.get();
  const retentionDays = Math.max(1, Number.parseInt(cfg.retentionDays ?? "7", 10) || 7);

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS events (
       seq INTEGER PRIMARY KEY AUTOINCREMENT,
       thread_id TEXT NOT NULL,
       type TEXT NOT NULL,
       payload TEXT NOT NULL,
       ts INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_events_thread_seq ON events(thread_id, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
  ]);

  const insertEvent = db.prepare(
    `INSERT INTO events (thread_id, type, payload, ts) VALUES (?, ?, ?, ?)`,
  );
  const pruneStmt = db.prepare(`DELETE FROM events WHERE ts < ?`);

  function bufferEvent(threadId: string, type: string, payload: unknown): number | null {
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      bb.log.warn(`dropping unencodable event ${type} for ${threadId}`);
      return null;
    }
    try {
      const res = insertEvent.run(threadId, type, json, Date.now());
      pruneStmt.run(Date.now() - retentionDays * 86_400_000);
      const seq = Number(res.lastInsertRowid);
      if (seq % 256 === 0) bb.log.debug(`event buffer at seq ${seq} (retention ${retentionDays}d)`);
      return seq;
    } catch (err) {
      bb.log.error(`event buffer insert failed: ${String(err)}`);
      return null;
    }
  }

  // Dirty set for the drain loop: threads with recent activity. Cursor per
  // thread = the last server event seq we persisted.
  const pending = new Set<string>();
  const lastSeq = new Map<string, number>();
  const abort = new AbortController();
  let wakeWorker: (() => void) | null = null;

  function markDirty(threadId: string) {
    pending.add(threadId);
    wakeWorker?.();
  }

  // Pull new events for one thread from the server store and persist them.
  async function drainThread(threadId: string): Promise<void> {
    try {
      const from = lastSeq.get(threadId) ?? 0;
      const rows = await bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(from),
        limit: "500",
      });
      for (const row of rows) {
        bufferEvent(row.threadId, row.type, row);
        lastSeq.set(threadId, row.seq);
      }
      if (rows.length > 0) {
        bb.log.debug(`buffered ${rows.length} events for ${threadId} (via seq ${lastSeq.get(threadId)})`);
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        bb.log.warn(`events.list failed for ${threadId}: ${String(err)}`);
      }
    }
  }

  async function getClientInfoData() {
    let version = "unknown";
    try {
      const v = await bb.sdk.system.version();
      version = v.currentVersion;
    } catch (err) {
      bb.log.warn(`system.version failed: ${String(err)}`);
    }
    // Re-read rather than closing over the factory's snapshot: `bb tui info` is
    // a once-per-client-start call, and a settings save does not reload a
    // healthy plugin, so a stale snapshot would strand the user's edit.
    const live = await settings.get();
    const advertised = (live.serverUrl ?? "").trim();
    const provider = (live.spawnProvider ?? "").trim();
    const model = (live.spawnModel ?? "").trim();
    // Same reason as the URL above: a saved preference must reach the next
    // client start without a reload.
    const livePrefs = {
      hideReasoning: live.hideReasoning ?? false,
      pollMs: Math.max(200, Math.min(10_000, Number.parseInt(live.pollMs ?? "800", 10) || 800)),
    };
    return {
      serverUrl: advertised === "" ? bb.server.loopbackBaseUrl : advertised,
      dataDir: process.env.BB_DATA_DIR ?? "~/.bb",
      version,
      pluginVersion: PLUGIN_VERSION,
      retentionDays,
      prefs: livePrefs,
      spawn:
        provider === "" && model === ""
          ? null
          : { provider: provider === "" ? null : provider, model: model === "" ? null : model },
    };
  }

  bb.background.service("event-buffer", {
    async start(serviceSignal) {
      const sub = bb.sdk.subscribe({
        event: "thread:changed",
        callback: (msg) => {
          const id = msg.id;
          if (id && id.startsWith("thr_")) {
            markDirty(id);
            const meta = (msg as { metadata?: { eventTypes?: string[] } }).metadata;
            if (meta?.eventTypes?.length) {
              bb.log.debug(`realtime ${id}: ${meta.eventTypes.slice(0, 8).join(",")}`);
            }
          }
        },
      });
      bb.log.info("event-buffer service started (realtime + drain loop)");

      // Backfill: mark currently-active threads dirty so we don't miss a turn
      // that started before the plugin loaded.
      try {
        const act = await bb.sdk.threads.list({ includeHidden: true });
        for (const t of act) {
          if (t.status === "active" || t.status === "starting" || t.status === "error") {
            markDirty(t.id);
          }
        }
      } catch (err) {
        bb.log.warn(`active-thread backfill failed: ${String(err)}`);
      }

      try {
        while (!serviceSignal.aborted && !abort.signal.aborted) {
          if (pending.size > 0) {
            for (const threadId of pending) {
              await drainThread(threadId);
            }
            pending.clear();
            continue;
          }
          // Idle-sleep, waking on realtime activity or a watchdog timer.
          await new Promise<void>((resolve) => {
            wakeWorker = resolve;
            const timer = setTimeout(() => {
              wakeWorker = null;
              resolve();
            }, 3000);
            serviceSignal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                wakeWorker = null;
                resolve();
              },
              { once: true },
            );
          });
        }
      } finally {
        sub();
        bb.log.info("event-buffer service stopped");
      }
    },
  });

  // ---- RPC ----
  bb.rpc.register(rpcContract, {
    getClientInfo: () => getClientInfoData(),

    async listThreads({ projectId, limit }) {
      const res = await bb.sdk.threads.list({
        projectId,
        limit: limit ?? 200,
        includeHidden: false,
        archived: false,
      });
      return { threads: res as unknown[] };
    },

    async getTimeline({ threadId, before }) {
      // Both ride the timeline call the client already polls, so plan mode and
      // the execution options cost no extra round trip. A scroll-back page is
      // pure history: neither applies, so it skips that second call.
      const [res, exec] = await Promise.all([
        bb.sdk.threads.timeline(
          before
            ? { threadId, beforeAnchorSeq: String(before.anchorSeq), beforeAnchorId: before.anchorId }
            : { threadId },
        ),
        before ? null : bb.sdk.threads.defaultExecutionOptions({ threadId }).catch(() => null),
      ]);
      const plan = res.activePromptMode;
      return {
        items: res.rows as unknown[],
        page: {
          hasOlderRows: res.timelinePage.hasOlderRows,
          olderCursor: res.timelinePage.olderCursor,
        },
        planMode: plan ? { prompt: plan.prompt } : null,
        execution: exec
          ? {
              model: exec.model,
              permissionMode: exec.permissionMode,
              reasoningLevel: exec.reasoningLevel,
            }
          : null,
      };
    },

    eventsSince({ afterSeq, limit, threadId }) {
      const seq = afterSeq ?? 0;
      const rows = (
        threadId
          ? db
              .prepare(
                `SELECT seq, thread_id AS threadId, type, payload, ts
                   FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
              )
              .all(threadId, seq, limit ?? 500)
          : db
              .prepare(
                `SELECT seq, thread_id AS threadId, type, payload, ts
                   FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
              )
              .all(seq, limit ?? 500)
      ) as {
        seq: number;
        threadId: string;
        type: string;
        payload: string;
        ts: number;
      }[];
      const events = rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
      const nextCursor = events.length > 0 ? events[events.length - 1]!.seq : seq;
      return { events, nextCursor };
    },
  });

  // ---- CLI: server discovery for the client ----
  bb.cli.register({
    name: "tui",
    summary: "bb-tui client support",
    commands: [
      { name: "info", summary: "Print server + plugin facts the TUI client needs", usage: "bb tui info" },
    ],
    async run(argv) {
      if (argv[0] === "info") {
        const info = await getClientInfoData();
        return { exitCode: 0, stdout: `${JSON.stringify(info, null, 2)}\n` };
      }
      return { exitCode: 2, stderr: `usage: bb tui info\n` };
    },
  });

  bb.onDispose(() => {
    abort.abort();
    bb.log.info("bb-tui backend disposed");
  });
}