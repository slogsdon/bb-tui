// bb-tui client API layer: discovery + plugin RPC + bb CLI wrappers.
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ClientPrefs {
  hideReasoning: boolean;
  pollMs: number;
}

export interface ClientInfo {
  serverUrl: string;
  dataDir: string;
  version: string;
  pluginVersion: string;
  retentionDays: number;
  prefs: ClientPrefs;
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
export async function discover(): Promise<ClientInfo> {
  const env = process.env.BB_TUI_SERVER_URL;
  if (env) {
    return {
      serverUrl: env,
      dataDir: "unknown",
      version: "unknown",
      pluginVersion: "?",
      retentionDays: 0,
      prefs: { hideReasoning: true, pollMs: 800 },
    };
  }
  try {
    const { stdout } = await execFileP("bb", ["tui", "info"], { timeout: 10_000 });
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
    prefs: { hideReasoning: true, pollMs: 800 },
  };
}

/** Call a bb-tui plugin RPC method over loopback HTTP. */
export async function rpc<T>(serverUrl: string, method: string, input: unknown): Promise<T> {
  const res = await fetch(`${serverUrl}/api/v1/plugins/bb-tui/rpc/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input === null ? "null" : JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; error?: { code?: string; message?: string } };
  if (!body.ok || body.result === undefined) {
    throw new Error(body.error?.message ?? `rpc ${method} failed (${res.status})`);
  }
  return body.result;
}

export function listThreads(info: ClientInfo, projectId?: string): Promise<{ threads: ThreadRow[] }> {
  return rpc(info.serverUrl, "listThreads", { projectId, limit: 100 });
}

export function getTimeline(info: ClientInfo, threadId: string): Promise<{ items: unknown[] }> {
  return rpc(info.serverUrl, "getTimeline", { threadId });
}

export function eventsSince(info: ClientInfo, afterSeq: number, threadId?: string): Promise<EventsPage> {
  return rpc(info.serverUrl, "eventsSince", { afterSeq, limit: 500, threadId });
}

export interface Project {
  id: string;
  name: string;
  kind: string;
  [k: string]: unknown;
}

/** Run a bb CLI command with --json and parse stdout. */
export async function bbJson<T>(args: string[]): Promise<T> {
  const { stdout } = await execFileP("bb", [...args, "--json"], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

export async function listProjects(): Promise<Project[]> {
  return bbJson<Project[]>(["project", "list"]);
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
  return bbJson(["thread", "tell", threadId, message]);
}

export function stopThread(threadId: string): Promise<unknown> {
  return bbJson(["thread", "stop", threadId]);
}

export function compactThread(threadId: string): Promise<unknown> {
  return bbJson(["thread", "compact", threadId]);
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

/** Extract readable lines from a timeline row (recursive). */
export function timelineLines(row: unknown, acc: string[] = []): string[] {
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
    const tag = r.role === "user" ? "U" : r.role === "assistant" ? "A" : "S";
    acc.push(`${tag}: ${r.text ?? ""}`);
  } else if (r.kind === "turn") {
    acc.push(`— turn ${r.summary ? r.summary.slice(0, 200) : ""}`);
  } else if (typeof r.summary === "string" && r.summary) {
    acc.push(`[${r.kind ?? "work"}] ${r.summary.slice(0, 200)}`);
  } else if (r.error) {
    acc.push(`[error] ${r.error}`);
  }
  for (const c of r.children ?? []) timelineLines(c, acc);
  return acc;
}

// ---- cursor persistence (per server) ----
function cursorFile(): string {
  return path.join(os.homedir(), ".local", "state", "bb-tui", "cursor.json");
}

export async function loadCursor(serverUrl: string, threadId?: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(cursorFile(), "utf8")) as Record<string, number>;
    return raw[key(serverUrl, threadId)] ?? 0;
  } catch {
    return 0;
  }
}

export async function saveCursor(serverUrl: string, seq: number, threadId?: string): Promise<void> {
  try {
    const file = cursorFile();
    await mkdir(path.dirname(file), { recursive: true });
    const raw = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as Record<string, number>;
    raw[key(serverUrl, threadId)] = seq;
    await writeFile(file, JSON.stringify(raw));
  } catch {
    // non-fatal
  }
}

function key(serverUrl: string, threadId?: string): string {
  return threadId ? `${serverUrl}::${threadId}` : serverUrl;
}