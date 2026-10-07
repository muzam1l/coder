/** The terminal as a live surface: its size, visible widths of styled text, and a redrawable region that never scrolls what is above it. */
import process from 'node:process';

import { outStyle } from './output';

// The slice of a write stream LiveRegion needs is structural, so tests can
// drive a fake terminal and callers can pass process.stdout/stderr as-is.
export interface LiveStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  getWindowSize?: () => number[];
  write(data: string): boolean;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

// Fresh terminal size via syscall. stream.columns/rows are only updated when
// SIGWINCH is delivered. A repaint frame between a physical resize and the
// signal would erase with a stale width and strand copies of the live block.
export function termCols(stream: LiveStream = process.stdout): number | undefined {
  try {
    return stream.getWindowSize?.()[0] ?? stream.columns;
  } catch {
    return stream.columns;
  }
}

export function termRows(stream: LiveStream = process.stdout): number | undefined {
  try {
    return stream.getWindowSize?.()[1] ?? stream.rows;
  } catch {
    return stream.rows;
  }
}

// Approximate wcwidth for one code point. Live-block lines carry arbitrary
// task-log text; a CJK char or emoji measured as 1 column would let a
// "clipped" line touch the last column, set the terminal's soft-wrap flag,
// and break the row accounting LiveRegion's erase relies on.
function charWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners/marks
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions
  ) {
    return 2;
  }
  return 1;
}

