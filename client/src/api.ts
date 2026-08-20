// bb-tui client API layer: discovery + plugin RPC + bb CLI wrappers.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TranscriptBlock } from "./markdown.js";

const execFileP = promisify(execFile);

// Everything this module has in flight, cancelled together when the UI goes
// away. Node keeps the process alive for a pending fetch *and* for a running
// child process, and the bb CLI wrapper below allows 120s — so without a way to
// cancel them, quitting the TUI restores the terminal and then leaves the
// process sitting there, which is indistinguishable from a hang.
const appAbort = new AbortController();

/** Cancel every in-flight request and subprocess. Call once, on the way out. */
export function shutdownRequests(): void {
  appAbort.abort();
}

/** Combine the shutdown signal with a timeout and any caller-supplied signal. */
function requestSignal(timeoutMs: number, caller?: AbortSignal): AbortSignal {
  const signals = [AbortSignal.timeout(timeoutMs), appAbort.signal];
  if (caller) signals.push(caller);
  return AbortSignal.any(signals);
}

export type { TranscriptBlock };

export interface ClientPrefs {
  hideReasoning: boolean;
  pollMs: number;
}

/** Optional spawn target for the alternate new-thread shortcut, configured with
 * `bb plugin config bb-tui set spawnProvider|spawnModel`. Null, or a null
 * field, means the project's own default is used. */
export interface SpawnTarget {
  provider: string | null;
  model: string | null;
}

export interface ClientInfo {
  serverUrl: string;
  dataDir: string;
  version: string;
  pluginVersion: string;
  retentionDays: number;
  prefs: ClientPrefs;
  spawn?: SpawnTarget | null;
}

export interface ThreadRow {
  id: string;
  projectId: string;
  providerId: string;
  title: string | null;
  titleFallback: string | null;
  status: "error" | "active" | "idle" | "starting" | "stopping";
  parentThreadId: string | null;
  visibility: "visible" | "hidden";
  pinnedAt: string | null;
  archivedAt: string | null;
  updatedAt?: number;
  createdAt?: number;
  environmentBranchName?: string | null;
  environmentHostId?: string | null;
  hasPendingInteraction?: boolean;
  [k: string]: unknown;
}

export interface BufferedEvent {
  seq: number;
  threadId: string;
  type: string;
  payload: {
    delta?: string;
    summary?: string;
    text?: string;
    data?: {
      delta?: string;
      text?: string;
      summary?: string;
      itemId?: string;
      turnId?: string;
      model?: string;
      error?: string;
      message?: string;
    };
    [k: string]: unknown;
  };
  ts: number;
}

export interface EventsPage {
  events: BufferedEvent[];
  nextCursor: number;
}

/**
 * Discover the bb server. Priority:
 *   1. BB_TUI_SERVER_URL env override
 *   2. `bb tui info` — plugin CLI command (authoritative when the plugin is installed)
 *   3. ~/.bb/bb-app-runtime.json — pre-install fallback
 */
// Cache discovery: the poll loop calls discover() every tick, and each call
// spawns a `bb tui info` subprocess (~300ms). Refresh at most once a minute.
let discoverCache: { info: ClientInfo; at: number } | null = null;

export async function discover(): Promise<ClientInfo> {
  if (discoverCache && Date.now() - discoverCache.at < 60_000) {
    return discoverCache.info;
  }
  const info = await discoverFresh();
  discoverCache = { info, at: Date.now() };
  return info;
}

