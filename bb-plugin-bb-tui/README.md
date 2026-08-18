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

## Install

```sh
bb plugin install . --yes
bb plugin reload bb-tui     # after edits
bb plugin logs bb-tui -f    # follow its log
```

## Settings

`bb plugin config bb-tui set <key> <value>`. See the
[root README](../README.md#configuration) for the full table. Settings are
re-read per call, so a change reaches the next client start without a reload.
