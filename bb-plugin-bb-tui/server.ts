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
// A drained page is one commit, not one per event (see buffer.ts): the plugin
// runs in-process and better-sqlite3 is synchronous, so every commit here is
// time the whole bb server is not serving anything else. `eventsSince` can also
// be long-polled — the drain wakes parked callers as it commits — so the client
// costs nothing while a thread is quiet and hears about a delta when it lands
// rather than on its next tick.
//
// Learned in Phase-1 spike: bb.sdk.threads.events.wait rejects an empty event
// type (HTTP 400 "expected string to have >=1 characters") and lists events
// via a per-thread server seq cursor, so the drain uses events.list instead.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createEventBuffer, DRAIN_PAGE, MIGRATIONS, PRUNE_INTERVAL_MS } from "./buffer.js";

/** Kept in step with package.json `version` by `version.test.ts`; the manifest
 * is the source of truth for installs, this is only what the client displays.
 * The client also reads it as a capability gate: 0.2.0 is the first build whose
 * `eventsSince` accepts `waitMs`, and the input schema is strict, so an older
 * plugin rejects the field outright rather than ignoring it. */
export const PLUGIN_VERSION = "0.2.0";

/** Longest a long-polled `eventsSince` parks before answering empty. Under any
 * intermediary's idle timeout, and short enough that a wedged connection costs
 * one stalled interval rather than a stalled session. */
const MAX_WAIT_MS = 25_000;

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
        // Long poll. With no rows past the cursor, hold the request open for up
        // to this long and answer the moment the drain commits one. Omitted or
        // zero keeps the original fire-and-return behaviour.
        waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
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
  bb.storage.migrate(db, MIGRATIONS);
  const buffer = createEventBuffer(db);

  // Dirty set for the drain loop: threads with recent activity. Cursor per
  // thread = the last server event seq we persisted, restored from `cursors` so
  // a reload resumes rather than re-ingesting.
  const pending = new Set<string>();
  const lastSeq = buffer.cursors();
  const abort = new AbortController();
  let wakeWorker: (() => void) | null = null;

  // Long-polled `eventsSince` calls parked with nothing to return. Woken by the
  // drain the moment it commits a page, which is what turns the client's 800ms
  // poll into an answer that arrives when the event does.
  const waiters = new Set<() => void>();

  function wakeWaiters() {
    if (waiters.size === 0) return;
    const woken = [...waiters];
    waiters.clear();
    for (const resolve of woken) resolve();
  }

  function markDirty(threadId: string) {
    pending.add(threadId);
    wakeWorker?.();
  }

  // Pull new events for one thread from the server store and persist them.
  // Keeps asking until a page comes back short: one call per wake left a thread
  // producing faster than DRAIN_PAGE waiting on the 3s watchdog for the rest.
  async function drainThread(threadId: string): Promise<void> {
    try {
      for (;;) {
        const from = lastSeq.get(threadId) ?? 0;
        const rows = await bb.sdk.threads.events.list({
          threadId,
          afterSeq: String(from),
          limit: String(DRAIN_PAGE),
        });
        if (rows.length === 0) return;
        // The in-memory cursor advances only once the commit that persisted it
        // returns; a rolled-back page must be re-drained, not skipped.
        const { stored, skipped, last } = buffer.writeBatch(threadId, rows);
        if (last > 0) lastSeq.set(threadId, last);
        if (skipped > 0) bb.log.warn(`dropped ${skipped} unencodable events for ${threadId}`);
        if (stored > 0) {
          bb.log.debug(`buffered ${stored} events for ${threadId} (via seq ${last})`);
          wakeWaiters();
        }
        if (rows.length < DRAIN_PAGE) return;
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        bb.log.warn(`events.list failed for ${threadId}: ${String(err)}`);
      }
    }
  }

  // Retention, on its own clock. This used to run as a DELETE behind every
  // insert to enforce a window measured in days.
  let lastPruneAt = 0;
  function pruneIfDue() {
    const now = Date.now();
    if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
    lastPruneAt = now;
    try {
      const removed = buffer.prune(now - retentionDays * 86_400_000);
      if (removed > 0) bb.log.debug(`pruned ${removed} events past ${retentionDays}d`);
    } catch (err) {
      bb.log.error(`event buffer prune failed: ${String(err)}`);
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
            // Take the batch before draining it. Marking a thread dirty while
            // the loop was already past it was a no-op on the Set, and the
            // clear() that followed then erased the signal — the thread waited
            // on the 3s watchdog. New marks now land in an empty set and are
            // picked up by the next turn of this loop.
            const batch = [...pending];
            pending.clear();
            for (const threadId of batch) {
              await drainThread(threadId);
            }
            continue;
          }
          pruneIfDue();
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

    async eventsSince({ afterSeq, limit, threadId, waitMs }) {
      const seq = afterSeq ?? 0;
      const first = readEvents(seq, limit ?? 500, threadId);
      // Answer immediately when there is anything to say, and when the caller
      // did not ask to wait — that is the pre-0.2.0 contract, unchanged.
      if (first.events.length > 0 || !waitMs) return first;
      // Keep waiting out the budget rather than returning on the first wake. A
      // wake means *some* thread committed a page, not this caller's: on a busy
      // server a single-shot wait is woken almost at once by unrelated traffic
      // and answers empty, which collapses the long poll back into a poll.
      const deadline = Date.now() + Math.min(waitMs, MAX_WAIT_MS);
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return readEvents(seq, limit ?? 500, threadId);
        await waitForEvents(remaining);
        // Disposal resolves every waiter; without this the loop would spin on a
        // signal that will never carry rows.
        if (abort.signal.aborted) return readEvents(seq, limit ?? 500, threadId);
        const page = readEvents(seq, limit ?? 500, threadId);
        if (page.events.length > 0) return page;
      }
    },
  });

  function readEvents(seq: number, limit: number, threadId?: string) {
    return buffer.read(seq, limit, threadId);
  }

  /** Park until the drain commits a page, the timeout expires, or the plugin is
   * disposed. A wake is a hint, not a promise: the caller re-queries, and a
   * per-thread waiter woken by another thread's activity simply answers empty. */
  function waitForEvents(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (abort.signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        abort.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      abort.signal.addEventListener("abort", done, { once: true });
    });
  }

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
      // A plugin CLI command runs in the server and returns captured strings —
      // it has no terminal to draw on, so `bb tui` cannot BE the TUI. Point at
      // the client instead, or the one discoverable name is a dead end.
      if (argv.length === 0) {
        return {
          exitCode: 0,
          stdout:
            `bb-tui runs as its own binary — this plugin is its server half.\n\n` +
            `  npx bb-tui           launch the terminal UI\n` +
            `  npm i -g bb-tui      install it once, then run \`bb-tui\`\n` +
            `  bb tui info          server facts the client discovers\n`,
        };
      }
      return { exitCode: 2, stderr: `usage: bb tui [info]\n` };
    },
  });

  bb.onDispose(() => {
    abort.abort();
    bb.log.info("bb-tui backend disposed");
  });
}