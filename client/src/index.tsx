// bb-tui — Ink frontend. Phase 2: streaming transcript of buffered deltas,
// reasoning suppression (default on, `r` toggles), thread actions (x stop /
// c compact / m model), fixed-position input, word-wrapped history + input,
// user messages assembled from buffered turn requests, live status sync,
// recency-sorted thread list (pinned first, then updated desc).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, render } from "ink";
import {
  compactThread,
  discover,
  eventsSince,
  getTimeline,
  listProjects,
  listThreads,
  loadCursor,
  providerModels,
  saveCursor,
  setThreadModel,
  spawnThread,
  stopThread,
  tellThread,
  threadShow,
  timelineLines,
  type BufferedEvent,
  type ClientInfo,
  type EventsPage,
  type Project,
  type ThreadRow,
} from "./api.js";

type View =
  | { kind: "list" }
  | { kind: "detail"; thread: ThreadRow }
  | { kind: "spawn" }
  | { kind: "model"; thread: ThreadRow };

const MAX_TAIL = 600;
const MAX_TRANSCRIPT_CHARS = 600;
const LIST_WINDOW = 24;
const DETAIL_CHROME = 10; // fixed rows: header, meta, border, status, input(3), hint
const MAX_INPUT_ROWS = 3;

const isEraseKey = (key: { backspace?: boolean; delete?: boolean }): boolean => !!key.backspace || !!key.delete;

/** Apply an input chunk to the prompt: erase bytes pop, printable chars append,
 * remaining control bytes dropped. Handles terminals that batch keystrokes
 * (e.g. `\x7f\x08` together) and Ink's inconsistent backspace/delete mapping
 * across PTY modes. */
function transformInput(prev: string, data: string): string {
  let s = prev;
  for (const ch of data) {
    if (ch === "\x7f" || ch === "\x08") s = s.slice(0, -1);
    else if (ch >= " " && ch !== "\x7f") s += ch;
  }
  return s;
}

/** Word-wrap a single line to width; returns display rows (continuation lines
 * are indented two spaces so wrapped blocks stay visually distinct). */
function wrapToWidth(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= w || line === "") {
      line = candidate;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  if (out.length === 0) out.push("");
  // second+ lines get a continuation indent (applied for display)
  return out;
}

