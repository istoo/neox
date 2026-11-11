import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isValidJson, keepLastGood, type Valid } from "./last-good.js";

interface AtomicFileRuntime {
  platform: NodeJS.Platform;
  rename: (source: string, destination: string) => Promise<void>;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

const runtime: AtomicFileRuntime = {
  platform: process.platform,
  rename: fs.rename,
  now: () => performance.now(),
  sleep,
};

export async function writeFileAtomic(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, "utf8");
    await replaceFile(tempPath, filePath, operations);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function replaceFile(
  source: string,
  destination: string,
  operations: AtomicFileRuntime,
): Promise<void> {
  // Windows readers/scanners can briefly deny replacement. Yield with backoff,
  // but keep interactive persistence failures bounded to a one-second retry budget.
  const deadline = operations.now() + 1000;
  let delay = 10;
  for (;;) {
    try {
      await operations.rename(source, destination);
      return;
    } catch (error) {
      if (
        operations.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EPERM", "EACCES", "EBUSY"].includes(String(error.code))
      ) {
        throw error;
      }
      const remaining = deadline - operations.now();
      if (remaining <= 0) throw error;
      await operations.sleep(Math.min(delay, remaining));
      if (operations.now() >= deadline) throw error;
      delay = Math.min(delay * 2, 100);
    }
  }
}

export async function writeJsonFileAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), operations);
}

/**
 * `writeFileAtomic` for a state file Neolix must not lose: the generation
 * there now is kept as `<file>.bak` first, or copied aside when it is
 * itself unreadable (myna lastgood.Keep). A write whose keep fails is not
 * made, so a file that can't be read is never written over.
 */
export async function writeFileAtomicKeepingLastGood(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
  valid: Valid,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await keepLastGood(filePath, valid);
  await writeFileAtomic(filePath, data, operations);
}

/** `writeJsonFileAtomic` with the last good generation kept as `<file>.bak`. */
export async function writeJsonFileAtomicKeepingLastGood(
  filePath: string,
  value: unknown,
  operations: AtomicFileRuntime = runtime,
): Promise<void> {
  await writeFileAtomicKeepingLastGood(
    filePath,
    JSON.stringify(value, null, 2),
    isValidJson,
    operations,
  );
}
