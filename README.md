# bb-tui

A terminal UI around the bb ecosystem. **Phase 1 spike complete** — see
[DESIGN.md](./DESIGN.md) for the full rationale.

## Status

- ✅ Plugin backend (`bb-plugin-bb-tui`): installed on this host, RPC
  (`getClientInfo` / `listThreads` / `getTimeline` / `eventsSince` with per-thread
  filter), CLI discovery (`bb tui info`), event buffer service (SQLite,
  realtime-driven), prefs (`bb plugin config bb-tui set hideReasoning|pollMs …`).
- ✅ Client (Ink, Phase 2+): app-style split layout — left list (threads grouped
  under their project with fold markers and counts, content markers, colored
  status dots), right thread pane (header, streaming transcript, bordered
  composer); markdown rendering (headings, lists with hanging indents, fenced
  code, quotes, tables, inline emphasis) tolerant of half-streamed text;
  adaptive 30% thread list capped at 44 columns; single focused pane below 72
  columns; contextual shortcuts below pane borders; `tab` switches focus;
  `←/→` folds a project; `/` filters by thread or project title; right-aligned
  branch/machine column (live activity while a thread runs); composer context
  line (project · machine · branch · provider · turn elapsed); actions (`x`
  stop / `c` compact / `m` model); per-thread cursors; archived threads
  excluded; discovery cached; status refreshes event-gated.
  Set `BB_TUI_DEBUG=1` to append buffer counters to the context line.
  `ctrl-l` forces a full repaint, and a resize repaints rather than diffing.
- ⏭ Next: Phase 3 — terminals panes, queue UX, bundled single-file client.

## Pi provider note

bb's pi provider catalogs: `opencode/*` (zen) is billing-blocked on this host
(CreditsError 401); `opencode-go/*` (zen/go) is your paid subscription —
verified working. Use `opencode-go/deepseek-v4-flash` (cheapest), or
`opencode-go/{minimax-m3,qwen3.7-plus}`.

## Run

```sh
# plugin (server side)
cd bb-plugin-bb-tui
bb plugin install . --yes          # once; path-installed
bb plugin reload bb-tui            # after edits

# client (terminal side)
cd client
npm install
npx tsx src/cli.ts info            # headless: discovery facts
npx tsx src/cli.ts list            # headless: thread list
npx tsx src/cli.ts watch --thread <id>   # headless: follow buffered events
npm test                                 # layout + terminal lifecycle tests
npx tsx src/index.tsx              # interactive TUI
```

Requires a bb server on loopback (the bb app or `bb` daemon). Discovery:
`bb tui info` → `~/.bb/bb-app-runtime.json` → `BB_TUI_SERVER_URL` override.

## Responsive layout and terminal compatibility

- At 72 columns and wider, the thread list uses 30% of the terminal width and
  caps at 44 columns. Provider identifiers stay in thread detail, not list rows.
- Below 72 columns, only the focused list or detail pane is rendered; `tab`
  switches panes after a thread is open.
- The composer has its own focus-colored border, while contextual keyboard help
  renders beneath the pane borders.
- The client uses the terminal alternate-screen buffer and stable frame geometry
  to avoid retained border fragments during incremental repaints. This behavior
  is verified in exact-size tmux renders; Termius remains a client-specific
  device check because it is not available in the local test environment.
- Termius on iOS intermittently garbles the frame, usually the bottom border.
  The corruption is client-side — it appears in other full-screen TUIs too — so
  the client cannot prevent it, only recover: `ctrl-l` forces a complete rewrite
  of every cell, and a resize (the iOS keyboard opening and closing is the
  common trigger) repaints instead of letting Ink diff against a frame the
  client may have mangled.
- Repainting cannot go through Ink's `clear()`. That erases the screen but
  leaves `lastOutput` set, and Ink skips writing when the next frame matches it,
  so the screen stays blank until something genuinely changes. The client
  renders one throwaway frame instead, which differs from both its neighbours
  and so forces two writes, the second repainting everything.

## Layout

```
bb-plugin-bb-tui/    bb plugin (server entry: rpc, settings, storage, cli, buffer service)
client/              Ink TUI + headless CLI (TypeScript)
DESIGN.md            architecture + validation + spike results
```
