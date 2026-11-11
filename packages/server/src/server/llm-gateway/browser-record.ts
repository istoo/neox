import sharp from "sharp";

/**
 * A browser recording, ported from myna: between record_start and record_stop
 * the gateway keeps a picture of the window after each action that can change
 * the page, the action written under it, and makes them one GIF when the
 * recording stops. The gateway does it all, so any extension version records.
 */

/** A frame's width: a window, readable, at a size a few hundred frames keep small. */
export const RECORD_WIDTH = 800;
/** The most frames one recording keeps. */
export const RECORD_MOST = 300;
/** How long a recording nobody stops is kept. */
export const RECORD_IDLE_MS = 30 * 60 * 1000;

const RECORD_LABEL = 22;
const RECORD_QUALITY = 80;

export interface BrowserRecording {
  frames: Buffer[];
  /** RECORD_MOST frames were taken; later ones weren't. */
  full: boolean;
  started: number;
}

interface LiveRecording extends BrowserRecording {
  last: number;
}

export class BrowserRecordings {
  private readonly live = new Map<string, LiveRecording>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Begins a session's recording, over one it had, and drops idle ones. */
  public start(session: string): void {
    const now = this.now();
    for (const [key, recording] of this.live) {
      if (now - recording.last > RECORD_IDLE_MS) {
        this.live.delete(key);
      }
    }
    this.live.set(session, { frames: [], full: false, started: now, last: now });
  }

  public on(session: string): boolean {
    return this.live.has(session);
  }

  public count(session: string): number {
    return this.live.get(session)?.frames.length ?? 0;
  }

  /** Keeps a frame for a session's recording, if it has one. */
  public add(session: string, frame: Buffer): void {
    const recording = this.live.get(session);
    if (recording === undefined) {
      return;
    }
    recording.last = this.now();
    if (recording.frames.length >= RECORD_MOST) {
      recording.full = true;
      return;
    }
    recording.frames.push(frame);
  }

  /** Ends a session's recording and is it, undefined when there was none. */
  public stop(session: string): BrowserRecording | undefined {
    const recording = this.live.get(session);
    if (recording === undefined) {
      return undefined;
    }
    this.live.delete(session);
    return { frames: recording.frames, full: recording.full, started: recording.started };
  }
}

/**
 * What a frame says was done: the action and what it was done to, never what
 * was typed (a password, a message).
 */
export function recordSay(frames: number, action: string, args: Record<string, unknown>): string {
  let said = `${frames}  ${action}`;
  for (const key of ["url", "ref", "key", "direction", "from"]) {
    const value = args[key];
    if (typeof value !== "string" || value === "") {
      continue;
    }
    said += `  ${value.length > 80 ? `${value.slice(0, 77)}...` : value}`;
    if (key === "from" && typeof args.to === "string") {
      said += ` -> ${args.to}`;
    }
    break;
  }
  return said;
}

/**
 * The picture data (base64) as a frame: RECORD_WIDTH wide, with the label in
 * a strip under it, as a JPEG.
 */
