// bb-tui headless CLI — also the smoke-test harness.
// Commands:
//   bb-tui info                                      discovery facts
//   bb-tui list [--project <id>]                     thread list (JSON lines)
//   bb-tui watch --thread <id> [--from <seq>]        follow buffered events
import {
  discover,
  eventText,
  eventsSince,
  flushCursorsSync,
  listThreads,
  loadCursor,
  saveCursor,
  supportsLongPoll,
  type ClientInfo,
  type ThreadRow,
} from "./api.js";

// Cursor writes are debounced, so `watch --once` and a ctrl-c would both exit
// with the last few seconds of progress still in memory.
process.once("exit", flushCursorsSync);

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[], flags: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      out[a.slice(2)] = argv[++i]!;
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "info": {
      const info = await discover();
      console.log(JSON.stringify(info, null, 2));
      return;
    }

    case "list": {
      const flags = parseArgs(rest, { project: "" });
      const info = await discover();
      const { threads } = await listThreads(info, flags.project || undefined);
      console.log(`${threads.length} threads`);
      for (const t of threads) console.log(threadRowLine(t));
      return;
    }

    case "watch": {
      const flags = parseArgs(rest, { thread: "", from: "" });
      if (!flags.thread) fail("watch requires --thread <id>");
      const info = await discover();
      let cursor = Number.parseInt(flags.from ?? "", 10);
      cursor = Number.isFinite(cursor) && cursor > 0 ? cursor : await loadCursor(info.serverUrl, flags.thread);
      const skipReasoning = flags["no-reasoning"] === "true";
      // Same deal as the TUI: let the plugin hold the request open so events
      // print when they happen rather than on the next 750ms tick.
      const waitMs = supportsLongPoll(info.pluginVersion) ? 20_000 : undefined;
      let got = 0;
      const started = Date.now();
      for (;;) {
        let page;
        try {
          page = await eventsSince(info, cursor, flags.thread, waitMs);
        } catch (err) {
          console.error(`poll error at cursor ${cursor}: ${String(err)}`);
          await sleep(2000);
          continue;
        }
        for (const e of page.events) {
          if (skipReasoning && e.type.startsWith("item/reasoning/")) continue;
          const text = eventText(e).replace(/\n/g, "\\n");
          console.log(`${e.seq}\t${e.threadId}\t${e.type}\t${text.slice(0, 120)}`);
          got++;
        }
        cursor = page.nextCursor;
        saveCursor(info.serverUrl, page.nextCursor, flags.thread);
        if (got > 0 && flags["once"] === "true") {
          console.log(`total ${got} events in ${Date.now() - started}ms`);
          return;
        }
        // Floors the cadence whether or not the request was long-polled: on a
        // busy server a long poll returns rows immediately, and skipping the
        // sleep then spins.
        await sleep(750);
      }
    }

    default:
      fail(`unknown command '${cmd}'; expected info|list|watch`);
  }
}

function threadRowLine(t: ThreadRow): string {
  const title = (t.title ?? t.titleFallback ?? "").slice(0, 60);
  return `${t.id}\t${t.status.padEnd(8)}\t${t.providerId.padEnd(12)}\t${title}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Discovery failures are ordinary conditions with an exact fix in the message
// (bb not running, plugin not installed) — print them, do not stack-trace them.
void main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
