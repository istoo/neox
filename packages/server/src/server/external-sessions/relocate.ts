import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { claudeProjectDir } from "../agent/providers/claude/project-dir.js";
import { readSessionText, writeSessionText } from "./compressed.js";
import { setCodexThreadProvider } from "./sqlite.js";

export interface CodexMoveResult {
  id: string;
  from: string;
  to: string;
  backup: string;
}

export interface RelocatePreview {
  from: string;
  to: string;
  sessions: number;
  bytes: number;
}

const PROVIDER_RE = /^[0-9A-Za-z_.-]{1,64}$/u;
const ACTIVE_WINDOW_MS = 60_000;

/**
 * Rewrites one Codex rollout's `model_provider`, and its row in Codex's state
 * database, keeping a copy of the files first. A session written to in the
 * last minute is left alone: Codex may still be running it.
 */
export async function moveCodexProvider(input: {
  neolixHome: string;
  codexHome: string;
  id: string;
  paths: readonly string[];
  to: string;
  now?: number;
  sqliteHome?: string;
}): Promise<CodexMoveResult> {
  if (!PROVIDER_RE.test(input.to)) {
    throw new Error(`"${input.to}" isn't a provider id`);
  }
  const paths: string[] = [];
  for (const file of input.paths) {
    const info = await stat(file).catch(() => null);
    if (info !== null && info.isFile()) {
      paths.push(file);
    }
  }
  if (paths.length === 0) {
    throw new Error("no such session");
  }
  const now = input.now ?? Date.now();
  for (const file of paths) {
    const info = await stat(file);
    if (now - info.mtimeMs < ACTIVE_WINDOW_MS) {
      throw new ActiveExternalSessionError();
    }
  }
  const originals = await Promise.all(paths.map((file) => readSessionText(file)));
  let from = "";
  const rewritten = originals.map((text) => {
    const result = rewriteCodexProvider(text, input.to);
    from = from.length > 0 ? from : result.from;
    return result.text;
  });
  const backup = await backupFiles(input.neolixHome, "codex-provider", input.id, paths);
  const written: string[] = [];
  try {
    for (const [index, file] of paths.entries()) {
      await writeSessionText(file, rewritten[index] ?? "");
      written.push(file);
    }
  } catch (error) {
    // The files changed so far go back as they were.
    for (const file of written) {
      const index = paths.indexOf(file);
      await writeSessionText(file, originals[index] ?? "").catch(() => {});
    }
    throw error;
  }
  for (const db of await codexStateDBs(input.codexHome, input.sqliteHome)) {
    await setCodexThreadProvider(db, input.id, input.to);
  }
  return { id: input.id, from, to: input.to, backup };
}

export class ActiveExternalSessionError extends Error {
  constructor() {
    super("The session was written to in the last minute; it may still be running");
    this.name = "ActiveExternalSessionError";
  }
}

interface CodexRewrite {
  text: string;
  from: string;
}

/** Sets the provider of every session_meta line, keeping each line's length. */
function rewriteCodexProvider(text: string, provider: string): CodexRewrite {
  let from = "";
  const lines = text.split("\n").map((line) => {
    if (!line.includes('"session_meta"')) {
      return line;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return line;
    }
    if (!isRecord(event) || event.type !== "session_meta" || !isRecord(event.payload)) {
      return line;
    }
    const current = event.payload.model_provider;
    if (typeof current !== "string") {
      return line;
    }
    from = from.length > 0 ? from : current;
    if (current === provider) {
      return line;
    }
    const next = JSON.stringify({
      ...event,
      payload: { ...event.payload, model_provider: provider },
    });
    // Codex keeps places in a paginated rollout by byte: its session_meta
    // line must not grow.
    const paged = event.payload.history_mode === "paginated";
    if (next.length > line.trimEnd().length) {
      if (paged) {
        throw new Error(
          "this session keeps its history by byte, and the new provider id is longer than the old one",
        );
      }
      return next;
    }
    return next.padEnd(line.length, " ");
  });
  return { text: lines.join("\n"), from };
}

async function codexStateDBs(home: string, sqliteHome?: string): Promise<string[]> {
  const configured = sqliteHome?.trim() ?? "";
  let dir = process.env.CODEX_SQLITE_HOME?.trim() || home;
  if (configured.length > 0) {
    dir = path.isAbsolute(configured) ? configured : path.join(home, configured);
  }
  const entries = await readdir(dir).catch(() => []);
  return entries
    .filter((name) => name.startsWith("state_") && name.endsWith(".sqlite"))
    .map((name) => path.join(dir, name));
}

