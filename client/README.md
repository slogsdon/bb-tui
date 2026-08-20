# bb-tui

A terminal UI for [bb](https://getbb.app). Browse every thread across your
projects, follow a running agent's output as it streams, and reply — without
leaving the terminal.

```sh
bb plugin install npm:bb-plugin-bb-tui@^0.2.0 --yes   # the server half
npx bb-tui                                            # this package
```

The plugin is required: it buffers bb's realtime firehose into a monotonic,
cursorable event log this client polls and resumes from. Running `bb-tui`
without it prints the install command.

`bb-tui-cli` is the headless companion (`info`, `list`, `watch --thread <id>`),
useful for scripting and for checking the plugin is reachable.

Keys, settings, and the rest of the documentation live in the
[repository README](https://github.com/slogsdon/bb-tui#readme).
