// bb-tui — Ink frontend matching the bb app layout: left sidebar (Needs
// attention / Recent sections) + right thread pane (header, timeline,
// composer). Tab switches focus between list and composer. Performance:
// discovery is cached, status refreshes fire only on status-relevant events,
// and timeline refreshes are throttled to the open thread.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout, render } from "ink";
import {
  cancelPlan,
  compactThread,
  discover,
  eventActivityLabel,
  eventsSince,
  getTimeline,
  listMachines,
  listProjects,
  listSkills,
  listThreads,
  loadCursor,
  providerModels,
  saveCursor,
  setThreadModel,
  spawnThread,
  stopThread,
  tellThread,
  threadShow,
  timelineBlocks,
  type BufferedEvent,
  type ClientInfo,
  type EventsPage,
  type Execution,
  type Project,
  type ThreadRow,
} from "./api.js";
import { calculatePaneLayout, WorkspaceLayout, type ListRow } from "./layout.js";
import { renderBlocks, type TranscriptBlock } from "./markdown.js";
import {
  applyKey,
  EMPTY,
  layoutComposer,
  replaceToken,
  slashTokenAt,
  type Composer,
} from "./composer.js";
import {
  INITIAL_MENU_SELECTION,
  MENU_MAX_ENTRIES,
  buildCatalog,
  matchEntries,
  moveMenuSelection,
  resolveSlash,
  type CatalogEntry,
} from "./commands.js";
import { enterAlternateScreen } from "./terminal.js";

type View =
  | { kind: "home" }
  | { kind: "detail"; thread: ThreadRow }
  | { kind: "spawn" }
  | { kind: "model"; thread: ThreadRow };

const MAX_TAIL = 600;
// Per-item cap on assembled streaming text. Generous because the pane already
// windows what it draws — this exists to bound memory, not to shorten messages.
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_INPUT_ROWS = 3;
const MAX_TRANSCRIPT_BLOCKS = 200;

const isEraseKey = (key: { backspace?: boolean; delete?: boolean }): boolean => !!key.backspace || !!key.delete;

// Erase screen + scrollback, cursor home. Written as escapes rather than literal
// control bytes so the source stays plain ASCII.
const CLEAR_SCREEN = "\u001B[2J\u001B[3J\u001B[H";

/** Apply an input chunk: erase bytes pop, printable chars append, control
 * dropped. Handles batched keystrokes and Ink's inconsistent backspace/delete
 * mapping across PTY modes. */
function transformInput(prev: string, data: string): string {
  let s = prev;
  for (const ch of data) {
    if (ch === "\x7f" || ch === "\x08") s = s.slice(0, -1);
    else if (ch >= " " && ch !== "\x7f") s += ch;
  }
  return s;
}

/** Word-wrap the composer input to width. Transcript text goes through
 * renderBlocks instead — it needs styling and hanging indents this cannot do. */
function wrapToWidth(text: string, width: number): string[] {
  const w = Math.max(8, width);
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= w || line === "") line = candidate;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  if (out.length === 0) out.push("");
  return out;
}

