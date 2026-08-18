# bb-plugin-bb-tui

The server half of [bb-tui](../README.md), a terminal UI for bb.

The client cannot subscribe to bb's realtime socket and resume where it left
off, so this plugin does it instead: a background service watches
`thread:changed`, drains each hot thread's events, and appends them to a local
SQLite table under a monotonic sequence the client can cursor over. The TUI then
polls one cheap endpoint and never misses an event across a restart.

## Surfaces

| Kind | Name | Purpose |
|---|---|---|
| rpc | `getClientInfo` | server URL, version, prefs, spawn target |
| rpc | `listThreads` | thread rows for the navigator |
| rpc | `getTimeline` | history, plan mode, resolved execution options |
| rpc | `eventsSince` | buffered events after a sequence number |
| cli | `bb tui info` | discovery, so the client needs no configuration |
| service | `event-buffer` | realtime drain into SQLite |

## Requirements

- Node.js 20 or newer with npm
- bb server 0.38 or newer
- bb plugin SDK 0.4.6 or newer

The bb and SDK floors are declared in `package.json` under `engines`.

## Install

```sh
npm ci
bb plugin install . --yes
bb tui info
```

## Settings

`bb plugin config bb-tui set <key> <value>`. See the
[root README](../README.md#configuration) for the full table. Settings are
re-read per call, so a change reaches the next client start without a reload.

## Development

Use the plugin development loop after the initial install:

```sh
bb plugin dev
```

Validate the source, SDK pin, and release artifact:

```sh
./node_modules/.bin/tsc --noEmit
bb plugin types --check
bb plugin build
```

Follow plugin logs separately when debugging the event buffer:

```sh
bb plugin logs bb-tui -f
```
