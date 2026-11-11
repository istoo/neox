import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { sniffImageType } from "./vision-fetch.js";

/**
 * Image formats a vendor may refuse, rewritten before the request leaves:
 * an iPhone's HEIC is written as JPEG for every provider (most take only
 * JPEG, PNG, GIF and WebP), and a WebP only after a provider refused one.
 * Images handed to the file-based vision model are also fitted the way
 * Claude Code fits its own: 2000 px a side and 5 MiB of base64 at most.
 */

const MAX_SIDE = 4096;
const MAX_PIXELS = 50_000_000;
const CLAUDE_SIDE = 2000;
const CLAUDE_BASE64 = 5 << 20;
const CACHE_BYTES = 64 << 20;
const CACHE_ENTRIES = 32;
const SIPS_TIMEOUT_MS = 20_000;
const run = promisify(execFile);

export interface ConvertedImage {
  bytes: Buffer;
  mediaType: string;
}

interface CacheEntry extends ConvertedImage {
  key: string;
}

const cache = new Map<string, CacheEntry>();
let cacheBytes = 0;

function cacheKey(bytes: Buffer, mode: string): string {
  return `${mode}:${createHash("sha256").update(bytes).digest("hex")}`;
}

function cacheGet(key: string): ConvertedImage | null {
  const entry = cache.get(key);
  if (entry === undefined) {
    return null;
  }
  cache.delete(key);
  cache.set(key, entry);
  return { bytes: entry.bytes, mediaType: entry.mediaType };
}

function cachePut(key: string, image: ConvertedImage): void {
  if (image.bytes.length > CACHE_BYTES) {
    return;
  }
  const existing = cache.get(key);
  if (existing !== undefined) {
    cacheBytes -= existing.bytes.length;
    cache.delete(key);
  }
  cache.set(key, { ...image, key });
  cacheBytes += image.bytes.length;
  while (cache.size > CACHE_ENTRIES || cacheBytes > CACHE_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done === true) {
      break;
    }
    const dropped = cache.get(oldest.value);
    cache.delete(oldest.value);
    cacheBytes -= dropped?.bytes.length ?? 0;
  }
}

function isHeic(bytes: Buffer): boolean {
  return sniffImageType(bytes) === "image/heic";
}

function isWebp(bytes: Buffer): boolean {
  return sniffImageType(bytes) === "image/webp";
}

interface Encoded {
  bytes: Buffer;
  mediaType: string;
}

async function resizeAndEncode(
  bytes: Buffer,
  side: number,
  preferJpeg: boolean,
): Promise<Encoded | null> {
  try {
    const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "none" }).rotate();
    const metadata = await source.metadata();
    if (metadata.width === undefined || metadata.height === undefined) {
      return null;
    }
    const resized =
      metadata.width > side || metadata.height > side
        ? source.resize({ width: side, height: side, fit: "inside", withoutEnlargement: true })
        : source;
    if (!preferJpeg && metadata.hasAlpha === true) {
      const png = await resized.png().toBuffer();
      return { bytes: png, mediaType: "image/png" };
    }
    const jpeg = await resized.jpeg({ quality: 90 }).toBuffer();
    return { bytes: jpeg, mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * HEIC as PNG through macOS's own decoder. The sharp build shipped with
 * Neolix cannot read HEVC (its libheif carries no such plugin), and adding
 * one would mean another native dependency; `sips` is the decoder the
 * platform already has. Other platforms go without, leaving the image as
 * it came.
 */
async function decodeHeic(bytes: Buffer): Promise<Buffer | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  let dir: string | null = null;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "neolix-heic-"));
    const input = path.join(dir, "image.heic");
    const output = path.join(dir, "image.png");
    await writeFile(input, bytes, { mode: 0o600 });
    await run("/usr/bin/sips", ["-s", "format", "png", input, "--out", output], {
      timeout: SIPS_TIMEOUT_MS,
    });
    const png = await readFile(output);
    return png.length === 0 ? null : png;
  } catch {
    return null;
  } finally {
    if (dir !== null) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * The image in a format vendors take: HEIC always, WebP when asked. Bytes
 * that are neither, or that the platform's decoder cannot read, go as they
 * came.
 */
export async function convertForVendor(
  bytes: Buffer,
  mediaType: string,
  options: { convertWebp: boolean },
): Promise<ConvertedImage> {
  const heic = isHeic(bytes);
  const webp = isWebp(bytes);
  if (!heic && !(webp && options.convertWebp)) {
    return { bytes, mediaType };
  }
  const key = cacheKey(bytes, heic ? "heic" : "webp");
  const cached = cacheGet(key);
  if (cached !== null) {
    return cached;
  }
  let encoded = await resizeAndEncode(bytes, MAX_SIDE, mediaType === "image/jpeg");
  if (encoded === null && heic) {
    const decoded = await decodeHeic(bytes);
    if (decoded !== null) {
      encoded = await resizeAndEncode(decoded, MAX_SIDE, false);
    }
  }
  if (encoded === null) {
    return { bytes, mediaType };
  }
  const converted = { bytes: encoded.bytes, mediaType: encoded.mediaType };
  cachePut(key, converted);
  return converted;
}

async function fitToClaude(bytes: Buffer, mediaType: string): Promise<Encoded | null> {
  const source = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "none" }).rotate();
  const metadata = await source.metadata();
  if (metadata.width === undefined || metadata.height === undefined) {
    return null;
  }
  const withinSide = metadata.width <= CLAUDE_SIDE && metadata.height <= CLAUDE_SIDE;
  const withinBytes = Math.ceil((bytes.length * 4) / 3) <= CLAUDE_BASE64;
  if (withinSide && withinBytes) {
    return { bytes, mediaType };
  }
  const resized = withinSide
    ? source
    : source.resize({
        width: CLAUDE_SIDE,
        height: CLAUDE_SIDE,
        fit: "inside",
        withoutEnlargement: true,
      });
  const fits = (data: Buffer): boolean => Math.ceil((data.length * 4) / 3) <= CLAUDE_BASE64;
  if (mediaType === "image/jpeg") {
    const jpeg = await resized.jpeg({ quality: 85 }).toBuffer();
    if (fits(jpeg)) {
      return { bytes: jpeg, mediaType: "image/jpeg" };
    }
  } else {
    const png = await resized.png().toBuffer();
    if (fits(png)) {
      return { bytes: png, mediaType: "image/png" };
    }
  }
  for (const quality of [75, 60, 40]) {
    const jpeg = await resized.flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer();
    if (fits(jpeg)) {
      return { bytes: jpeg, mediaType: "image/jpeg" };
    }
  }
  return null;
}

/**
 * The image as the description model gets it: HEIC and WebP rewritten, and
 * fitted to 2000 px a side and 5 MiB of base64, as Claude Code fits an
 * image it hands its model.
 */
export async function fitForVision(bytes: Buffer, mediaType: string): Promise<ConvertedImage> {
  const key = cacheKey(bytes, "vision");
  const cached = cacheGet(key);
  if (cached !== null) {
    return cached;
  }
  const converted = await convertForVendor(bytes, mediaType, { convertWebp: true });
  let fitted: Encoded | null = null;
  try {
    fitted = await fitToClaude(converted.bytes, converted.mediaType);
  } catch {
    fitted = null;
  }
  const image = fitted ?? converted;
  cachePut(key, image);
  return image;
}
