# bb-tui — Design Document

**Status:** Draft for review
**Date:** 2026-08-16
**Scope:** Feasibility of a terminal UI (TUI) around the bb ecosystem, with focus on
validating whether the TUI should ship as a bb plugin.
**Environment verified against:** bb server 0.38.0 on macOS (local daemon,
`http://127.0.0.1:38886`), plugin SDK surface `>=0.4.3`.

---

## 1. TL;DR — Validation verdict

| Question | Answer |
|---|---|
| Can a TUI be a pure bb plugin? | **No — not the terminal itself.** Plugins run in-process inside the bb server. Plugin CLI commands are buffered request/response (`run` executes server-side, output capped at 1 MiB), so no raw-mode/fullscreen rendering is possible through them. |
| Can a TUI be built **on top of** a bb plugin? | **Yes — this is the recommended design.** The plugin supplies install/distribution, settings, storage, and a data plane (RPC + HTTP); a thin local client renders the terminal and drives the ecosystem through the `bb` CLI + plugin RPC. |
| Do existing plugins survive alongside it? | Yes. The TUI is additive: it shells out to the same `bb` CLI and speaks the same plugin RPC contract as the app. Server-side plugin surfaces (CLI commands, tools, skills, cron, HTTP, storage) all keep working. |
| Is the app's internal HTTP/WS protocol needed? | No. The documented surfaces (`bb` CLI `--json`, plugin `bb.rpc`, plugin `bb.http`) cover the design. The app's SPA `/api` + `/ws` remain private and are deliberately avoided. |

**Install story (target):** `bb plugin install git:…`, then run a small client binary
that the plugin ships (`~/.bb/plugins/bb-tui/bin/bb-tui`). Updates flow through
`bb plugin outdated` / `bb plugin update`. Marketplace distribution is possible later
via a `marketplace.json`.

---

## 2. Background — verified architecture facts

- bb is headless. A server process owns state (`~/.bb/bb.db` SQLite, `config.json`,
  `plugins/`, `thread-storage/`, `worktrees/`) and binds a loopback HTTP origin
  (`serverUrl: http://127.0.0.1:38886` observed in `~/.bb/bb-app-runtime.json`).
  Enough to note: the server serves the SPA, `/api/v1`, and `/ws`; a host daemon per
  enrolled machine (`host-daemon/dist/daemon-bundle.mjs`) handles remote execution.
- Agents are **provider bridge subprocesses**, not bb-internal: `bb-pi-bridge.mjs`,
  `bb-claude-code-bridge.mjs`, and friends. Each pi thread writes JSONL under
  `~/.bb/pi-bridge-sessions/thr_*.jsonl`.
- The `bb` CLI is the sanctioned scripting surface. **Every command supports `--json`.**
  It is the same surface agents use (this session runs against it), so it is exercised
  and stable.
- Plugins are TypeScript packages loaded **in-process** into the server (full trust).
  Official backend surfaces: CLI subcommands, agent tools, skills, instructions,
  cron + background services, HTTP routes (auth modes incl. token), RPC contracts,
  SQLite/kv storage, settings (`bb plugin config`), lifecycle events (`thread.active`,
  `thread.idle`, `thread.failed`, …), and `bb.sdk` — a full server-bound SDK covering
  threads, projects, environments, hosts, files, terminals, providers, skills,
  plugins, theme, status, system.
- Plugin RPC methods are plain-HTTP reachable and **open on loopback without a token**
  (verified this session: `POST /api/v1/plugins/<id>/rpc/<method>` on the live server
  returned method-resolution and input-validation results, never 401/403).
  `bb.http` routes have explicit auth modes (`local`, `token`, `none`) and are the
  right place for anything sensitive or non-loopback.

---

## 3. Why a pure plugin cannot be the TUI (evidence)

1. **Plugins are server-side.** The factory registers surfaces; there is no terminal,
   no stdin, no screen attached to the server process.
2. **Plugin CLI commands are buffered.** `bb.cli.register({ run(argv, ctx) })` returns
   `{ exitCode, stdout, stderr }`; combined output is capped at
   `PLUGIN_CLI_OUTPUT_MAX_BYTES` (1 MiB) and rejected atomically beyond that.
   `run` executes on the **server**, proxied by the invoking CLI. There is no PTY,
   raw-mode, or incremental output contract.
