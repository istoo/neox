/**
 * Claude Code's screen as a terminal draws it: what it writes is put in the
 * grid's cells where the cursor is. Read as a stream with its escapes taken
 * out, a screen drawn again only where it changed is misread; the grid holds
 * the screen as it is.
 *
 * Ported from myna's claudetui/screen.go.
 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

export class ScreenGrid {
  private readonly cells: string[][];
  private readonly cols: number;
  private readonly rows: number;
  private row = 0;
  private col = 0;
  /** The start of an escape, or a character a read ended in the middle of. */
  private pending = "";

  public constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => blankRow(cols));
  }

  /** Draws a blank screen, as a program clearing it does. */
  public reset(): void {
    for (let row = 0; row < this.rows; row += 1) {
      this.cells[row] = blankRow(this.cols);
    }
    this.row = 0;
    this.col = 0;
    this.pending = "";
  }

  /** The screen, a line a row, each without its trailing spaces. */
  public text(): string {
    return this.cells
      .map((row) =>
        row
          .filter((cell) => cell !== "\0")
          .join("")
          .replace(/ +$/, ""),
      )
      .join("\n");
  }

  public write(chunk: string): void {
    let input = this.pending + chunk;
    this.pending = "";
    let at = 0;
    while (at < input.length) {
      const char = input[at] ?? "";
      if (char === "\u001b") {
        const length = this.escape(input.slice(at));
        if (length === 0) {
          if (input.length - at < 4096) {
            this.pending = input.slice(at);
          }
          return;
        }
        at += length;
        continue;
      }
      if (char === "\r") {
        this.col = 0;
      } else if (char === "\n" || char === "\v" || char === "\f") {
        this.lineFeed();
      } else if (char === "\b") {
        this.col = Math.max(this.col - 1, 0);
      } else if (char === "\t") {
        this.col = Math.min((Math.floor(this.col / 8) + 1) * 8, this.cols - 1);
      } else if (char >= " " && char !== "\u007f") {
        this.put(char);
      }
      at += 1;
    }
    input = "";
  }

  /** Puts back what a read cut in the middle of, at the end of the stream. */
  public flush(): string {
    const held = this.pending;
    this.pending = "";
    return held;
  }

  private clamp(): void {
    this.row = Math.min(Math.max(this.row, 0), this.rows - 1);
    this.col = Math.min(Math.max(this.col, 0), this.cols);
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
      return;
    }
    this.cells.shift();
    this.cells.push(blankRow(this.cols));
  }

  private put(char: string): void {
    const width = WIDE.test(char) ? 2 : 1;
    if (this.col + width > this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    const row = this.cells[this.row];
    if (row === undefined) {
      return;
    }
    row[this.col] = char;
    if (width === 2 && this.col + 1 < this.cols) {
      row[this.col + 1] = "\0";
    }
    this.col += width;
  }

  private erase(row: number, from: number, to: number): void {
    const cells = this.cells[row];
    if (cells === undefined) {
      return;
    }
    for (let at = Math.max(from, 0); at < Math.min(to, this.cols); at += 1) {
      cells[at] = " ";
    }
  }

  /** Acts on the escape at the start of chunk and answers its length, 0 when cut off. */
  private escape(chunk: string): number {
    if (chunk.length < 2) {
      return 0;
    }
    const kind = chunk[1] ?? "";
    if (kind === "[") {
      return this.csiEscape(chunk);
    }
    if (kind === "]" || kind === "P" || kind === "^" || kind === "_") {
      return stringEscapeEnd(chunk, kind);
    }
    if ("( ) * + # %".split(" ").includes(kind)) {
      return chunk.length < 3 ? 0 : 3;
    }
    this.simpleEscape(kind);
    return 2;
  }

  private csiEscape(chunk: string): number {
    let at = 2;
    while (at < chunk.length && (chunk[at] ?? "") >= " " && (chunk[at] ?? "") <= "?") {
      at += 1;
    }
    const params = chunk.slice(2, at);
    while (at < chunk.length && (chunk[at] ?? "") >= " " && (chunk[at] ?? "") <= "/") {
      at += 1;
    }
    if (at >= chunk.length) {
      return 0;
    }
    this.csi(params, chunk[at] ?? "");
    return at + 1;
  }

  private simpleEscape(kind: string): void {
    if (kind === "D") {
      this.lineFeed();
    } else if (kind === "E") {
      this.col = 0;
      this.lineFeed();
    } else if (kind === "M") {
      this.row = Math.max(this.row - 1, 0);
    }
  }

  private csi(params: string, final: string): void {
    if (/^[?><=]/.test(params)) {
      return; // modes and keyboard protocols draw nothing
    }
    const ps = params.split(";").map((part) => Number.parseInt(part, 10) || 0);
    const arg = (index: number, fallback: number): number => {
      const value = ps[index];
      return value !== undefined && value > 0 ? value : fallback;
    };
    if (this.move(final, arg)) {
      this.clamp();
      return;
    }
    this.eraseCsi(final, arg);
    this.clamp();
  }

  /** Moves the cursor for a movement code; false for any other. */
  private move(final: string, arg: (index: number, fallback: number) => number): boolean {
    switch (final) {
      case "A":
        this.row -= arg(0, 1);
        return true;
      case "B":
      case "e":
        this.row += arg(0, 1);
        return true;
      case "C":
      case "a":
        this.col += arg(0, 1);
        return true;
      case "D":
        this.col -= arg(0, 1);
        return true;
      case "E":
        this.row += arg(0, 1);
        this.col = 0;
        return true;
      case "F":
        this.row -= arg(0, 1);
        this.col = 0;
        return true;
      case "G":
      case "`":
        this.col = arg(0, 1) - 1;
        return true;
      case "d":
        this.row = arg(0, 1) - 1;
        return true;
      case "H":
      case "f":
        this.row = arg(0, 1) - 1;
        this.col = arg(1, 1) - 1;
        return true;
      default:
        return false;
    }
  }

  private eraseCsi(final: string, arg: (index: number, fallback: number) => number): void {
    if (final === "K") {
      this.eraseLine(arg(0, 0));
    } else if (final === "J") {
      this.eraseScreen(arg(0, 0));
    } else if (final === "X") {
      this.erase(this.row, this.col, this.col + arg(0, 1));
    }
  }

  private eraseLine(mode: number): void {
    if (this.row < 0 || this.row >= this.rows) {
      return;
    }
    if (mode === 0) {
      this.erase(this.row, this.col, this.cols);
    } else if (mode === 1) {
      this.erase(this.row, 0, this.col + 1);
    } else if (mode === 2) {
      this.erase(this.row, 0, this.cols);
    }
  }

  private eraseScreen(mode: number): void {
    if (mode === 0) {
      this.erase(this.row, this.col, this.cols);
      for (let row = this.row + 1; row < this.rows; row += 1) {
        this.erase(row, 0, this.cols);
      }
      return;
    }
    if (mode === 1) {
      for (let row = 0; row < this.row; row += 1) {
        this.erase(row, 0, this.cols);
      }
      this.erase(this.row, 0, this.col + 1);
      return;
    }
    for (let row = 0; row < this.rows; row += 1) {
      this.erase(row, 0, this.cols);
    }
  }
}

/** The end of a string escape (OSC ended by BEL, others by ST), 0 when cut off. */
function stringEscapeEnd(chunk: string, kind: string): number {
  for (let at = 2; at < chunk.length; at += 1) {
    if (chunk[at] === "\u0007" && kind === "]") {
      return at + 1;
    }
    if (chunk[at] === "\u001b" && at + 1 < chunk.length && chunk[at + 1] === "\\") {
      return at + 2;
    }
  }
  return 0;
}

function blankRow(cols: number): string[] {
  return Array.from({ length: cols }, () => " ");
}
