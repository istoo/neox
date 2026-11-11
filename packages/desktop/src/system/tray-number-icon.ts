/**
 * Windows' tray icon when "Tray icon number" is on: the first allowance's
 * figure drawn as a bitmap (myna's traynumber.go). The main process has no
 * canvas, so the digits are a built-in 5x7 font rasterized to RGBA and
 * written as a PNG; nativeImage.createFromBuffer then makes the icon. This is
 * pure on purpose: the tests read the bitmap and the PNG header directly.
 */

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_GAP = 1;
const ICON_SIZE = 32;
const ICON_PADDING = 2;

const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "%": ["11000", "11001", "00010", "00100", "01000", "10011", "00011"],
};

export interface TrayNumberBitmap {
  width: number;
  height: number;
  /** RGBA, row-major, transparent where there is no glyph pixel. */
  rgba: Uint8Array;
}

export interface TrayNumberColor {
  r: number;
  g: number;
  b: number;
}

/** One font pixel, magnified to the chosen scale. */
function paintBlock(
  rgba: Uint8Array,
  x0: number,
  y0: number,
  scale: number,
  color: TrayNumberColor,
): void {
  for (let dy = 0; dy < scale; dy += 1) {
    for (let dx = 0; dx < scale; dx += 1) {
      const index = ((y0 + dy) * ICON_SIZE + (x0 + dx)) * 4;
      rgba[index] = color.r;
      rgba[index + 1] = color.g;
      rgba[index + 2] = color.b;
      rgba[index + 3] = 255;
    }
  }
}

/** The figure as a 32px RGBA bitmap; null when it holds no digit we have. */
export function trayNumberBitmap(figure: string, color: TrayNumberColor): TrayNumberBitmap | null {
  const glyphs = [...figure].map((character) => GLYPHS[character]);
  if (glyphs.length === 0 || glyphs.some((glyph) => glyph === undefined)) {
    return null;
  }
  const width = glyphs.length * GLYPH_WIDTH + (glyphs.length - 1) * GLYPH_GAP;
  const scale = Math.max(
    1,
    Math.min(
      Math.floor((ICON_SIZE - ICON_PADDING * 2) / width),
      Math.floor((ICON_SIZE - ICON_PADDING * 2) / GLYPH_HEIGHT),
    ),
  );
  const drawnWidth = width * scale;
  const drawnHeight = GLYPH_HEIGHT * scale;
  const offsetX = Math.floor((ICON_SIZE - drawnWidth) / 2);
  const offsetY = Math.floor((ICON_SIZE - drawnHeight) / 2);

  const rgba = new Uint8Array(ICON_SIZE * ICON_SIZE * 4);
  for (const [glyphIndex, glyph] of glyphs.entries()) {
    const glyphOffsetX = offsetX + glyphIndex * (GLYPH_WIDTH + GLYPH_GAP) * scale;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      for (let column = 0; column < GLYPH_WIDTH; column += 1) {
        if (glyph?.[row]?.[column] !== "1") continue;
        paintBlock(rgba, glyphOffsetX + column * scale, offsetY + row * scale, scale, color);
      }
    }
  }
  return { width: ICON_SIZE, height: ICON_SIZE, rgba };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    out[4 + index] = type.charCodeAt(index);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * The bitmap as a PNG. Deflate "stored" blocks keep this dependency-free;
 * a 32px icon is a few kilobytes and is made only when the figure changes.
 */
export function encodeTrayNumberPng(bitmap: TrayNumberBitmap): Uint8Array {
  const stride = bitmap.width * 4;
  const raw = new Uint8Array((stride + 1) * bitmap.height);
  for (let row = 0; row < bitmap.height; row += 1) {
    raw[row * (stride + 1)] = 0; // filter: none
    raw.set(bitmap.rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, bitmap.width);
  headerView.setUint32(4, bitmap.height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  const blocks: number[] = [0x78, 0x01];
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const length = Math.min(65535, raw.length - offset);
    const final = offset + length >= raw.length ? 1 : 0;
    blocks.push(final, length & 0xff, (length >>> 8) & 0xff);
    const inverse = ~length & 0xffff;
    blocks.push(inverse & 0xff, (inverse >>> 8) & 0xff);
    blocks.push(...raw.subarray(offset, offset + length));
  }
  const adler = adler32(raw);
  blocks.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);

  const parts = [
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", Uint8Array.from(blocks)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The figure as PNG bytes, for nativeImage.createFromBuffer. */
export function trayNumberPng(figure: string, color: TrayNumberColor): Uint8Array | null {
  const bitmap = trayNumberBitmap(figure, color);
  return bitmap === null ? null : encodeTrayNumberPng(bitmap);
}