3. **The app UI model doesn't transfer.** `bb.ui.requestInput` forms and React
   frontend entries (`bb.app` → `dist/app.js`) require the app's host. A TUI cannot
   render them.

Conclusion: the plugin is a **backend**, not a **frontend**. The terminal frontend
must be a separate local process. That process is small, because everything
interesting lives behind `bb` CLI / plugin RPC on loopback.

---

## 4. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  thin local client: `bb-tui` (Node 20+/TS, Ink or pi-tui)  │
│                                                            │
│  ── renders: thread list/pane, composer, terminal panes,   │
│     provider/model picker, status footer, keybindings      │
│                                                            │
│  ── shell functions: bb CLI --json (control plane)         │
│  ── data plane: plugin RPC over loopback HTTP              │
│  ── long-poll: bb thread wait --event / --status           │
│  ── auth: loopback trust; optional plugin token            │
└──────────────┬─────────────────────────────────────────────┘
               │ loopback HTTP (127.0.0.1:38886 default)
┌──────────────▼─────────────────────────────────────────────┐
│  bb server (unchanged)                                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  bb-tui plugin (server-in-process)                   │   │
│  │  • bb.rpc: tailored read/project/thread API          │   │
│  │  • bb.settings: TUI prefs (theme, layout)            │   │
│  │  • bb.storage: SQLite for client state, event buffer │   │
│  │  • bb.cli: `bb tui` doc/status command               │   │
│  │  • bb.background: event buffering service (optional) │   │
│  └──────────────────────────────────────────────────────┘   │
│  providers: codex, claude-code, pi, acp-* (bridge procs)    │
│  machines: per-host daemons                                 │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Layers and responsibilities

**Client (`bb-tui`)** — everything that touches the terminal.

- Thread manager: list/search/spawn/fork/archive/stop/retry/compact via `bb thread …
  --json`.
- Turn view: poll `bb thread log` (seq cursor pagination) + `bb thread output`;
  compose/steer via `bb thread tell` (`--mode steer|queue|auto`).
- Live updates: blocking long-poll `bb thread wait --event …` with a timeout loop
  (no push protocol is public; see §6).
- Terminals: `bb terminal …` CRUD + output polling, rendered as panes.
- Providers/models: `bb provider list|models --json`, reasoning-level picker.
- Keys: reuse pi's keybinding model (`matchesKey`, `Key.*`) if built on pi-tui, or
  Ink's built-in input model. Configurable via settings.

**Plugin (`bb-tui` id)** — the ecosystem anchor.

- `bb.rpc` contract, e.g.:
  - `getClientInfo` (server version, dataDir, host id, provider availability)
  - `listThreads(filter)` (thin wrapper with exact filter semantics)
  - `getTimeline(threadId, sinceSeq)` (pageable messages)
  - `getSessionStats(threadId)` (tokens/cost — mirrors `pi get_session_stats` where
    available; falls back to `bb thread show`)
  - `eventsSince(cursor)` (lifecycle events buffered by the background service)
  - `clientPrefsGet/Set` (theme, layout, pinned threads — persisted in plugin DB)
- `bb.settings`: TUI preferences so they revert through `bb plugin config bb-tui set …`
  — same surface the app uses, which keeps a single source of truth.
- `bb.storage.database()`: plugin SQLite for client state + optional lifecycle event
  log (via `bb.sdk.subscribe`) so the TUI can long-poll a server-side cursor instead
  of polling `bb thread list`.
- `bb.cli.register`: a `bb tui` status/version command (helpful in scripts, agents,
  and validates install).
- No React app entry — the TUI replaces the app, so a frontend entry is out of scope.

**bb server / CLI / providers / machines** — untouched. The TUI is a new client of
the existing public contract, not a fork.

### 4.2 Client stack

- **Language/runtime:** TypeScript, Node 20+. Matches the ecosystem (server and app
  frontend are TS/React; compile-to-ESM bundles are the norm).
- **Rendering:** two candidates — decide in a spike:
  - **Ink** (React for terminals): consistent with the ecosystem's React host,
    composable, batteries included. Recommended default.
  - **pi-tui components** (`@earendil-works/pi-tui`): minimal `render(width)` /
    `handleInput` contract, already proven in pi; reuse pi keybindings/themes, but
    less ergonomic for a full layout app.
- **Binary layout:** monorepo `bb-tui/` with `plugin/` (server entry) and `client/`.
  Client ships as a bundled ESM script; the plugin install layout places it at
  `<plugins>/bb-tui/bin/bb-tui` (see §7).