async function backupFiles(
  neolixHome: string,
  kind: string,
  id: string,
  files: readonly string[],
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const dir = path.join(neolixHome, "trash", kind, `${stamp}-${id}`);
  await mkdir(path.join(dir, "files"), { recursive: true });
  const items: Array<{ from: string; name: string }> = [];
  for (const [index, file] of files.entries()) {
    const name = `${index}-${path.basename(file)}`;
    await copyFile(file, path.join(dir, "files", name));
    items.push({ from: file, name });
  }
  await writeFile(
    path.join(dir, "move.json"),
    `${JSON.stringify({ id, at: new Date().toISOString(), items }, null, 2)}\n`,
    "utf8",
  );
  return dir;
}

export interface ClaudeRelocation {
  from: string;
  to: string;
  sessions: number;
  bytes: number;
  token: string;
}

interface RelocationFile {
  rel: string;
  modMs: number;
  mode: number;
}

interface RelocationPlan {
  source: string;
  dest: string;
  preview: RelocatePreview;
  token: string;
  files: RelocationFile[];
}

const INDEX_FILE = "sessions-index.json";
const PROJECT_DIR_CAP = 200;

/** Counts what moving a Claude project's sessions takes, changing nothing. */
export async function previewClaudeRelocation(input: {
  configDir: string;
  from: string;
  to: string;
}): Promise<ClaudeRelocation> {
  const plan = await planRelocation(input.configDir, input.from, input.to, false);
  return { ...plan.preview, token: plan.token };
}

/**
 * Moves a Claude project's session folder to the folder the new path encodes,
 * rewriting the cwd each transcript records. The originals are kept under
 * `neolix-relocations` first; an existing target storage is never overwritten.
 */
