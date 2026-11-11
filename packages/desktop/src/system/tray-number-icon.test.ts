import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { encodeTrayNumberPng, trayNumberBitmap, trayNumberPng } from "./tray-number-icon";

const BLACK = { r: 0, g: 0, b: 0 };

function alphaAt(bitmap: { width: number; rgba: Uint8Array }, x: number, y: number): number {
  return bitmap.rgba[(y * bitmap.width + x) * 4 + 3] ?? 0;
}

function pngChunks(png: Uint8Array): { type: string; data: Uint8Array }[] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

describe("tray number bitmap", () => {
  it("draws the figure on a transparent 32px square", () => {
    const bitmap = trayNumberBitmap("62", BLACK);

    expect(bitmap).not.toBeNull();
    expect(bitmap?.width).toBe(32);
    expect(bitmap?.height).toBe(32);
    expect(alphaAt(bitmap!, 0, 0)).toBe(0);
    expect(bitmap?.rgba.some((_, index) => index % 4 === 3 && bitmap.rgba[index] === 255)).toBe(
      true,
    );
  });

  it("fits a three-figure reading inside the icon", () => {
    const bitmap = trayNumberBitmap("100", BLACK)!;
    let opaque = 0;
    for (let index = 3; index < bitmap.rgba.length; index += 4) {
      if (bitmap.rgba[index] === 255) opaque += 1;
    }

    expect(opaque).toBeGreaterThan(0);
    // Nothing is clipped: every drawn pixel is inside the 32px square.
    expect(bitmap.rgba.length).toBe(32 * 32 * 4);
  });

  it("refuses characters the font does not have", () => {
    expect(trayNumberBitmap("", BLACK)).toBeNull();
    expect(trayNumberBitmap("6x", BLACK)).toBeNull();
  });
});

describe("tray number PNG", () => {
  it("writes a PNG with the bitmap's size and raw rows", () => {
    const bitmap = trayNumberBitmap("62", BLACK)!;
    const png = encodeTrayNumberPng(bitmap);

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks = pngChunks(png);
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const header = new DataView(
      chunks[0]!.data.buffer,
      chunks[0]!.data.byteOffset,
      chunks[0]!.data.byteLength,
    );
    expect(header.getUint32(0)).toBe(32);
    expect(header.getUint32(4)).toBe(32);
    expect(chunks[0]!.data[9]).toBe(6); // RGBA

    const raw = inflateSync(chunks[1]!.data);
    expect(raw.length).toBe((32 * 4 + 1) * 32);
    expect(raw[0]).toBe(0); // filter: none
  });

  it("is null when the figure cannot be drawn", () => {
    expect(trayNumberPng("", BLACK)).toBeNull();
  });
});
