// bb-tui — Ink frontend. Phase 2: streaming transcript of buffered deltas,
// reasoning suppression (default on, `r` toggles), thread actions (x stop /
// c compact / m model), cursor persistence across restarts.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  compactThread,
  discover,
  eventText,
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

export default function App() {
  const { exit } = useApp();
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<View>({ kind: "list" });
  const [tail, setTail] = useState<BufferedEvent[]>([]);
  const [timeline, setTimeline] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [hideReasoning, setHideReasoning] = useState(true);
  const [modelHints, setModelHints] = useState<string[]>([]);

  const cursorRef = useRef(0); // global stream cursor
  const threadCursorRef = useRef(new Map<string, number>()); // per-thread cursors
  const seenSeqRef = useRef(new Set<number>());
  const tailRef = useRef<BufferedEvent[]>([]);
  const transcriptsRef = useRef(new Map<string, string>());
  const reasoningRef = useRef(new Map<string, string>());
  const pollMsRef = useRef(800);
  const viewRef = useRef<View>({ kind: "list" });
  useEffect(() => void (viewRef.current = view), [view]);

  // Bootstrap: discover, projects, threads.
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
        setProjects(new Map(projs.map((p) => [p.id, p.name])));
        const { threads } = await listThreads(info);
        setThreads(threads);
      } catch (err) {
        setError(String(err));
        setStatus("failed");
      }
    })();
  }, []);

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
          refreshThreadStatuses(fresh);
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

  function refreshThreadStatuses(events: BufferedEvent[]) {
    void discover()
      .then((i) => listThreads(i))
      .then(({ threads }) => {
        setThreads(threads);
      })
      .catch(() => {});
  }

  async function openThread(t: ThreadRow) {
    setView({ kind: "detail", thread: t });
    setTimeline([]);
    setInput("");
    setStatus(`opening ${t.id}`);
    try {
      const { items } = await getTimeline(info!, t.id);
      setTimeline(items.flatMap((i) => timelineLines(i)).slice(-40));
      const evs = tailRef.current.filter((e) => e.threadId === t.id);
      assembleTranscripts(evs);
      setStatus(`${t.providerId} · ${t.status} · ${t.id}`);
    } catch (err) {
      setStatus(`timeline error: ${String(err)}`);
    }
  }

  async function send(message: string) {
    if (view.kind !== "detail" || !message.trim()) return;
    setInput("");
    setStatus("sending…");
    try {
      await tellThread(view.thread.id, message.trim());
      setStatus(`sent → ${view.thread.providerId}`);
      await refreshThreadStatuses(tailRef.current);
    } catch (err) {
      setStatus(`tell error: ${String(err)}`);
    }
  }

  async function doSpawn(promptText: string, useGo: boolean) {
    if (!promptText.trim() || !info) return;
    setInput("");
    setStatus(useGo ? "spawning thread (pi · opencode-go)…" : "spawning thread (defaults)…");
    try {
      const first = projects.keys().next().value as string;
      const result = await spawnThread(
        first,
        promptText.trim(),
        useGo ? "pi" : undefined,
        useGo ? "opencode-go/deepseek-v4-flash" : undefined,
      );
      const { threads } = await listThreads(info);
      setThreads(threads);
      const t = threads.find((x) => x.id === result.id);
      if (t) {
        setView({ kind: "detail", thread: t });
        await openThread(t);
      }
    } catch (err) {
      setStatus(`spawn error: ${String(err)}`);
    }
  }

  async function doModel(model: string) {
    if (view.kind !== "model" || !model.trim()) return;
    setInput("");
    try {
      await setThreadModel(view.thread.id, model.trim());
      setStatus(`model → ${model.trim()}`);
    } catch (err) {
      setStatus(`model error: ${String(err)}`);
    }
    setView({ kind: "detail", thread: view.thread });
  }

  async function pickModel(t: ThreadRow) {
    setView({ kind: "model", thread: t });
    setInput("");
    setStatus("loading models…");
    try {
      const ms = await providerModels(t.providerId);
      setModelHints(ms.slice(0, 14).map((m) => m.id));
      setStatus(`${t.providerId}: enter a model id (↑ from list below)`);
    } catch {
      setModelHints([]);
      setStatus(`could not list models for ${t.providerId}`);
    }
  }

  useInput((data, key) => {
    if (key.ctrl && data === "c") return exit();

    if (view.kind === "spawn") {
      if (key.return) void doSpawn(input, true);
      else if (key.escape) setView({ kind: "list" });
      else if (key.backspace) setInput((s) => s.slice(0, -1));
      else if (data === "d") void doSpawn(input, false);
      else if (data) setInput((s) => s + data);
      return;
    }
    if (view.kind === "model") {
      if (key.return) void doModel(input);
      else if (key.escape) {
        const t = view.thread;
        setView({ kind: "detail", thread: t });
      } else if (key.backspace) setInput((s) => s.slice(0, -1));
      else if (data) setInput((s) => s + data);
      return;
    }
    if (view.kind === "detail") {
      if (key.return) void send(input);
      else if (key.escape) {
        setView({ kind: "list" });
        void refreshThreadStatuses(tailRef.current);
      } else if (data === "r") {
        setHideReasoning((v) => !v);
        setStatus(`reasoning deltas ${hideReasoning ? "shown" : "hidden"}`);
      } else if (data === "x") {
        setStatus("stopping…");
        void stopThread(view.thread.id).then(() => setStatus("stopped"));
      } else if (data === "c") {
        setStatus("compacting…");
        void compactThread(view.thread.id).then(() => setStatus("compaction requested"));
      } else if (data === "m") {
        void pickModel(view.thread);
      } else if (key.backspace) setInput((s) => s.slice(0, -1));
      else if (data) setInput((s) => s + data);
      return;
    }
    // list view
    if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(threads.length - 1, s + 1));
    else if (key.return && threads[sel]) void openThread(threads[sel]!);
    else if (data === "n") setView({ kind: "spawn" });
  });

  const focusedEvents = useMemo(
    () => (view.kind === "detail" ? tail.filter((e) => e.threadId === view.thread.id) : []),
    [tail, view],
  );

  // Streaming transcript of the focused thread: deltas assembled per item.
  const transcriptLines = useMemo(() => {
    if (view.kind !== "detail") return [];
    const prefix = `${view.thread.id}::`;
    const msgs = [...transcriptsRef.current.entries()]
      .filter(([k, text]) => k.startsWith(prefix) && text.length > 0)
      .slice(-8)
      .map(([, text]) => {
        const oneLine = text.replace(/\n/g, " ").trim();
        return `A: ${oneLine.length > 110 ? oneLine.slice(0, 110) + "…" : oneLine}`;
      });
    const why = hideReasoning
      ? []
      : [...reasoningRef.current.entries()]
          .filter(([k, text]) => k.startsWith(prefix) && text.length > 0)
          .slice(-4)
          .map(([, text]) => `   💭 ${text.replace(/\n/g, " ").trim().slice(0, 90)}`);
    return [...msgs, ...why];
  }, [focusedEvents, hideReasoning, view]);

  const byThread = useMemo(() => {
    const m = new Map<string, BufferedEvent>();
    for (const e of tail) m.set(e.threadId, e);
    return m;
  }, [tail]);

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">bb-tui: {error}</Text>
        <Text dimColor>hint: install the bb-tui plugin (`bb plugin install …`) or set BB_TUI_SERVER_URL</Text>
      </Box>
    );
  }

  if (view.kind === "spawn") {
    return (
      <Box flexDirection="column">
        <Text color="cyan">New thread prompt (pi · opencode-go):</Text>
        <Text>{input || " "}</Text>
        <Text dimColor>enter=spawn (pi/opencode-go) · d=spawn with project defaults · esc=cancel</Text>
      </Box>
    );
  }

  if (view.kind === "model") {
    return (
      <Box flexDirection="column">
        <Text color="cyan">Model for {view.thread.id} (current provider {view.thread.providerId}):</Text>
        <Text>{input || " "}</Text>
        {modelHints.map((id) => (
          <Text key={id} dimColor wrap="truncate">
            {id}
          </Text>
        ))}
        <Text dimColor>enter=apply esc=cancel</Text>
      </Box>
    );
  }

  if (view.kind === "detail") {
    const t = view.thread;
    const active = t.status === "active" || t.status === "starting";
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>
            {(t.title ?? t.titleFallback ?? t.id).slice(0, 80)}
          </Text>
          <Text dimColor>
            {"  "}
            {projects.get(t.projectId) ?? t.projectId} · {t.providerId} · {t.status}
            {active ? " ●" : ""}
          </Text>
        </Box>
        <Box height={14} flexDirection="column" borderStyle="round">
          {timeline.map((line, i) => (
            <Text key={`tl-${i}`} wrap="truncate">
              {line.slice(0, 140)}
            </Text>
          ))}
          {transcriptLines.map((line, i) => (
            <Text key={`tr-${i}`} color={line.startsWith("A:") ? "green" : "yellow"} wrap="truncate">
              {line.slice(0, 140)}
            </Text>
          ))}
          {active && transcriptLines.length === 0 && <Text dimColor>streaming… (no deltas yet)</Text>}
        </Box>
        <Text dimColor>history: {timeline.length} rows · live: {focusedEvents.length} events · seq {cursorRef.current}</Text>
        <Text dimColor>
          &gt; <Text color="white">{input || " "}</Text>
        </Text>
        <Text dimColor>
          enter=tell r=reasoning({hideReasoning ? "off" : "on"}) x=stop c=compact m=model esc=list ctrl+c=quit · {status}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        bb-tui
      </Text>
      <Text dimColor>
        {status} · {projects.size} projects · {threads.length} threads
      </Text>
      {threads.length === 0 && <Text dimColor>no threads (or plugin not installed)</Text>}
      {threads.slice(0, 40).map((t, i) => {
        const last = byThread.get(t.id);
        const marker = last ? ` ⟶ ${last.type}` : "";
        return (
          <Text key={t.id} color={i === sel ? "green" : undefined} wrap="truncate">
            {i === sel ? "> " : "  "}
            {t.status === "active" ? "●" : t.status === "idle" ? "○" : "✗"} {t.providerId.padEnd(10)}{" "}
            {(t.title ?? t.titleFallback ?? t.id).slice(0, 60)}
            <Text dimColor>{marker}</Text>
          </Text>
        );
      })}
      <Text dimColor>↑/↓ select · enter open · n new thread · ctrl+c quit</Text>
    </Box>
  );
}

// TUI entry: `tsx src/index.tsx`
render(<App />);