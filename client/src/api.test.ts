import assert from "node:assert/strict";
import test from "node:test";
import { coveredByTimeline, rowItemId, timelineCoverage } from "./api.js";

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
