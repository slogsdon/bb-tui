// Tool use, as one line per call.
//
// The server timeline collapses a finished turn to its conversation rows — tool
// calls exist only in the event stream. So this layer reads `item/started` and
// `item/completed` and renders what the agent is *doing*, which is the whole
// point of watching a running thread.

import type { BufferedEvent } from "./api.js";

export type ToolItem = { text: string; ts: number };

const first = (text: string): string => (text.split("\n")[0] ?? "").trim();
const cut = (text: string, max = 120): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

type Item = {
  type?: string;
  id?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  command?: string;
  description?: string;
  status?: string;
  changes?: Array<{ path?: string; kind?: string }>;
};

/** The argument worth showing: agents put the subject (a path, a pattern, a
 * command) in a string field, and the rest is noise at this width. */
function argSummary(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const values = Object.values(args).filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return values.length > 0 ? first(values[0]!) : "";
}

/** One line describing a tool item, or null for items rendered elsewhere
 * (agent text and reasoning have their own layers). */
export function toolItemText(item: Item): string | null {
  const failed = item.status === "failed" || item.status === "error";
  const mark = failed ? " ✗" : "";
  switch (item.type) {
    case "toolCall":
      return cut(`⚒ ${item.tool ?? "tool"} ${argSummary(item.arguments)}`.trim()) + mark;
    case "commandExecution":
      return cut(`$ ${first(item.command ?? "")}`) + mark;
    case "fileChange": {
      const changes = (item.changes ?? [])
        .map((c) => `${c.kind ?? "edit"} ${(c.path ?? "").split("/").pop() ?? ""}`.trim())
        .filter(Boolean);
      return cut(`✎ ${changes.join(", ") || "file change"}`) + mark;
    }
    case "backgroundTask":
      return cut(`⚙ ${first(item.description ?? "background task")}`) + mark;
    default:
      return null;
  }
}

/** Fold tool item events into a map keyed `threadId::itemId`. Keyed, not
 * appended, so `item/completed` replaces the `item/started` line it finishes
 * instead of printing the call twice.
 *
 * Returns how many entries it wrote. The transcript is assembled into refs that
 * React cannot observe, so the caller needs to know whether anything actually
 * moved — a size comparison would miss `item/completed` replacing the
 * `item/started` line in place, which is a visible change. */
export function assembleToolItems(map: Map<string, ToolItem>, events: BufferedEvent[]): number {
  let written = 0;
  for (const e of events) {
    if (e.type !== "item/started" && e.type !== "item/completed") continue;
    const item = (e.payload?.data as { item?: Item } | undefined)?.item;
    if (!item?.id) continue;
    const text = toolItemText(item);
    if (text === null) continue;
    map.set(`${e.threadId}::${item.id}`, { text, ts: e.ts });
    written += 1;
  }
  return written;
}
