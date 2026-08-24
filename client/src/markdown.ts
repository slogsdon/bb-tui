// Markdown → terminal lines. Models emit markdown; the TUI needs styled,
// pre-wrapped LINES (not a formatted blob) because the thread pane windows the
// transcript by slicing an array. Everything here is line-oriented for that
// reason, and tolerant of half-arrived markdown: text streams in deltas, so an
// unterminated fence or a dangling `**` must never restyle what came before it.

export type Span = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  color?: string;
};

export type MdLine = { spans: Span[] };

/** A transcript entry: one conversational or tool block, rendered as a unit. */
export type TranscriptBlock = {
  role: "user" | "agent" | "system" | "work" | "reasoning";
  text: string;
  /** Nesting depth for tool/work children (rendered with a `└` gutter). */
  depth?: number;
};

// Built from escapes rather than literal bytes so the source stays plain ASCII.
const ANSI = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
const CONTROL = new RegExp("[\\u0000-\\u0009\\u000B-\\u001F\\u007F]", "g");

/** Model text can carry escape sequences and control bytes; both corrupt frame
 * geometry once Ink measures the row. Tabs expand because they break width math. */
function sanitize(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(ANSI, "").replace(/\t/g, "  ").replace(CONTROL, "");
}

// Inline emphasis. Ordered longest-delimiter-first so `**` wins over `*`. Every
// alternative requires its closing delimiter, so an unclosed `**` simply fails
// to match and survives as literal text — the tolerance property streaming needs.
// `_` forms are word-bounded so snake_case identifiers are not italicised.
const INLINE = new RegExp(
  [
    "`([^`]+)`",
    "\\*\\*([^*]+?)\\*\\*",
    "(?<!\\w)__([^_]+?)__(?!\\w)",
    "\\*([^*\\n]+?)\\*",
    "(?<!\\w)_([^_\\n]+?)_(?!\\w)",
    "\\[([^\\]]+)\\]\\(([^)\\s]+)\\)",
  ].join("|"),
  "g",
);

/** Split one line of markdown into styled spans. Unmatched delimiters stay literal. */
export function parseInline(text: string, base: Span = { text: "" }): Span[] {
  const style = { ...base, text: "" };
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ ...style, text: text.slice(last, at) });
    if (m[1] !== undefined) out.push({ ...style, text: m[1], color: "cyan" });
    else if (m[2] !== undefined) out.push({ ...style, text: m[2], bold: true });
    else if (m[3] !== undefined) out.push({ ...style, text: m[3], bold: true });
    else if (m[4] !== undefined) out.push({ ...style, text: m[4], italic: true });
    else if (m[5] !== undefined) out.push({ ...style, text: m[5], italic: true });
    else {
      out.push({ ...style, text: m[6] ?? "" });
      out.push({ ...style, text: ` (${m[7] ?? ""})`, dim: true });
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ ...style, text: text.slice(last) });
  return out.filter((s) => s.text !== "");
}

type Block = {
  /** Gutter/marker rendered on the first line; continuations get equal padding. */
  prefix: Span[];
  body: Span[];
  /** Code and table rows truncate instead of wrapping — wrapped code is worse
   * than clipped code. */
  noWrap?: boolean;
  blank?: boolean;
};

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^[\s|:-]+$/;
const BULLETS = ["•", "◦", "‣"];

