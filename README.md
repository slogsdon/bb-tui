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
  line (project · machine · branch · model · permission mode · turn elapsed);
  a plan-mode banner while the provider is planning; per-thread
  cursors; archived threads excluded; discovery cached; status refreshes
  event-gated. See [Keys](#keys).
  Set `BB_TUI_DEBUG=1` to append buffer counters to the context line.
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
| `ctrl-p` | pick a model |
| `tab`, `esc` | back to the list |

### Slash menu

Typing a `/` at the start of the input or after a space opens a completion
menu of bb commands and the skills bb knows about, matching bb.app.

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

In the composer `q` is an ordinary character — use `esc` then `q` to quit. Two
actions lose their mnemonic to the terminal rather than to preference: `ctrl-m`
is Enter, and `ctrl-k` is kill-line, so compact and model take `ctrl-t` and
`ctrl-p`.

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

## Layout

```
bb-plugin-bb-tui/    bb plugin (server entry: rpc, settings, storage, cli, buffer service)
client/              Ink TUI + headless CLI (TypeScript)
DESIGN.md            architecture + validation + spike results
```
