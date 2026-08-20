import React, { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { Execution, ThreadRow } from "./api.js";
import type { MdLine } from "./markdown.js";
import type { ComposerLayout } from "./composer.js";
import { MENU_MAX_ENTRIES, type CatalogEntry } from "./commands.js";

export type PaneFocus = "list" | "detail";

export type PaneLayout = {
  compact: boolean;
  listWidth: number;
  detailWidth: number;
};

/** Calculate stable pane widths while reserving one terminal column to avoid wrapping. */
/** Transcript rows the detail pane can show. Exported because the app has to
 * ask the same question to size its scroll ceiling and decide when to page in
 * history — two copies of this arithmetic would drift apart the first time the
 * pane's chrome changes height. */
export function transcriptRows(height: number, menuRows = 0, planRows = 0, extraRows = 0): number {
  return Math.max(3, height - 10 - menuRows - planRows - extraRows);
}

export function calculatePaneLayout(
  columns: number,
  focus: PaneFocus,
  listHidden = false,
): PaneLayout {
  const usableColumns = Math.max(1, columns - 1);

  // Hidden is the compact case without the focus rule: the thread pane owns the
  // width whether or not it holds focus.
  if (listHidden) return { compact: true, listWidth: 0, detailWidth: usableColumns };

  if (columns < 72) {
    return {
      compact: true,
      listWidth: focus === "list" ? usableColumns : 0,
      detailWidth: focus === "detail" ? usableColumns : 0,
    };
  }

  const listWidth = Math.min(44, Math.floor(columns * 0.3));
  return {
    compact: false,
    listWidth,
    detailWidth: Math.max(1, usableColumns - listWidth - 1),
  };
}

export type MouseTarget = { pane: "list"; row: number } | { pane: "detail" } | null;

/** Map 1-based terminal coordinates onto a pane, and onto the list row under
 * the pointer. Kept beside calculatePaneLayout because it is the same geometry
 * read backwards — split them and a border change breaks clicking silently.
 * The returned row is an offset into the visible window, not the row list. */
export function hitTest(
  columns: number,
  rows: number,
  focus: PaneFocus,
  x: number,
  y: number,
  listHidden = false,
): MouseTarget {
  const layout = calculatePaneLayout(columns, focus, listHidden);
  if (listHidden) return { pane: "detail" };
  const paneTop = 2; // the top bar owns row 1
  const paneBottom = paneTop + Math.max(8, rows - 1) - 2 - 1;
  if (y < paneTop || y > paneBottom) return null;
  if (layout.compact) return focus === "list" ? listHit(y, paneTop) : { pane: "detail" };
  return x <= layout.listWidth ? listHit(y, paneTop) : { pane: "detail" };
}

function listHit(y: number, paneTop: number): MouseTarget {
  const row = y - paneTop - 1; // the pane's own border takes the first row
  return row >= 0 ? { pane: "list", row } : null;
}

const STATUS_STYLE: Record<string, { glyph: string; color: string }> = {
  active: { glyph: "●", color: "green" },
  starting: { glyph: "◐", color: "yellow" },
  stopping: { glyph: "◌", color: "yellow" },
  error: { glyph: "✗", color: "red" },
  idle: { glyph: "○", color: "gray" },
};

/** One navigator row. Projects and their threads share a single index space so
 * arrow keys move through the tree without special cases. */
export type ListRow =
  | { kind: "project"; projectId: string; name: string; count: number; collapsed: boolean }
  | { kind: "thread"; thread: ThreadRow };

export type ThreadListPaneProps = {
  rows: ListRow[];
  selectedIndex: number;
  firstVisible: number;
  visibleCount: number;
  activityByThread: Map<string, string>;
  hostNames: Map<string, string>;
  width: number;
  height: number;
  focused?: boolean;
};

// A branch every thread shares distinguishes nothing; it just repeats down the
// column and steals title width.
const UNINFORMATIVE_BRANCHES = new Set(["main", "master", "trunk", "default"]);

/** Stable per-thread metadata for the right-hand column: the branch it works on,
 * or the machine it runs on when the branch says nothing. Generated worktree
 * branches carry the thread id as a suffix — drop it, it is already the row.
 * Returns "" whenever the value would be the same for every row, because a
 * column of identical values is worse than no column. */
export function threadMeta(thread: ThreadRow, hostNames: Map<string, string>): string {
  const branch = (thread.environmentBranchName ?? "")
    .replace(/-?thr_[a-z0-9]+$/i, "")
    .replace(/^bb\//, "");
  if (branch && !UNINFORMATIVE_BRANCHES.has(branch)) return branch;
  // With a single machine enrolled, naming it tells you nothing either.
  if (hostNames.size > 1) return hostNames.get(thread.environmentHostId ?? "") ?? "";
  return "";
}

/** Render the thread navigator: threads grouped under their project, without
 * provider labels. */
export function ThreadListPane(props: ThreadListPaneProps) {
  const visibleRows = props.rows.slice(props.firstVisible, props.firstVisible + props.visibleCount);
  const remaining = props.rows.length - (props.firstVisible + props.visibleCount);

  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      borderStyle="round"
      borderColor={props.focused ? "cyan" : "gray"}
      borderDimColor={!props.focused}
      overflow="hidden"
    >
      {props.rows.length === 0 && <Text dimColor>no threads</Text>}
      {visibleRows.map((row, index) => {
        const selected = props.firstVisible + index === props.selectedIndex;

        if (row.kind === "project") {
          return (
            <Text key={`p:${row.projectId}`} color={selected ? "green" : undefined} wrap="truncate">
              {selected ? "›" : " "}
              {row.collapsed ? "▸" : "▾"} <Text bold>{row.name}</Text> <Text dimColor>{row.count}</Text>
            </Text>
          );
        }

        const thread = row.thread;
        const status = STATUS_STYLE[thread.status] ?? STATUS_STYLE.idle!;
        const running = thread.status === "active" || thread.status === "starting";
        // A running thread's live activity is the useful thing to show; a settled
        // one's is a stale fragment, so it yields to stable metadata you can
        // actually scan by (which branch / which machine).
        const meta = running ? props.activityByThread.get(thread.id) : threadMeta(thread, props.hostNames);
        const metaWidth = meta ? Math.min(22, Math.max(8, Math.floor(props.width * 0.3))) : 0;
        const titleWidth = Math.max(8, props.width - 8 - metaWidth);
        const title = (thread.title ?? thread.titleFallback ?? thread.id).slice(0, titleWidth);
        const shown = meta ? meta.slice(0, metaWidth) : "";
        // Flush the metadata right so the column reads as a column.
        const gap = Math.max(1, titleWidth - title.length + (metaWidth - shown.length) + 1);

        return (
          <Text key={thread.id} color={selected ? "green" : undefined} wrap="truncate">
            {selected ? "› " : "  "}
            {thread.pinnedAt ? "◆" : " "}
            <Text color={status.color}>{status.glyph}</Text> {title}
            {shown !== "" && (
              <Text dimColor>
                {" ".repeat(gap)}
                {shown}
              </Text>
            )}
          </Text>
        );
      })}
      {remaining > 0 && <Text dimColor>… {remaining} more</Text>}
    </Box>
  );
}

export type ThreadPaneProps = {
  thread: ThreadRow;
  projectName: string;
  hostNames: Map<string, string>;
  detailLines: MdLine[];
  scrollUp: number;
  composer: ComposerLayout;
  /** Slash completion, when the token at the cursor matches something. */
  menu?: { entries: CatalogEntry[]; selected: number; firstVisible: number };
  focus: PaneFocus;
  /** Seconds the current turn has been running, when one is. */
  elapsedSeconds: number | null;
  /** Execution options for the next turn, once the timeline has reported them. */
  execution?: Execution | null;
  /** Set while the provider is in plan mode. */
  planMode?: { prompt: string } | null;
  /** Set while a turn is outstanding — from the moment a message is sent, not
   * from the moment the provider gets around to reporting a turn. */
  waiting?: { seconds: number; frame: string } | null;
  /** The last thing that went wrong on this thread. Lives in the pane rather
   * than the top bar, because a one-line status shared with routine chatter is
   * where errors go to be missed. */
  errorText?: string | null;
  /** Debug counters, shown only when BB_TUI_DEBUG is set. */
  debug?: { timelineLength: number; conversationLive: number; cursorSeq: number };
  width: number;
  height: number;
};

/** The composer context line: project, machine, branch, model, permission mode,
 * and what the thread is doing right now. Empty parts are dropped rather than
 * shown blank. */
export function contextRow(props: ThreadPaneProps): string[] {
  const thread = props.thread;
  const running = thread.status === "active" || thread.status === "starting";
  const parts = [
    props.projectName,
    props.hostNames.get(thread.environmentHostId ?? "") ?? "",
    thread.environmentBranchName ?? "",
    // Permission mode precedes the model because the row truncates from the
    // right: a bounded enum is useless half-rendered, while a model id stays
    // recognizable. It is also the one fact here with safety consequences.
    props.execution?.permissionMode ?? "",
    // The model is the more specific fact and implies the provider, so it takes
    // the slot rather than adding one. Provider stands in until it arrives.
    props.execution?.model ?? thread.providerId,
    // The spinner row carries "working"; repeating it here would only cost
    // width the model id and permission mode need.
    thread.status,
  ];
  if (props.debug) {
    parts.push(
      `history ${props.debug.timelineLength}`,
      `live ${props.debug.conversationLive}`,
      `seq ${props.debug.cursorSeq}`,
    );
  }
  return parts.filter((p) => p !== "");
}

/** Rows the slash menu occupies, including its section headers. Capped so it
 * can never crowd the transcript out entirely. */
export function menuHeight(menu: ThreadPaneProps["menu"]): number {
  if (!menu || menu.entries.length === 0) return 0;
  const shown = menu.entries.slice(menu.firstVisible, menu.firstVisible + MENU_MAX_ENTRIES);
  const sections = new Set(shown.map((entry) => entry.kind)).size;
  return shown.length + sections + 2;
}

/** Slash completion, sectioned like the app: commands, then skills. */
function SlashMenu(props: { menu: NonNullable<ThreadPaneProps["menu"]>; width: number }) {
  const shown = props.menu.entries.slice(
    props.menu.firstVisible,
    props.menu.firstVisible + MENU_MAX_ENTRIES,
  );
  const innerWidth = Math.max(1, props.width - 2);
  const nameWidth = Math.max(12, Math.floor(innerWidth * 0.4));
  const descWidth = Math.max(0, innerWidth - nameWidth - 5);
  let section: string | null = null;

  return (
    <Box flexDirection="column" width={props.width} borderStyle="single" borderColor="cyan">
      {shown.map((entry, index) => {
        const header = entry.kind !== section ? (section = entry.kind) : null;
        const selected = props.menu.firstVisible + index === props.menu.selected;
        return (
          <Box flexDirection="column" key={`${entry.kind}:${entry.name}`}>
            {header && <Text dimColor>{header === "command" ? "Commands" : header === "model" ? "Models" : "Skills"}</Text>}
            <Text wrap="truncate" inverse={selected}>
              {entry.kind === "command" ? " > " : entry.kind === "model" ? " ◆ " : " ~ "}
              {entry.name.slice(0, nameWidth).padEnd(nameWidth)}
              <Text dimColor={!selected}> {entry.description.slice(0, descWidth)}</Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/** One composer row with the cursor drawn as an inverse cell. Terminals hide the
 * real cursor in the alternate screen, so the block is the only position cue. */
export function CursorLine(props: { text: string; column: number; focused: boolean }) {
  const before = props.text.slice(0, props.column);
  const under = props.text.slice(props.column, props.column + 1) || " ";
  const after = props.text.slice(props.column + 1);
  if (!props.focused) return <Text>{props.text === "" ? " " : props.text}</Text>;
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  );
}

/** Render thread history and a fixed-height, visually distinct composer. */
export function ThreadPane(props: ThreadPaneProps) {
  const thread = props.thread;
  const active = thread.status === "active" || thread.status === "starting";
  // The pane has fixed geometry, so the menu takes its rows from the transcript
  // rather than overlaying it.
  const menuRows = menuHeight(props.menu);
  const menuActive = menuRows > 0;
  const planRows = props.planMode ? 1 : 0;
  const extraRows = (props.waiting ? 1 : 0) + (props.errorText ? 1 : 0);
  const visibleCount = transcriptRows(props.height, menuRows, planRows, extraRows);
  const scrollable = Math.max(0, props.detailLines.length - visibleCount);
  const clamped = Math.min(props.scrollUp, scrollable);
  const from = Math.max(0, props.detailLines.length - visibleCount - clamped);
  const visible = props.detailLines.slice(from, from + visibleCount);
  const composer = props.composer;
  const empty = composer.rows.length === 1 && composer.rows[0] === "";

  return (
    <Box
      flexDirection="column"
      width={props.width}
      height={props.height}
      borderStyle="round"
      borderColor="gray"
      borderDimColor
      overflow="hidden"
    >
      {/* Title only — the context line below the transcript carries the rest. */}
      <Text wrap="truncate">
        <Text color="cyan" bold>
          {(thread.title ?? thread.titleFallback ?? thread.id).slice(0, Math.max(8, props.width - 4))}
        </Text>
        {active ? <Text color="green"> ●</Text> : ""}
      </Text>
      <Box flexDirection="column" height={visibleCount} overflow="hidden">
        {visible.length === 0 && <Text dimColor>{active ? "streaming…" : "no messages"}</Text>}
        {visible.map((line, index) =>
          line.spans.every((span) => span.text.trim() === "") ? (
            // A blank MdLine may contain only zero-width padding spans; Ink
            // gives the resulting Text zero height. The Box consumes the row
            // already budgeted for the separator in visibleCount.
            <Box key={from + index} minHeight={1} flexShrink={0}>
              <Text> </Text>
            </Box>
          ) : (
            <Text key={from + index} wrap="truncate">
              {line.spans.map((span, spanIndex) => (
                <Text
                  key={spanIndex}
                  bold={span.bold}
                  italic={span.italic}
                  dimColor={span.dim}
                  color={span.color}
                >
                  {span.text}
                </Text>
              ))}
            </Text>
          ),
        )}
      </Box>
      {props.waiting && (
        <Text wrap="truncate">
          <Text color="cyan">
            {props.waiting.frame} working {props.waiting.seconds}s
          </Text>
          <Text dimColor> · ^x to stop</Text>
        </Text>
      )}
      {/* Context, not counters: where this thread runs and what it is doing. */}
      <Text dimColor wrap="truncate">
        {clamped === 0 ? "▼ bottom" : `▲ ${clamped}`}
        {contextRow(props).map((part) => ` · ${part}`)}
        {props.thread.hasPendingInteraction ? " · " : ""}
        {props.thread.hasPendingInteraction ? <Text color="yellow">needs you</Text> : ""}
      </Text>
      {props.errorText && (
        <Text wrap="truncate">
          <Text color="red" bold>
            ▍{props.errorText}
          </Text>
        </Text>
      )}
      {props.planMode && (
        <Text wrap="truncate">
          <Text color="yellow">▍plan mode</Text>
          <Text dimColor> · /cancel-plan to exit</Text>
        </Text>
      )}
      {props.menu && menuRows > 0 && <SlashMenu menu={props.menu} width={props.width - 4} />}
      <Box
        flexDirection="column"
        height={6}
        borderStyle="single"
        borderColor={props.focus === "detail" && !menuActive ? "cyan" : "gray"}
        borderDimColor={props.focus !== "detail" || menuActive}
        paddingX={1}
      >
        <Text color={props.focus === "detail" && !menuActive ? "cyan" : "gray"}>
          MESSAGE
          {composer.scrolled ? <Text dimColor> ▲</Text> : ""}
        </Text>
        {empty ? (
          <Text>
            {props.focus === "detail" ? <Text inverse> </Text> : ""}
            <Text dimColor>Type a message… (enter sends · shift-enter or ctrl-o for a new line)</Text>
          </Text>
        ) : (
          composer.rows.map((line, index) => (
            <Text key={index} wrap="truncate">
              {index === composer.cursorRow ? (
                <CursorLine text={line} column={composer.cursorCol} focused={props.focus === "detail"} />
              ) : (
                <Text>{line === "" ? " " : line}</Text>
              )}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}

type WorkspaceListProps = Omit<ThreadListPaneProps, "width" | "height">;
type WorkspaceDetailProps = Omit<ThreadPaneProps, "width" | "height">;

export type WorkspaceLayoutProps = {
  columns: number;
  rows: number;
  focus: PaneFocus;
  /** Thread list folded away, giving the open thread the whole frame. */
  listHidden?: boolean;
  topBar: ReactNode;
  list: WorkspaceListProps;
  detail?: WorkspaceDetailProps;
};

/** Compose stable panes and keep contextual shortcuts outside their borders. */
export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const layout = calculatePaneLayout(props.columns, props.focus, props.listHidden);
  const frameHeight = Math.max(8, props.rows - 1);
  const paneHeight = frameHeight - 2;
  const showList = !props.listHidden && (!layout.compact || props.focus === "list");
  const showDetail = props.listHidden === true || !layout.compact || props.focus === "detail";

  return (
    <Box flexDirection="column" height={frameHeight}>
      <Text wrap="truncate">{props.topBar}</Text>
      <Box flexDirection="row" height={paneHeight}>
        {showList && (
          <ThreadListPane
            {...props.list}
            width={layout.listWidth}
            height={paneHeight}
            focused={props.focus === "list"}
          />
        )}
        {!layout.compact && <Box width={1} />}
        {showDetail && props.detail ? (
          <ThreadPane {...props.detail} width={layout.detailWidth} height={paneHeight} />
        ) : showDetail ? (
          <Box
            flexDirection="column"
            width={layout.detailWidth}
            height={paneHeight}
            borderStyle="round"
            overflow="hidden"
          >
            <Text dimColor>select a thread (↑/↓, enter) or press n for a new thread</Text>
            <Text dimColor wrap="truncate">
              tab switches focus to the composer once a thread is open
            </Text>
          </Box>
        ) : null}
      </Box>
      <ShortcutFooter
        compact={layout.compact}
        detailOpen={props.detail !== undefined}
        focus={props.focus}
        listHidden={props.listHidden}
      />
    </Box>
  );
}

export function ShortcutFooter(props: {
  compact: boolean;
  detailOpen: boolean;
  focus: PaneFocus;
  listHidden?: boolean;
}) {
  const listKey = props.listHidden ? "^s show list" : "^s hide list";
  // Hidden comes first: the state that removed the list from the screen is the
  // one that has to say how to get it back.
  const shortcuts = props.listHidden
    ? `↑/↓ scroll · enter send · ⇧enter/^o newline · ^x stop · ${listKey} · tab list`
    : props.compact
    ? props.detailOpen && props.focus === "detail"
      ? "↑/↓ scroll · enter send · ^o newline · ^x stop · tab list"
      : "↑/↓ select · ←/→ fold · / filter · enter open · n new · q quit"
    : !props.detailOpen
      ? "↑/↓ select · ←/→ fold · / filter · enter open · n new · esc home · q quit"
      : props.focus === "list"
        ? "↑/↓ select · ←/→ fold · / filter · enter open · n new · tab composer · esc home · q quit"
        : `↑/↓ scroll · enter send · ⇧enter/^o newline · ^x stop · ${listKey} · tab list`;
  return (
    <Text dimColor wrap="truncate">
      {shortcuts}
    </Text>
  );
}
