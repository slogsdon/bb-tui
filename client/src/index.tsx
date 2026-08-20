// bb-tui — Ink frontend matching the bb app layout: left sidebar (Needs
// attention / Recent sections) + right thread pane (header, timeline,
// composer). Tab switches focus between list and composer. Performance:
// discovery is cached, status refreshes fire only on status-relevant events,
// and timeline refreshes are throttled to the open thread.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout, render } from "ink";
import {
  cancelPlan,
  compactThread,
  coveredByTimeline,
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
  timelineCoverage,
  type BufferedEvent,
  type ClientInfo,
  type EventsPage,
  type Execution,
  type Project,
  type ThreadRow,
  type Timeline,
  type TimelineCoverage,
  type TimelineCursor,
} from "./api.js";
import {
  calculatePaneLayout,
  hitTest,
  menuHeight,
  transcriptRows,
  WorkspaceLayout,
  type ListRow,
} from "./layout.js";
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
  modelEntries,
  modelQuery,
  moveMenuSelection,
  resolveSlash,
  type CatalogEntry,
} from "./commands.js";
import { assembleToolItems, type ToolItem } from "./tools.js";
import { enableMouse, isMouseInput, parseMouse, type MouseEvent } from "./mouse.js";
import { enterAlternateScreen } from "./terminal.js";

type View =
  | { kind: "home" }
  | { kind: "detail"; thread: ThreadRow }
  | { kind: "spawn" };

