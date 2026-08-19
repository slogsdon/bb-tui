// Mouse reporting. Ink has none, so the terminal is asked directly: SGR
// tracking (1006) because the legacy encoding cannot report a column past 223,
// and button tracking (1000) because motion events are noise we would only
// throw away.

export type TerminalWriter = { write(value: string): unknown };

export type MouseEvent =
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number }
  | { kind: "press"; button: number; x: number; y: number };

const ENABLE = "\u001B[?1000h\u001B[?1006h";
const DISABLE = "\u001B[?1006l\u001B[?1000l";

/** Turn mouse reporting on; the returned callback is idempotent, because it
 * runs from both the exit hook and Ink's unmount. */
export function enableMouse(stream: TerminalWriter): () => void {
  let disabled = false;
  stream.write(ENABLE);
  return () => {
    if (disabled) return;
    disabled = true;
    stream.write(DISABLE);
  };
}

// SGR: ESC [ < button ; col ; row (M=press, m=release). Coordinates are 1-based.
// The ESC is optional because Ink strips it before a handler sees the chunk.
const SGR = new RegExp("\\u001B?\\[<(\\d+);(\\d+);(\\d+)([Mm])", "g");

/** True when a chunk carries mouse reports, so the key handler can ignore it
 * rather than reading the escape as a keypress. */
export function isMouseInput(data: string): boolean {
  return new RegExp("\\u001B?\\[<\\d").test(data);
}

/** Parse every mouse report in one stdin chunk. Releases are dropped: a click
 * is one action, and reporting both halves would double it. */
export function parseMouse(data: string): MouseEvent[] {
  const out: MouseEvent[] = [];
  for (const m of data.matchAll(SGR)) {
    const button = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (m[4] === "m") continue;
    // Bit 6 (64) marks the wheel; its low bit is the direction.
    if (button & 64) out.push({ kind: "wheel", direction: button & 1 ? "down" : "up", x, y });
    else out.push({ kind: "press", button: button & 3, x, y });
  }
  return out;
}
