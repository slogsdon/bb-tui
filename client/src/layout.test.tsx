import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import type { ThreadRow } from "./api.js";
import {
  calculatePaneLayout,
  contextRow,
  ThreadListPane,
  ThreadPane,
  threadMeta,
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

/** One plain transcript line, as the markdown renderer would emit it. */
const line = (text: string) => ({ spans: [{ text }] });

/** An empty composer, as layoutComposer would return it. */
const emptyComposer = { rows: [""], cursorRow: 0, cursorCol: 0, scrolled: false };

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
      rows={[{ kind: "thread", thread: sampleThread }]}
      selectedIndex={0}
      firstVisible={0}
      visibleCount={1}
      activityByThread={new Map()}
      hostNames={new Map()}
      width={36}
      height={12}
    />,
  );

  assert.match(frame, /● Start Claude Opus UI thread/);
  assert.doesNotMatch(frame, /codex\s+Start Claude/);
});

test("project rows show a fold marker and their thread count", () => {
  const frame = renderFrame(
    <ThreadListPane
      rows={[
        { kind: "project", projectId: "proj_bb_tui", name: "bb-tui", count: 2, collapsed: false },
        { kind: "thread", thread: sampleThread },
        { kind: "project", projectId: "proj_personal", name: "Personal", count: 9, collapsed: true },
      ]}
      selectedIndex={0}
      firstVisible={0}
      visibleCount={3}
      activityByThread={new Map()}
      hostNames={new Map()}
      width={36}
      height={12}
    />,
  );

  assert.match(frame, /▾ bb-tui 2/);
  assert.match(frame, /▸ Personal 9/);
  assert.match(frame, /● Start Claude Opus UI thread/);
});

test("the overflow count reflects the scroll position, not the list length", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    kind: "thread" as const,
    thread: { ...sampleThread, id: `thr_${i}` },
  }));
  const atTop = renderFrame(
    <ThreadListPane
      rows={rows}
      selectedIndex={0}
      firstVisible={0}
      visibleCount={4}
      activityByThread={new Map()}
      hostNames={new Map()}
      width={36}
      height={12}
    />,
  );
  const atBottom = renderFrame(
    <ThreadListPane
      rows={rows}
      selectedIndex={9}
      firstVisible={6}
      visibleCount={4}
      activityByThread={new Map()}
      hostNames={new Map()}
      width={36}
      height={12}
    />,
  );

  assert.match(atTop, /… 6 more/);
  assert.doesNotMatch(atBottom, /more/);
});

test("row metadata prefers the branch and strips generated worktree noise", () => {
  const hosts = new Map([["host_1", "mac-mini"]]);
  assert.equal(
    threadMeta({ ...sampleThread, environmentBranchName: "bb/improve-thread-view-thr_kud5sfwmaq" }, hosts),
    "improve-thread-view",
  );
  assert.equal(threadMeta(sampleThread, hosts), "");
});

test("row metadata stays empty when it would repeat on every row", () => {
  const oneHost = new Map([["host_1", "mac-mini"]]);
  const twoHosts = new Map([
    ["host_1", "mac-mini"],
    ["host_2", "cloud"],
  ]);

  // Default branches say nothing when almost every thread sits on one.
  assert.equal(threadMeta({ ...sampleThread, environmentBranchName: "main" }, twoHosts), "");
  assert.equal(threadMeta({ ...sampleThread, environmentBranchName: "master" }, twoHosts), "");
  // One enrolled machine means naming it distinguishes nothing.
  assert.equal(threadMeta({ ...sampleThread, environmentHostId: "host_1" }, oneHost), "");
  assert.equal(threadMeta({ ...sampleThread, environmentHostId: "host_1" }, twoHosts), "mac-mini");
});

test("settled threads show metadata while running threads show live activity", () => {
  const idle = renderFrame(
    <ThreadListPane
      rows={[{ kind: "thread", thread: { ...sampleThread, status: "idle", environmentBranchName: "fix/scroll" } }]}
      selectedIndex={0}
      firstVisible={0}
      visibleCount={1}
      activityByThread={new Map([["thr_ui", "writing tests"]])}
      hostNames={new Map()}
      width={44}
      height={12}
    />,
  );
  const running = renderFrame(
    <ThreadListPane
      rows={[{ kind: "thread", thread: { ...sampleThread, environmentBranchName: "fix/scroll" } }]}
      selectedIndex={0}
      firstVisible={0}
      visibleCount={1}
      activityByThread={new Map([["thr_ui", "writing tests"]])}
      hostNames={new Map()}
      width={44}
      height={12}
    />,
  );

  assert.match(idle, /fix\/scroll/);
  assert.doesNotMatch(idle, /writing tests/);
  assert.match(running, /writing tests/);
});