// Event types that change a thread's status row (everything else is content).
const STATUS_EVENTS = new Set([
  "thread/started",
  "turn/started",
  "turn/completed",
  "client/thread/start",
  "provider/error",
  "thread/identity",
  "thread/compacted",
  "thread/context/cleared",
]);

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
  const [view, setView] = useState<View>({ kind: "home" });
  const [focus, setFocus] = useState<"list" | "detail">("list");
  const [tail, setTail] = useState<BufferedEvent[]>([]);
  const [timeline, setTimeline] = useState<TranscriptBlock[]>([]);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [planMode, setPlanMode] = useState<{ prompt: string } | null>(null);
  const [composer, setComposer] = useState<Composer>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [hideReasoning, setHideReasoning] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hostNames, setHostNames] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [repainting, setRepainting] = useState(false);
  const [scrollUp, setScrollUp] = useState(0);
  const [modelHints, setModelHints] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [menuSelection, setMenuSelection] = useState(INITIAL_MENU_SELECTION);
  const [menuDismissed, setMenuDismissed] = useState(false);

  const cursorRef = useRef(0);
  const threadCursorRef = useRef(new Map<string, number>());
  const seenSeqRef = useRef(new Set<number>());
  const tailRef = useRef<BufferedEvent[]>([]);
  const transcriptsRef = useRef(new Map<string, string>());
  const reasoningRef = useRef(new Map<string, string>());
  const userMsgsRef = useRef(new Map<string, string[]>()); // optimistic, deduped vs timeline
  const localGraceRef = useRef(new Map<string, number>());
  const lastTimelineRefreshRef = useRef(0);
  const lastStatusRefreshRef = useRef(0);
  const pollMsRef = useRef(800);
  const viewRef = useRef<View>({ kind: "home" });
  const focusRef = useRef<"list" | "detail">("list");
  useEffect(() => void (viewRef.current = view), [view]);
  useEffect(() => void (focusRef.current = focus), [focus]);

  // Force a complete rewrite of every cell. Recovery, not prevention: the
  // corruption happens in the client (Termius on iOS garbles the bottom border),
  // and Ink's incremental redraw leaves the damage there indefinitely.
  //
  // Ink's own clear() is not enough — it erases the screen but leaves lastOutput
  // set, and render() skips writing when the new output matches it, so the
  // screen stays blank until something genuinely changes. Render one throwaway
  // frame instead: it differs from the frame before it and from the frame after,
  // so Ink writes both, and the second write repaints everything.
  const repaint = useCallback(() => {
    stdout.write(CLEAR_SCREEN);
    setRepainting(true);
  }, [stdout]);

  useEffect(() => {
    if (!repainting) return;
    const t = setTimeout(() => setRepainting(false), 16);
    return () => clearTimeout(t);
  }, [repainting]);

  // A resize is the likeliest moment to inherit a garbled frame — the iOS
  // keyboard opening or closing fires several in a burst — so repaint instead
  // of letting Ink diff against a frame the client may have mangled. Debounced
  // so a burst costs one redraw, not one per event.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(repaint, 100);
    };
    stdout.on("resize", onResize);
    return () => {
      if (timer) clearTimeout(timer);
      stdout.off("resize", onResize);
    };
  }, [stdout, repaint]);

  // Bootstrap.
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
        const { threads } = await listThreads(info, undefined, 200);
        setThreads(sortThreads(threads.filter((t) => !t.archivedAt)));
        // Thread rows carry a host id, not a host name; resolve once.
        try {
          const machines = await listMachines();
          setHostNames(new Map(machines.map((m) => [m.id, m.name])));
        } catch {
          // non-fatal: rows fall back to showing no machine
        }
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

  // Poll loop: global stream (list markers) + per-thread stream (open detail).
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
          // Turn clock for the open thread: how long has it been working.
          for (const e of fresh) {
            if (focusId && e.threadId !== focusId) continue;
            if (e.type === "turn/started") setTurnStartedAt(e.ts || Date.now());
            else if (e.type === "turn/completed") setTurnStartedAt(null);
          }
          // Status row refreshes only on status-relevant events, throttled.
          const hasStatus = fresh.some((e) => STATUS_EVENTS.has(e.type));
          if (hasStatus && Date.now() - lastStatusRefreshRef.current > 2000) {
            lastStatusRefreshRef.current = Date.now();
            refreshThreadStatuses();
          }
        }
        // Throttled timeline refresh for the open thread (server-authoritative
        // user messages and ordering).
        const now = Date.now();
        if (focusId && now - lastTimelineRefreshRef.current > 4000) {
          lastTimelineRefreshRef.current = now;
          try {
            const tl = await getTimeline(info, focusId);
            setTimeline(tl.items.flatMap((i) => timelineBlocks(i)).slice(-MAX_TRANSCRIPT_BLOCKS));
            setExecution(tl.execution ?? null);
            setPlanMode(tl.planMode ?? null);
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

  // A running turn needs a second hand, and nothing else re-renders between
  // events. Only ticks while a turn is actually open.
  useEffect(() => {
    if (turnStartedAt === null) return;
    const t = setInterval(() => setClockTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [turnStartedAt]);

  const elapsedSeconds = useMemo(
    () => (turnStartedAt === null ? null : Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000))),
    [turnStartedAt, clockTick],
  );

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

  // Server list is authoritative for removal; locally spawned rows get a grace
  // window (spawned threads may not appear in the list yet).
  function mergeThreads(rows: ThreadRow[]) {
    setThreads((prev) => {
      const fresh = new Map(rows.map((r) => [r.id, r]));
      const now = Date.now();
      const out: ThreadRow[] = [];
      let changed: ThreadRow | undefined;
      for (const t of prev) {
        const f = fresh.get(t.id);
        if (f) {
          if (f.archivedAt) continue;
          const merged = {
            ...t,
            status: f.status,
            title: f.title ?? t.title,
            updatedAt: f.updatedAt ?? t.updatedAt,
          };
          if (t.status !== f.status) changed = merged;
          out.push(merged);
          fresh.delete(t.id);
        } else {
          const added = localGraceRef.current.get(t.id);
          if (added !== undefined && now - added < 15_000) out.push(t);
        }
      }
      for (const r of fresh.values()) {
        if (r.archivedAt) continue;
        out.push(r);
      }
      if (changed && viewRef.current.kind === "detail" && changed.id === viewRef.current.thread.id) {
        const next = { ...viewRef.current, thread: changed };
        viewRef.current = next;
        setView(next);
      }
      return out;
    });
  }

  function refreshThreadStatuses() {
    void discover()
      .then((i) => listThreads(i, undefined, 200))
      .then(({ threads }) => mergeThreads(threads))
      .catch(() => {});
  }

  async function openThread(t: ThreadRow) {
    const snapshot: ThreadRow = { ...t };
    setView({ kind: "detail", thread: snapshot });
    setFocus("detail");
    setTimeline([]);
    setExecution(null);
    setPlanMode(null);
    setComposer(EMPTY);
    setScrollUp(0);
    setStatus(`opening ${t.id}`);
    // Project-scoped, since project skills override user and builtin ones.
    void listSkills(t.projectId)
      .then((skills) => setCatalog(buildCatalog(skills)))
      .catch(() => setCatalog(buildCatalog([])));
    try {
      const tl = await getTimeline(info!, t.id);
      setTimeline(tl.items.flatMap((i) => timelineBlocks(i)).slice(-MAX_TRANSCRIPT_BLOCKS));
      setExecution(tl.execution ?? null);
      setPlanMode(tl.planMode ?? null);
      const evs = tailRef.current.filter((e) => e.threadId === t.id);
      assembleTranscripts(evs);
      setStatus(`${t.providerId} · ${t.status}`);
    } catch (err) {
      setStatus(`timeline error: ${String(err)}`);
    }
  }

  /** The bb-side implementation of a slash command. Kept next to the table it
   * serves rather than inside it, so the table stays data. */
  function runBbCommand(name: string, threadId: string): Promise<unknown> {
    if (name === "compact") return compactThread(threadId);
    if (name === "cancel-plan") return cancelPlan(threadId);
    return Promise.reject(new Error(`no bb implementation for /${name}`));
  }

  function backToHome() {
    setView({ kind: "home" });
    setFocus("list");
    setComposer(EMPTY);
    refreshThreadStatuses();
  }

  function appendUserMsg(threadId: string, text: string) {
    const list = userMsgsRef.current.get(threadId) ?? [];
    if (list[list.length - 1] !== text) {
      userMsgsRef.current.set(threadId, [...list.slice(-60), text]);
    }
  }

  async function send() {
    if (view.kind !== "detail" || !composer.text.trim()) return;
    const tid = view.thread.id;
    const resolved = resolveSlash(composer.text);
    setComposer(EMPTY);
    setScrollUp(0);

    // A message that *is* a bb command runs the same operation the app composer
    // does; `bb thread tell` is raw and would send the literal string instead.
    if (resolved.kind === "command") {
      setStatus(`running /${resolved.name}…`);
      try {
        await runBbCommand(resolved.name, tid);
        setStatus(`/${resolved.name} done`);
        refreshThreadStatuses();
      } catch (err) {
        setStatus(`/${resolved.name} error: ${String(err)}`);
      }
      return;
    }

    appendUserMsg(tid, resolved.text);
    setStatus("sending…");
    try {
      await tellThread(tid, resolved.text);
      setStatus(`sent → ${view.thread.providerId}`);
      refreshThreadStatuses();
    } catch (err) {
      setStatus(`tell error: ${String(err)}`);
    }
  }

  /** `configured` picks the alternate spawn target from plugin settings, when
   * one is set; otherwise both paths fall through to the project's defaults. */
  async function doSpawn(promptText: string, configured: boolean) {
    if (!promptText.trim() || !info) return;
    const projectId = spawnProject ?? projectOrder[0];
    if (!projectId) {
      setStatus("no project available");
      return;
    }
    const spawn = configured ? (info.spawn ?? null) : null;
    const target = spawn
      ? [spawn.provider, spawn.model].filter(Boolean).join(" · ")
      : "project defaults";
    const text = promptText.trim();
    setComposer(EMPTY);
    setStatus(`spawning thread (${projects.get(projectId) ?? projectId}, ${target})…`);
    try {
      const result = await spawnThread(
        projectId,
        text,
        spawn?.provider ?? undefined,
        spawn?.model ?? undefined,
      );
      const t = await threadShow(result.id);
      localGraceRef.current.set(t.id, Date.now());
      appendUserMsg(t.id, text);
      mergeThreads([t]);
      setView({ kind: "detail", thread: t });
      setFocus("detail");
      await openThread(t);
    } catch (err) {
      setStatus(`spawn error: ${String(err)}`);
    }
  }

  async function doModel(model: string) {
    if (view.kind !== "model" || !model.trim()) return;
    const t = view.thread;
    setComposer(EMPTY);
    try {
      await setThreadModel(t.id, model.trim());
      setStatus(`model → ${model.trim()}`);
    } catch (err) {
      setStatus(`model error: ${String(err)}`);
    }
    setView({ kind: "detail", thread: t });
    setFocus("detail");
  }

  async function pickModel(t: ThreadRow) {
    setView({ kind: "model", thread: t });
    setComposer(EMPTY);
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

  // ---- keyboard ----
  useInput((data, key) => {
    if (key.ctrl && data === "c") return exit();
    // Checked before every mode so it works from the composer and filter too.
    if (key.ctrl && data === "l") return repaint();

    // Filter mode owns every keystroke until it is dismissed, otherwise typing
    // a title would trigger the single-key actions underneath it.
    if (filtering) {
      if (key.escape) {
        setFiltering(false);
        setFilter("");
      } else if (key.return) {
        setFiltering(false);
      } else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setSel((s) => Math.min(listRows.length - 1, s + 1));
      else if (isEraseKey(key) || data) {
        setFilter((s) => transformInput(s, isEraseKey(key) ? "\x7f" : data));
        setSel(0);
      }
      return;
    }

    if (view.kind === "spawn") {
      if (key.return) void doSpawn(composer.text, true);
      else if (key.escape || data === "q") setView({ kind: "home" });
      else if (key.ctrl && data === "t") {
        const order = projectOrder;
        if (order.length > 0) {
          const i = order.indexOf(spawnProject ?? "");
          setSpawnProject(order[(i + 1) % order.length]);
        }
      } else if (key.ctrl && data === "d") void doSpawn(composer.text, false);
      else setComposer((c) => applyKey(c, data, key));
      return;
    }
    if (view.kind === "model") {
      if (key.return) void doModel(composer.text);
      else if (key.escape || data === "q") {
        const t = view.thread;
        setView({ kind: "detail", thread: t });
        setFocus("detail");
      } else setComposer((c) => applyKey(c, data, key));
      return;
    }
    if (view.kind === "detail") {
      if (focus === "list") {
        if (key.upArrow) setSel((s) => Math.max(0, s - 1));
        else if (key.downArrow) setSel((s) => Math.min(listRows.length - 1, s + 1));
        else if (key.return) activateRow();
        else if (key.leftArrow || key.rightArrow) collapseKey(key.rightArrow === true);
        else if (data === "/") startFilter();
        else if (data === "n") {
          setView({ kind: "spawn" });
          setComposer(EMPTY);
        } else if (key.tab) setFocus("detail");
        else if (key.escape || data === "q") backToHome();
        return;
      }
      // Composer focus. Every printable key belongs to the message — the
      // actions live on ctrl chords, because gating them on an empty composer
      // meant a message could not begin with those letters.
      // With the menu open it owns enter, tab, the arrows and escape. Escape
      // only dismisses it — a second escape leaves the composer.
      if (menuOpen && !key.shift && (key.return || key.tab)) return acceptMenuEntry();
      if (menuOpen && key.upArrow) {
        return setMenuSelection((state) =>
          moveMenuSelection(state, -1, menuMatches.length, MENU_MAX_ENTRIES),
        );
      }
      if (menuOpen && key.downArrow) {
        return setMenuSelection((state) =>
          moveMenuSelection(state, 1, menuMatches.length, MENU_MAX_ENTRIES),
        );
      }
      if (menuOpen && key.escape) return setMenuDismissed(true);

      if (key.return && key.shift) setComposer((c) => applyKey(c, "\n", {}));
      else if (key.return) void send();
      else if (key.ctrl && data === "o") setComposer((c) => applyKey(c, "\n", {}));
      else if (key.escape) setFocus("list");
      else if (key.tab) setFocus("list");
      // Arrows keep scrolling the transcript, as before; left/right reach the
      // composer so the cursor can still move.
      else if (key.upArrow || key.pageUp) setScrollUp((s) => s + 1);
      else if (key.downArrow || key.pageDown) setScrollUp((s) => Math.max(0, s - 1));
      else if (key.ctrl && data === "x") {
        setStatus("stopping…");
        void stopThread(view.thread.id).then(() => {
          setStatus("stopped");
          refreshThreadStatuses();
        });
      } else if (key.ctrl && data === "r") {
        setHideReasoning((v) => !v);
        setStatus(`reasoning deltas ${hideReasoning ? "shown" : "hidden"}`);
      } else if (key.ctrl && data === "t") {
        setStatus("compacting…");
        void compactThread(view.thread.id).then(() => setStatus("compaction requested"));
      } else if (key.ctrl && data === "p") {
        void pickModel(view.thread);
      } else setComposer((c) => applyKey(c, data, key));
      return;
    }
    // home view (no detail open)
    if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(listRows.length - 1, s + 1));
    else if (key.return) activateRow();
    else if (key.leftArrow || key.rightArrow) collapseKey(key.rightArrow === true);
    else if (data === "/") startFilter();
    else if (data === "n") {
      setView({ kind: "spawn" });
      setComposer(EMPTY);
    }
  });

  // ---- derived ----
  const focusedEvents = useMemo(
    () => (view.kind === "detail" ? tail.filter((e) => e.threadId === view.thread.id) : []),
    [tail, view],
  );

  const conversation = useMemo(() => {
    if (view.kind !== "detail") return { blocks: [] as TranscriptBlock[], live: 0 };
    const prefix = `${view.thread.id}::`;
    // Newlines are load-bearing: they carry the markdown block structure the
    // renderer needs. Only trim the edges.
    // The server timeline is authoritative. Once a streamed message lands there,
    // the locally assembled copy is a stale duplicate of the same text (and a
    // truncated one while the turn is still arriving), so drop it.
    const settled = timeline.filter((b) => b.role === "agent").map((b) => b.text);
    const agent: TranscriptBlock[] = [...transcriptsRef.current.entries()]
      .filter(([k, text]) => k.startsWith(prefix) && text.trim().length > 0)
      .map(([, text]) => text.trim())
      .filter((text) => !settled.some((s) => s.includes(text)))
      .map((text) => ({ role: "agent" as const, text }));
    if (!hideReasoning) {
      for (const [k, text] of reasoningRef.current.entries()) {
        if (k.startsWith(prefix) && text.trim().length > 0) {
          agent.push({ role: "reasoning", text: text.trim() });
        }
      }
    }
    const sent = new Set(timeline.filter((b) => b.role === "user").map((b) => b.text));
    const users: TranscriptBlock[] = (userMsgsRef.current.get(view.thread.id) ?? [])
      .filter((text) => !sent.has(text))
      .map((text) => ({ role: "user" as const, text }));
    return { blocks: [...timeline, ...users, ...agent], live: focusedEvents.length };
  }, [timeline, focusedEvents, hideReasoning, view]);

  // Navigator rows: threads grouped under their project. A flat list of every
  // thread on the host is unnavigable past ~20 rows; the project is the unit
  // people actually search by. Projects sort by their most recent thread, so
  // whatever just moved floats up.
  const listRows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = (t: ThreadRow) =>
      needle === "" ||
      (t.title ?? t.titleFallback ?? t.id).toLowerCase().includes(needle) ||
      (projects.get(t.projectId) ?? "").toLowerCase().includes(needle);
    const groups = new Map<string, ThreadRow[]>();
    for (const t of threads) {
      if (!matches(t)) continue;
      const list = groups.get(t.projectId);
      if (list) list.push(t);
      else groups.set(t.projectId, [t]);
    }
    const recency = (list: ThreadRow[]) => Math.max(...list.map((t) => t.updatedAt ?? 0));
    const ordered = [...groups.entries()].sort((a, b) => recency(b[1]) - recency(a[1]));
    const rows: ListRow[] = [];
    for (const [projectId, list] of ordered) {
      // A filter that hides its own matches is useless — searching overrides fold state.
      const isCollapsed = needle === "" && collapsed.has(projectId);
      rows.push({
        kind: "project",
        projectId,
        name: projects.get(projectId) ?? projectId,
        count: list.length,
        collapsed: isCollapsed,
      });
      if (!isCollapsed) for (const thread of list) rows.push({ kind: "thread", thread });
    }
    return rows;
  }, [threads, projects, collapsed, filter]);

  const selectedRow = listRows[sel];

  function toggleProject(projectId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  /** Enter: open a thread, or fold the project it lands on. */
  function activateRow() {
    if (!selectedRow) return;
    if (selectedRow.kind === "project") toggleProject(selectedRow.projectId);
    else void openThread(selectedRow.thread);
  }

  function startFilter() {
    setFiltering(true);
    setFilter("");
    setSel(0);
  }

  /** ←/→ fold and unfold. On a thread row, ← jumps to its project header so a
   * whole group can be closed without hunting for the header first. */
  function collapseKey(expand: boolean) {
    if (!selectedRow) return;
    if (selectedRow.kind === "project") {
      if (expand === collapsed.has(selectedRow.projectId)) toggleProject(selectedRow.projectId);
      return;
    }
    if (expand) return;
    const header = listRows.findIndex(
      (r) => r.kind === "project" && r.projectId === selectedRow.thread.projectId,
    );
    if (header >= 0) {
      setSel(header);
      toggleProject(selectedRow.thread.projectId);
    }
  }

  // Slash menu. The token rule is bb.app's: a slash at index 0 or after a
  // space. Zero matches hides the menu, which is what keeps an absolute path
  // from getting in the way.
  const slashToken = useMemo(
    () => (focus === "detail" && view.kind === "detail" ? slashTokenAt(composer) : null),
    [composer, focus, view],
  );
  const menuMatches = useMemo(
    () => (slashToken ? matchEntries(catalog, slashToken.text) : []),
    [catalog, slashToken],
  );
  const menuOpen = menuMatches.length > 0 && !menuDismissed;
  // Catalog contents can change after the token does (skills load
  // asynchronously). Normalize for render and accept so stale selection state
  // cannot point past a newly shorter match list for even one frame.
  const visibleMenuSelection = moveMenuSelection(
    menuSelection,
    0,
    menuMatches.length,
    MENU_MAX_ENTRIES,
  );

  // Re-arm the menu whenever the token itself changes, so dismissing applies to
  // the token you dismissed and not to the rest of the message.
  const tokenText = slashToken?.text ?? null;
  useEffect(() => {
    setMenuDismissed(false);
    setMenuSelection(INITIAL_MENU_SELECTION);
  }, [tokenText]);

  function acceptMenuEntry() {
    const entry = menuMatches[visibleMenuSelection.selected];
    if (!slashToken || !entry) return;
    setComposer((c) => {
      const token = slashTokenAt(c);
      return token ? replaceToken(c, token, entry.name) : c;
    });
  }

  // Latest meaningful activity per thread (content, not raw event names).
  const byThread = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of [...tail].reverse()) {
      if (m.has(e.threadId)) continue;
      const label = eventActivityLabel(e);
      if (label) m.set(e.threadId, label);
    }
    return m;
  }, [tail]);

  const paneLayout = calculatePaneLayout(cols, focus);
  const detailInnerW = Math.max(8, (paneLayout.detailWidth || cols - 1) - 4);
  const composerLayout = useMemo(
    () => layoutComposer(composer, detailInnerW, MAX_INPUT_ROWS),
    [composer, detailInnerW],
  );

  const detailLines = useMemo(
    () => (view.kind === "detail" ? renderBlocks(conversation.blocks, detailInnerW) : []),
    [conversation, detailInnerW, view],
  );

  // ---- rendering ----
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">bb-tui: {error}</Text>
        <Text dimColor>hint: install the bb-tui plugin or set BB_TUI_SERVER_URL</Text>
      </Box>
    );
  }

  // One frame of nothing, so the frame after it is written in full. See repaint().
  if (repainting) {
    return <Text> </Text>;
  }

  if (view.kind === "spawn") {
    // Names the configured spawn target so the two shortcuts are legible; with
    // nothing configured both spawn the same way and the label says so.
    const configured = info?.spawn ?? null;
    // With no spawn target configured the two keys do the same thing, so say so
    // once rather than printing "spawn defaults · d=defaults".
    const spawnHint = configured
      ? `enter=spawn ${[configured.provider, configured.model].filter(Boolean).join("/")} · d=defaults`
      : "enter/d=spawn defaults";
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          New thread — prompt ({spawnHint} · t=project)
        </Text>
        <Text dimColor>
          project: {spawnProject ? `${projects.get(spawnProject) ?? spawnProject} (${spawnProject})` : "—"}
        </Text>
        {composerLayout.rows.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === composerLayout.rows.length - 1 ? `> ${l}` : `  ${l}`}
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
        {composerLayout.rows.map((l, i) => (
          <Text key={i} wrap="truncate">
            {i === composerLayout.rows.length - 1 ? `> ${l}` : `  ${l}`}
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

  const visibleCount = Math.max(4, rows - 6);
  // Keep the selection four rows down the pane, but stop scrolling once the end
  // of the list is on screen.
  const firstVisible = Math.max(0, Math.min(sel - 4, listRows.length - visibleCount));

  return (
    <WorkspaceLayout
      columns={cols}
      rows={rows}
      focus={focus}
      topBar={
        <>
          <Text color="cyan" bold>
            bb-tui
          </Text>
          {filtering || filter !== "" ? (
            <Text color="yellow">
              {" "}
              /{filter}
              {filtering ? "_" : ""} · {listRows.length} rows
            </Text>
          ) : (
            <Text dimColor>
              {" "}· {status} · {projects.size} projects · {threads.length} threads · tab=focus
            </Text>
          )}
        </>
      }
      list={{
        rows: listRows,
        selectedIndex: sel,
        firstVisible,
        visibleCount,
        activityByThread: byThread,
        hostNames,
      }}
      detail={
        view.kind === "detail"
          ? {
              thread: view.thread,
              projectName: projects.get(view.thread.projectId) ?? view.thread.projectId,
              hostNames,
              detailLines,
              scrollUp,
              composer: composerLayout,
              menu: menuOpen ? { entries: menuMatches, ...visibleMenuSelection } : undefined,
              focus,
              elapsedSeconds,
              execution,
              planMode,
              debug: process.env.BB_TUI_DEBUG
                ? {
                    timelineLength: timeline.length,
                    conversationLive: conversation.live,
                    cursorSeq: cursorRef.current,
                  }
                : undefined,
            }
          : undefined
      }
    />
  );
}

// TUI entry: `tsx src/index.tsx`
const restoreScreen = process.stdout.isTTY ? enterAlternateScreen(process.stdout) : () => {};
process.once("exit", restoreScreen);
const instance = render(<App />);
void instance.waitUntilExit().finally(() => {
  restoreScreen();
  process.off("exit", restoreScreen);
});
