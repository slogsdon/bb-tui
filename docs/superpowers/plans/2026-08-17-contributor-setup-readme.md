# Contributor Setup README Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give contributors a verified, copy-paste path from a fresh clone to a running source build of bb-tui.

**Architecture:** The root `README.md` is the canonical contributor guide. `bb-plugin-bb-tui/README.md` contains only server-component details and links back to the root guide, preventing two setup flows from drifting.

**Tech Stack:** Markdown, Node.js 20+, npm, TypeScript, Ink, bb plugin CLI

## Global Constraints

- Document the checkout and Git release paths for the plugin; the client still has no bundled `bb-tui` binary.
- Require Node.js 20+, npm, and a bb server version 0.38 or newer; document `serverUrl` for non-loopback clients.
- Use `npm ci` because both packages have committed `package-lock.json` files.
- Do not add dependencies or change application behavior.
- Preserve the explicit statement that Termius has not been device-verified.
- Before any Git write, enumerate exact paths and obtain user approval; never push unless asked.

---

### Task 1: Replace the root setup flow

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `bb-plugin-bb-tui/package.json`, `client/package.json`, the live `bb` CLI help, and `bb tui info`.
- Produces: the canonical first-time setup and contributor workflow referenced by the plugin README.

- [x] **Step 1: Record the pre-edit documentation failures**

Run:

```bash
rg -n "Phase 1 spike complete|Pi provider note|cd bb-plugin-bb-tui|npm install|npx tsx src/index.tsx" README.md
```

Expected: output shows stale phase wording, a host-specific provider note, directory-state-dependent setup, and `npm install` despite committed lockfiles.

- [x] **Step 2: Rewrite the root README as the canonical contributor guide**

Use this section order and content contract:

```markdown
# bb-tui

Source-stage terminal UI for bb, composed of a server-side bb plugin and a local Ink client.

> Development status: install the plugin from a checkout or Git release; run the client from source because no bundled `bb-tui` binary exists.

## Prerequisites

- Node.js 20 or newer and npm
- bb server 0.38 or newer, running on the same host
- A terminal with color and alternate-screen support

## First-time setup

From the repository root:

1. Install locked dependencies in both packages.
2. Install the checkout collection with `bb plugin install path:. --plugin bb-tui --yes`.
3. Verify discovery with `bb tui info`.
4. Start the interactive client from `client` with `npm run dev`.

## Development workflow

- Reload `bb-tui` after plugin edits.
- Restart the client after client edits, or run the relevant headless command.
- Run client tests and typechecking plus plugin typechecking before handoff.

## Headless client commands

Document `npm --prefix client run cli -- info`,
`npm --prefix client run cli -- list`, and
`npm --prefix client run cli -- watch --thread <thread-id>` from the repository
root.

## Configuration

Document inspection plus the verified `hideReasoning`, `pollMs`, and
`retentionDays` settings through `bb plugin config bb-tui`.

## Troubleshooting

Cover plugin engine mismatch, a missing `bb tui` command, server discovery,
and the unverified Termius device case without claiming a fix.

## Current capabilities

Keep the implemented UI/backend summary and clearly label future work.

## Repository layout

Link the plugin README and `DESIGN.md` while describing the latter as design
history and future direction, not setup instructions.
```

Use fenced shell blocks that start from the repository root and never rely on shell state left implicit by a previous block.

- [x] **Step 3: Verify every root command against repository sources**

Run:

```bash
node -e 'const fs=require("fs"); for (const p of ["client/package.json","bb-plugin-bb-tui/package.json"]) JSON.parse(fs.readFileSync(p,"utf8"));'
rg -n '"(dev|cli|test|typecheck)"' client/package.json
bb plugin install --help
bb plugin reload --help
bb plugin config --help
```

Expected: both manifests parse; every documented client script exists; bb help accepts the documented install, reload, and config command shapes.

### Task 2: Replace plugin scaffold documentation

**Files:**
- Modify: `bb-plugin-bb-tui/README.md`

**Interfaces:**
- Consumes: the canonical root `README.md` setup flow and `bb-plugin-bb-tui/package.json` engine/entrypoint metadata.
- Produces: a component-specific reference with no competing first-time setup.

- [x] **Step 1: Record the pre-edit scaffold content**

Run:

```bash
rg -n "A BB plugin|bb plugin new|greeting hi|Ask BB to write plugins" bb-plugin-bb-tui/README.md
```

Expected: output identifies generic scaffold copy and a nonexistent `greeting` setting.

- [x] **Step 2: Rewrite the plugin README**

The file must:

```markdown
# bb-tui server plugin

Identify `server.ts` as the backend for discovery, thread/timeline RPC, event
buffering, settings, and the `bb tui info` command.

Link to `../README.md` for complete contributor setup.

Document only:
- `npm ci`
- `bb plugin install . --yes`
- `bb plugin dev` for the edit/reload loop
- `bb tui info`
- `bb plugin config bb-tui`
- settings: `hideReasoning`, `pollMs`, `retentionDays`
- `./node_modules/.bin/tsc --noEmit`
- `bb plugin types` and `bb plugin types --check`
- `bb plugin build` as a release-artifact check, not the client distribution path
```

Retain the engine floors (`bb >=0.38`, plugin SDK `>=0.4.6`) and remove generic plugin-authoring tutorial text.

- [x] **Step 3: Verify the plugin reference**

Run:

```bash
rg -n "greeting|bb plugin new|bundled.*client.*available|marketplace.*available" bb-plugin-bb-tui/README.md
```

Expected: no output.

### Task 3: Exercise the documented contributor path

**Files:**
- Verify: `README.md`
- Verify: `bb-plugin-bb-tui/README.md`

**Interfaces:**
- Consumes: the final documented setup and development commands.
- Produces: fresh evidence that the instructions match the current source tree and running bb server.

- [x] **Step 1: Install from lockfiles**

Run:

```bash
npm_config_cache=/tmp/bb-tui-npm-cache npm --prefix bb-plugin-bb-tui ci
npm_config_cache=/tmp/bb-tui-npm-cache npm --prefix client ci
```

Expected: both commands exit 0 without modifying either lockfile.

- [x] **Step 2: Run static and behavioral verification**

Run:

```bash
npm --prefix client test
npm --prefix client run typecheck
./bb-plugin-bb-tui/node_modules/.bin/tsc --noEmit -p bb-plugin-bb-tui/tsconfig.json
```

Expected: all client tests pass and both TypeScript checks exit 0.

- [x] **Step 3: Verify the live plugin interface**

Run:

```bash
bb tui info
bb plugin config bb-tui
```

Expected: `bb tui info` reports plugin version `0.1.0`, and config lists `hideReasoning`, `pollMs`, and `retentionDays`.

- [x] **Step 4: Audit documentation claims and working tree**

Run:

```bash
rg -n "Phase 1 spike complete|Pi provider note|greeting hi|npm install( |$)|npx tsx src/index.tsx" README.md bb-plugin-bb-tui/README.md
git diff --check
git status --short
```

Expected: the stale-claim search has no output; diff check exits 0; status contains only the two README edits and this plan unless separately committed.

- [x] **Step 5: Prepare the documentation commit for approval**

Present the exact diff and propose:

```text
docs: clarify contributor setup
```

Do not stage or commit until the user approves the exact paths.
