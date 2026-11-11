import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

/** The repository revision AstrLink Guard's files were hashed at (v0.1.3). */
export const GUARD_REVISION = "7216b6a3b897ef903d4b1ba367ae6fb95b0fa5e4";
/** The revision's folder: its first twelve characters. */
export const GUARD_REVISION_DIR = GUARD_REVISION.slice(0, 12);

const BASE_URL = `https://huggingface.co/QuantumNous/astrlink-guard/resolve/${GUARD_REVISION}/`;

export interface GuardFile {
  /** Its path in the repository; saved under its base name. */
  path: string;
  size: number;
  sha256: string;
}

/** The model's files, as myna pins them (internal/pii/astrlink.go). */
export const GUARD_FILES: readonly GuardFile[] = [
  {
    path: "int8/model_int8.onnx",
    size: 330_781,
    sha256: "0a070d3113615e33ba3b84d6bd486f663a377c04c4b056e7381732179f51832a",
  },
  {
    path: "int8/model_int8.onnx_data",
    size: 37_124_608,
    sha256: "0ba34216ceead01e0ae2dfd8e46d52b67e7aee80b04f722d9b758613a91c0067",
  },
  {
    path: "int8/tokenizer.json",
    size: 1_502_881,
    sha256: "0cf3b235ef125658015a6c8026a5fe6f28088bf825101a990ec18a10200feef4",
  },
];

export const GUARD_TOTAL_SIZE = GUARD_FILES.reduce((total, file) => total + file.size, 0);

/** Where a revision's files live: `$NEOLIX_HOME/cache/astrlink-guard/<rev12>`. */
export function guardDirectory(neolixHome: string): string {
  return path.join(neolixHome, "cache", "astrlink-guard", GUARD_REVISION_DIR);
}

/** The folder all revisions live under, which remove deletes. */
export function guardRoot(neolixHome: string): string {
  return path.join(neolixHome, "cache", "astrlink-guard");
}

function fileName(file: GuardFile): string {
  return path.basename(file.path);
}

async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}

/** Whether every file is on disk at its pinned size. */
export async function guardInstalled(neolixHome: string): Promise<boolean> {
  const dir = guardDirectory(neolixHome);
  for (const file of GUARD_FILES) {
    if ((await sizeOf(path.join(dir, fileName(file)))) !== file.size) {
      return false;
    }
  }
  return true;
}

export interface GuardDownloadOptions {
  neolixHome: string;
  signal: AbortSignal;
  onProgress: (done: number) => void;
}

/**
 * Fetches the files not on disk yet, each checked against its size and
 * sha256. A file is written beside its target and renamed over it, so a
 * half download is never read as the model.
 */
export async function downloadGuard(options: GuardDownloadOptions): Promise<void> {
  const dir = guardDirectory(options.neolixHome);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  let base = 0;
  for (const file of GUARD_FILES) {
    const target = path.join(dir, fileName(file));
    if ((await sizeOf(target)) !== file.size) {
      await fetchFile({ ...options, file, target, base });
    }
    base += file.size;
    options.onProgress(base);
  }
}

interface FetchFileOptions extends GuardDownloadOptions {
  file: GuardFile;
  target: string;
  base: number;
}

async function fetchFile(options: FetchFileOptions): Promise<void> {
  const { file, target, signal } = options;
  const url = BASE_URL + file.path;
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`${fileName(file)}: HTTP ${response.status}`);
  }
  const temporary = `${target}.tmp-${process.pid}`;
  const handle = await open(temporary, "w", 0o644);
  const hash = createHash("sha256");
  let written = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      if (signal.aborted) {
        throw new Error("Download cancelled");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      hash.update(value);
      await handle.write(value);
      written += value.byteLength;
      options.onProgress(options.base + Math.min(written, file.size));
    }
    await handle.close();
    if (written !== file.size) {
      throw new Error(`${fileName(file)}: ${written} bytes, not ${file.size}`);
    }
    const digest = hash.digest("hex");
    if (digest !== file.sha256) {
      throw new Error(`${fileName(file)}: sha256 ${digest}, not ${file.sha256}`);
    }
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
