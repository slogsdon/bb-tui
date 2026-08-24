// The manifest is the source of truth for installs; PLUGIN_VERSION is what the
// client reads back over `getClientInfo` and gates capabilities on. They are
// two files, so nothing but this test keeps them from drifting apart.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "./server.js";

test("PLUGIN_VERSION matches the package manifest", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8")) as { version: string };
  assert.equal(PLUGIN_VERSION, pkg.version);
});
