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
  width: number;
  height: number;
};

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
        const marker = props.activityByThread.get(thread.id);
        const markerWidth = marker ? Math.min(14, Math.max(8, Math.floor(props.width * 0.25))) : 0;
        const titleWidth = Math.max(8, props.width - 8 - markerWidth);
        const title = (thread.title ?? thread.titleFallback ?? thread.id).slice(0, titleWidth);

        return (
          <Text key={thread.id} color={selected ? "green" : undefined} wrap="truncate">
            {selected ? "› " : "  "}
            {thread.pinnedAt ? "◆" : " "}
            <Text color={status.color}>{status.glyph}</Text> {title}
            {marker && (
              <Text dimColor>
                {" "}
                {marker.slice(0, markerWidth)}
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
  timelineLength: number;
  conversationLive: number;
  detailLines: MdLine[];
  scrollUp: number;
  inputRows: string[];
  focus: PaneFocus;
  cursorSeq: number;
  width: number;
  height: number;
};

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
      <Text wrap="truncate">
        <Text color="cyan" bold>
          {(thread.title ?? thread.titleFallback ?? thread.id).slice(0, 60)}
        </Text>
        <Text dimColor>
          {" "}
          {props.projectName} · {thread.providerId} · {thread.status}
          {active ? " ●" : ""}
        </Text>
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
      <Text dimColor wrap="truncate">
        {clamped === 0 ? "▼ bottom" : `▲ ${clamped}`} · history {props.timelineLength} · live{" "}
        {props.conversationLive} · seq {props.cursorSeq}
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