export async function applyClaudeRelocation(input: {
  configDir: string;
  neolixHome: string;
  from: string;
  to: string;
  token: string;
}): Promise<{ backup: string; to: string }> {
  if (input.token.length === 0) {
    throw new Error("preview the relocation before confirming it");
  }
  const plan = await planRelocation(input.configDir, input.from, input.to, true);
  if (plan.token !== input.token) {
    throw new Error("project files changed; preview the relocation again");
  }
  const backupRoot = path.join(input.configDir, "neolix-relocations");
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const backup = await mkdtemp(path.join(backupRoot, "project-"));
  const stage = path.join(backup, "staged");
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    for (const file of plan.files) {
      const source = path.join(plan.source, file.rel);
      const text = await readFile(source, "utf8");
      const next = transformRelocation(
        file.rel,
        text,
        input.from,
        input.to,
        plan.source,
        plan.dest,
      );
      const target = path.join(stage, file.rel);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, next.text, { mode: file.mode });
      const at = new Date(file.modMs);
      await utimes(target, at, at);
    }
    // Recheck after staging, before touching any original.
    const fresh = await planRelocation(input.configDir, input.from, input.to, true);
    if (fresh.token !== plan.token) {
      throw new Error("project files changed during staging; originals were not moved");
    }
    await writeFile(
      path.join(backup, "manifest.json"),
      `${JSON.stringify(
        {
          from: plan.source,
          to: plan.dest,
          projectFrom: input.from,
          projectTo: input.to,
          original: path.join(backup, "original"),
          preview: plan.preview,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await publishRelocation(plan.source, plan.dest, backup);
  } catch (error) {
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { backup, to: input.to };
}

async function planRelocation(
  configDir: string,
  from: string,
  to: string,
  keepFiles: boolean,
): Promise<RelocationPlan> {
  requireCleanPath(from);
  requireCleanPath(to);
  const targetInfo = await stat(to).catch(() => null);
  if (targetInfo === null || !targetInfo.isDirectory()) {
    throw new Error("the target project directory does not exist");
  }
  const source = await claudeProjectDir(from, { configDir });
  const dest = await claudeProjectDir(to, { configDir });
  if (source === dest) {
    throw new Error("the project paths resolve to the same Claude storage directory");
  }
  const sourceInfo = await lstat(source).catch(() => null);
  if (sourceInfo === null || !sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("source project storage is missing or is a symbolic link");
  }
  if ((await lstat(dest).catch(() => null)) !== null) {
    throw new Error("target Claude project storage already exists; nothing was changed");
  }
  const hash = createHash("sha256");
  hash.update(`${JSON.stringify([configDir, from, to])}\n`);
  const files: RelocationFile[] = [];
  let sessions = 0;
  let bytes = 0;
  const walk = async (dir: string, relDir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
      const info = await lstat(full);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error("project storage contains a symbolic link or special file");
      }
      if (Date.now() - info.mtimeMs < ACTIVE_WINDOW_MS) {
        throw new ActiveExternalSessionError();
      }
      hash.update(`${JSON.stringify([rel, info.size, Math.trunc(info.mtimeMs), info.mode])}\n`);
      if (info.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      const text = await readFile(full, "utf8");
      hash.update(text);
      bytes += info.size;
      const main = !rel.includes("/") && rel.endsWith(".jsonl");
      if (main) {
        sessions += 1;
      }
      const transformed = transformRelocation(rel, text, from, to, source, dest);
      if (main && !transformed.changed) {
        throw new Error(`${rel} has no project cwd; cannot safely relocate it`);
      }
      if (keepFiles) {
        files.push({ rel, modMs: info.mtimeMs, mode: info.mode & 0o777 });
      }
    }
  };
  await walk(source, "");
  if (sessions === 0) {
    throw new Error("no Claude Code sessions found in this project");
  }
  return {
    source,
    dest,
    preview: { from, to, sessions, bytes },
    token: hash.digest("hex"),
    files,
  };
}

interface Transformed {
  text: string;
  changed: boolean;
}

/** Rewrites the cwd of every transcript line that names one under from. */
function transformRelocation(
  rel: string,
  text: string,
  projectFrom: string,
  projectTo: string,
  source: string,
  dest: string,
): Transformed {
  if (rel === INDEX_FILE) {
    return { text: relocateIndex(text, source, dest, projectFrom, projectTo), changed: true };
  }
  const main = !rel.includes("/") && rel.endsWith(".jsonl");
  const sub = rel.split("/").slice(-2, -1)[0] === "subagents" && rel.endsWith(".jsonl");
  if (!main && !sub) {
    return { text, changed: false };
  }
  return relocateTranscript(text, projectFrom, projectTo, main);
}

function relocateTranscript(text: string, from: string, to: string, main: boolean): Transformed {
  let found = false;
  let sawCwd = false;
  const lines = text.split("\n").map((line) => {
    if (line.trim().length === 0) {
      return line;
    }
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error("not an object");
      }
      row = parsed;
    } catch {
      throw new Error("invalid transcript JSON; repair it before relocating");
    }
    if (!Object.hasOwn(row, "cwd")) {
      return line;
    }
    if (typeof row.cwd !== "string") {
      throw new Error("invalid transcript cwd");
    }
    const next = relocatePath(row.cwd, from, to);
    if (main && !sawCwd && next === null) {
      throw new Error(`transcript contains a different project cwd ${JSON.stringify(row.cwd)}`);
    }
    sawCwd = true;
    if (next === null) {
      // A session may have visited another project or a subagent worktree.
      return line;
    }
    found = true;
    row.cwd = next;
    return JSON.stringify(row);
  });
  return { text: lines.join("\n"), changed: found };
}

function relocatePath(value: string, from: string, to: string): string | null {
  if (value === from) {
    return to;
  }
  for (const separator of ["/", "\\"]) {
    if (value.startsWith(`${from}${separator}`)) {
      return `${to}${value.slice(from.length)}`;
    }
  }
  return null;
}

function relocateIndex(
  text: string,
  source: string,
  dest: string,
  from: string,
  to: string,
): string {
  let index: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("not an object");
    }
    index = parsed;
  } catch {
    throw new Error("invalid Claude sessions index");
  }
  if (Object.hasOwn(index, "originalPath") && index.originalPath !== from) {
    throw new Error("Claude sessions index belongs to another project");
  }
  if (Object.hasOwn(index, "originalPath")) {
    index.originalPath = to;
  }
  const entries = index.entries;
  if (!Array.isArray(entries)) {
    throw new Error("invalid Claude sessions index");
  }
  index.entries = entries.map((value) => {
    if (!isRecord(value)) {
      throw new Error("invalid Claude sessions index");
    }
    for (const [key, pair] of [
      ["projectPath", [from, to]],
      ["fullPath", [source, dest]],
    ] as const) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      const current = value[key];
      if (typeof current !== "string") {
        throw new Error(`invalid index ${key}`);
      }
      const next = relocatePath(current, pair[0], pair[1]);
      if (next === null) {
        throw new Error(`index ${key} is outside the source project`);
      }
      value[key] = next;
    }
    return value;
  });
  return JSON.stringify(index);
}

async function publishRelocation(source: string, dest: string, backup: string): Promise<void> {
  const original = path.join(backup, "original");
  const stage = path.join(backup, "staged");
  await mkdir(path.dirname(dest), { recursive: true });
  await rename(source, original);
  try {
    if ((await lstat(dest).catch(() => null)) !== null) {
      throw new Error("target storage appeared during relocation");
    }
    await rename(stage, dest);
  } catch (error) {
    await rename(original, source).catch(() => {});
    throw new Error(`relocation failed (backup: ${backup})`, { cause: error });
  }
}

function requireCleanPath(value: string): void {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    encode(value).length > PROJECT_DIR_CAP
  ) {
    throw new Error("use a clean absolute project path, without a trailing separator");
  }
}

/** Claude Code's project-folder encoding, as the SDK computes it. */
function encode(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
