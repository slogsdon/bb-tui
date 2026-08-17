export type TerminalWriter = {
  write(value: string): unknown;
};

const ENTER_ALTERNATE_SCREEN = "\u001B[?1049h\u001B[H";
const RESTORE_PRIMARY_SCREEN = "\u001B[?25h\u001B[?1049l";

/** Enter the alternate screen and return an idempotent primary-screen restore callback. */
export function enterAlternateScreen(stream: TerminalWriter): () => void {
  let restored = false;
  stream.write(ENTER_ALTERNATE_SCREEN);

  return () => {
    if (restored) return;
    restored = true;
    stream.write(RESTORE_PRIMARY_SCREEN);
  };
}