### 4.3 Discovery and auth

- **Server URL discovery (priority):** the plugin itself exposes discovery. The
  client runs `bb tui info` (a plugin-registered CLI command, executes server-side
  where `bb.server.loopbackBaseUrl` is authoritative) and receives
  `{ serverUrl, dataDir, version }` without parsing any runtime file. Fallbacks:
  env override `BB_TUI_SERVER_URL`, then parse `~/.bb/bb-app-runtime.json`
  (`serverUrl` field, observed) for the pre-install/standalone case. This retires
  the previous open question (no public `bb server info`/`bb config` command exists
  today — verified; the plugin CLI is the sanctioned way to surface it).
- **Auth:** plugin RPC on loopback is tokenless (verified). The client trusts
  loopback. Any route that must survive non-loopback exposure or carry sensitive
  payloads uses `bb.http` with `"token"` auth and the per-plugin token
  (`bb plugin token bb-tui`). Secret material never crosses the client.

### 4.4 The golden rule the client follows

> Shell out to `bb` for anything the CLI already does; use plugin RPC only where the
> CLI is insufficient (server facts, buffered event log, prefs). This keeps the TUI
> thin and keeps every future CLI feature available to it for free.

---

## 5. Ecosystem tie-in — what the plugin buys us

| Capability | Delivered by |
|---|---|
| One-command install / uninstall (`bb plugin install <path\|git\|npm>`) | bb plugin lifecycle |
| Updates (`bb plugin outdated`, `bb plugin update`) | bb plugin lifecycle |
| Marketplace distribution later (`marketplace.json` → `bb marketplace add`) | bb plugin catalog |
| Version gating (`engines.bb`, `engines.bbPluginSdk`) | manifest contract |
| Settings UI for prefs (`bb plugin config bb-tui set …`) | `bb.settings` |
| Durable client state + buffers | `bb.storage.database()` |
| Server facts for the client | `bb.rpc` / `bb.http` |
| Agent-facing `bb tui` docs | `bb.cli` |
| Optional agent skills/tools contributed by the TUI plugin | `bb.agents` / `skills/` |
| Background event buffering | `bb.background` service |
| Existing third-party plugins | unchanged — TUI shells out to `bb <plugin-command>` |

Out of scope: the app-side `useComposer()`, `requestInput` renderers, settings
pages, and panels — those are the app's React host and have no terminal analogue.

---

## 6. Streaming / live-update strategy

- No public push channel for thread turns today: the CLI is pull-based
  (`thread log`, `thread output`), and the app's `/ws` is private.
- **State + content updates (implemented in Phase 1, plugin-side buffer).** The
  plugin's background service subscribes to realtime lifecycle events via
  `bb.sdk.subscribe({ event: "thread:changed" })` and drains the server event
  store (`bb.sdk.threads.events.list`, per-thread server-seq cursor) into plugin
  SQLite rows with a plugin-local monotonic `seq`. The client long-polls
  `rpc/eventsSince(cursor)` — one cheap call per cycle — and gets near-real-time
  state **and content** updates: verified in the spike with 1,697
  `item/agentMessage/delta` rows (token-level) + 6,573 `item/reasoning/textDelta`
  rows streamed into the buffer over 45s. Retention/pruning: keeps N days
  (`retentionDays` setting, default 7), pruned on insert.
- **Client UI note:** reasoning deltas dominate event volume; the TUI should
  suppress `item/reasoning/*` by default and expose a toggle (post-MVP polish).
- Raw per-token streaming remains unnecessary for the turn UX the buffer already
  provides; the only push primitive is `bb.realtime` (WS `plugin-signal`), which
  is app-protocol-bound and deliberately avoided.

---

## 7. Distribution

```
bb-tui/
├── plugin/                 # bb plugin (server entry)
│   ├── package.json        # name bb-plugin-bb-tui; engines.bb; bbPluginSdk >=0.4.3
│   ├── server.ts           # factory: rpc, settings, storage, cli, background
│   └── bin/bb-tui          # bundled client + launcher (shebang node)
├── client/                 # TUI source (TS, Ink)
├── scripts/install.sh      # bb plugin install + symlink ~/.local/bin/bb-tui
├── marketplace.json        # future: third-party marketplace entry
└── DESIGN.md / README.md
```

Install today:

