// Composer input model: text plus a cursor. Kept pure and free of Ink so the
// editing rules, the slash-token rule and the wrap/cursor mapping are all
// testable without rendering a frame — the render harness cannot see cursor
// bugs, which is where this kind of code actually goes wrong.

export type Composer = { text: string; cursor: number };

export const EMPTY: Composer = { text: "", cursor: 0 };

/** The subset of Ink's key flags this model reacts to. */
export type KeyFlags = {
  ctrl?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, max));

const withCursor = (state: Composer, cursor: number): Composer => ({
  text: state.text,
  cursor: clamp(cursor, state.text.length),
});

/** Start of the word before the cursor, skipping any whitespace it sits on. */
function wordStart(text: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && /\s/.test(text[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(text[i - 1] ?? "")) i--;
  return i;
}

function eraseBefore(state: Composer): Composer {
  if (state.cursor === 0) return state;
  return {
    text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
    cursor: state.cursor - 1,
  };
}

function insert(state: Composer, chunk: string): Composer {
  return {
    text: state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor),
    cursor: state.cursor + chunk.length,
  };
}

/** Apply one input chunk. Readline conventions only — nothing invented.
 * Printable text inserts at the cursor, and a paste arrives as one multi-char
 * chunk, so insertion is per-chunk rather than per-key. */
export function applyKey(state: Composer, data: string, key: KeyFlags): Composer {
  if (key.leftArrow) return withCursor(state, state.cursor - 1);
  if (key.rightArrow) return withCursor(state, state.cursor + 1);
  if (key.backspace) return eraseBefore(state);
  if (key.delete) {
    if (state.cursor >= state.text.length) return state;
    return {
      text: state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1),
      cursor: state.cursor,
    };
  }

  if (key.ctrl) {
    switch (data) {
      case "a":
        return withCursor(state, 0);
      case "e":
        return withCursor(state, state.text.length);
      case "b":
        return withCursor(state, state.cursor - 1);
      case "f":
        return withCursor(state, state.cursor + 1);
      case "u":
        return { text: state.text.slice(state.cursor), cursor: 0 };
      case "k":
        return { text: state.text.slice(0, state.cursor), cursor: state.cursor };
      case "w": {
        const start = wordStart(state.text, state.cursor);
        return { text: state.text.slice(0, start) + state.text.slice(state.cursor), cursor: start };
      }
      default:
        // Unhandled control chords must not leak into the text.
        return state;
    }
  }

  let next = state;
  let pending = "";
  for (const ch of data) {
    // Ink reports erase inconsistently across PTY modes: sometimes a flag,
    // sometimes these bytes in the data chunk.
    if (ch === "\u007F" || ch === "\b") {
      if (pending !== "") {
        next = insert(next, pending);
        pending = "";
      }
      next = eraseBefore(next);
      continue; // erase marker handled
    }
    if (ch === "\n" || ch >= " ") pending += ch;
  }
  return pending === "" ? next : insert(next, pending);
}

export type SlashToken = { text: string; start: number; end: number };

/** The slash token the cursor sits in, or null.
 *
 * Matches bb.app: the `/` must be at index 0 or preceded by a space. That rule
 * is what keeps `http://host` and `and/or` from opening the menu, since neither
 * token begins with the slash. */
export function slashTokenAt(state: Composer): SlashToken | null {
  const { text, cursor } = state;
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start--;
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end] ?? "")) end++;
  if (text[start] !== "/") return null;
  if (start > 0 && !/\s/.test(text[start - 1] ?? "")) return null;
  return { text: text.slice(start, end), start, end };
}

/** Replace a slash token with a chosen command or skill, leaving exactly one
 * space after it. Accepting mid-sentence must not double the space that is
 * already there; the cursor lands past it either way. */
export function replaceToken(state: Composer, token: SlashToken, name: string): Composer {
  const following = state.text[token.end];
  const hasSpace = following !== undefined && /\s/.test(following);
  const inserted = hasSpace ? `/${name}` : `/${name} `;
  return {
    text: state.text.slice(0, token.start) + inserted + state.text.slice(token.end),
    cursor: token.start + name.length + 2,
  };
}

type Row = { text: string; start: number };

/** Hard wrap at the pane width, preserving every character. Word wrapping would
 * collapse or move the user's own spaces, which an editable field cannot do. */
function wrapRows(text: string, width: number): Row[] {
  const rows: Row[] = [];
  let offset = 0;
  for (const segment of text.split("\n")) {
    let at = 0;
    do {
      rows.push({ text: segment.slice(at, at + width), start: offset + at });
      at += width;
    } while (at < segment.length);
    offset += segment.length + 1; // consume the newline
  }
  return rows;
}

export type ComposerLayout = {
  rows: string[];
  /** Cursor position within the returned window. */
  cursorRow: number;
  cursorCol: number;
  /** True when rows above the window are hidden. */
  scrolled: boolean;
};

/** Wrap the text and locate the cursor, windowed to maxRows so a long message
 * scrolls with the cursor instead of overflowing the composer. */
export function layoutComposer(state: Composer, width: number, maxRows: number): ComposerLayout {
  const w = Math.max(4, width);
  const limit = Math.max(1, maxRows);
  const rows = wrapRows(state.text, w);

  let index = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i] as Row).start <= state.cursor) {
      index = i;
      break;
    }
  }
  let col = state.cursor - (rows[index] as Row).start;
  // Cursor immediately past a full row belongs at the start of the next one.
  if (col >= w) {
    rows.push({ text: "", start: state.cursor });
    index += 1;
    col = 0;
  }

  const from = Math.max(0, index - limit + 1);
  return {
    rows: rows.slice(from, from + limit).map((r) => r.text),
    cursorRow: index - from,
    cursorCol: col,
    scrolled: from > 0,
  };
}
