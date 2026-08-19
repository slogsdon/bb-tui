# bb-tui

A terminal UI for [bb](https://getbb.app). Browse every thread across your
projects, follow a running agent's output as it streams, and reply — without
leaving the terminal.

It is two pieces: a **bb plugin** that runs inside your bb server and buffers
thread events, and an **Ink client** that renders them. The plugin is what makes
the client cheap — it turns bb's realtime firehose into a monotonic, cursorable
event log the TUI can poll and resume from.

```
┌ threads ────────┐┌ thread ─────────────────────────────────┐
│ ▾ my-project 3  ││ Fix the flaky parser test               │
│   ● Fix the fl  ││                                         │
│   ○ Add --ver   ││ I found the race: the fixture rebuilds  │
│ ▾ notes 1       ││ the index while the test reads it.      │
│   ○ Draft the   ││                                         │
│                 ││ ▼ bottom · my-project · auto · idle     │
│                 ││┌ MESSAGE ─────────────────────────────┐ │
│                 │││ Type a message…                      │ │
│                 ││└──────────────────────────────────────┘ │
└─────────────────┘└─────────────────────────────────────────┘
```

> **Development status:** the plugin can be installed from a checkout or Git
> release. The client still runs from source; no bundled `bb-tui` binary exists.

## Status

Early but usable day to day. Threads, streaming, markdown, slash commands, and
the composer all work; terminals and queue UX do not exist yet.

- **Plugin** — RPC (`getClientInfo` / `listThreads` / `getTimeline` /
  `eventsSince`), a `bb tui info` discovery command, and a background service
  that drains thread events into SQLite.
- **Client** — split layout: threads grouped under their project with fold
  markers and counts, and a thread pane with a streaming transcript, markdown
  rendering, a slash-command menu (with a `/model` picker), tool calls and
  reasoning as they stream, and a bordered composer.
- **Not yet** — terminal panes, queue UX, a bundled single-file client.

## Requirements

- bb `>=0.38` running locally (the bb app or the `bb` daemon)
- Node.js 20+ with npm
- A terminal with color and alternate-screen support

## Install

```sh
git clone https://github.com/slogsdon/bb-tui.git
cd bb-tui

# 1. locked development dependencies
npm --prefix bb-plugin-bb-tui ci
npm --prefix client ci

# 2. the plugin, into your bb server
bb plugin install path:. --plugin bb-tui --yes
bb tui info

# 3. the client
npm --prefix client run dev
```

To make the installed plugin track releases instead of the checkout, replace
step 2 with:

```sh
bb plugin install git:https://github.com/slogsdon/bb-tui.git@^0.1.0 --plugin bb-tui
```

There is also a headless CLI, useful for scripting and for checking that the
plugin is reachable before you open the UI:

```sh
npm --prefix client run cli -- info
npm --prefix client run cli -- list
npm --prefix client run cli -- watch --thread <thread-id>
```

## Configuration

Plugin settings, via `bb plugin config bb-tui set <key> <value>`:

Inspect current values and descriptions with `bb plugin config bb-tui`.

| Setting | Default | What it does |
|---|---|---|
| `serverUrl` | *(blank)* | URL the client should connect to. Blank means this server's own loopback URL. Set it when the TUI runs where that URL does not resolve — another machine, a container, a tunnel. |
| `retentionDays` | `7` | How long buffered events are kept. |
| `pollMs` | `800` | How often the client polls for new events. |
| `hideReasoning` | `false` | Suppress reasoning deltas in the transcript. |
| `spawnProvider` | *(blank)* | Provider for the alternate new-thread shortcut. Blank uses the project's default. |
| `spawnModel` | *(blank)* | Model for the alternate new-thread shortcut. Blank uses the project's default. |

Settings apply to the next client start — no `bb plugin reload` needed.

The client finds the server in this order: `BB_TUI_SERVER_URL`, then
`bb tui info`, then `~/.bb/bb-app-runtime.json`. The environment variable is the
escape hatch for a client running where the `bb` CLI is not installed.
`BB_TUI_DEBUG=1` appends buffer counters to the context line.

If `bb tui` is unavailable after a source edit, reload the path-installed
plugin and verify discovery before restarting the client:

```sh
bb plugin reload bb-tui
bb tui info
```

## Keys

The client is modal. In the thread list there is no text entry, so plain letters
are actions. In the composer every printable key belongs to the message, so
actions there are ctrl chords.

### Thread list

| Key | Action |
|---|---|
| `↑` `↓` | move selection |
| `←` `→` | fold / unfold a project (`←` on a thread jumps to its header) |
| `enter` | open a thread, or fold the project it lands on |
| `/` | filter by thread or project title (`esc` clears) |
| `n` | new thread |
| `tab` | focus the composer |
| `esc` | back to the list from an open thread |
| `q` | quit |

### Composer

| Key | Action |
|---|---|
| `enter` | send |
| `shift-enter`, `ctrl-o` | newline (see the terminal note below) |
| `ctrl-a` `ctrl-e` | start / end of input |
| `ctrl-b` `ctrl-f`, `←` `→` | move the cursor |
| `ctrl-w` | delete the word before the cursor |
| `ctrl-u` `ctrl-k` | kill to start / to end |
| `↑` `↓`, `pgup` `pgdn` | scroll the transcript |
| `ctrl-x` | stop the thread |
| `ctrl-r` | toggle reasoning deltas |
| `ctrl-t` | compact |
| `tab`, `esc` | back to the list |

### Slash menu

Typing a `/` at the start of the input or after a space opens a completion
menu of bb commands and the skills bb knows about, matching bb.app. `/model`
replaces that list with the models the thread's provider offers; accepting one
switches the thread's model straight away, with nothing left to send.

| Key | Action |
|---|---|
| `↑` `↓` | select |
| `enter`, `tab` | accept the highlighted entry |
| `esc` | dismiss the menu (a second `esc` leaves the composer) |

A message that *is* `/compact` or `/cancel-plan` runs the bb thread operation,
the same one the app composer produces — `bb thread tell` is raw and would send
the literal string. Everything else passes through untouched: skills are
resolved by the agent, and provider commands the TUI has never heard of still
work. `//` sends a literal leading slash.

`/plan` is deliberately *not* a bb command. Plan mode is the provider's state,
not a bb setting: the only client-settable permission modes are `accept-edits`,
`auto`, and `full`, and plan travels in a separate host-to-provider field
(`claudeCodePermissionMode`) that no plugin or CLI surface can write. So `/plan`
reaches the agent as text and the agent enters plan mode itself. bb exposes the
other half — `bb thread cancel-plan` — and the timeline reports the state, so
the TUI shows a banner and offers `/cancel-plan` to leave.

In the composer `q` is an ordinary character — use `esc` then `q` to quit. One
action loses its mnemonic to the terminal rather than to preference: `ctrl-m` is
Enter, so compact takes `ctrl-t`.

### Anywhere

| Key | Action |
|---|---|
| `ctrl-l` | force a full repaint |
| `ctrl-c` | exit |

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
- `shift-enter` depends on the terminal. Most send the same byte (CR) for Enter
  and Shift+Enter, so the app cannot tell them apart; `ctrl-o` always works.
  Terminals that can be configured to send a line feed for Shift+Enter get it
  for free — in Ghostty, `keybind = shift+enter=text:\n`; in iTerm2, a key
  binding sending `\n`. The client also accepts a shift-modified return
  reported through CSI modifiers, for terminals that provide one.
- Repainting cannot go through Ink's `clear()`. That erases the screen but
  leaves `lastOutput` set, and Ink skips writing when the next frame matches it,
  so the screen stays blank until something genuinely changes. The client
  renders one throwaway frame instead, which differs from both its neighbours
  and so forces two writes, the second repainting everything.

## Repository layout

```
bb-plugin-bb-tui/    bb plugin: rpc, settings, storage, cli, buffer service
client/              Ink TUI + headless CLI (TypeScript)
scripts/demo.sh      end-to-end smoke test against a live bb
DESIGN.md            architecture notes and what the spike established
```

## Development

```sh
# from the repository root
npm --prefix bb-plugin-bb-tui ci
npm --prefix client ci

npm --prefix client test
npm --prefix client run typecheck
./bb-plugin-bb-tui/node_modules/.bin/tsc --noEmit \
  --project bb-plugin-bb-tui/tsconfig.json

cd bb-plugin-bb-tui
bb plugin types --check
bb plugin build
```

For the plugin edit/reload loop:

```sh
cd bb-plugin-bb-tui
bb plugin dev
```

The client's rendering logic is deliberately pure and unit-tested —
`markdown.ts`, `composer.ts`, and `commands.ts` know nothing about Ink or bb, so
they are testable without a terminal or a server. `layout.tsx` renders them.

Contributions are welcome. There is no CLA and no required issue template; a PR
with a test is plenty.

## License

MIT — see [LICENSE](./LICENSE).
