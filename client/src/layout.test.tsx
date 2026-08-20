import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import type { ThreadRow } from "./api.js";
import { renderBlocks } from "./markdown.js";
import {
  calculatePaneLayout,
  contextRow,
  hitTest,
  menuHeight,
  ThreadListPane,
  ThreadPane,
  threadMeta,
  transcriptRows,
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
  // Read the frame before unmounting. Ink's debug path writes the frame and
  // returns without recording it as `lastOutput`, and unmount writes
  // `lastOutput + "\n"` when it thinks it is running in CI — so on any machine
  // with CI set, the last chunk is a bare newline rather than the frame.
  const frame = stdout.chunks.at(-1) ?? "";
  instance.unmount();
  return stripAnsi(frame);
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

  // "working" belongs to the spinner row; this row carries stable context.
  assert.deepEqual(parts, ["bb-tui", "mac-mini", "fix/pane-scroll", "codex", "active"]);
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

test("command menu keeps an off-prefix selection visible inside its own border", () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    kind: "skill" as const,
    name: `skill-${index}`,
    description: `Description ${index}`,
  }));
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      elapsedSeconds={null}
      hostNames={new Map()}
      detailLines={[line("Agent response")]}
      scrollUp={0}
      composer={emptyComposer}
      menu={{ entries, selected: 7, firstVisible: 2 }}
      focus="detail"
      width={83}
      height={36}
    />,
  );

  assert.match(frame, /skill-7/);
  assert.doesNotMatch(frame, /skill-0/);
  assert.equal(frame.match(/┌/g)?.length, 2);
});

test("command menu height follows the visible window and includes its border", () => {
  const entries = [
    { kind: "command" as const, name: "compact", description: "Compact context" },
    { kind: "command" as const, name: "cancel-plan", description: "Exit plan mode" },
    ...Array.from({ length: 6 }, (_, index) => ({
      kind: "skill" as const,
      name: `skill-${index}`,
      description: `Description ${index}`,
    })),
  ];

  assert.equal(menuHeight(undefined), 0);
  assert.equal(menuHeight({ entries: entries.slice(0, 2), selected: 0, firstVisible: 0 }), 5);
  assert.equal(menuHeight({ entries, selected: 5, firstVisible: 0 }), 10);
  assert.equal(menuHeight({ entries, selected: 7, firstVisible: 2 }), 9);
});

test("thread pane preserves authored Markdown paragraph rows", () => {
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      elapsedSeconds={null}
      hostNames={new Map()}
      detailLines={renderBlocks(
        [
          {
            role: "agent",
            text: "First paragraph.\n\nSecond paragraph.\n\n- item one\n- item two\n\nFinal paragraph.",
          },
        ],
        76,
      )}
      scrollUp={0}
      composer={emptyComposer}
      focus="detail"
      width={80}
      height={28}
    />,
    80,
    28,
  );
  const rows = frame.split("\n");
  const rowOf = (text: string) => rows.findIndex((row) => row.includes(text));

  assert.equal(rowOf("Second paragraph.") - rowOf("First paragraph."), 2);
  assert.equal(rowOf("Final paragraph.") - rowOf("• item two"), 2);
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

test("transcriptRows matches how many lines the pane actually shows", () => {
  // The app sizes its scroll ceiling and its history paging off this helper
  // while the pane windows the transcript with it. If the two ever disagree,
  // scrolling stops at the wrong line and history pages in early or never.
  const height = 24;
  const lines = Array.from({ length: 200 }, (_, i) => ({ spans: [{ text: `line-${i}` }] }));
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      hostNames={new Map()}
      detailLines={lines}
      scrollUp={0}
      composer={emptyComposer}
      focus="detail"
      elapsedSeconds={null}
      width={80}
      height={height}
    />,
  );

  const shown = lines.filter((_, i) => frame.includes(`line-${i}\n`) || frame.includes(`line-${i} `));
  assert.equal(shown.length, transcriptRows(height));
  // Bottom-anchored: the newest line is always on screen, the oldest is not.
  assert.match(frame, /line-199/);
  assert.doesNotMatch(frame, /line-0\b/);
});