async function discoverFresh(): Promise<ClientInfo> {
  const env = process.env.BB_TUI_SERVER_URL;
  if (env) {
    return {
      serverUrl: env,
      dataDir: "unknown",
      version: "unknown",
      pluginVersion: "?",
      retentionDays: 0,
      prefs: { hideReasoning: false, pollMs: 800 },
      spawn: null,
    };
  }
  try {
    const { stdout } = await execFileP("bb", ["tui", "info"], {
      timeout: 10_000,
      signal: appAbort.signal,
    });
    const info = JSON.parse(stdout) as ClientInfo;
    if (info.serverUrl) return info;
  } catch {
    // fall through to runtime.json
  }
  const dataDir = path.join(os.homedir(), ".bb");
  const rt = JSON.parse(await readFile(path.join(dataDir, "bb-app-runtime.json"), "utf8")) as {
    serverUrl?: string;
    version?: string;
  };
  if (!rt.serverUrl) {
    throw new Error("cannot discover bb server: set BB_TUI_SERVER_URL or install the bb-tui plugin");
  }
  return {
    serverUrl: rt.serverUrl,
    dataDir,
    version: rt.version ?? "unknown",
    pluginVersion: "?",
    retentionDays: 0,
    prefs: { hideReasoning: false, pollMs: 800 },
    spawn: null,
  };
}

/** Call a bb-tui plugin RPC method over loopback HTTP. `timeoutMs` has to clear
 * whatever the server may spend answering — a long-polled eventsSince parks on
 * purpose, and the default would abort it every time. */
