import assert from "node:assert/strict";
import test from "node:test";
import {
  cliArgs,
  cliMessage,
  coveredByTimeline,
  probePlugin,
  rowItemId,
  supportsLongPoll,
  timelineCoverage,
} from "./api.js";

test("rowItemId pulls the delta key out of a timeline row id", () => {
  assert.equal(rowItemId("thr_x:assistant:kind:assistant|turn:t1|parent:root|item:pi-assistant-103"), "pi-assistant-103");
  assert.equal(rowItemId("thr_x:user-seed:1"), null);
  assert.equal(rowItemId(undefined), null);
});

test("timelineCoverage reports the items and the high-water mark", () => {
  const cov = timelineCoverage([
    { id: "thr_x:user-seed:1", createdAt: 100 },
    { id: "thr_x:assistant|item:a-1", createdAt: 300 },
    null,
  ]);
  assert.deepEqual([...cov.itemIds], ["a-1"]);
  assert.equal(cov.newestTs, 300);
});

test("coverage rejects replayed history and the settled copy, keeps live text", () => {
  const cov = timelineCoverage([{ id: "thr_x:assistant|item:a-9", createdAt: 300 }]);
  assert.equal(coveredByTimeline(cov, "a-1", 50), true, "history outside the timeline window");
  assert.equal(coveredByTimeline(cov, "a-9", 400), true, "still streaming, but already settled");
  assert.equal(coveredByTimeline(cov, "a-10", 400), false, "new item the timeline has not caught up to");
});

test("an empty timeline covers nothing, so a fresh thread still streams", () => {
  const cov = timelineCoverage([]);
  assert.equal(coveredByTimeline(cov, "a-1", 1), false);
});

test("user text goes after --, so a message starting with a dash still sends", () => {
  // Without the marker the CLI reads "- tables don't render" as an option and
  // rejects the whole send.
  assert.deepEqual(cliArgs(["thread", "tell"], ["thr_x", "- a\n- b"]), [
    "thread",
    "tell",
    "--json",
    "--",
    "thr_x",
    "- a\n- b",
  ]);
  assert.deepEqual(cliArgs(["project", "list"]), ["project", "list", "--json"]);
});

test("a CLI failure shows its reason, not the command that echoed the message", () => {
  const failure = Object.assign(
    new Error("Command failed: bb thread tell --json -- thr_x - a\nError: HTTP 404: Thread not found\n"),
    { stderr: "Error: HTTP 404: Thread not found\n" },
  );
  assert.equal(cliMessage(failure), "Error: HTTP 404: Thread not found");
  // No stderr to read: fall back to the message's own last meaningful line.
  assert.equal(
    cliMessage(new Error("Command failed: bb thread tell thr_x\nerror: unknown option '- a'")),
    "error: unknown option '- a'",
  );
  assert.equal(cliMessage("plain string"), "plain string");
});

test("long polling is offered only to a plugin that declares it", () => {
  // The plugin's eventsSince input is strict, so sending waitMs to a build that
  // does not know the field fails the whole call rather than degrading.
  assert.equal(supportsLongPoll("0.2.0"), true);
  assert.equal(supportsLongPoll("0.11.3"), true);
  assert.equal(supportsLongPoll("1.0.0"), true);
  assert.equal(supportsLongPoll("0.1.0"), false);
  // "?" is a record from before discovery probed the plugin for its version.
  assert.equal(supportsLongPoll("?"), false);
  assert.equal(supportsLongPoll(undefined), false);
});

// Discovery's three outcomes are three different fixes for the user, so each
// one has to be distinguishable from the message alone.
test("probePlugin separates an absent server, an absent plugin, and a live one", async () => {
  const reply = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  await assert.rejects(
    probePlugin("http://127.0.0.1:1", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch),
    /cannot reach the bb server/,
  );

  await assert.rejects(probePlugin("http://s", reply(404, {})), /plugin is not installed/);

  const info = await probePlugin(
    "http://reached",
    reply(200, { ok: true, result: { serverUrl: "http://configured", pluginVersion: "0.2.0" } }),
  );
  assert.equal(info.pluginVersion, "0.2.0");
  // The reachable URL wins over the one the plugin reports, which is the whole
  // point of the BB_TUI_SERVER_URL override.
  assert.equal(info.serverUrl, "http://reached");
});
