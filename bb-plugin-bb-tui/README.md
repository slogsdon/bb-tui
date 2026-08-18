# bb-tui server plugin

This directory contains the server-side bb plugin used by the local Ink client.
`server.ts` provides client discovery, thread and timeline RPC methods, buffered
thread events, settings, and the `bb tui info` command.

See the [root contributor guide](../README.md) for complete first-time setup and
client instructions.

## Requirements

- Node.js 20 or newer and npm.
- bb server 0.38 or newer.
- bb plugin SDK 0.4.6 or newer.

The bb and SDK floors are declared in `package.json` under `engines`.

## Install from source

Run from this directory:

```sh
npm ci
bb plugin install . --yes
bb tui info
```

The plugin is path-installed. Source edits become active after a reload:

```sh
bb plugin reload bb-tui
bb tui info
```

## Configuration

Inspect current values and descriptions:

```sh
bb plugin config bb-tui
```

Settings used by the client and event buffer:

```sh
bb plugin config bb-tui set hideReasoning true
bb plugin config bb-tui set pollMs 800
bb plugin config bb-tui set retentionDays 7
bb plugin reload bb-tui
```

- `hideReasoning`: whether the client suppresses reasoning deltas.
- `pollMs`: client polling interval, clamped to 200–10,000 milliseconds.
- `retentionDays`: buffered-event retention, with a minimum of one day.

The plugin also exposes `serverUrl`, `spawnProvider`, and `spawnModel` settings;
blank values use the local server or project defaults.

## Checks

Typecheck the server entry:

```sh
./node_modules/.bin/tsc --noEmit
```

Synchronize or validate the SDK types against the running bb server:

```sh
bb plugin types
bb plugin types --check
```

`@get-bb/plugin-sdk` is pinned in `devDependencies`. Its backend declarations
are installed at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

## Release artifact check

```sh
bb plugin build
```

This validates and bundles the server plugin into `dist/`. It does not build or
install a distributable client binary; the client currently runs from source as
documented in the root README.