export async function rpc<T>(
  serverUrl: string,
  method: string,
  input: unknown,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<T> {
  // A long-polled request parks on the server for its whole budget, and a
  // pending fetch keeps node alive — so without a caller-supplied signal to
  // cancel it, quitting the TUI leaves the process running with the screen
  // already restored, for up to the full wait. `signal` is how the poll loop
  // hands over its own cancellation.
  const res = await fetch(`${serverUrl}/api/v1/plugins/bb-tui/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input === null ? "null" : JSON.stringify(input),
    signal: requestSignal(timeoutMs, signal),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; error?: { code?: string; message?: string } };
  if (!body.ok || body.result === undefined) {
    throw new Error(body.error?.message ?? `rpc ${method} failed (${res.status})`);
  }
  return body.result;
}

export function listThreads(info: ClientInfo, projectId?: string, limit = 100): Promise<{ threads: ThreadRow[] }> {
  return rpc(info.serverUrl, "listThreads", { projectId, limit });
}

/** Execution options the thread's next turn will use. bb resolves these from
 * the last turn request, the sticky thread setting, and the project default —
 * so this is the only honest source for what the model actually is. */
export interface Execution {
  model: string;
  permissionMode: string;
  reasoningLevel: string;
}

/** Cursor for the page of rows immediately older than the one just returned. */
export interface TimelineCursor {
  anchorSeq: number;
  anchorId: string;
}

export interface Timeline {
  items: unknown[];
  /** Absent on older plugin builds, which always returned the latest page. */
  page?: { hasOlderRows: boolean; olderCursor: TimelineCursor | null };
  /** Non-null while the provider is in plan mode. Entering it is the agent's
   * move, not bb's — `bb thread cancel-plan` is the only side bb exposes. */
  planMode?: { prompt: string } | null;
  execution?: Execution | null;
}

export function getTimeline(info: ClientInfo, threadId: string, before?: TimelineCursor): Promise<Timeline> {
  return rpc(info.serverUrl, "getTimeline", before ? { threadId, before } : { threadId });
}

/** `waitMs` asks the plugin to hold the request open until an event lands, so
 * text arrives when it is produced rather than up to a poll interval later.
 * Only send it to a plugin that declares support: the input schema is strict,
 * so an older build rejects the whole call rather than ignoring the field. */
export function eventsSince(
  info: ClientInfo,
  afterSeq: number,
  threadId?: string,
  waitMs?: number,
  signal?: AbortSignal,
): Promise<EventsPage> {
  return rpc(
    info.serverUrl,
    "eventsSince",
    { afterSeq, limit: 500, threadId, ...(waitMs ? { waitMs } : {}) },
    // The parked wait plus room for the round trip. Aborting at the default
    // 15s would kill every long poll before the server ever answered.
    waitMs ? waitMs + 10_000 : undefined,
    signal,
  );
}

/** Whether the connected plugin accepts `eventsSince({ waitMs })`. 0.2.0 is the
 * first build that does. An unknown version ("?" from the env-override or
 * runtime.json discovery paths) is treated as too old, which costs a poll
 * interval of latency and never an error. */
export function supportsLongPoll(pluginVersion: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(pluginVersion ?? "");
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 0 || minor >= 2;
}

export interface Project {
  id: string;
  name: string;
  kind: string;
  [k: string]: unknown;
}

/** Argument vector for a bb command whose trailing arguments are text the user
 * typed. The CLI's parser reads any argument starting with `-` as an option, so
 * a message that begins with a Markdown bullet is rejected as an unknown
 * option. Everything the user wrote goes after `--`, and `--json` has to
 * precede that marker to still be read as an option. */
export function cliArgs(command: string[], operands: string[] = []): string[] {
  return operands.length === 0
    ? [...command, "--json"]
    : [...command, "--json", "--", ...operands];
}

/** Run a bb CLI command with --json and parse stdout. `operands` is for
 * arguments the CLI takes positionally; pass user text there, never in
 * `command`. */
export async function bbJson<T>(command: string[], operands: string[] = []): Promise<T> {
  const { stdout } = await execFileP("bb", cliArgs(command, operands), {
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    // A running child keeps node alive for the whole 120s otherwise.
    signal: appAbort.signal,
  });
  return JSON.parse(stdout) as T;
}

/** The part of a CLI failure worth showing. execFile's message leads with the
 * whole command line — for `thread tell` that is the user's own message echoed
 * back — and buries the reason at the end, which is the one line that helps. */
export function cliMessage(error: unknown): string {
  const withStderr = error as { stderr?: string; message?: string } | null;
  const text = (withStderr?.stderr ?? "").trim() || String(withStderr?.message ?? error);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("Command failed:"));
  return lines[lines.length - 1] ?? text;
}

export async function listProjects(): Promise<Project[]> {
  return bbJson<Project[]>(["project", "list"]);
}

export interface Machine {
  id: string;
  name: string;
  status?: string;
  [k: string]: unknown;
}

/** Execution machines, for turning a thread's environmentHostId into a name. */
export async function listMachines(): Promise<Machine[]> {
  return bbJson<Machine[]>(["machine", "list"]);
}

export interface Skill {
  id: string;
  name: string;
  description?: string;
  scope?: string;
  [k: string]: unknown;
}

/** Skills bb knows about, for slash completion. Project-scoped, since project
 * skills override user and builtin ones. Cached by caller: the menu filters on
 * every keystroke and this is a ~300ms subprocess. */
export async function listSkills(projectId?: string): Promise<Skill[]> {
  const args = ["skill", "list"];
  if (projectId) args.push("--project", projectId);
  const res = await bbJson<{ skills?: Skill[] } | Skill[]>(args);
  return Array.isArray(res) ? res : (res.skills ?? []);
}

export interface SpawnResult {
  id: string;
  [k: string]: unknown;
}

export async function spawnThread(projectId: string, prompt: string, provider?: string, model?: string): Promise<SpawnResult> {
  const args = ["thread", "spawn", "--project", projectId, "--prompt", prompt];
  if (provider) args.push("--provider", provider);
  if (model) args.push("--model", model);
  return bbJson<SpawnResult>(args);
}

/** Fetch a single thread by id (spawned threads may not be in listThreads yet). */
export async function threadShow(threadId: string): Promise<ThreadRow> {
  const res = (await bbJson<Record<string, unknown>>(["thread", "show", threadId])) as {
    thread?: ThreadRow;
  };
  return (res.thread ?? res) as ThreadRow;
}

export function tellThread(threadId: string, message: string): Promise<unknown> {
  return bbJson(["thread", "tell"], [threadId, message]);
}

export function stopThread(threadId: string): Promise<unknown> {
  return bbJson(["thread", "stop", threadId]);
}

export function compactThread(threadId: string): Promise<unknown> {
  return bbJson(["thread", "compact", threadId]);
}

export function cancelPlan(threadId: string): Promise<unknown> {
  return bbJson(["thread", "cancel-plan", threadId]);
}

export function setThreadModel(threadId: string, model: string): Promise<unknown> {
  return bbJson(["thread", "update", threadId, "--model", model]);
}

export function providerModels(providerId: string): Promise<Array<{ id: string; displayName?: string }>> {
  return bbJson(["provider", "models", providerId]);
}

/** Extract display text from a buffered event row. */
export function eventText(e: BufferedEvent): string {
  const p = e.payload ?? {};
  if (typeof p.delta === "string") return p.delta;
  if (typeof p.data?.delta === "string") return p.data.delta;
  if (typeof p.data?.text === "string") return p.data.text;
  if (typeof p.summary === "string") return p.summary;
  if (typeof p.data?.summary === "string") return p.data.summary;
  if (typeof p.data?.message === "string") return p.data.message;
  try {
    return JSON.stringify(p).slice(0, 160);
  } catch {
    return "";
  }
}

/** Human-readable activity label for a buffered event, or null when the event
 * carries no meaningful content (token/context-usage updates are suppressed —
 * they are status noise, not activity). Used for thread-list markers. */
export function eventActivityLabel(e: BufferedEvent): string | null {
  const d = (e.payload as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const delta = typeof d.delta === "string" ? d.delta.replace(/\s+/g, " ").trim() : "";
  switch (e.type) {
    case "item/agentMessage/delta":
      return delta || null;
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      return delta ? `💭 ${delta}` : null;
    case "item/commandExecution/outputDelta":
      return delta ? `$ ${delta}` : null;
    case "item/started":
    case "item/completed": {
      const it = d.item as { summary?: unknown; type?: unknown; name?: unknown } | undefined;
      if (it && typeof it.summary === "string" && it.summary) return it.summary.slice(0, 80);
      if (it && typeof it.type === "string") return it.type;
      return null;
    }
    case "turn/started":
      return "turn started";
    case "thread/started":
      return "started";
    case "turn/completed":
      return "done";
    case "provider/error":
      return String(d.error ?? d.message ?? "provider error");
    case "thread/tokenUsage/updated":
    case "thread/contextWindowUsage/updated":
      return null; // status noise
    default:
      return null;
  }
}

/** The provider item id embedded in a timeline row id
 * (`thr_x:assistant:…|item:pi-assistant-103` -> `pi-assistant-103`). Deltas are
 * keyed by that bare id, so it is the only reliable join between the two. */
export function rowItemId(id: unknown): string | null {
  const m = typeof id === "string" ? /\|item:([^|]+)$/.exec(id) : null;
  return m ? (m[1] ?? null) : null;
}

/** What the server timeline already accounts for. The buffered-event layer
 * retains every delta back to the retention window — far more history than the
 * timeline page shows — so replaying all of it appends the whole conversation a
 * second time, out of order, below the timeline. The pane keeps a locally
 * assembled item only when the timeline neither contains that item nor covers
 * its point in time. */
export interface TimelineCoverage {
  itemIds: Set<string>;
  newestTs: number;
}

export function timelineCoverage(items: unknown[]): TimelineCoverage {
  const itemIds = new Set<string>();
  let newestTs = 0;
  for (const it of items) {
    const r = it as { id?: unknown; createdAt?: unknown } | null;
    const id = rowItemId(r?.id);
    if (id) itemIds.add(id);
    if (typeof r?.createdAt === "number") newestTs = Math.max(newestTs, r.createdAt);
  }
  return { itemIds, newestTs };
}

/** Whether the timeline already accounts for a locally assembled item — it
 * carries that item, or it covers that item's point in time. The transcript
 * filter and the prune are the same question asked twice, so they share one
 * answer: anything covered is never rendered again, and is therefore safe to
 * drop. Keep them on this function. */
export function coveredByTimeline(cov: TimelineCoverage, itemId: string, ts: number): boolean {
  return cov.itemIds.has(itemId) || ts <= cov.newestTs;
}

/** Flatten a timeline row into role-tagged transcript blocks (recursive).
 * Blocks keep their raw markdown — the renderer, not this layer, decides how
 * text is styled and wrapped. Tool/work rows carry their nesting depth so the
 * pane can draw them as children of the call that produced them. */
export function timelineBlocks(row: unknown, acc: TranscriptBlock[] = [], depth = 0): TranscriptBlock[] {
  const r = row as {
    kind?: string;
    role?: string;
    text?: string;
    summary?: string;
    children?: unknown[];
    error?: string | null;
  };
  if (r == null || typeof r !== "object") return acc;
  if (r.kind === "conversation") {
    const role = r.role === "user" ? "user" : r.role === "assistant" ? "agent" : "system";
    if ((r.text ?? "").trim()) acc.push({ role, text: r.text ?? "" });
  } else if (r.kind === "turn") {
    // A turn boundary with nothing to say needs no row; blocks are already
    // separated by a blank line.
    if (r.summary) acc.push({ role: "system", text: r.summary });
  } else if (typeof r.summary === "string" && r.summary) {
    acc.push({ role: "work", text: r.summary, depth });
  } else if (r.error) {
    acc.push({ role: "system", text: `error: ${r.error}` });
  }
  const childDepth = r.kind === "conversation" || r.kind === "turn" ? 0 : depth + 1;
  for (const c of r.children ?? []) timelineBlocks(c, acc, childDepth);
  return acc;
}

// ---- cursor persistence (per server) ----
function cursorFile(): string {
  return path.join(os.homedir(), ".local", "state", "bb-tui", "cursor.json");
}

/** How long a cursor may sit unwritten. This used to be a mkdir + read + parse
 * + write on every save, twice per poll tick, to persist two integers. A cursor
 * is a resume hint: losing a few seconds of it costs a handful of replayed
 * events that the timeline-coverage filter already drops. */
const CURSOR_FLUSH_MS = 5_000;

const dirtyCursors = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadCursor(serverUrl: string, threadId?: string): Promise<number> {
  const k = key(serverUrl, threadId);
  // An unflushed save is still the truth — reading around it would replay
  // events the caller has already consumed this session.
  const pending = dirtyCursors.get(k);
  if (pending !== undefined) return pending;
  try {
    const raw = JSON.parse(await readFile(cursorFile(), "utf8")) as Record<string, number>;
    return raw[k] ?? 0;
  } catch {
    return 0;
  }
}

export function saveCursor(serverUrl: string, seq: number, threadId?: string): void {
  dirtyCursors.set(key(serverUrl, threadId), seq);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCursors();
  }, CURSOR_FLUSH_MS);
  // The timer must never be the reason the process stays alive.
  flushTimer.unref?.();
}

export async function flushCursors(): Promise<void> {
  if (dirtyCursors.size === 0) return;
  const batch = [...dirtyCursors];
  dirtyCursors.clear();
  try {
    const file = cursorFile();
    await mkdir(path.dirname(file), { recursive: true });
    const raw = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, number>;
    // Never let a cursor go backwards. Seqs only ever grow, so a decrease is
    // always a bug somewhere upstream — and the cost of writing one is that the
    // next start replays everything between, which is exactly the storm this is
    // here to make unreachable.
    for (const [k, seq] of batch) raw[k] = Math.max(raw[k] ?? 0, seq);
    await writeFile(file, JSON.stringify(raw));
  } catch {
    // non-fatal
  }
}

/** Last-chance flush from a process `exit` handler, where nothing async can
 * still run. */
export function flushCursorsSync(): void {
  if (dirtyCursors.size === 0) return;
  const batch = [...dirtyCursors];
  dirtyCursors.clear();
  try {
    const file = cursorFile();
    mkdirSync(path.dirname(file), { recursive: true });
    let raw: Record<string, number> = {};
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>;
    } catch {
      raw = {};
    }
    // Never let a cursor go backwards. Seqs only ever grow, so a decrease is
    // always a bug somewhere upstream — and the cost of writing one is that the
    // next start replays everything between, which is exactly the storm this is
    // here to make unreachable.
    for (const [k, seq] of batch) raw[k] = Math.max(raw[k] ?? 0, seq);
    writeFileSync(file, JSON.stringify(raw));
  } catch {
    // non-fatal
  }
}

function key(serverUrl: string, threadId?: string): string {
  return threadId ? `${serverUrl}::${threadId}` : serverUrl;
}