```sh
bb plugin install git:https://github.com/<owner>/bb-tui.git@main
ln -s ~/.bb/plugins/bb-tui/bin/bb-tui ~/.local/bin/bb-tui   # or ship install.sh
bb-tui
```

Notes:

- `bb plugin build` bundles server + builds the client artifact; the toolchain
  download is cached per `plugins/toolchain-*` for CI.
- Git installs run `npm install --omit=dev` first — keep the client's runtime
  deps in `dependencies` or bundle fully (prefer bundling: zero-dependency client).
- Client binary must be a single self-contained ESM file so no `node_modules`
  copy is required on the user's machine beyond Node itself.
- `Assumption:` users are on the same host as the bb server (typical: the machine
  running bb.app). Remote-machine use cases already work through bb's own
  multi-machine routing once the server URL is reachable.

---

## 8. Security

- Plugin RPC is loopback-open (verified). The client declares "trust loopback,"
  same posture as `bb.http` `"local"` auth.
- Anything sensitive or remotely reachable: `bb.http` `"token"` + per-plugin token.
  The TUI can mint/read the token via `bb plugin token bb-tui` (CLI, interactive or
  piped) rather than storing secrets itself.
- The plugin is full-trust by definition (server-in-process); no new trust boundary.
- Logs: plugin logs to `<dataDir>/plugins/bb-tui/logs/plugin.log` (JSONL,
  auto-rotated) and is tailable via `bb plugin logs bb-tui -f`.

---

## 9. MVP scope

Phase 1 — prove the loop ✅ (spike complete, verified live):

1. Plugin implements `bb.rpc` (`getClientInfo` incl. `serverUrl`/`dataDir` via
   `bb.server.loopbackBaseUrl`, `listThreads`, `getTimeline`, `eventsSince`) and
   `bb.cli` `tui info`; path-installed into the live server 0.38.0.
2. Background `event-buffer` service: `bb.sdk.subscribe(thread:changed)` +
   `bb.sdk.threads.events.list` drain → SQLite; cursor over plugin-local seq.
   Verified: 9,492 rows in 45s incl. token-level message deltas; monotonic seq;
   retention prune.
3. Ink client (one pane): boots under a PTY, discovers server via `bb tui info`,
   renders live thread list w/ status glyphs, poll loop active; headless CLI
   (`info`/`list`/`watch`) smoke-tested; spawn → hidden codex thread → 1,351
   delta rows streamed to the buffer → stop+archive cleanup.

Phase 2 — usable TUI ✅ (this pass):

4. Detail view streaming transcript: buffered `item/agentMessage/delta` rows
   assembled per `(threadId, itemId)` and rendered live beneath the getTimeline
   history; reasoning deltas (`item/reasoning/*`) suppressed by default (plugin
   pref, `r` toggles); thread actions `x` stop / `c` compact / `m` model picker
   (hints from `bb provider models`); spawn uses the configured spawn target
   when one is set (`d` = project defaults); cursors scoped per thread + persisted to
   `~/.local/state/bb-tui/cursor.json`; per-thread `eventsSince` filter added
   (server-side) so busy servers don't force backlog pagination.
5. Settings + prefs via plugin: `bb plugin config bb-tui set hideReasoning …` /
   `set pollMs …` round-trip verified; served to the client via `getClientInfo`.
6. Cursor dedupe between global + per-thread streams (seq set); gap re-sync via
   getTimeline on detail open.

Phase 3 — polish (next): terminals panes, thread-queue UX, sections/pinning,
prefs editor in the TUI, bundled single-file client (`bb plugin build`).

Phase 2 — usable TUI:

3. Terminals panes, provider/model picker, reasoning level, fork/stop/retry/compact.
4. Settings + prefs stored via plugin; `bb plugin config bb-tui set …` round-trip.
5. Background event buffering + `eventsSince` cursor (instant state updates).

Phase 3 — polish:

6. Multi-machine thread browsing; queued messages; sections/pinning/archive UX.
7. Marketplace publication; `bb plugin outdated` hygiene; keybinding presets.

---

## 10. Risks & open questions

1. **No push streaming for turns** — content is polled (buffer covers state, not
   tokens); raw token streaming remains a post-MVP item until a public streaming
   contract exists. Decision: acceptable for MVP; revisit if turn latency feels
   wrong in the spike.
2. **Plugin CLI discovery dependency** — `bb tui info` requires the plugin to be
   installed; the runtime.json/env fallbacks cover the pre-install case. Fine for
   the product (install is a prerequisite anyway).