const MAX_TAIL = 600;
// Per-item cap on assembled streaming text. Generous because the pane already
// windows what it draws — this exists to bound memory, not to shorten messages.
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_INPUT_ROWS = 3;
const MAX_TRANSCRIPT_BLOCKS = 200;
// Scroll-back ceiling. Every loaded block is re-wrapped whenever the pane width
// changes, so history is capped rather than unbounded.
const MAX_HISTORY_BLOCKS = 600;
// Braille spinner, one frame per tick.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 120;
const UNANSWERED_SEND_MS = 60_000;

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
  // History paged in above the live page. Immutable once loaded: the 4s refresh
  // replaces `timeline` wholesale, which would otherwise throw scroll-back away
  // every tick.
  const [older, setOlder] = useState<TranscriptBlock[]>([]);
  const [olderCursor, setOlderCursor] = useState<TimelineCursor | null>(null);
  const [coverage, setCoverage] = useState(() => timelineCoverage([]));
  // Optimistic user messages, deduped against the timeline. State, not a ref:
  // the transcript has to repaint the moment one is appended.
  const [userMsgs, setUserMsgs] = useState<Map<string, string[]>>(new Map());
  const [execution, setExecution] = useState<Execution | null>(null);
  const [planMode, setPlanMode] = useState<{ prompt: string } | null>(null);
  const [composer, setComposer] = useState<Composer>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("connecting…");
  const [hideReasoning, setHideReasoning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [hostNames, setHostNames] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  // The moment a message left the composer. A turn does not report itself for a
  // second or two, and that gap is exactly when the user wonders whether the
  // key press registered.
  const [sentAt, setSentAt] = useState<number | null>(null);
  // What last went wrong on the open thread, shown in the pane rather than in
  // the top bar's shared status line.
  const [threadError, setThreadError] = useState<string | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [repainting, setRepainting] = useState(false);
  const [scrollUp, setScrollUp] = useState(0);
  const [models, setModels] = useState<Array<{ id: string; displayName?: string }>>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [menuSelection, setMenuSelection] = useState(INITIAL_MENU_SELECTION);
  const [menuDismissed, setMenuDismissed] = useState(false);

  const cursorRef = useRef(0);
  const threadCursorRef = useRef(new Map<string, number>());
  const seenSeqRef = useRef(new Set<number>());
  const tailRef = useRef<BufferedEvent[]>([]);
  // Locally assembled streaming text, keyed `threadId::itemId`, with the ts of
  // the last delta so the pane can tell live text from replayed history.
  const transcriptsRef = useRef(new Map<string, { text: string; ts: number }>());
  const reasoningRef = useRef(new Map<string, { text: string; ts: number }>());
  // Tool calls, keyed the same way. Their own map because they are whole lines,
  // not assembled deltas.
  const toolsRef = useRef(new Map<string, ToolItem>());
  const localGraceRef = useRef(new Map<string, number>());
  const modelsProviderRef = useRef<string | null>(null);
  const pagingRef = useRef(false);
  const pagingStartedRef = useRef(false);
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
          // Only the focused thread: the map is read with that thread's prefix
          // and nothing else, so text for background threads is unreachable
          // growth. List markers read `tail`, not this.
          if (focusId) assembleTranscripts(fresh.filter((e) => e.threadId === focusId));
          // Turn clock for the open thread: how long has it been working.
          for (const e of fresh) {
            if (focusId && e.threadId !== focusId) continue;
            if (e.type === "turn/started") {
              setTurnStartedAt(e.ts || Date.now());
              setSentAt(null);
            } else if (e.type === "turn/completed") {
              setTurnStartedAt(null);
              setSentAt(null);
            } else if (e.type === "provider/error" || e.type === "system/error") {
              setThreadError(eventActivityLabel(e) ?? "provider error");
              setSentAt(null);
            }
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
            applyTimeline(focusId, tl);
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
  // A turn reports itself within a second or two of a send. If one never does,
  // the send is the last honest thing we know — stop claiming work is underway
  // rather than spinning forever.
  const pendingSend = sentAt !== null && Date.now() - sentAt < UNANSWERED_SEND_MS ? sentAt : null;
  const waitingSince = turnStartedAt ?? pendingSend;
  useEffect(() => {
    if (waitingSince === null) return;
    // Fast enough that the spinner reads as motion; the pane redraws are cheap
    // next to the poll they sit between.
    const t = setInterval(() => setClockTick((n) => n + 1), SPINNER_MS);
    return () => clearInterval(t);
  }, [waitingSince]);

  const elapsedSeconds = useMemo(
    () => (turnStartedAt === null ? null : Math.max(0, Math.round((Date.now() - turnStartedAt) / 1000))),
    [turnStartedAt, clockTick],
  );

  const waiting = useMemo(
    () =>
      waitingSince === null
        ? null
        : {
            seconds: Math.max(0, Math.round((Date.now() - waitingSince) / 1000)),
            frame: SPINNER_FRAMES[clockTick % SPINNER_FRAMES.length]!,
          },
    [waitingSince, clockTick],
  );

  function assembleTranscripts(events: BufferedEvent[]) {
    assembleToolItems(toolsRef.current, events);
    for (const e of events) {
      const d = e.payload?.data ?? {};
      const itemId = d.itemId;
      if (!itemId) continue;
      const key = `${e.threadId}::${itemId}`;
      const map = e.type.startsWith("item/reasoning/") ? reasoningRef.current : transcriptsRef.current;
      if (typeof d.delta === "string" && e.type.endsWith("/delta")) {
        const cur = map.get(key)?.text ?? "";
        map.set(key, { text: (cur + d.delta).slice(-MAX_TRANSCRIPT_CHARS), ts: e.ts });
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

  /** Timeline blocks plus the coverage the live delta layer is filtered by. */
  function applyTimeline(threadId: string, tl: Timeline) {
    const cov = timelineCoverage(tl.items);
    setTimeline(tl.items.flatMap((i) => timelineBlocks(i)).slice(-MAX_TRANSCRIPT_BLOCKS));
    setCoverage(cov);
    pruneTranscripts(threadId, cov);
    // Only while nothing is paged in: once scroll-back starts, the head page's
    // cursor would walk back over history that is already on screen.
    setOlderCursor((prev: TimelineCursor | null) => (pagingStartedRef.current ? prev : (tl.page?.hasOlderRows ? (tl.page.olderCursor ?? null) : null)));
  }

  /** Pull the page of rows just above what is loaded. Scroll position is
   * measured from the bottom, so prepending never moves the viewport. */
  async function loadOlder(threadId: string) {
    if (!info || pagingRef.current || !olderCursor) return;
    pagingRef.current = true;
    pagingStartedRef.current = true;
    try {
      const tl = await getTimeline(info, threadId, olderCursor);
      const blocks = tl.items.flatMap((i) => timelineBlocks(i));
      setOlder((prev) => [...blocks, ...prev].slice(-MAX_HISTORY_BLOCKS));
      setOlderCursor(tl.page?.hasOlderRows ? (tl.page.olderCursor ?? null) : null);
      setStatus(blocks.length > 0 ? `loaded ${blocks.length} older rows` : "at the start of the thread");
    } catch (err) {
      setStatus(`history error: ${String(err)}`);
    } finally {
      pagingRef.current = false;
    }
  }

  /** Coverage only ever moves forward, so an entry it accounts for can never be
   * rendered again. Dropping exactly the set the transcript filter rejects is
   * safe by construction and keeps the map at roughly one turn's worth. */
  function pruneTranscripts(threadId: string, cov: TimelineCoverage) {
    const prefix = `${threadId}::`;
    for (const map of [transcriptsRef.current, reasoningRef.current, toolsRef.current] as Array<
      Map<string, { ts: number }>
    >) {
      for (const [k, v] of map) {
        if (!k.startsWith(prefix)) continue;
        if (coveredByTimeline(cov, k.slice(prefix.length), v.ts)) map.delete(k);
      }
    }
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
    setOlder([]);
    setOlderCursor(null);
    pagingRef.current = false;
    pagingStartedRef.current = false;
    setCoverage(timelineCoverage([]));
    // Nothing from the thread we just left is reachable again.
    transcriptsRef.current.clear();
    reasoningRef.current.clear();
    toolsRef.current.clear();
    setExecution(null);
    setPlanMode(null);
    setComposer(EMPTY);
    setScrollUp(0);
    setSentAt(null);
    setThreadError(null);
    setStatus(`opening ${t.id}`);
    // Project-scoped, since project skills override user and builtin ones.
    void listSkills(t.projectId)
      .then((skills) => setCatalog(buildCatalog(skills)))
      .catch(() => setCatalog(buildCatalog([])));
    try {
      const tl = await getTimeline(info!, t.id);
      applyTimeline(t.id, tl);
      setExecution(tl.execution ?? null);
      setPlanMode(tl.planMode ?? null);
      const evs = tailRef.current.filter((e) => e.threadId === t.id);
      assembleTranscripts(evs);
      setStatus(`${t.providerId} · ${t.status}`);
    } catch (err) {
      setStatus(`timeline error: ${String(err)}`);
      setThreadError(`timeline error: ${String(err)}`);
    }
  }

  /** The bb-side implementation of a slash command. Kept next to the table it
   * serves rather than inside it, so the table stays data. */
  function runBbCommand(name: string, threadId: string, args: string): Promise<unknown> {
    if (name === "compact") return compactThread(threadId);
    if (name === "cancel-plan") return cancelPlan(threadId);
    if (name === "model") {
      return args.trim() ? setThreadModel(threadId, args.trim()) : Promise.reject(new Error("usage: /model <id>"));
    }
    return Promise.reject(new Error(`no bb implementation for /${name}`));
  }

  function backToHome() {
    setView({ kind: "home" });
    setFocus("list");
    setComposer(EMPTY);
    refreshThreadStatuses();
  }

  function appendUserMsg(threadId: string, text: string) {
    setUserMsgs((prev) => {
      const list = prev.get(threadId) ?? [];
      if (list[list.length - 1] === text) return prev;
      return new Map(prev).set(threadId, [...list.slice(-60), text]);
    });
  }

  async function send() {
    if (view.kind !== "detail" || !composer.text.trim()) return;
    const tid = view.thread.id;
    const resolved = resolveSlash(composer.text);
    setComposer(EMPTY);
    setScrollUp(0);
    // Sending is the user's answer to whatever went wrong last.
    setThreadError(null);

    // A message that *is* a bb command runs the same operation the app composer
    // does; `bb thread tell` is raw and would send the literal string instead.
    if (resolved.kind === "command") {
      setStatus(`running /${resolved.name}…`);
      try {
        await runBbCommand(resolved.name, tid, resolved.args);
        setStatus(`/${resolved.name} done`);
        refreshThreadStatuses();
      } catch (err) {
        setStatus(`/${resolved.name} error: ${String(err)}`);
        setThreadError(`/${resolved.name}: ${String(err)}`);
      }
      return;
    }

    appendUserMsg(tid, resolved.text);
    setStatus("sending…");
    try {
      await tellThread(tid, resolved.text);
      setSentAt(Date.now());
      setStatus(`sent → ${view.thread.providerId}`);
      refreshThreadStatuses();
    } catch (err) {
      setStatus(`tell error: ${String(err)}`);
      setThreadError(`send failed: ${String(err)}`);
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

  /** Apply a model picked from the `/model` menu. The composer clears, because
   * the command has already run — there is nothing left to send. */
  async function applyModel(threadId: string, model: string) {
    setComposer(EMPTY);
    setStatus(`switching to ${model}…`);
    try {
      await setThreadModel(threadId, model);
      setExecution((prev) => (prev ? { ...prev, model } : prev));
      setStatus(`model → ${model}`);
    } catch (err) {
      setStatus(`model error: ${String(err)}`);
      setThreadError(`model error: ${String(err)}`);
    }
  }

  // ---- keyboard ----
  useInput((data, key) => {
    if (key.ctrl && data === "c") return exit();
    // Mouse reports arrive on the same stream; the listener below owns them.
    if (isMouseInput(data)) return;
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
        setSentAt(null);
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
    // The server timeline is authoritative; live text is only what it has not
    // accounted for. An item the timeline already carries is a duplicate, and
    // one that predates its newest row is history the timeline page windowed
    // out — replaying either appends the conversation a second time, out of
    // order, below the timeline.
    const live = (map: Map<string, { text: string; ts: number }>, role: TranscriptBlock["role"]) =>
      [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .filter(([k, v]) => v.text.trim().length > 0 && !coveredByTimeline(coverage, k.slice(prefix.length), v.ts))
        .map(([, v]) => ({ role, text: v.text.trim(), ts: v.ts }));
    // One list, ordered by when each piece arrived: a tool call after the
    // sentence that announced it, not in a block of its own at the bottom.
    const agent: Array<TranscriptBlock & { ts: number }> = [
      ...live(transcriptsRef.current, "agent"),
      ...live(toolsRef.current, "work"),
      ...(hideReasoning ? [] : live(reasoningRef.current, "reasoning")),
    ].sort((a, b) => a.ts - b.ts);
    const sent = new Set(timeline.filter((b) => b.role === "user").map((b) => b.text));
    const users: TranscriptBlock[] = (userMsgs.get(view.thread.id) ?? [])
      .filter((text) => !sent.has(text))
      .map((text) => ({ role: "user" as const, text }));
    return { blocks: [...timeline, ...users, ...agent], live: focusedEvents.length };
  }, [timeline, coverage, userMsgs, focusedEvents, hideReasoning, view]);

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
  const visibleCount = Math.max(4, rows - 6);
  // Keep the selection four rows down the pane, but stop scrolling once the end
  // of the list is on screen. Also what turns a click's y into a row.
  const firstVisible = Math.max(0, Math.min(sel - 4, listRows.length - visibleCount));

  // ---- mouse ----
  // The wheel scrolls whatever it is over; a click focuses that pane, and on a
  // list row opens it. Held in a ref because the listener is attached once and
  // the handler closes over state that changes every frame.
  const mouseRef = useRef<(event: MouseEvent) => void>(() => {});
  mouseRef.current = (event: MouseEvent) => {
    const target = hitTest(cols, rows, focus, event.x, event.y);
    if (!target) return;
    if (event.kind === "wheel") {
      const up = event.direction === "up";
      if (target.pane === "detail") {
        if (view.kind === "detail") setScrollUp((sc) => (up ? sc + 3 : Math.max(0, sc - 3)));
        return;
      }
      setSel((sc) => Math.max(0, Math.min(listRows.length - 1, sc + (up ? -1 : 1))));
      return;
    }
    // Right and middle buttons have no meaning here; ignoring them beats
    // guessing at one.
    if (event.button !== 0) return;
    if (target.pane === "detail") {
      if (view.kind === "detail") setFocus("detail");
      return;
    }
    const row = listRows[firstVisible + target.row];
    if (!row) return;
    setSel(firstVisible + target.row);
    setFocus("list");
    if (row.kind === "project") toggleProject(row.projectId);
    else void openThread(row.thread);
  };

  // Tracking itself is turned on at entry, next to the alternate screen, so a
  // crash restores the terminal the same way it restores the screen.
  const { stdin } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      for (const event of parseMouse(chunk.toString())) mouseRef.current(event);
    };
    stdin.on("data", onData);
    return () => void stdin.off("data", onData);
  }, [stdin]);

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
  // `/model …` replaces the command list with the provider's models, so the
  // picker is the same popover the rest of the slash namespace uses.
  const modelFilter =
    focus === "detail" && view.kind === "detail" ? modelQuery(composer.text) : null;
  const menuMatches = useMemo(
    () =>
      modelFilter !== null
        ? modelEntries(models, modelFilter)
        : slashToken
          ? matchEntries(catalog, slashToken.text)
          : [],
    [catalog, slashToken, modelFilter, models],
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
  const tokenText = modelFilter !== null ? `model:${modelFilter}` : (slashToken?.text ?? null);
  useEffect(() => {
    setMenuDismissed(false);
    setMenuSelection(INITIAL_MENU_SELECTION);
  }, [tokenText]);

  // Models are a ~300ms subprocess, so they load once per provider, the first
  // time the picker is asked for.
  const providerId = view.kind === "detail" ? view.thread.providerId : null;
  useEffect(() => {
    if (modelFilter === null || !providerId) return;
    if (modelsProviderRef.current === providerId) return;
    modelsProviderRef.current = providerId;
    void providerModels(providerId)
      .then(setModels)
      .catch(() => {
        modelsProviderRef.current = null;
        setModels([]);
        setStatus(`could not list models for ${providerId}`);
      });
  }, [modelFilter, providerId]);

  function acceptMenuEntry() {
    const entry = menuMatches[visibleMenuSelection.selected];
    if (!entry) return;
    if (entry.kind === "model") {
      if (view.kind === "detail") void applyModel(view.thread.id, entry.name);
      return;
    }
    if (!slashToken) return;
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

  // History renders on its own, because it is immutable and the live page is
  // not: folding them into one call would re-wrap every scrolled-back block on
  // the 4s refresh that only ever changes the tail.
  const olderLines = useMemo(
    () => (view.kind === "detail" ? renderBlocks(older, detailInnerW) : []),
    [older, detailInnerW, view],
  );
  const headLines = useMemo(
    () => (view.kind === "detail" ? renderBlocks(conversation.blocks, detailInnerW) : []),
    [conversation, detailInnerW, view],
  );
  const detailLines = useMemo(
    // renderBlocks separates its own blocks; the seam between the two calls is
    // the one gap neither of them knows about.
    () =>
      olderLines.length > 0 && headLines.length > 0
        ? [...olderLines, { spans: [] }, ...headLines]
        : [...olderLines, ...headLines],
    [olderLines, headLines],
  );

  // The pane's own geometry, computed here from the same two exported helpers
  // it uses, so the scroll ceiling and the paging trigger agree with what is
  // actually on screen.
  const detailMenu = menuOpen ? { entries: menuMatches, ...visibleMenuSelection } : undefined;
  const detailLineCount = detailLines.length;
  const visibleTranscriptRows = transcriptRows(
    Math.max(8, rows - 1) - 2,
    menuHeight(detailMenu),
    planMode ? 1 : 0,
    (waiting ? 1 : 0) + (threadError ? 1 : 0),
  );
  const maxScrollUp = Math.max(0, detailLineCount - visibleTranscriptRows);

  // Scrolling past the top used to be free — the pane clamps for display, so
  // the overshoot was invisible. It stops being invisible once history can
  // arrive underneath it: the clamp would let go and the view would jump by
  // however far past the end the counter had run.
  useEffect(() => {
    setScrollUp((s) => Math.min(s, maxScrollUp));
  }, [maxScrollUp]);

  // Page history in as the scroll reaches the top.
  useEffect(() => {
    if (view.kind !== "detail" || !olderCursor) return;
    if (scrollUp < maxScrollUp) return;
    void loadOlder(view.thread.id);
  }, [scrollUp, maxScrollUp, olderCursor, view]);

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
              menu: detailMenu,
              focus,
              elapsedSeconds,
              execution,
              planMode,
              waiting,
              errorText: threadError,
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
const tty = process.stdout.isTTY;
const restoreScreen = tty ? enterAlternateScreen(process.stdout) : () => {};
const restoreMouse = tty ? enableMouse(process.stdout) : () => {};
const restore = () => {
  restoreMouse();
  restoreScreen();
};
process.once("exit", restore);
const instance = render(<App />);
void instance.waitUntilExit().finally(() => {
  restore();
  process.off("exit", restore);
});