test("the context row carries where the thread runs, not debug counters", () => {
  const parts = contextRow({
    thread: { ...sampleThread, environmentHostId: "host_1", environmentBranchName: "fix/pane-scroll" },
    projectName: "bb-tui",
    hostNames: new Map([["host_1", "mac-mini"]]),
    detailLines: [],
    scrollUp: 0,
    composer: emptyComposer,
    focus: "detail",
    elapsedSeconds: 18,
    width: 80,
    height: 24,
  });

  assert.deepEqual(parts, [
    "bb-tui",
    "mac-mini",
    "fix/pane-scroll",
    "codex",
    "working 18s · esc to interrupt",
  ]);
  assert.ok(!parts.some((p) => p.includes("seq")));
});

test("the model and permission mode replace the provider once bb reports them", () => {
  const parts = contextRow({
    thread: { ...sampleThread, status: "idle" },
    projectName: "bb-tui",
    hostNames: new Map(),
    detailLines: [],
    scrollUp: 0,
    composer: emptyComposer,
    focus: "detail",
    elapsedSeconds: null,
    execution: { model: "claude-opus-5[1m]", permissionMode: "auto", reasoningLevel: "medium" },
    width: 80,
    height: 24,
  });

  // Permission mode precedes the model: the row truncates from the right, and a
  // half-rendered permission mode is worse than a half-rendered model id.
  assert.deepEqual(parts, ["bb-tui", "auto", "claude-opus-5[1m]", "idle"]);
  // The provider id is implied by the model, so it does not also take a slot.
  assert.ok(!parts.includes("codex"));
});

test("a thread in plan mode says so and names the way out", () => {
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      hostNames={new Map()}
      detailLines={[]}
      scrollUp={0}
      composer={emptyComposer}
      focus="detail"
      elapsedSeconds={null}
      planMode={{ prompt: "Research the parser first" }}
      width={80}
      height={24}
    />,
  );

  assert.match(frame, /plan mode/);
  assert.match(frame, /\/cancel-plan/);
});

test("debug counters appear only when explicitly requested", () => {
  const parts = contextRow({
    thread: { ...sampleThread, status: "idle" },
    projectName: "bb-tui",
    hostNames: new Map(),
    detailLines: [],
    scrollUp: 0,
    composer: emptyComposer,
    focus: "detail",
    elapsedSeconds: null,
    debug: { timelineLength: 10, conversationLive: 0, cursorSeq: 42 },
    width: 80,
    height: 24,
  });

  assert.deepEqual(parts, ["bb-tui", "codex", "idle", "history 10", "live 0", "seq 42"]);
});

test("thread composer renders a labeled focused border and placeholder", () => {
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      elapsedSeconds={null}
      hostNames={new Map()}
      detailLines={[line("› Improve the UI"), line("Inspecting the render")]}
      scrollUp={0}
      composer={emptyComposer}
      focus="detail"
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
        rows: [{ kind: "thread" as const, thread: sampleThread }],
        selectedIndex: 0,
        firstVisible: 0,
        visibleCount: 1,
        activityByThread: new Map(),
        hostNames: new Map(),
      }}
      detail={{
        thread: sampleThread,
        projectName: "bb-tui",
        elapsedSeconds: null,
        hostNames: new Map(),
        detailLines: [line("› Improve the UI")],
        scrollUp: 0,
        composer: emptyComposer,
        focus: "detail",
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
        rows: [{ kind: "thread" as const, thread: sampleThread }],
        selectedIndex: 0,
        firstVisible: 0,
        visibleCount: 1,
        activityByThread: new Map(),
        hostNames: new Map(),
      }}
      detail={{
        thread: sampleThread,
        projectName: "bb-tui",
        elapsedSeconds: null,
        hostNames: new Map(),
        detailLines: [line("DETAIL CONTENT")],
        scrollUp: 0,
        composer: emptyComposer,
        focus: "detail",
      }}
    />,
    60,
    24,
  );

  assert.match(frame, /DETAIL CONTENT/);
  assert.doesNotMatch(frame, /Start Claude Opus UI thread\s+.*Start Claude Opus UI thread/);
  assert.match(frame.split("\n").at(-1) ?? "", /tab list/);
});

test("detail footer keeps its shortcuts visible at 80 columns", () => {
  const frame = renderFrame(
    <WorkspaceLayout
      columns={80}
      rows={24}
      focus="detail"
      topBar="bb-tui · active"
      list={{
        rows: [{ kind: "thread" as const, thread: sampleThread }],
        selectedIndex: 0,
        firstVisible: 0,
        visibleCount: 1,
        activityByThread: new Map(),
        hostNames: new Map(),
      }}
      detail={{
        thread: sampleThread,
        projectName: "bb-tui",
        elapsedSeconds: null,
        hostNames: new Map(),
        detailLines: [line("DETAIL CONTENT")],
        scrollUp: 0,
        composer: emptyComposer,
        focus: "detail",
      }}
    />,
    80,
    24,
  );

  assert.match(frame.split("\n").at(-1) ?? "", /tab list/);
});