test("model menu renders its own section, one row per model", () => {
  const entries = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5"].map((name) => ({
    kind: "model" as const,
    name,
    description: name,
  }));
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      elapsedSeconds={null}
      hostNames={new Map()}
      detailLines={[line("Agent response")]}
      scrollUp={0}
      composer={emptyComposer}
      menu={{ entries, selected: 1, firstVisible: 0 }}
      focus="detail"
      width={83}
      height={36}
    />,
  );

  const rows = frame.split("\n");
  const at = (text: string) => rows.findIndex((row) => row.includes(text));
  assert.ok(at("Models") >= 0);
  // Header, then every model, in order, inside the menu border.
  assert.equal(at("claude-fable-5") - at("Models"), 1);
  assert.equal(at("claude-opus-5") - at("claude-fable-5"), 1);
  assert.equal(at("claude-sonnet-5") - at("claude-opus-5"), 1);
  assert.equal(menuHeight({ entries, selected: 1, firstVisible: 0 }), 6);
});

test("a waiting turn gets a spinner row above the composer", () => {
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      elapsedSeconds={12}
      hostNames={new Map()}
      detailLines={[line("Agent response")]}
      scrollUp={0}
      composer={emptyComposer}
      focus="detail"
      waiting={{ seconds: 12, frame: "\u2819" }}
      width={83}
      height={24}
    />,
  );

  const rows = frame.split("\n");
  const at = (text: string) => rows.findIndex((row) => row.includes(text));
  assert.ok(at("\u2819 working 12s") >= 0);
  // The hint has to name the key that actually stops a thread: esc moves focus
  // to the list, which the footer says at the same time.
  assert.match(frame, /working 12s · \^x to stop/);
  // Directly under the transcript it is waiting to extend, above the context
  // line rather than buried below it.
  assert.ok(at("Agent response") < at("\u2819 working 12s"));
  assert.ok(at("\u2819 working 12s") < at("bb-tui"));
  assert.ok(at("\u2819 working 12s") < at("MESSAGE"));
});

test("an error gets its own row, nearest the input", () => {
  const frame = renderFrame(
    <ThreadPane
      thread={sampleThread}
      projectName="bb-tui"
      elapsedSeconds={null}
      hostNames={new Map()}
      detailLines={[line("Agent response")]}
      scrollUp={0}
      composer={emptyComposer}
      focus="detail"
      waiting={{ seconds: 12, frame: "\u2819" }}
      errorText="send failed: connection refused"
      width={83}
      height={24}
    />,
  );

  const rows = frame.split("\n");
  const at = (text: string) => rows.findIndex((row) => row.includes(text));
  assert.ok(at("connection refused") >= 0);
  assert.ok(at("\u2819 working 12s") < at("connection refused"));
  assert.ok(at("connection refused") < at("MESSAGE"));
});

test("the spinner and error rows come out of the transcript, not the frame", () => {
  assert.equal(transcriptRows(24), 14);
  assert.equal(transcriptRows(24, 0, 0, 2), 12);
});

test("a hidden list gives the thread pane the whole frame", () => {
  const detail = {
    thread: sampleThread,
    projectName: "bb-tui",
    elapsedSeconds: null,
    hostNames: new Map(),
    detailLines: [line("DETAIL CONTENT")],
    scrollUp: 0,
    composer: emptyComposer,
    focus: "detail" as const,
  };
  const list = {
    rows: [{ kind: "thread" as const, thread: sampleThread }],
    selectedIndex: 0,
    firstVisible: 0,
    visibleCount: 1,
    activityByThread: new Map(),
    hostNames: new Map(),
  };
  const frame = renderFrame(
    <WorkspaceLayout
      columns={120}
      rows={24}
      focus="detail"
      listHidden
      topBar="bb-tui · active"
      list={list}
      detail={detail}
    />,
    120,
    24,
  );

  assert.match(frame, /DETAIL CONTENT/);
  // One pane on screen, not two: the list border is gone entirely.
  assert.equal(frame.match(/╭/g)?.length, 1);
  assert.match(frame.split("\n").at(-1) ?? "", /\^s show list/);
  // The pane widens to the frame instead of leaving the list's columns blank.
  assert.deepEqual(calculatePaneLayout(120, "detail", true), {
    compact: true,
    listWidth: 0,
    detailWidth: 119,
  });
});

test("with the list hidden every click lands in the thread pane", () => {
  assert.deepEqual(hitTest(120, 40, "detail", 5, 8, true), { pane: "detail" });
  assert.deepEqual(hitTest(120, 40, "detail", 5, 8), { pane: "list", row: 5 });
});
