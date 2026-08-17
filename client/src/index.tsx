// bb-tui — minimal Ink frontend. Phase-1 spike: prove the loop.
//   list threads -> open one -> live events via plugin buffer -> tell/spawn.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, render } from "ink";
import {
  discover,
  eventText,
  eventsSince,
  getTimeline,
  listProjects,
  listThreads,
  spawnThread,
  tellThread,
  timelineLines,
  type BufferedEvent,
  type ClientInfo,
  type Project,
  type ThreadRow,
} from "./api.js";

type View = { kind: "list" } | { kind: "detail"; thread: ThreadRow } | { kind: "spawn" };

const POLL_MS = 800;
const MAX_TAIL = 400;

export default function App() {
  const { exit } = useApp();
  const [info, setInfo] = useState<ClientInfo | null>(null);
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [sel, setSel] = useState(0);
  const [view, setView] = useState<View>({ kind: "list" });
  const [cursor, setCursor] = useState(0);
  const [tail, setTail] = useState<BufferedEvent[]>([]); // focused thread's events
  const [timeline, setTimeline] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting…");
  const tailRef = useRef<BufferedEvent[]>([]);

  // Bootstrap: discover, projects, threads.
  useEffect(() => {
    (async () => {
      try {
        const info = await discover();
        setInfo(info);
        setStatus(`bb ${info.version} @ ${info.serverUrl}`);
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

  // Event poll loop: drive the plugin-side buffer forward.
  useEffect(() => {
    const t = setInterval(async () => {
      if (!info) return;
      try {
        const page = await eventsSince(info, cursorRef.current);
        if (page.events.length > 0) {
          cursorRef.current = page.nextCursor;
          const next = [...tailRef.current, ...page.events].slice(-MAX_TAIL);
          tailRef.current = next;
          setTail(next);
          refreshThreadStatuses(next);
        }
      } catch (err) {
        setStatus(`buffer poll error: ${String(err)}`);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [info]);

  const cursorRef = useRef(cursor);
  const threadsRef = useRef<ThreadRow[]>([]);
  useEffect(() => void (threadsRef.current = threads), [threads]);

  function refreshThreadStatuses(events: BufferedEvent[]) {
    // Status changes are rare; refresh the list whenever we see events.
    void discover()
      .then((i) => listThreads(i))
      .then(({ threads }) => {
        threadsRef.current = threads;
        setThreads(threads);
      })
      .catch(() => {});
  }

  async function openThread(t: ThreadRow) {
    setView({ kind: "detail", thread: t });
    setTimeline([]);
    setTail([]);
    tailRef.current = [];
    setStatus(`opening ${t.id}`);

    // Initial history from the server timeline.
    try {
      const { items } = await getTimeline(info!, t.id);
      const lines = items.flatMap((i) => timelineLines(i));
      setTimeline(lines.slice(-60));
      const evs = tailRef.current.filter((e) => e.threadId === t.id);
      setTail(evs);
      setStatus(`${t.providerId} · ${t.status}`);
    } catch (err) {
      setStatus(`timeline error: ${String(err)}`);
    }
  }

  async function send(message: string) {
    if (view.kind !== "detail" || !message.trim()) return;
    setInput("");
    setStatus(`sending…`);
    try {
      const t = view.thread;
      await tellThread(t.id, message.trim());
      setStatus(`sent → ${t.providerId}`);
    } catch (err) {
      setStatus(`tell error: ${String(err)}`);
    }
  }

  async function spawn(promptText: string) {
    if (!promptText.trim() || !info) return;
    setInput("");
    setStatus("spawning thread…");
    try {
      const first = projects.keys().next().value as string;
      const result = await spawnThread(first, promptText.trim());
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

  useInput((data, key) => {
    if (key.ctrl && data === "c") return exit();
    if (view.kind === "spawn") {
      if (key.return) void spawn(input);
      else if (key.escape) setView({ kind: "list" });
      else if (key.backspace) setInput((s) => s.slice(0, -1));
      else if (data) setInput((s) => s + data);
      return;
    }
    if (view.kind === "detail") {
      if (key.return) void send(input);
      else if (key.escape) {
        setView({ kind: "list" });
        void refreshThreadStatuses(tailRef.current);
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

  const byThread = useMemo(() => {
    const m = new Map<string, BufferedEvent>();
    for (const e of tail) m.set(e.threadId, e);
    return m;
  }, [tail]);

  const focusedTail = useMemo(
    () => (view.kind === "detail" ? tail.filter((e) => e.threadId === view.thread.id).slice(-40) : []),
    [tail, view],
  );

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
        <Text color="cyan">New thread prompt:</Text>
        <Text>{input || " "}</Text>
        <Text dimColor>enter=spawn esc=cancel</Text>
      </Box>
    );
  }

  if (view.kind === "detail") {
    const t = view.thread;
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan" bold>
            {(t.title ?? t.titleFallback ?? t.id).slice(0, 80)}
          </Text>
          <Text dimColor>  {projects.get(t.projectId) ?? t.projectId} · {t.providerId} · {t.status}</Text>
        </Box>
        <Box height={14} flexDirection="column" borderStyle="round">
          {timeline.map((line, i) => (
            <Text key={`tl-${i}`} wrap="truncate">
              {line.slice(0, 140)}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" borderStyle="round" marginTop={1}>
          <Text dimColor>live (plugin buffer, seq {cursorRef.current}):</Text>
          {focusedTail.length === 0 && <Text dimColor>waiting for events…</Text>}
          {focusedTail.slice(-12).map((e) => {
            const txt = eventText(e).replace(/\n/g, " ");
            return (
              <Text key={e.seq} color={e.type.endsWith("/delta") ? "green" : "white"} wrap="truncate">
                [{e.seq}] {e.type}: {txt.slice(0, 90)}
              </Text>
            );
          })}
        </Box>
        <Text dimColor>
          &gt; <Text color="white">{input || " "}</Text>
        </Text>
        <Text dimColor>enter=tell esc=list ctrl+c=quit · {status}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        bb-tui
      </Text>
      <Text dimColor>{status} · {projects.size} projects · {threads.length} threads</Text>
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