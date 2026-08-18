# bb-tui

A source-stage terminal UI for bb, composed of a server-side bb plugin and a
local Ink client.

> **Development status:** run bb-tui from source. A packaged `bb-tui` binary,
> Git/npm installation path, and marketplace release are not available yet.

## Prerequisites

- Node.js 20 or newer and npm.
- A bb server version 0.38 or newer, running on the same host.
- A terminal with color and alternate-screen support.

## First-time setup

Run every command in this section from the repository root.

1. Install the locked dependencies for the server plugin and client:

   ```sh
   npm --prefix bb-plugin-bb-tui ci
   npm --prefix client ci
   ```

2. Install the plugin from the local source directory:

   ```sh
   bb plugin install ./bb-plugin-bb-tui --yes
   ```

3. Verify that the plugin and bb server are discoverable:

   ```sh
   bb tui info
   ```

   The JSON response should include `serverUrl`, bb `version`, and
   `pluginVersion`.

4. Start the interactive client:

   ```sh
   npm --prefix client run dev
   ```

## Development workflow

After editing `bb-plugin-bb-tui/server.ts`, reload the installed plugin:

```sh
bb plugin reload bb-tui
bb tui info
```

After editing the client, stop and restart `npm --prefix client run dev`.

Before handing off a change, run:

```sh
npm --prefix client test
npm --prefix client run typecheck
./bb-plugin-bb-tui/node_modules/.bin/tsc --noEmit \
  --project bb-plugin-bb-tui/tsconfig.json
```

The client test suite covers responsive layout and terminal lifecycle behavior.

## Headless client commands

The client also provides non-interactive commands for smoke testing and event
inspection:

```sh
npm --prefix client run cli -- info
npm --prefix client run cli -- list
npm --prefix client run cli -- watch --thread <thread-id>
```

`watch` continues until interrupted and stores its event cursor under
`~/.bb/bb-tui/`.

## Configuration

Inspect all plugin settings:

```sh
bb plugin config bb-tui
```

Common development settings are:

```sh
bb plugin config bb-tui set hideReasoning false
bb plugin config bb-tui set pollMs 1000
bb plugin config bb-tui set retentionDays 7
bb plugin reload bb-tui
```

- `hideReasoning`: suppress reasoning deltas in the TUI; defaults to `true`.
- `pollMs`: client polling interval in milliseconds; defaults to `800` and is
  clamped to 200–10,000.
- `retentionDays`: buffered-event retention in days; defaults to `7`.

## Troubleshooting

### Plugin installation reports an engine mismatch

The plugin manifest requires bb server 0.38 or newer and plugin SDK 0.4.6 or
newer. Update bb, restart its server, and repeat the local plugin installation.

### `bb tui` is unavailable

Install or reload the local plugin, then retry discovery:

```sh
bb plugin install ./bb-plugin-bb-tui --yes
bb plugin reload bb-tui
bb tui info
```

### The client cannot discover the server

Discovery checks `BB_TUI_SERVER_URL` first, then `bb tui info`, then
`~/.bb/bb-app-runtime.json`. For a non-default loopback URL, start the client
with an explicit override:

```sh
BB_TUI_SERVER_URL=http://127.0.0.1:<port> npm --prefix client run dev
```

The current development path assumes the client and bb server share a host.

### Terminal repaint artifacts

The client uses the alternate-screen buffer and stable frame geometry to avoid
retained border fragments. Exact-size tmux renders are covered during UI
verification. Termius remains a device-specific check because it has not been
verified in the local development environment.

## Current capabilities

- Plugin backend: client discovery, thread listing, timelines, buffered events,
  settings, and the `bb tui info` command.
- Ink client: responsive split layout, a focused single-pane mode below 72
  columns, thread actions, streaming transcript, and a bordered composer.
- Adaptive thread list: 30% width from 72 columns upward, capped at 44 columns;
  provider identifiers remain in thread detail rather than list rows.
- Contextual shortcuts render below pane borders; `tab` switches focus.
- Archived threads are excluded, discovery is cached, and status refreshes are
  event-gated.

Next development phase: terminal panes, queue UX, and a bundled single-file
client.

## Repository layout

```text
bb-plugin-bb-tui/  Server-side bb plugin: RPC, settings, storage, CLI, buffer
client/            Local Ink TUI and headless CLI
DESIGN.md          Design history, validation evidence, and future direction
```

See [the plugin README](./bb-plugin-bb-tui/README.md) for server-component
details. [DESIGN.md](./DESIGN.md) records architecture decisions and planned
distribution; it is not the contributor setup guide.