/** Visible terminal columns of a styled line (SGR sequences count 0). */
export function visibleWidth(line: string): number {
  let width = 0;
  for (const ch of line.replace(/\x1b\[[0-9;]*m/g, '')) width += charWidth(ch.codePointAt(0)!);
  return width;
}

// Index at which `line` reaches `width` visible columns; SGR sequences pass
// through without counting.
function widthCut(line: string, width: number): number {
  let visible = 0;
  for (let i = 0; i < line.length;) {
    const m = line[i] === '\x1b' ? /^\x1b\[[0-9;]*m/.exec(line.slice(i)) : null;
    if (m) {
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = charWidth(ch.codePointAt(0)!);
    if (visible + w > width) return i;
    visible += w;
    i += ch.length;
  }
  return line.length;
}

// Break a line into at most `rows` rows of `width` visible columns, ellipsising
// whatever is left over. Breaks at a space when one sits in the last third of
// the row, so words survive wherever that is affordable.
export function wrapAnsi(line: string, width: number, rows: number): string[] {
  if (width < 4 || rows < 1) return [line];
  const out: string[] = [];
  let rest = line;
  while (visibleWidth(rest) > width) {
    if (out.length === rows - 1) {
      return [...out, `${rest.slice(0, widthCut(rest, width - 1))}…`];
    }
    const edge = widthCut(rest, width);
    const space = rest.lastIndexOf(' ', edge);
    const cut = space > width * 0.66 ? space : edge;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  return [...out, rest];
}

// Clip a styled line to at most `max` visible columns, preserving ANSI
// sequences. Live-block lines must never hard-wrap at paint time: a resize
// reflows wrapped rows in ways the cursor-up erase cannot reliably count.
export function clipAnsi(line: string, max: number): string {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length;) {
    const m = line[i] === '\x1b' ? /^\x1b\[[0-9;]*m/.exec(line.slice(i)) : null;
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (visible + w > max - 1) return `${out}\x1b[0m${outStyle.dim('…')}`;
    out += ch;
    visible += w;
    i += ch.length;
  }
  return out;
}

// While a live block is on screen, echoed keystrokes corrupt it: an Enter
// echoes a newline, silently moving the cursor down a row, and every erase
// after that is off by one. One copy of the block is stranded per press. Raw
// mode turns echo off for the duration. Raw mode also stops the terminal
// generating SIGINT/SIGTSTP, so Ctrl-C and Ctrl-Z are forwarded by hand.
// Returns a restore function; no-op when stdin or stdout isn't a TTY.
export function muteKeys(): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) return () => {};
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (chunk: Buffer): void => {
    if (chunk.includes(0x03)) process.kill(process.pid, 'SIGINT'); // Ctrl-C
    if (chunk.includes(0x1a)) process.kill(process.pid, 'SIGTSTP'); // Ctrl-Z
  };
  stdin.on('data', onData);
  // The muted stdin must never keep the process alive on its own.
  stdin.unref();
  return () => {
    stdin.off('data', onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
}

// Size must be stable this long before the live block repaints after a resize.
const RESIZE_QUIET_MS = 250;

/**
 * A repaintable block of lines pinned at the bottom of the terminal, with
 * finalized lines committed into scrollback above it. The shared live-render
 * primitive (the flow follower today; anything with a spinner tomorrow).
 * Callers compose styled lines; LiveRegion owns every cursor code. On a
 * non-TTY stream set() is a no-op and commit() is a plain write, so callers
 * need no TTY branching around it.
 *
 * Geometry contract: each painted line is clipped to cols-1 so no row ever
 * touches the last column (a reflowing terminal joins soft-wrapped rows on
 * resize, breaking row accounting), the block is capped to the viewport
 * height (cursor-up must never clamp against the top of the screen), and
 * clear() re-measures the painted widths against the CURRENT width so a
 * resize between paints still erases the reflowed block.
 *
 * The erase/reflow race during a live drag is not closable from the app side:
 * there is no atomicity between reading the PTY size and the emulator
 * rewrapping already-painted rows, and a mis-erased frame strands copies in
 * scrollback where no escape sequence can reach them. So on the first
 * `resize` event the block is erased once. Geometry is at most one reflow
 * stale for the best odds of a clean erase. Painting is suspended until the
 * size has been stable for `quietMs`. A blank block has nothing to garble.
 */
export class LiveRegion {
  private lines: string[] = [];
  private painted: string[] = [];
  private paintedWidths: number[] = [];
  private paintedCols: number | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private readonly tty: boolean;

  constructor(
    private readonly stream: LiveStream = process.stdout,
    private readonly quietMs = RESIZE_QUIET_MS,
  ) {
    this.tty = Boolean(stream.isTTY);
    if (this.tty) stream.on('resize', this.onResize);
  }

  /** Replace the live block. Remembered but not painted during a resize storm. */
  set(lines: string[]): void {
    this.lines = lines;
    if (!this.tty || this.resizeTimer) return;
    this.paint();
  }

  /** Erase the block and write permanent text above it (caller repaints via set). */
  commit(text: string): void {
    this.clear();
    this.stream.write(text);
  }

  /** Erase the live block (idempotent; no-op when nothing is painted). */
  clear(): void {
    if (!this.painted.length) return;
    const cols = termCols(this.stream);
    let rows = this.painted.length;
    if (cols && this.paintedCols && cols !== this.paintedCols) {
      // Resized since the paint: reflowing terminals (Ghostty, iTerm, kitty,
      // VS Code) rewrap each painted line to the new width. Recompute the
      // physical row count from the recorded visible widths.
      rows = this.paintedWidths.reduce((sum, w) => sum + Math.max(1, Math.ceil(w / cols)), 0);
    }
    this.stream.write(`\x1b[${rows}A\x1b[0J`);
    this.painted = [];
    this.paintedWidths = [];
  }

  /** Detach the resize listener, flushing any repaint the storm suppressed. */
  done(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
      this.paint();
    }
    if (this.tty) this.stream.off('resize', this.onResize);
  }

  private paint(): void {
    this.clear();
    const cols = termCols(this.stream);
    let lines = cols ? this.lines.map(l => clipAnsi(l, cols - 1)) : this.lines;
    // Cap to the viewport, keeping the tail (the newest activity): rows pushed
    // past the top of the screen could never be erased again.
    const rows = termRows(this.stream);
    if (rows && lines.length > rows - 1) lines = rows > 1 ? lines.slice(-(rows - 1)) : [];
    for (const line of lines) this.stream.write(`${line}\n`);
    this.painted = lines;
    this.paintedWidths = lines.map(visibleWidth);
    this.paintedCols = cols;
  }

  // First event: erase immediately (see class doc), then hold the block blank
  // until the size has been stable for quietMs and repaint once.
  private readonly onResize = (): void => {
    this.clear();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.paint();
    }, this.quietMs);
    this.resizeTimer.unref?.();
  };
}
