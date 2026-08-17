import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import type { ThreadRow } from "./api.js";
import {
  calculatePaneLayout,
  ThreadListPane,
  ThreadPane,
  WorkspaceLayout,
} from "./layout.js";

class TerminalOutput extends Writable {
  columns: number;
  rows: number;
  chunks: string[] = [];

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.chunks.push(chunk.toString());
    done();
  }
}

const sampleThread: ThreadRow = {
  id: "thr_ui",
  projectId: "proj_bb_tui",
  providerId: "codex",
  title: "Start Claude Opus UI thread",
  titleFallback: null,
  status: "active",
  parentThreadId: null,
  visibility: "visible",
  pinnedAt: null,
  archivedAt: null,
};

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderFrame(node: React.ReactElement, columns = 120, rows = 40): string {
  const stdout = new TerminalOutput(columns, rows);
  const instance = render(node, { stdout: stdout as unknown as NodeJS.WriteStream, debug: true });
  instance.unmount();
  return stripAnsi(stdout.chunks.at(-1) ?? "");
}

test("uses a 24-column thread list at 80 columns", () => {
  assert.deepEqual(calculatePaneLayout(80, "list"), {
    compact: false,
    listWidth: 24,
    detailWidth: 54,
  });
});

test("uses a 36-column thread list at 120 columns", () => {
  assert.deepEqual(calculatePaneLayout(120, "list"), {
    compact: false,
    listWidth: 36,
    detailWidth: 82,
  });
});

test("caps the thread list at 44 columns", () => {
  assert.deepEqual(calculatePaneLayout(160, "list"), {
    compact: false,
    listWidth: 44,
    detailWidth: 114,
  });
});

test("collapses to the focused detail pane below 72 columns", () => {
  assert.deepEqual(calculatePaneLayout(60, "detail"), {
    compact: true,
    listWidth: 0,
    detailWidth: 59,
  });
});

test("thread list renders status and title without provider identifiers", () => {
  const frame = renderFrame(
    <ThreadListPane
      threads={[sampleThread]}
      selectedIndex={0}
      firstVisible={0}
      visibleCount={1}
      activityByThread={new Map()}
      width={36}
      height={12}
    />,
  );

  assert.match(frame, /● Start Claude Opus UI thread/);
  assert.doesNotMatch(frame, /codex\s+Start Claude/);
});

test("thread composer renders a labeled focused border and placeholder", () => {
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      timelineLength={2}
      conversationLive={0}
      detailLines={["U: Improve the UI", "A: Inspecting the render"]}
      scrollUp={0}
      inputRows={[""]}
      focus="detail"
      cursorSeq={42}
      width={83}
      height={36}
    />,
  );

  assert.match(frame, /MESSAGE/);
  assert.match(frame, /Type a message…/);
  assert.match(frame, /┌─/);
});

test("workspace renders shortcuts below both pane borders", () => {
  const frame = renderFrame(
    <WorkspaceLayout
      columns={120}
      rows={40}
      focus="detail"
      topBar="bb-tui · active"
      list={{
        threads: [sampleThread],
        selectedIndex: 0,
        firstVisible: 0,
        visibleCount: 1,
        activityByThread: new Map(),
      }}
      detail={{
        thread: sampleThread,
        projectName: "bb-tui",
        timelineLength: 2,
        conversationLive: 0,
        detailLines: ["U: Improve the UI"],
        scrollUp: 0,
        inputRows: [""],
        focus: "detail",
        cursorSeq: 42,
      }}
    />,
  );

  assert.ok(frame.lastIndexOf("╰") < frame.indexOf("↑/↓ scroll"));
});

test("compact workspace renders only the focused detail pane", () => {
  const frame = renderFrame(
    <WorkspaceLayout
      columns={60}
      rows={24}
      focus="detail"
      topBar="bb-tui · active"
      list={{
        threads: [sampleThread],
        selectedIndex: 0,
        firstVisible: 0,
        visibleCount: 1,
        activityByThread: new Map(),
      }}
      detail={{
        thread: sampleThread,
        projectName: "bb-tui",
        timelineLength: 2,
        conversationLive: 0,
        detailLines: ["DETAIL CONTENT"],
        scrollUp: 0,
        inputRows: [""],
        focus: "detail",
        cursorSeq: 42,
      }}
    />,
    60,
    24,
  );

  assert.match(frame, /DETAIL CONTENT/);
  assert.doesNotMatch(frame, /Start Claude Opus UI thread\s+.*Start Claude Opus UI thread/);
  assert.match(frame.split("\n").at(-1) ?? "", /q quit/);
});

test("detail footer keeps the quit shortcut visible at 80 columns", () => {
  const frame = renderFrame(
    <WorkspaceLayout
      columns={80}
      rows={24}
      focus="detail"
      topBar="bb-tui · active"
      list={{
        threads: [sampleThread],
        selectedIndex: 0,
        firstVisible: 0,
        visibleCount: 1,
        activityByThread: new Map(),
      }}
      detail={{
        thread: sampleThread,
        projectName: "bb-tui",
        timelineLength: 2,
        conversationLive: 0,
        detailLines: ["DETAIL CONTENT"],
        scrollUp: 0,
        inputRows: [""],
        focus: "detail",
        cursorSeq: 42,
      }}
    />,
    80,
    24,
  );

  assert.match(frame.split("\n").at(-1) ?? "", /q quit/);
});
