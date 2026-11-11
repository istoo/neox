import { createReadStream } from "node:fs";
import { readFile, rename, stat, utimes, writeFile } from "node:fs/promises";
import type { Duplex, Readable } from "node:stream";
import * as zlib from "node:zlib";

// @types/node 20 has no declarations for the zstd half of node:zlib; the
// server runs on a Node that has it. Only what the session reader uses.
const zstd = zlib as unknown as {
  createZstdDecompress(options?: unknown): Duplex;
  zstdCompressSync(buffer: Buffer, options?: unknown): Buffer;
  zstdDecompressSync(buffer: Buffer, options?: unknown): Buffer;
};

const ZSTD = ".zst";

/** Whether a session file is one Codex packed after its last turn. */
export function isPacked(path: string): boolean {
  return path.endsWith(ZSTD);
}

/** The rollout's lines, decompressed when Codex packed it. */
export function createLineStream(filePath: string): Readable {
  const source = createReadStream(filePath);
  if (!isPacked(filePath)) {
    return source.setEncoding("utf8");
  }
  return source.pipe(zstd.createZstdDecompress()).setEncoding("utf8");
}

export async function readSessionText(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  if (!isPacked(filePath)) {
    return bytes.toString("utf8");
  }
  return zstd.zstdDecompressSync(bytes).toString("utf8");
}

/** Writes a session file atomically, packing it again when it was packed. */
export async function writeSessionText(filePath: string, text: string): Promise<void> {
  const temp = `${filePath}.tmp`;
  const info = await stat(filePath).catch(() => null);
  // debt: the whole file is compressed in memory; it is a user-requested move
  // of one rollout, not a listing read.
  const bytes = isPacked(filePath)
    ? zstd.zstdCompressSync(Buffer.from(text, "utf8"))
    : Buffer.from(text, "utf8");
  await writeFile(temp, bytes);
  if (info !== null) {
    await utimes(temp, info.atime, info.mtime).catch(() => {});
  }
  await rename(temp, filePath);
}
