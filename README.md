# bb-tui

A terminal UI around the bb ecosystem. **Phase 1 spike complete** — see
[DESIGN.md](./DESIGN.md) for the full rationale.

## Status

- ✅ Plugin backend (`bb-plugin-bb-tui`): installed on this host, RPC
  (`getClientInfo` / `listThreads` / `getTimeline` / `eventsSince`), CLI
  discovery (`bb tui info`), event buffer service (SQLite, realtime-driven).
- ✅ Client (Ink): boots, discovers server, renders live thread list; headless
  CLI (`bb-tui info|list|watch`).
- ⏭ Next: Phase 2 — detail streaming view, terminals, provider/model picker.

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