function parseBlocks(lines: string[], width: number, base: Span): Block[] {
  const out: Block[] = [];
  let inFence = false;
  // A table is the one construct here that cannot be rendered a line at a time:
  // column widths are a property of the whole thing. Rows collect until
  // something that is not a row ends them.
  let table: string[] = [];

  const pushBlank = () => {
    if (out.length > 0 && !out[out.length - 1]!.blank) out.push({ prefix: [], body: [], blank: true });
  };
  const flushTable = () => {
    if (table.length === 0) return;
    out.push(...layoutTable(table, width, base));
    table = [];
  };

  for (const raw of lines) {
    if (!TABLE_ROW.test(raw)) flushTable();
    if (FENCE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    // An unterminated fence keeps everything after it as code, by design.
    if (inFence) {
      out.push({
        prefix: [{ text: "│ ", dim: true }],
        body: [{ text: raw, color: "cyan" }],
        noWrap: true,
      });
      continue;
    }

    if (raw.trim() === "") {
      pushBlank();
      continue;
    }

    const heading = HEADING.exec(raw);
    if (heading) {
      pushBlank();
      out.push({ prefix: [], body: parseInline(heading[2] ?? "", { ...base, bold: true }) });
      continue;
    }

    if (RULE.test(raw)) {
      out.push({ prefix: [], body: [{ text: "─".repeat(Math.max(4, width)), dim: true }], noWrap: true });
      continue;
    }

    const quote = QUOTE.exec(raw);
    if (quote) {
      out.push({
        prefix: [{ text: "│ ", dim: true }],
        body: parseInline(quote[1] ?? "", { ...base, dim: true }),
      });
      continue;
    }

    const list = LIST.exec(raw);
    if (list) {
      const depth = Math.min(3, Math.floor((list[1] ?? "").length / 2));
      const rawMarker = list[2] ?? "-";
      const marker = /^\d/.test(rawMarker) ? rawMarker : BULLETS[depth % BULLETS.length]!;
      out.push({
        prefix: [{ text: `${"  ".repeat(depth)}${marker} ` }],
        body: parseInline(list[3] ?? "", base),
      });
      continue;
    }

    if (TABLE_ROW.test(raw)) {
      table.push(raw);
      continue;
    }

    out.push({ prefix: [], body: parseInline(raw.trim(), base) });
  }
  flushTable();
  return out;
}

type Align = "left" | "right" | "center";

/** Split `| a | b |` into its cells, without the empty edges the pipes make. */
function tableCells(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

/** Column alignment from the separator row's colons, GitHub's rule. */
function tableAlign(cells: string[]): Align[] {
  return cells.map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

/** Fit natural column widths into the pane: shrink the widest column first, so
 * one long prose cell cannot squeeze the short ones into uselessness. */
function fitColumns(natural: number[], available: number): number[] {
  const widths = [...natural];
  let over = widths.reduce((n, w) => n + w, 0) - available;
  while (over > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if ((widths[widest] ?? 0) <= 3) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    over -= 1;
  }
  return widths;
}

const padCell = (spans: Span[], width: number, align: Align, base: Span): Span[] => {
  const room = Math.max(0, width - spanWidth(spans));
  const left = align === "right" ? room : align === "center" ? Math.floor(room / 2) : 0;
  return [
    ...(left > 0 ? [{ ...base, text: " ".repeat(left) }] : []),
    ...spans,
    ...(room - left > 0 ? [{ ...base, text: " ".repeat(room - left) }] : []),
  ];
};

/** Render buffered rows as an aligned table. Streaming-tolerant by
 * construction: a header alone, or a header and its separator, is just a
 * one-row table until the rest arrives. */
function layoutTable(rows: string[], width: number, base: Span): Block[] {
  const parsed = rows.map(tableCells);
  const sepIndex = rows.findIndex((row) => TABLE_SEP.test(row));
  const align = sepIndex >= 0 ? tableAlign(parsed[sepIndex] ?? []) : [];
  const body = parsed.filter((_, index) => index !== sepIndex);
  if (body.length === 0) return [];
  const columns = Math.max(...body.map((cells) => cells.length));
  const gap = 3; // " │ "
  const available = Math.max(columns * 3, Math.max(8, width) - gap * (columns - 1));
  const natural = Array.from({ length: columns }, (_, column) =>
    Math.max(1, ...body.map((cells) => (cells[column] ?? "").length)),
  );
  const widths = fitColumns(natural, available);
  // A separator row means the first row is a header; without one every row is
  // data, which is what a half-arrived table looks like.
  const hasHeader = sepIndex > 0;

  const line = (cells: string[], header: boolean): Block => ({
    prefix: [],
    noWrap: true,
    body: widths.flatMap((columnWidth, column) => {
      const style = header ? { ...base, bold: true } : base;
      const cell = truncateSpans(parseInline(cells[column] ?? "", style), columnWidth);
      const alignment = align[column] ?? "left";
      // Padding the last column left-aligned would be trailing whitespace, which
      // costs real pane width and shows up as ragged padding.
      const padded =
        column === widths.length - 1 && alignment === "left"
          ? cell
          : padCell(cell, columnWidth, alignment, style);
      return column === 0 ? padded : [{ text: " │ ", dim: true }, ...padded];
    }),
  });

  const out: Block[] = [];
  body.forEach((cells, index) => {
    out.push(line(cells, hasHeader && index === 0));
    if (hasHeader && index === 0) {
      out.push({
        prefix: [],
        noWrap: true,
        body: [{ text: widths.map((w) => "─".repeat(w)).join("─┼─"), dim: true }],
      });
    }
  });
  return out;
}

const spanWidth = (spans: Span[]): number => spans.reduce((n, s) => n + s.text.length, 0);

/** Drop the separator space a break lands on; a trailing space costs a real
 * column of pane width and shows up as ragged padding. */
function flushed(line: Span[]): Span[] {
  const out = [...line];
  while (out.length > 0 && out[out.length - 1]!.text.trim() === "") out.pop();
  return out;
}

/** Greedy word wrap that preserves per-span styling across the break. */
export function wrapSpans(spans: Span[], width: number): Span[][] {
  const w = Math.max(4, width);
  const out: Span[][] = [];
  let line: Span[] = [];
  let len = 0;

  for (const span of spans) {
    for (const part of span.text.split(/(\s+)/)) {
      if (part === "") continue;
      const isSpace = /^\s+$/.test(part);
      const token = isSpace ? " " : part;
      if (isSpace && len === 0) continue;
      if (len + token.length > w && len > 0) {
        out.push(flushed(line));
        line = [];
        len = 0;
        if (isSpace) continue;
      }
      // A token longer than the pane (a URL, a path) hard-breaks; len is 0 here
      // because the wrap above already flushed the line.
      if (token.length > w) {
        let rest = token;
        while (rest.length > w) {
          out.push([{ ...span, text: rest.slice(0, w) }]);
          rest = rest.slice(w);
        }
        line = rest === "" ? [] : [{ ...span, text: rest }];
        len = rest.length;
        continue;
      }
      line.push({ ...span, text: token });
      len += token.length;
    }
  }
  const tail = flushed(line);
  if (tail.length > 0) out.push(tail);
  if (out.length === 0) out.push([]);
  return out;
}

function truncateSpans(spans: Span[], width: number): Span[] {
  const w = Math.max(4, width);
  const out: Span[] = [];
  let len = 0;
  for (const span of spans) {
    const room = w - len;
    if (room <= 0) return [...out, { text: "›", dim: true }];
    if (span.text.length <= room) {
      out.push(span);
      len += span.text.length;
      continue;
    }
    return [...out, { ...span, text: span.text.slice(0, room - 1) }, { text: "›", dim: true }];
  }
  return out;
}

function layoutBlocks(blocks: Block[], width: number): MdLine[] {
  const out: MdLine[] = [];
  for (const block of blocks) {
    if (block.blank) {
      out.push({ spans: [] });
      continue;
    }
    const prefixWidth = spanWidth(block.prefix);
    const inner = Math.max(4, width - prefixWidth);
    if (block.noWrap) {
      out.push({ spans: [...block.prefix, ...truncateSpans(block.body, inner)] });
      continue;
    }
    const pad: Span = { text: " ".repeat(prefixWidth) };
    wrapSpans(block.body, inner).forEach((spans, index) => {
      out.push({ spans: index === 0 ? [...block.prefix, ...spans] : [pad, ...spans] });
    });
  }
  // Leading and trailing blanks are the block separator's job, not content's.
  while (out.length > 0 && out[0]!.spans.length === 0) out.shift();
  while (out.length > 0 && out[out.length - 1]!.spans.length === 0) out.pop();
  return out;
}

// Re-rendering the whole transcript every poll tick is waste; only the streaming
// tail block is ever dirty. Keyed on width + text, capped so it cannot grow
// unbounded across a long session.
const CACHE_MAX = 256;
const cache = new Map<string, MdLine[]>();

/** Render markdown as pre-wrapped, styled terminal lines. */
export function renderMarkdown(text: string, width: number, base: Span = { text: "" }): MdLine[] {
  const key = `${width} ${base.color ?? ""}${base.dim ? "d" : ""}${base.italic ? "i" : ""} ${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const lines = layoutBlocks(parseBlocks(sanitize(text).split("\n"), width, base), width);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, lines);
  return lines;
}

const ROLE_STYLE: Record<TranscriptBlock["role"], { prefix: Span[]; base: Span }> = {
  // The agent carries the bulk of the content, so it gets the full pane width
  // and no gutter. Everything else is marked so it can be skipped by eye.
  agent: { prefix: [], base: { text: "" } },
  user: { prefix: [{ text: "› ", color: "blue", bold: true }], base: { text: "", color: "blue" } },
  system: { prefix: [{ text: "· ", dim: true }], base: { text: "", dim: true } },
  work: { prefix: [{ text: "· ", dim: true }], base: { text: "", dim: true } },
  reasoning: { prefix: [{ text: "~ ", dim: true }], base: { text: "", dim: true, italic: true } },
};

// Second cache layer, above the markdown one and keyed on block identity rather
// than text. The two catch different misses and both are needed:
//
//   - This one holds the gutter/padding pass, which the markdown cache never
//     saw. Without it every block in the transcript reallocated one array per
//     rendered line on every poll tick, to display the ~30 lines that fit.
//   - The markdown cache below still carries the 4s timeline refresh, which
//     rebuilds every block object from scratch and so misses here by identity
//     while hitting there by text.
//
// Weak, so a block dropped by the history cap or a thread switch is collected
// with it; no cap to tune.
const blockCache = new WeakMap<TranscriptBlock, { width: number; lines: MdLine[] }>();

function blockLines(block: TranscriptBlock, width: number): MdLine[] {
  const hit = blockCache.get(block);
  if (hit && hit.width === width) return hit.lines;
  const style = ROLE_STYLE[block.role];
  const child = (block.depth ?? 0) > 0;
  const prefix = child ? [{ text: "  └ ", dim: true }] : style.prefix;
  const prefixWidth = spanWidth(prefix);
  const rendered = renderMarkdown(block.text, Math.max(4, width - prefixWidth), style.base);
  const pad: Span = { text: " ".repeat(prefixWidth) };
  const lines = rendered.map((line, index) => ({
    spans: index === 0 ? [...prefix, ...line.spans] : [pad, ...line.spans],
  }));
  blockCache.set(block, { width, lines });
  return lines;
}

/** Render transcript blocks with a blank line between them and a role gutter on
 * the first line only, so a wrapped message reads as one message. */
export function renderBlocks(blocks: TranscriptBlock[], width: number): MdLine[] {
  const out: MdLine[] = [];
  for (const block of blocks) {
    const lines = blockLines(block, width);
    if (lines.length === 0) continue;
    if (out.length > 0) out.push({ spans: [] });
    // Pushed one at a time rather than spread: a long block can exceed the
    // argument limit that `push(...lines)` would hit.
    for (const line of lines) out.push(line);
  }
  return out;
}
