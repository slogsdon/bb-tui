import React, { type ReactNode } from "react";
import { Box, Text } from "ink";
import type { ThreadRow } from "./api.js";
import type { MdLine } from "./markdown.js";

export type PaneFocus = "list" | "detail";

export type PaneLayout = {
  compact: boolean;
  listWidth: number;
  detailWidth: number;
};

/** Calculate stable pane widths while reserving one terminal column to avoid wrapping. */
export function calculatePaneLayout(columns: number, focus: PaneFocus): PaneLayout {
  const usableColumns = Math.max(1, columns - 1);

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
};

/** Stable per-thread metadata for the right-hand column: the branch it works on,
 * or the machine it runs on when the branch says nothing. Generated worktree
 * branches carry the thread id as a suffix — drop it, it is already the row. */
export function threadMeta(thread: ThreadRow, hostNames: Map<string, string>): string {
  const branch = thread.environmentBranchName ?? "";
  if (branch) return branch.replace(/-?thr_[a-z0-9]+$/i, "").replace(/^bb\//, "");
  const host = thread.environmentHostId ?? "";
  return hostNames.get(host) ?? "";
}

/** Render the thread navigator: threads grouped under their project, without
 * provider labels. */
export function ThreadListPane(props: ThreadListPaneProps) {
  const visibleRows = props.rows.slice(props.firstVisible, props.firstVisible + props.visibleCount);
  const remaining = props.rows.length - (props.firstVisible + props.visibleCount);

  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle="round" overflow="hidden">
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
  inputRows: string[];
  focus: PaneFocus;
  /** Seconds the current turn has been running, when one is. */
  elapsedSeconds: number | null;
  /** Debug counters, shown only when BB_TUI_DEBUG is set. */
  debug?: { timelineLength: number; conversationLive: number; cursorSeq: number };
  width: number;
  height: number;
};

/** The composer context line: project, machine, branch, provider, and what the
 * thread is doing right now. Empty parts are dropped rather than shown blank. */
export function contextRow(props: ThreadPaneProps): string[] {
  const thread = props.thread;
  const running = thread.status === "active" || thread.status === "starting";
  const parts = [
    props.projectName,
    props.hostNames.get(thread.environmentHostId ?? "") ?? "",
    thread.environmentBranchName ?? "",
    thread.providerId,
    running && props.elapsedSeconds !== null
      ? `working ${props.elapsedSeconds}s · esc to interrupt`
      : thread.status,
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

/** Render thread history and a fixed-height, visually distinct composer. */
export function ThreadPane(props: ThreadPaneProps) {
  const thread = props.thread;
  const active = thread.status === "active" || thread.status === "starting";
  const visibleCount = Math.max(3, props.height - 10);
  const scrollable = Math.max(0, props.detailLines.length - visibleCount);
  const clamped = Math.min(props.scrollUp, scrollable);
  const from = Math.max(0, props.detailLines.length - visibleCount - clamped);
  const visible = props.detailLines.slice(from, from + visibleCount);
  const inputRows = props.inputRows.slice(-3);

  return (
    <Box flexDirection="column" width={props.width} height={props.height} borderStyle="round" overflow="hidden">
      {/* Title only — the context line below the transcript carries the rest. */}
      <Text wrap="truncate">
        <Text color="cyan" bold>
          {(thread.title ?? thread.titleFallback ?? thread.id).slice(0, Math.max(8, props.width - 4))}
        </Text>
        {active ? <Text color="green"> ●</Text> : ""}
      </Text>
      <Box flexDirection="column" height={visibleCount} overflow="hidden">
        {visible.length === 0 && <Text dimColor>{active ? "streaming…" : "no messages"}</Text>}
        {visible.map((line, index) => (
          <Text key={from + index} wrap="truncate">
            {/* A blank block separator still has to occupy a row. */}
            {line.spans.length === 0
              ? " "
              : line.spans.map((span, spanIndex) => (
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
        ))}
      </Box>
      {/* Context, not counters: where this thread runs and what it is doing.
          Model and permission mode are deliberately absent — bb does not expose
          them on the thread row, and a guessed value is worse than none. */}
      <Text dimColor wrap="truncate">
        {clamped === 0 ? "▼ bottom" : `▲ ${clamped}`}
        {contextRow(props).map((part) => ` · ${part}`)}
        {props.thread.hasPendingInteraction ? " · " : ""}
        {props.thread.hasPendingInteraction ? <Text color="yellow">needs you</Text> : ""}
      </Text>
      <Box
        flexDirection="column"
        height={6}
        borderStyle="single"
        borderColor={props.focus === "detail" ? "cyan" : "gray"}
        paddingX={1}
      >
        <Text color={props.focus === "detail" ? "cyan" : "gray"}>MESSAGE</Text>
        {inputRows.length === 1 && inputRows[0] === "" ? (
          <Text dimColor>Type a message…</Text>
        ) : (
          inputRows.map((line, index) => (
            <Text key={index} color={active ? "green" : "white"} wrap="truncate">
              {line === "" ? " " : line}
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
  topBar: ReactNode;
  list: WorkspaceListProps;
  detail?: WorkspaceDetailProps;
};

/** Compose stable panes and keep contextual shortcuts outside their borders. */
export function WorkspaceLayout(props: WorkspaceLayoutProps) {
  const layout = calculatePaneLayout(props.columns, props.focus);
  const frameHeight = Math.max(8, props.rows - 1);
  const paneHeight = frameHeight - 2;
  const showList = !layout.compact || props.focus === "list";
  const showDetail = !layout.compact || props.focus === "detail";

  return (
    <Box flexDirection="column" height={frameHeight}>
      <Text wrap="truncate">{props.topBar}</Text>
      <Box flexDirection="row" height={paneHeight}>
        {showList && (
          <ThreadListPane {...props.list} width={layout.listWidth} height={paneHeight} />
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
      <ShortcutFooter compact={layout.compact} detailOpen={props.detail !== undefined} focus={props.focus} />
    </Box>
  );
}

export function ShortcutFooter(props: { compact: boolean; detailOpen: boolean; focus: PaneFocus }) {
  const shortcuts = props.compact
    ? props.detailOpen && props.focus === "detail"
      ? "↑/↓ scroll · enter send · tab list · r/x/c/m · q quit"
      : "↑/↓ select · ←/→ fold · / filter · enter open · n new · q quit"
    : !props.detailOpen
      ? "↑/↓ select · ←/→ fold · / filter · enter open · n new · esc home · q quit"
      : props.focus === "list"
        ? "↑/↓ select · ←/→ fold · / filter · enter open · n new · tab composer · esc home · q quit"
        : "↑/↓ scroll · enter send · tab list · r/x/c/m actions · esc list · q quit";
  return (
    <Text dimColor wrap="truncate">
      {shortcuts}
    </Text>
  );
}