3. **RPC endpoint auth model on non-loopback** — verified open on loopback only.
   Documented posture for remote: token via `bb.http`. Confirm before any remote
   exposure.
4. **Plugin CLI cap** — any future desire to render *from* a `bb.cli` command is
   blocked by the 1 MiB buffered contract; don't design for it.
5. **Dependency weight** — Ink pulls React; if bundle size or cold start matters,
   the pi-tui path drops to near-zero deps. Spike decision, not an architecture
   risk.

---

## 11. Rejected alternatives

- **Pure plugin TUI (no separate client):** impossible today (§3). Revisit only if
  bb ever ships a PTY/streaming CLI-command contract.
- **Client on the app's internal `/api` + `/ws`:** works technically (loopback),
  but it is the app's private protocol — no stability or support promise. Rejected
  in favor of documented surfaces.
- **TUI as a pi agent extension** (`ctx.ui.custom`, custom editor): gives full
  terminal control but lives in the **pi** ecosystem (one provider), not the bb
  orchestration plane. Viable only if the product is "an agent TUI" rather than
  "a bb manager TUI." Keep as a fork-in-the-road, not the design.
- **Web/SPA fallback:** out of scope; if remote/visual access is ever needed, the
  existing path is `bb connect expose <port>` against a thin web view — a future
  phase, not part of this TUI.

---

## 12. Appendix — verified facts (this session)

- bb server 0.38.0, loopback `http://127.0.0.1:38886` (`~/.bb/bb-app-runtime.json`).
- RPC endpoint open on loopback, tokenless: `POST /api/v1/plugins/<id>/rpc/<method>`
  returns `unknown_method` / input-validation envelopes, never auth errors.
- Plugin CLI contract is buffered, capped 1 MiB, executes server-side
  (`bb.plugin-authoring` skill, `bb.cli` section).
- Providers are per-installation; bb reports them via `bb provider list`. Some
  (pi at the time of writing) support only the `full` permission mode.
- Model catalogs are provider-reported per machine, with `isDefault`,
  reasoning efforts, `defaultReasoningEffort`.
- Threads support parent-child, fork (worktree/reuse), hidden workers, sections,
  pinning, archive, queued messages, edit-message, retry/compact/plan/goal,
  seq-cursored event log; `bb thread wait --status/--event` is the blocking hook.
- Plugin lifecycle: `bb plugin token`, `bb plugin list`, `bb plugin install`,
  `bb plugin outdated/update`, `bb plugin config`, `bb plugin logs`, `bb plugin run`.
- No `bb config` command exists today (verified: unknown command).

### Spike-verified facts (Phase 2)

- Model catalogs are per provider and per machine; a model id that works on one
  installation may not exist on another, which is why the spawn target is a
  setting rather than a constant.
- `bb plugin config bb-tui set <key> <value>` + `bb plugin reload bb-tui` applies
  settings live (no app needed).
- Timeline rows from `bb.sdk.threads.timeline` are flat here (children: null)
  and `kind: "conversation"` rows carry `role` + `text` directly.
- A busy local server streams thousands of rows/hour into the buffer (this chat
  alone was several thousand) — per-thread `eventsSince` filtering is required,
  not a nicety.

- `bb.sdk.threads.events.wait` rejects `type: ""` (HTTP 400 "expected string to
  have >=1 characters"); there is no documented "any event" wildcard, so the
  service drains with `events.list` instead. `events.list({ threadId, afterSeq:
  string, limit: string })` returns `ThreadEventRow[]` — each row has a server
  `seq` suitable as a strict-after cursor.
- Realtime `thread:changed` messages carry `id` = `thr_*` thread id (not project)
  plus `metadata.eventTypes` and `changes`.
- `ThreadEventRow` = `{ id, scope, threadId, seq, createdAt, type, data }`;
  content deltas live under `data` (e.g. `data.delta`).
- `bb.sdk.threads.list()` returns a flat array (not a `{threads:[]}` wrapper);
  `bb.sdk.threads.timeline()` returns `{ rows, activePromptMode, ... }`.
- Plugin RPC endpoint: `POST /api/v1/plugins/<id>/rpc/<method>` — open on
  loopback without token (verified). Schema validation failures return `400
  invalid_input` with `issues`.
- `bb.server.loopbackBaseUrl` is bind-gated: read it from handlers/services, not
  the factory.