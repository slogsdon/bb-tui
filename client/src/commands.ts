// Slash handling. Two independent rules that happen to share a prefix:
//
//   menu       the token at the cursor starts with "/"  -> live, per keystroke
//   execution  the whole message is "/name …"           -> on send
//
// A message that merely contains /compact mid-sentence offers the menu while
// typing and still sends as ordinary text. That mirrors bb.app, where accepting
// a skill inserts text the agent resolves, while a message that *is* /compact
// becomes a bb operation.
//
// bb owns this namespace, not the TUI: `/` reaches bb commands, bb skills, and
// whatever the provider itself defines. So unknown names are never blocked —
// they pass through untouched.

/** Commands bb resolves client-side and that `bb thread tell` cannot express.
 * Everything else — skills, provider commands — is passthrough. */
export const BB_COMMAND_NAMES = ["compact", "cancel-plan", "model"] as const;

export type Resolution =
  | { kind: "command"; name: string; args: string }
  | { kind: "text"; text: string };

const WHOLE_COMMAND = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i;

/** Decide what a composed message means, at send time. */
export function resolveSlash(input: string): Resolution {
  const text = input.trim();
  // `//name` escapes: send a literal leading slash.
  if (text.startsWith("//")) return { kind: "text", text: text.slice(1) };
  const match = WHOLE_COMMAND.exec(text);
  if (!match) return { kind: "text", text };
  const name = (match[1] ?? "").toLowerCase();
  if (!(BB_COMMAND_NAMES as readonly string[]).includes(name)) return { kind: "text", text };
  return { kind: "command", name, args: (match[2] ?? "").trim() };
}

export type CatalogEntry = {
  kind: "command" | "skill" | "model";
  name: string;
  description: string;
};

export const MENU_MAX_ENTRIES = 6;

export type MenuSelection = {
  selected: number;
  firstVisible: number;
};

export const INITIAL_MENU_SELECTION: MenuSelection = { selected: 0, firstVisible: 0 };

/** Move selection while keeping a stable viewport until the selected row
 * crosses one of its edges. */
export function moveMenuSelection(
  state: MenuSelection,
  delta: number,
  entryCount: number,
  visibleCount = MENU_MAX_ENTRIES,
): MenuSelection {
  const last = Math.max(0, entryCount - 1);
  const selected = Math.max(0, Math.min(last, state.selected + delta));
  const size = Math.max(1, visibleCount);
  const maxFirst = Math.max(0, entryCount - size);
  let firstVisible = Math.max(0, Math.min(maxFirst, state.firstVisible));
  if (selected < firstVisible) firstVisible = selected;
  else if (selected >= firstVisible + size) firstVisible = selected - size + 1;
  return { selected, firstVisible };
}

const COMMAND_ENTRIES: CatalogEntry[] = [
  { kind: "command", name: "compact", description: "Compact context" },
  { kind: "command", name: "cancel-plan", description: "Exit plan mode" },
  { kind: "command", name: "model", description: "Switch the model for this thread" },
];

const MODEL_INVOCATION = /^\/model(?:\s+([^\s]*))?$/i;

/** The filter typed after `/model`, or null when the composer is not a model
 * invocation. Returning "" for a bare `/model` is what opens the picker the
 * moment the command is accepted from the menu. */
export function modelQuery(text: string): string | null {
  const m = MODEL_INVOCATION.exec(text);
  return m ? (m[1] ?? "") : null;
}

/** Model ids as menu entries, filtered by what has been typed so far. */
export function modelEntries(
  models: Array<{ id: string; displayName?: string }>,
  query: string,
): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  return models
    .filter((m) => needle === "" || m.id.toLowerCase().includes(needle))
    .map((m) => ({ kind: "model" as const, name: m.id, description: m.displayName ?? "" }));
}

/** Merge bb commands with the skills bb knows about. Users do not care which
 * layer resolves a name, so both share one list. */
export function buildCatalog(skills: Array<{ name: string; description?: string }>): CatalogEntry[] {
  const seen = new Set(COMMAND_ENTRIES.map((e) => e.name));
  const skillEntries = skills
    .filter((s) => s.name && !seen.has(s.name))
    .map((s) => ({ kind: "skill" as const, name: s.name, description: s.description ?? "" }));
  return [...COMMAND_ENTRIES, ...skillEntries];
}

/** Entries matching a slash token, commands first. The token includes its
 * leading slash; an empty token (a bare "/") matches everything, which is what
 * makes the menu appear the moment you type it. */
export function matchEntries(catalog: CatalogEntry[], token: string): CatalogEntry[] {
  const needle = token.replace(/^\//, "").toLowerCase();
  const hit = (entry: CatalogEntry) => needle === "" || entry.name.toLowerCase().includes(needle);
  const rank = (entry: CatalogEntry) => {
    if (entry.kind === "command") return 0;
    // Prefix matches are what the user is most likely reaching for.
    return entry.name.toLowerCase().startsWith(needle) ? 1 : 2;
  };
  return catalog
    .filter(hit)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
