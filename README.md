# bb-tui

A terminal UI around the bb ecosystem. **Phase 1 spike complete** — see
[DESIGN.md](./DESIGN.md) for the full rationale.

## Status

- ✅ Plugin backend (`bb-plugin-bb-tui`): installed on this host, RPC
  (`getClientInfo` / `listThreads` / `getTimeline` / `eventsSince` with per-thread
  filter), CLI discovery (`bb tui info`), event buffer service (SQLite,
  realtime-driven), prefs (`bb plugin config bb-tui set hideReasoning|pollMs …`).
- ✅ Client (Ink, Phase 2+): app-style split layout — left list (Needs
  attention / Recent, content markers, colored status dots), right thread pane
  (header, streaming transcript, composer); `tab` switches focus; word wrap;
  actions (`x` stop / `c` compact / `m` model); per-thread cursors; archived
  threads excluded; discovery cached; status refreshes event-gated.
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
npx tsx src/index.tsx              # interactive TUI
```

Requires a bb server on loopback (the bb app or `bb` daemon). Discovery:
`bb tui info` → `~/.bb/bb-app-runtime.json` → `BB_TUI_SERVER_URL` override.

## Layout

```
bb-plugin-bb-tui/    bb plugin (server entry: rpc, settings, storage, cli, buffer service)
client/              Ink TUI + headless CLI (TypeScript)
DESIGN.md            architecture + validation + spike results
```