export async function recordFrame(data: string, label: string): Promise<Buffer> {
  const source = Buffer.from(data, "base64");
  const meta = source.length === 0 ? undefined : await sharp(source).metadata();
  const width = meta?.width ?? 0;
  const height = meta?.height ?? 0;
  if (width === 0 || height === 0) {
    throw new Error("an empty picture");
  }
  const scaled = Math.max(1, Math.floor((height * RECORD_WIDTH) / width));
  const { data: pixels, info } = await sharp(source)
    .resize({ width: RECORD_WIDTH, height: scaled, fit: "fill" })
    .extend({ bottom: RECORD_LABEL, background: { r: 0x22, g: 0x22, b: 0x22 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  drawLabel(pixels, info.width, info.height, scaled, label);
  return sharp(pixels, { raw: { width: info.width, height: info.height, channels: 4 } })
    .jpeg({ quality: RECORD_QUALITY })
    .toBuffer();
}

/** Draws the label in white, in myna's 7×13 face, under the picture. */
function drawLabel(
  pixels: Buffer,
  width: number,
  height: number,
  scaled: number,
  label: string,
): void {
  const top = scaled + RECORD_LABEL - 6 - FACE_ASCENT;
  let left = 8;
  for (const character of label) {
    drawGlyph(pixels, width, height, left, top, character);
    left += FACE_WIDTH;
  }
}

function drawGlyph(
  pixels: Buffer,
  width: number,
  height: number,
  left: number,
  top: number,
  character: string,
): void {
  const glyph = glyphOf(character.codePointAt(0) ?? 0);
  if (glyph === undefined) {
    return;
  }
  for (let row = 0; row < FACE_HEIGHT; row += 1) {
    drawGlyphRow(pixels, width, height, left, top + row, glyph[row] ?? 0);
  }
}

function drawGlyphRow(
  pixels: Buffer,
  width: number,
  height: number,
  left: number,
  y: number,
  bits: number,
): void {
  if (bits === 0 || y < 0 || y >= height) {
    return;
  }
  for (let column = 0; column < FACE_WIDTH; column += 1) {
    if ((bits & (1 << (FACE_WIDTH - 1 - column))) === 0) {
      continue;
    }
    const x = left + column;
    if (x >= width) {
      continue;
    }
    const at = (y * width + x) * 4;
    pixels[at] = 0xff;
    pixels[at + 1] = 0xff;
    pixels[at + 2] = 0xff;
    pixels[at + 3] = 0xff;
  }
}

/**
 * Frames as an animated GIF: a second a frame, the last held three. Each frame
 * after the first holds only the rectangle that changed. The palette and the
 * encoding are myna's, so a recording looks the same as one myna made.
 */
export async function encodeRecordingGif(frames: Buffer[]): Promise<Buffer> {
  if (frames.length === 0) {
    throw new Error("the recording has no frames");
  }
  const first = await frameOf(frames[0]!);
  const out = new ByteWriter();
  out.text("GIF89a");
  out.u16(first.width);
  out.u16(first.height);
  out.byte(0xf7); // A global colour table of 256 entries.
  out.byte(0x00); // Background colour index.
  out.byte(0x00); // Pixel aspect ratio.
  out.writeBytes(PLAN9);
  if (frames.length > 1) {
    out.byte(0x21);
    out.byte(0xff);
    out.byte(0x0b);
    out.text("NETSCAPE2.0");
    out.byte(0x03);
    out.byte(0x01);
    out.u16(0); // Loop forever.
    out.byte(0x00);
  }
  let previous: Frame | undefined = first;
  for (let i = 0; i < frames.length; i += 1) {
    const frame = i === 0 ? first : await frameOf(frames[i]!, first);
    const rect = previous === undefined || i === 0 ? fullRect(frame) : changedRect(previous, frame);
    // The frame is the rectangle that changed; a still frame is one pixel.
    out.byte(0x21);
    out.byte(0xf9);
    out.byte(0x04);
    out.byte(0x00); // No transparency, disposal none.
    out.u16(i === frames.length - 1 ? 300 : 100);
    out.byte(0x00);
    out.byte(0x00);
    out.byte(0x2c);
    out.u16(rect.x);
    out.u16(rect.y);
    out.u16(rect.width);
    out.u16(rect.height);
    out.byte(0x00); // No local colour table.
    writeImage(out, rectOf(frame, rect));
    previous = frame;
  }
  out.byte(0x3b);
  return out.finish();
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Frame {
  width: number;
  height: number;
  /** One PLAN9 index a pixel. */
  indices: Uint8Array;
}

async function frameOf(frame: Buffer, target?: Frame): Promise<Frame> {
  let image = sharp(frame);
  if (target !== undefined) {
    image = image.resize({ width: target.width, height: target.height, fit: "fill" });
  }
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, indices: quantize(data) };
}

function fullRect(frame: Frame): Rect {
  return { x: 0, y: 0, width: frame.width, height: frame.height };
}

/** The smallest rectangle in which a and b, of one size, differ. */
function changedRect(a: Frame, b: Frame): Rect {
  let x0 = b.width;
  let y0 = b.height;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < b.height; y += 1) {
    const row = y * b.width;
    let left = -1;
    let right = -1;
    for (let x = 0; x < b.width; x += 1) {
      if (a.indices[row + x] !== b.indices[row + x]) {
        left = x;
        break;
      }
    }
    if (left < 0) {
      continue;
    }
    for (let x = b.width - 1; x >= left; x -= 1) {
      if (a.indices[row + x] !== b.indices[row + x]) {
        right = x;
        break;
      }
    }
    y0 = Math.min(y0, y);
    y1 = y + 1;
    x0 = Math.min(x0, left);
    x1 = Math.max(x1, right + 1);
  }
  if (x0 >= x1 || y0 >= y1) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function rectOf(frame: Frame, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const from = (rect.y + y) * frame.width + rect.x;
    out.set(frame.indices.subarray(from, from + rect.width), y * rect.width);
  }
  return out;
}

/**
 * myna's palette: colour.Plan9, which partitions the 24-bit RGB space into a
 * 4×4×4 subdivision with 4 shades in each subcube.
 */
const PLAN9 = plan9Palette();

/**
 * colour.Plan9 as Go generates it: a 4×4×4 subdivision of the colour cube
 * with 4 shades in each subcube.
 */
function plan9Palette(): Buffer {
  const entries = new Uint8Array(768);
  let index = 0;
  for (let r = 0; r < 4; r += 1) {
    for (let v = 0; v < 4; v += 1, index += 16) {
      let offset = v - r;
      for (let g = 0; g < 4; g += 1) {
        for (let b = 0; b < 4; b += 1, offset += 1) {
          const colour = plan9Colour(r, g, b, v);
          const at = (index + (offset & 0x0f)) * 3;
          entries[at] = colour[0]!;
          entries[at + 1] = colour[1]!;
          entries[at + 2] = colour[2]!;
        }
      }
    }
  }
  return Buffer.from(entries);
}

function plan9Colour(r: number, g: number, b: number, v: number): number[] {
  const denominator = Math.max(r, g, b);
  if (denominator === 0) {
    const grey = 0x11 * v;
    return [grey, grey, grey];
  }
  const numerator = 17 * (4 * denominator + v);
  return [
    Math.trunc((r * numerator) / denominator),
    Math.trunc((g * numerator) / denominator),
    Math.trunc((b * numerator) / denominator),
  ];
}

const NEAREST = new Int16Array(1 << 15);
const FACE_WIDTH = 7;
const FACE_HEIGHT = 13;
const FACE_ASCENT = 11;

/** Face7x13's rows, ASCII 32–126, 13 rows of 7 bits each. */
const FACE = `00000000000000000000000000
00000808080808080800080000
00001414140000000000000000
00000014143e143e1414000000
000000081e281c0a3c08000000
0000225224080810244a440000
00000000304848304a443a0000
00000808080000000000000000
00000408081010100808040000
00001008080404040808100000
0000000024187e182400000000
0000000008083e080800000000
0000000000000000001c182000
0000000000003e000000000000
000000000000000000081c0800
00000202040408101020200000
00001824424242424224180000
000008182808080808083e0000
00003c424202041820407e0000
00007e0204081c0202423c0000
0000040c142444447e04040000
00007e40405c620202423c0000
00001c2040405c6242423c0000
00007e02040808101020200000
00003c4242423c4242423c0000
00003c4242463a020204380000
00000000081c080000081c0800
00000000081c0800001c182000
00000204081020100804020000
00000000007e00007e00000000
00002010080402040810200000
00003c42420204080800080000
00003c42424e52564a403c0000
000018244242427e4242420000
00007c2222223c2222227c0000
00003c424040404040423c0000
00007c222222222222227c0000
00007e404040784040407e0000
00007e40404078404040400000
00003c424040404e42463a0000
0000424242427e424242420000
00003e080808080808083e0000
00000e04040404040444380000
00004244485060504844420000
000040404040404040407e0000
00004266665a5a424242420000
0000424262524a464242420000
00003c424242424242423c0000
00007c4242427c404040400000
00003c4242424242524a3c0200
00007c4242427c504844420000
00003c4240403c0202423c0000
00003e08080808080808080000
000042424242424242423c0000
00004242422424241818180000
0000424242425a5a6666420000
00004242242418242442420000
00002222141408080808080000
00007e020408181020407e0000
003c2020202020202020203c00
00002020101008040402020000
003c0404040404040404043c00
00000814220000000000000000
00000000000000000000007e00
00100800000000000000000000
00000000003c023e42463a0000
00004040405c624242625c0000
00000000003c424040423c0000
00000202023a464242463a0000
00000000003c427e40423c0000
00001c22202078202020200000
00000000003a444438403c423c
00004040405c62424242420000
000000080018080808083e0000
0000000200060202020222221c
00004040404448704844420000
000018080808080808083e0000
0000000000342a2a2a2a220000
00000000005c62424242420000
00000000003c424242423c0000
00000000005c6242625c404040
00000000003a4642463a020202
00000000005c22202020200000
00000000003c42300c423c0000
000000202078202020221c0000
000000000042424242463a0000
00000000002222221414080000
000000000022222a2a2a140000
00000000004224181824420000
0000000000424242463a02423c
00000000007e040810207e0000
000e1010100830081010100e00
00000808080808080808080000
00380404040806080404043800
0000122a240000000000000000`;

const FACE_ROWS = FACE.split("\n");

function glyphOf(code: number): readonly number[] | undefined {
  if (code < 32 || code > 126) {
    return undefined;
  }
  const line = FACE_ROWS[code - 32];
  if (line === undefined) {
    return undefined;
  }
  const rows: number[] = [];
  for (let row = 0; row < FACE_HEIGHT; row += 1) {
    rows.push(Number.parseInt(line.slice(row * 2, row * 2 + 2), 16));
  }
  return rows;
}

/**
 * One PLAN9 index a pixel, with myna's cache: colours are looked up by their
 * top five bits, which is all the palette distinguishes.
 */
function quantize(pixels: Buffer): Uint8Array {
  const indices = new Uint8Array(pixels.length / 4);
  NEAREST.fill(-1);
  for (let at = 0, i = 0; at < pixels.length; at += 4, i += 1) {
    const r = pixels[at]!;
    const g = pixels[at + 1]!;
    const b = pixels[at + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let index = NEAREST[key]!;
    if (index < 0) {
      index = nearest((r & 0xf8) | 4, (g & 0xf8) | 4, (b & 0xf8) | 4);
      NEAREST[key] = index;
    }
    indices[i] = index;
  }
  return indices;
}

/** The palette entry nearest a colour, as color.Palette.Index finds it. */
function nearest(r: number, g: number, b: number): number {
  let best = 0;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < PLAN9.length / 3; i += 1) {
    const dr = PLAN9[i * 3]! - r;
    const dg = PLAN9[i * 3 + 1]! - g;
    const db = PLAN9[i * 3 + 2]! - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

/** Writes an image's indices: its LZW minimum code size and data sub-blocks. */
function writeImage(out: ByteWriter, indices: Uint8Array): void {
  out.byte(8);
  const data = lzw(indices, 8);
  for (let at = 0; at < data.length; at += 255) {
    const size = Math.min(255, data.length - at);
    out.byte(size);
    out.writeBytes(data.subarray(at, at + size));
  }
  out.byte(0x00);
}

/** The GIF variant of LZW, as Go's compress/lzw writes it for a 256-colour image. */
function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const out = new ByteWriter();
  const dictionary = new Int32Array(4096 * 256);
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let bits = 0;
  let accumulator = 0;
  const emit = (code: number): void => {
    accumulator |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.byte(accumulator & 0xff);
      accumulator >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  if (indices.length === 0) {
    emit(end);
    if (bits > 0) {
      out.byte(accumulator & 0xff);
    }
    return out.finish();
  }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i += 1) {
    const index = indices[i]!;
    const key = (prefix << 8) | index;
    const found = dictionary[key]!;
    if (found !== 0) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next < 4095) {
      dictionary[key] = next;
      next += 1;
      if (next > 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
    } else {
      emit(clear);
      dictionary.fill(0);
      next = end + 1;
      codeSize = minCodeSize + 1;
    }
    prefix = index;
  }
  emit(prefix);
  emit(end);
  if (bits > 0) {
    out.byte(accumulator & 0xff);
  }
  return out.finish();
}

class ByteWriter {
  private data = new Uint8Array(1 << 16);
  private length = 0;

  public byte(value: number): void {
    this.ensure(1);
    this.data[this.length] = value;
    this.length += 1;
  }

  public u16(value: number): void {
    this.byte(value & 0xff);
    this.byte((value >>> 8) & 0xff);
  }

  public text(value: string): void {
    this.writeBytes(Buffer.from(value, "latin1"));
  }

  public writeBytes(values: Uint8Array): void {
    this.ensure(values.length);
    this.data.set(values, this.length);
    this.length += values.length;
  }

  public finish(): Buffer {
    return Buffer.from(this.data.subarray(0, this.length));
  }

  private ensure(count: number): void {
    if (this.length + count <= this.data.length) {
      return;
    }
    let size = this.data.length * 2;
    while (size < this.length + count) {
      size *= 2;
    }
    const next = new Uint8Array(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}
