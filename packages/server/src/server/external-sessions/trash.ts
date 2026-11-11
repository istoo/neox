import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExternalSessionTrashed } from "./types.js";

const MANIFEST = "session.json";
const FILES = "files";

interface MovedItem {
  from: string;
  name: string;
}

export interface TrashManifest {
  key: string;
  agent: string;
  id: string;
  title: string;
  cwd: string;
  last: string;
  deleted: string;
  size: number;
  gateway?: boolean;
  items: MovedItem[];
}

export function sessionsTrashDir(neolixHome: string): string {
  return path.join(neolixHome, "trash", "sessions");
}

export function trashKey(agent: string, id: string): string {
  return createHash("sha256").update(`${agent}\u0000${id}`).digest("hex");
}

/** Moves a session's files into Neolix's trash and writes what it can restore. */
export async function moveToTrash(input: {
  neolixHome: string;
  agent: string;
  id: string;
  title: string;
  cwd: string;
  last: string;
  size: number;
  paths: readonly string[];
  gateway?: boolean;
}): Promise<TrashManifest> {
  const key = trashKey(input.agent, input.id);
  const root = path.join(sessionsTrashDir(input.neolixHome), key);
  await mkdir(path.join(root, FILES), { recursive: true });
  const items: MovedItem[] = [];
  try {
    for (const source of input.paths) {
      const name = `${items.length}-${path.basename(source)}`;
      await movePath(source, path.join(root, FILES, name));
      items.push({ from: source, name });
    }
    const manifest: TrashManifest = {
      key,
      agent: input.agent,
      id: input.id,
      title: input.title,
      cwd: input.cwd,
      last: input.last,
      deleted: new Date().toISOString(),
      size: input.size,
      ...(input.gateway === true ? { gateway: true } : {}),
      items,
    };
    await writeFile(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return manifest;
  } catch (error) {
    for (const item of items.toReversed()) {
      await movePath(path.join(root, FILES, item.name), item.from).catch(() => {});
    }
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** The sessions waiting in the trash, newest deletion first. */
export async function listTrash(neolixHome: string): Promise<ExternalSessionTrashed[]> {
  const root = sessionsTrashDir(neolixHome);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out: ExternalSessionTrashed[] = [];
  for (const entry of entries) {
    const manifest = await readManifest(root, entry);
    if (manifest === null) {
      continue;
    }
    out.push({
      key: manifest.key,
      agent: manifest.agent,
      id: manifest.id,
      title: manifest.title,
      cwd: manifest.cwd,
      last: manifest.last,
      deleted: manifest.deleted,
      size: manifest.size,
      ...(manifest.gateway === true ? { gateway: true } : {}),
    });
  }
  out.sort((a, b) => b.deleted.localeCompare(a.deleted));
  return out;
}

export async function readTrashManifest(
  neolixHome: string,
  key: string,
): Promise<TrashManifest | null> {
  return readManifest(sessionsTrashDir(neolixHome), key);
}

/** Puts a trashed session's files back where they were. */
export async function restoreFromTrash(neolixHome: string, key: string): Promise<TrashManifest> {
  assertKey(key);
  const root = path.join(sessionsTrashDir(neolixHome), key);
  const manifest = await readManifest(sessionsTrashDir(neolixHome), key);
  if (manifest === null) {
    throw new Error("That session is not in the trash");
  }
  for (const item of manifest.items) {
    if (await pathExists(item.from)) {
      throw new Error(`${item.from} already exists`);
    }
  }
  for (const item of manifest.items) {
    await mkdir(path.dirname(item.from), { recursive: true });
    await movePath(path.join(root, FILES, item.name), item.from);
  }
  await rm(root, { recursive: true, force: true });
  return manifest;
}

/** Erases a trashed session for good. Only the reader's purge reaches this. */
export async function purgeFromTrash(neolixHome: string, key: string): Promise<void> {
  assertKey(key);
  const root = path.join(sessionsTrashDir(neolixHome), key);
  const manifest = await readManifest(sessionsTrashDir(neolixHome), key);
  if (manifest === null) {
    throw new Error("That session is not in the trash");
  }
  await rm(root, { recursive: true, force: true });
}

async function readManifest(root: string, key: string): Promise<TrashManifest | null> {
  if (!/^[0-9a-f]{64}$/u.test(key)) {
    return null;
  }
  try {
    const text = await readFile(path.join(root, key, MANIFEST), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as TrashManifest;
  } catch {
    return null;
  }
}

function assertKey(key: string): void {
  if (!/^[0-9a-f]{64}$/u.test(key)) {
    throw new Error("Invalid trash key");
  }
}

async function movePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (isCrossDevice(error)) {
      await cp(from, to, { recursive: true });
      await rm(from, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

function isCrossDevice(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EXDEV";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