export default function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = stdout.rows || 24;
  const cols = stdout.columns || 80;

  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [spawnProject, setSpawnProject] = useState<string | undefined>(undefined);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<View>({ kind: "list" });
  const [tail, setTail] = useState<BufferedEvent[]>([]);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [hideReasoning, setHideReasoning] = useState(true);
  const [scrollUp, setScrollUp] = useState(0); // display rows scrolled off bottom
  const [modelHints, setModelHints] = useState<string[]>([]);

  const cursorRef = useRef(0);
  const threadCursorRef = useRef(new Map<string, number>());
  const seenSeqRef = useRef(new Set<number>());
  const tailRef = useRef<BufferedEvent[]>([]);
  const transcriptsRef = useRef(new Map<string, string>());
  const reasoningRef = useRef(new Map<string, string>());
  const userMsgsRef = useRef(new Map<string, string[]>()); // optimistic "U: …" (deduped vs timeline at render)
  const lastTimelineRefreshRef = useRef(0);
  const pollMsRef = useRef(800);
  const viewRef = useRef<View>({ kind: "list" });
  const threadsRef = useRef<ThreadRow[]>([]);
  useEffect(() => void (viewRef.current = view), [view]);
  useEffect(() => void (threadsRef.current = threads), [threads]);

  // Bootstrap: discover, projects, threads (pinned first, then updated desc).
  useEffect(() => {
    (async () => {
      try {
        const info = await discover();
        setInfo(info);
        pollMsRef.current = info.prefs.pollMs;
        setHideReasoning(info.prefs.hideReasoning);
        setStatus(`bb ${info.version} @ ${info.serverUrl}`);
        cursorRef.current = await loadCursor(info.serverUrl);
        const projs = await listProjects();
        const order = projs.map((p) => p.id);
        setProjectOrder(order);
        setProjects(new Map(projs.map((p) => [p.id, p.name])));
        const personal = projs.find((p) => p.name === "Personal");
        setSpawnProject(personal?.id ?? order[0]);
        const { threads } = await listThreads(info);
        setThreads(sortThreads(threads));
      } catch (err) {
        setError(String(err));
        setStatus("failed");
      }
    })();
  }, []);

  function sortThreads(list: ThreadRow[]): ThreadRow[] {
    return [...list].sort((a, b) => {
      const ap = a.pinnedAt ? 1 : 0;
      const bp = b.pinnedAt ? 1 : 0;
      if (ap !== bp) return bp - ap;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  }

  // Event poll loop: global stream for list markers + per-thread stream for
  // the open detail view. Dedupe by seq; persist per-stream cursors.
  useEffect(() => {
    const t = setInterval(async () => {
      if (!info) return;
      const focusId = viewRef.current.kind === "detail" ? viewRef.current.thread.id : undefined;
      try {
        const pages: EventsPage[] = [];
        const g = await eventsSince(info, cursorRef.current);
        pages.push(g);
        cursorRef.current = g.nextCursor;
        await saveCursor(info.serverUrl, g.nextCursor);
        if (focusId) {
          const tc = threadCursorRef.current.get(focusId) ?? (await loadCursor(info.serverUrl, focusId));
          threadCursorRef.current.set(focusId, tc);
          const pg = await eventsSince(info, tc, focusId);
          if (pg.events.length > 0) {
            threadCursorRef.current.set(focusId, pg.nextCursor);
            await saveCursor(info.serverUrl, pg.nextCursor, focusId);
            pages.push(pg);
          }
        }
        const fresh = pages.flatMap((p) => p.events).filter((e) => !seenSeqRef.current.has(e.seq));
        if (fresh.length > 0) {
          for (const e of fresh) seenSeqRef.current.add(e.seq);
          if (seenSeqRef.current.size > 20_000) {
            seenSeqRef.current = new Set(fresh.map((e) => e.seq));
          }
          const next = [...tailRef.current, ...fresh].slice(-MAX_TAIL);
          tailRef.current = next;
          setTail(next);
          assembleTranscripts(fresh);
          refreshThreadStatuses();
        }
        // Throttled timeline refresh for the open thread: keeps server order
        // authoritative for user messages (buffer deltas only carry agent text).
        const now = Date.now();
        if (
          focusId &&
          now - lastTimelineRefreshRef.current > 4000 &&
          info
        ) {
          lastTimelineRefreshRef.current = now;
          try {
            const { items } = await getTimeline(info, focusId);
            setTimeline(items.flatMap((i) => timelineLines(i)).slice(-120));
          } catch {
            // non-fatal; next cycle retries
          }
        }
      } catch (err) {
        setStatus(`buffer poll error: ${String(err)}`);
      }
    }, pollMsRef.current);
    return () => clearInterval(t);
  }, [info]);

  function assembleTranscripts(events: BufferedEvent[]) {
    for (const e of events) {
      const d = e.payload?.data ?? {};
      const itemId = d.itemId;
      if (!itemId) continue;
      const key = `${e.threadId}::${itemId}`;
      const map = e.type.startsWith("item/reasoning/") ? reasoningRef.current : transcriptsRef.current;
      if (typeof d.delta === "string" && e.type.endsWith("/delta")) {
        const cur = map.get(key) ?? "";
        map.set(key, (cur + d.delta).slice(-MAX_TRANSCRIPT_CHARS));
      }
    }
  }

  // User messages: the server timeline is authoritative, so buffered turn
  // requests are not added to history. `userMsgsRef` holds only optimistic
  // entries (sent from this client) and is deduped against the timeline at
  // render time.

  // Merge fresh statuses in place, sorting stays stable. If the open detail
  // thread changed, sync its snapshot so the header reflects live state.
  function mergeThreads(rows: ThreadRow[]) {
    setThreads((prev) => {
      const byId = new Map(prev.map((t) => [t.id, t]));
      let changed: ThreadRow | undefined;
      for (const r of rows) {
        const old = byId.get(r.id);
        if (old) {
          const merged = { ...old, status: r.status, title: r.title ?? old.title };
          byId.set(r.id, merged);
          if (old.status !== r.status) changed = merged;
        } else {
          byId.set(r.id, r);
        }
      }
      if (changed && viewRef.current.kind === "detail" && changed.id === viewRef.current.thread.id) {
        const next = { ...viewRef.current, thread: changed };
        viewRef.current = next;
        setView(next);
      }
      return [...byId.values()];
    });
  }

  function refreshThreadStatuses() {
    void discover()
      .then((i) => listThreads(i))
      .then(({ threads }) => mergeThreads(threads))
      .catch(() => {});
  }

  async function openThread(t: ThreadRow) {
    const active = t.status === "active" || t.status === "starting";
    const snapshot: ThreadRow = { ...t, status: t.status }; // sync happens via mergeThreads
    setView({ kind: "detail", thread: snapshot });
    setTimeline([]);
    setInput("");
    setScrollUp(0);
    setStatus(`opening ${t.id}`);
    try {
      const { items } = await getTimeline(info!, t.id);
      setTimeline(items.flatMap((i) => timelineLines(i)).slice(-120));
      const evs = tailRef.current.filter((e) => e.threadId === t.id);
      assembleTranscripts(evs);
      setStatus(`${t.providerId} · ${t.status} · ${t.id}${active ? " ●" : ""}`);
    } catch (err) {
      setStatus(`timeline error: ${String(err)}`);
    }
  }

  async function send(message: string) {
    if (view.kind !== "detail" || !message.trim()) return;
    const tid = view.thread.id;
    const text = message.trim();
    setInput("");
    setScrollUp(0);
    appendUserMsg(tid, text);
    setStatus("sending…");
    try {
      await tellThread(tid, text);
      setStatus(`sent → ${view.thread.providerId}`);
      refreshThreadStatuses();
    } catch (err) {
      setStatus(`tell error: ${String(err)}`);
    }
  }

  function appendUserMsg(threadId: string, text: string) {
    const list = userMsgsRef.current.get(threadId) ?? [];
    const line = `U: ${text}`;
    if (list[list.length - 1] !== line) {
      userMsgsRef.current.set(threadId, [...list.slice(-60), line]);
    }
  }

  async function doSpawn(promptText: string, useGo: boolean) {
    if (!promptText.trim() || !info) return;
    const projectId = spawnProject ?? projectOrder[0];
    if (!projectId) {
      setStatus("no project available");
      return;
    }
    const target = useGo ? "pi · opencode-go" : "project defaults";
    const text = promptText.trim();
    setInput("");
    setStatus(`spawning thread (${projects.get(projectId) ?? projectId}, ${target})…`);
    try {
      const result = await spawnThread(
        projectId,
        text,
        useGo ? "pi" : undefined,
        useGo ? "opencode-go/deepseek-v4-flash" : undefined,
      );
      const t = await threadShow(result.id);
      appendUserMsg(t.id, text);
      mergeThreads([t]);
      setView({ kind: "detail", thread: t });
      await openThread(t);
    } catch (err) {
      setStatus(`spawn error: ${String(err)}`);
    }
  }

  async function doModel(model: string) {
    if (view.kind !== "model" || !model.trim()) return;
    const t = view.thread;
    setInput("");
    try {
      await setThreadModel(t.id, model.trim());
      setStatus(`model → ${model.trim()}`);
    } catch (err) {
      setStatus(`model error: ${String(err)}`);
    }
    setView({ kind: "detail", thread: t });
  }

  async function pickModel(t: ThreadRow) {
    setView({ kind: "model", thread: t });
    setInput("");
    setStatus("loading models…");
    try {
      const ms = await providerModels(t.providerId);
      setModelHints(ms.slice(0, 12).map((m) => m.id));
      setStatus(`${t.providerId}: enter a model id`);
    } catch {
      setModelHints([]);
      setStatus(`could not list models for ${t.providerId}`);
    }
  }

  const backToList = () => {
    setView({ kind: "list" });
    refreshThreadStatuses();
  };

  useInput((data, key) => {
    if (key.ctrl && data === "c") return exit();

    if (view.kind === "spawn") {
      if (key.return) void doSpawn(input, true);
      else if (key.escape || data === "q") setView({ kind: "list" });
      else if (input === "" && data === "t") {
        const order = projectOrder;
        if (order.length > 0) {
          const i = order.indexOf(spawnProject ?? "");
          setSpawnProject(order[(i + 1) % order.length]);
        }
      } else if (input === "" && data === "d") void doSpawn(input, false);
      else if (isEraseKey(key) || data) setInput((s) => transformInput(s, isEraseKey(key) ? "\x7f" : data));
      return;
    }
    if (view.kind === "model") {
      if (key.return) void doModel(input);
      else if (key.escape || data === "q") {
        const t = view.thread;
        setView({ kind: "detail", thread: t });
      } else if (isEraseKey(key) || data) setInput((s) => transformInput(s, isEraseKey(key) ? "\x7f" : data));
      return;
    }
    if (view.kind === "detail") {
      if (key.return) void send(input);
      else if (key.escape || data === "q") backToList();
      else if (key.upArrow) setScrollUp((s) => s + 1);
      else if (key.downArrow) setScrollUp((s) => Math.max(0, s - 1));
      else if (input === "" && data === "r") {
        setHideReasoning((v) => !v);
        setStatus(`reasoning deltas ${hideReasoning ? "shown" : "hidden"}`);
      } else if (input === "" && data === "x") {
        setStatus("stopping…");
        void stopThread(view.thread.id).then(() => {
          setStatus("stopped");
          refreshThreadStatuses();
        });
      } else if (input === "" && data === "c") {
        setStatus("compacting…");
        void compactThread(view.thread.id).then(() => setStatus("compaction requested"));
      } else if (input === "" && data === "m") {
        void pickModel(view.thread);
      } else if (isEraseKey(key) || data) setInput((s) => transformInput(s, isEraseKey(key) ? "\x7f" : data));
      return;
    }
    // list view
    if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(threads.length - 1, s + 1));
    else if (key.return && threads[sel]) void openThread(threads[sel]!);
    else if (data === "n") {
      setView({ kind: "spawn" });
      setInput("");
    }
  });

  const focusedEvents = useMemo(
    () => (view.kind === "detail" ? tail.filter((e) => e.threadId === view.thread.id) : []),
    [tail, view],
  );

  // Agent transcript lines (raw, unwrapped) + user messages for the thread.
  const conversation = useMemo(() => {
    if (view.kind !== "detail") return { lines: [], live: 0 };
    const prefix = `${view.thread.id}::`;
    const agent = [...transcriptsRef.current.entries()]
      .filter(([k, text]) => k.startsWith(prefix) && text.length > 0)
      .map(([, text]) => `A: ${text.replace(/\n/g, " ").trim()}`);
    if (!hideReasoning) {
      for (const [k, text] of reasoningRef.current.entries()) {
        if (k.startsWith(prefix) && text.length > 0) {
          agent.push(`💭 ${text.replace(/\n/g, " ").trim()}`);
        }
      }
    }
    const users = (userMsgsRef.current.get(view.thread.id) ?? []).filter((l) => !timeline.includes(l));
    return { lines: [...timeline, ...users, ...agent], live: focusedEvents.length };
  }, [timeline, focusedEvents, hideReasoning, view]);

  const byThread = useMemo(() => {
    const m = new Map<string, BufferedEvent>();
    for (const e of tail) m.set(e.threadId, e);
    return m;
  }, [tail]);

  // Word-wrap everything to the inner width once, per render.
  const innerW = Math.max(20, cols - 6);
  const displayLines = useMemo(
    () => (view.kind === "detail" ? conversation.lines.flatMap((l) => wrapToWidth(l, innerW)) : []),
    [conversation, innerW, view],
  );

  const inputRows = useMemo(() => {
    if (!input) return [""];
    const lines = wrapToWidth(input, innerW);
    return lines.slice(-Math.max(0, MAX_INPUT_ROWS));
  }, [input, innerW]);

  // ---- rendering -------------------------------------------------------
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">bb-tui: {error}</Text>
        <Text dimColor>hint: install the bb-tui plugin or set BB_TUI_SERVER_URL</Text>
      </Box>
    );
  }

  if (view.kind === "spawn") {
    return (
      <Box flexDirection="column">
        <Text color="cyan">New thread — prompt (enter=spawn pi/opencode-go · d=defaults · t=project)</Text>
        <Text dimColor>
          project: {spawnProject ? `${projects.get(spawnProject) ?? spawnProject} (${spawnProject})` : "—"}
        </Text>
        {inputRows.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === inputRows.length - 1 ? `> ${l}` : `  ${l}`}
          </Text>
        ))}
        <Text dimColor>enter=spawn d=defaults t=cycle project esc/q=cancel</Text>
      </Box>
    );
  }

  if (view.kind === "model") {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Model for {view.thread.id} (provider {view.thread.providerId}):</Text>
        {inputRows.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === inputRows.length - 1 ? `> ${l}` : `  ${l}`}
          </Text>
        ))}
        {modelHints.map((id) => (
          <Text key={id} dimColor wrap="truncate">
            {id}
          </Text>
        ))}
        <Text dimColor>enter=apply esc/q=cancel</Text>
      </Box>
    );
  }

  if (view.kind === "detail") {
    const t = view.thread;
    const active = t.status === "active" || t.status === "starting";
    const visibleCount = Math.max(3, rows - DETAIL_CHROME);
    const scrollable = Math.max(0, displayLines.length - visibleCount);
    const clamped = Math.min(scrollUp, scrollable);
    const from = Math.max(0, displayLines.length - visibleCount - clamped);
    const visible = displayLines.slice(from, from + visibleCount);
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          <Text color="cyan" bold>
            {(t.title ?? t.titleFallback ?? t.id).slice(0, 80)}
          </Text>
          <Text dimColor>
            {"  "}
            {projects.get(t.projectId) ?? t.projectId} · {t.providerId} · {t.status}
            {active ? " ●" : ""}
          </Text>
        </Text>
        <Box flexDirection="column" borderStyle="round" height={visibleCount + 2}>
          {visible.length === 0 && <Text dimColor>{active ? "streaming…" : "no messages"}</Text>}
          {visible.map((line, i) => (
            <Text key={`${from + i}`} wrap="truncate">
              {line.startsWith("U: ") ? <Text color="blue">{line}</Text> : line.startsWith("A: ") ? <Text color="green">{line}</Text> : line}
            </Text>
          ))}
        </Box>
        <Text dimColor wrap="truncate">
          {clamped === 0 ? "▼ bottom" : `▲ ${clamped}`} · history {timeline.length} · live {conversation.live} · seq{" "}
          {cursorRef.current}
        </Text>
        {inputRows.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === inputRows.length - 1 ? `> ` : `  `}
            <Text color={active ? "green" : "white"}>{l === "" ? " " : l}</Text>
          </Text>
        ))}
        <Text dimColor wrap="truncate">
          enter=tell ↑↓=scroll r=reasoning({hideReasoning ? "off" : "on"}) x=stop c=compact m=model esc/q=list ctrl+c=quit ·{" "}
          {status}
        </Text>
      </Box>
    );
  }

  // list view
  const firstVisible = Math.max(0, sel - 4);
  const visibleThreads = threads.slice(firstVisible, firstVisible + LIST_WINDOW);
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        bb-tui
      </Text>
      <Text dimColor wrap="truncate">
        {status} · {projects.size} projects · {threads.length} threads
      </Text>
      {threads.length === 0 && <Text dimColor>no threads (or plugin not installed)</Text>}
      {visibleThreads.map((t, i) => {
        const abs = firstVisible + i;
        const last = byThread.get(t.id);
        const marker = last ? ` ⟶ ${last.type}` : "";
        return (
          <Text key={t.id} color={abs === sel ? "green" : undefined} wrap="truncate">
            {abs === sel ? "> " : "  "}
            {t.status === "active" ? "●" : t.status === "idle" ? "○" : "✗"} {t.providerId.padEnd(10)}{" "}
            {(t.title ?? t.titleFallback ?? t.id).slice(0, 60)}
            <Text dimColor>{marker}</Text>
          </Text>
        );
      })}
      <Text dimColor wrap="truncate">
        ↑/↓ select · enter open · n new thread · ctrl+c quit
      </Text>
    </Box>
  );
}

// TUI entry: `tsx src/index.tsx`
render(<App />);