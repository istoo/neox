import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { applyEdits, type FormattingOptions, modify, parse as parseJsoncText } from "jsonc-parser";
import { writeFileAtomic } from "../atomic-file.js";

/** A JSON value read or written at a dotted path, as the connect undo records it. */
export type JsonPathValue = string | null;

export async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A missing or empty file is an empty object; anything unparseable is an error. */
export async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const text = await readTextOrNull(filePath);
  if (text === null || text.trim() === "") {
    return {};
  }
  const parsed: unknown = parseJsonc(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** JSONC's comments and trailing commas, removed outside string literals. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") {
        index += 1;
      }
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

export function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

export function hasJsonComments(text: string): boolean {
  return stripJsonComments(text) !== text;
}

/** JSON with JSONC's comments and trailing commas allowed. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

export async function writeJsonObject(
  filePath: string,
  value: Record<string, unknown>,
  base?: Record<string, unknown>,
): Promise<string> {
  const before = await readTextOrNull(filePath);
  // `base` is the object the caller read before changing it. The file may
  // have gained keys while the caller held it (the user editing beside a
  // connect), and only the caller's own change may land: the difference
  // from `base` to `value` is applied to what is on disk now, rather than
  // writing the stale copy back whole.
  const intended = base === undefined ? value : applyChangeIntent(before, base, value);
  // A JSONC file is edited where it changed, so its comments, key order and
  // indentation stay (myna's internal/edit does the same). Anything else is
  // rewritten as before.
  const text =
    before !== null && hasJsonComments(before)
      ? editJsoncText(before, intended)
      : `${JSON.stringify(intended, null, 2)}\n`;
  await writeFileAtomic(filePath, text);
  return text;
}

/** What the caller changed, applied to the file as it is at write time. */
function applyChangeIntent(
  beforeText: string | null,
  base: Record<string, unknown>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const edits: JsoncEdit[] = [];
  jsoncEdits(base, value, [], edits);
  if (beforeText === null || beforeText.trim() === "") {
    return value;
  }
  let latest: unknown;
  try {
    latest = parseJsonc(beforeText);
  } catch {
    return value;
  }
  if (!isPlainObject(latest)) {
    return value;
  }
  for (const edit of edits) {
    if (edit.value === undefined) {
      deleteAtPath(latest, edit.path);
    } else {
      setAtPath(latest, edit.path, edit.value);
    }
  }
  return latest;
}

function setAtPath(root: Record<string, unknown>, at: (string | number)[], value: unknown): void {
  const last = at.at(-1);
  if (last === undefined) {
    return;
  }
  let current: unknown = root;
  for (const part of at.slice(0, -1)) {
    if (!isPlainObject(current)) {
      return;
    }
    const next = current[part];
    if (!isPlainObject(next)) {
      current[part] = {};
    }
    current = current[part];
  }
  if (isPlainObject(current)) {
    current[last] = value;
  }
}

function deleteAtPath(root: Record<string, unknown>, at: (string | number)[]): void {
  const last = at.at(-1);
  if (last === undefined) {
    return;
  }
  let current: unknown = root;
  for (const part of at.slice(0, -1)) {
    if (!isPlainObject(current)) {
      return;
    }
    current = current[part];
  }
  if (isPlainObject(current)) {
    delete current[last];
  }
}

interface JsoncEdit {
  path: (string | number)[];
  value: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The paths whose value differs, deepest last; arrays are replaced whole. */
function jsoncEdits(
  before: unknown,
  after: unknown,
  at: (string | number)[],
  out: JsoncEdit[],
): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of Object.keys(before)) {
      if (!(key in after)) out.push({ path: [...at, key], value: undefined });
    }
    for (const [key, value] of Object.entries(after)) {
      const prior = before[key];
      if (!(key in before)) out.push({ path: [...at, key], value });
      else if (isPlainObject(prior) && isPlainObject(value)) {
        jsoncEdits(prior, value, [...at, key], out);
      } else if (!sameJson(prior, value)) {
        out.push({ path: [...at, key], value });
      }
    }
    return;
  }
  if (!sameJson(before, after)) out.push({ path: at, value: after });
}

function jsoncFormatting(text: string): FormattingOptions {
  const tabs = /\n(\t+)"/u.exec(text);
  if (tabs?.[1] !== undefined) return { insertSpaces: false, tabSize: tabs[1].length };
  const spaces = /\n( +)"/u.exec(text);
  return { insertSpaces: true, tabSize: spaces?.[1]?.length ?? 2 };
}

/** value written into text where it changed, comments and layout elsewhere kept. */
export function editJsoncText(text: string, value: Record<string, unknown>): string {
  const errors: { error: number; offset: number; length: number }[] = [];
  const before = parseJsoncText(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(before)) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }
  const edits: JsoncEdit[] = [];
  jsoncEdits(before, value, [], edits);
  const formattingOptions = jsoncFormatting(text);
  let next = text;
  for (const edit of edits) {
    next = applyEdits(
      next,
      modify(next, edit.path, edit.value, {
        formattingOptions,
        isArrayInsertion: false,
      }),
    );
  }
  return next;
}

function partsOf(jsonPath: string): string[] {
  return jsonPath.split(".").filter((part) => part.length > 0);
}

function readAt(root: Record<string, unknown>, jsonPath: string): unknown {
  let current: unknown = root;
  for (const part of partsOf(jsonPath)) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The string at `jsonPath`, or null when it is absent or not a string. */
export function getString(root: Record<string, unknown>, jsonPath: string): string | null {
  const value = readAt(root, jsonPath);
  return typeof value === "string" ? value : null;
}

export function setString(root: Record<string, unknown>, jsonPath: string, value: string): void {
  const parts = partsOf(jsonPath);
  const last = parts.pop();
  if (last === undefined) return;
  let current = root;
  for (const part of parts) {
    const next = current[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[last] = value;
}

export function deleteAt(root: Record<string, unknown>, jsonPath: string): void {
  const parts = partsOf(jsonPath);
  const last = parts.pop();
  if (last === undefined) return;
  let current: Record<string, unknown> = root;
  const trail: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    const next = current[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return;
    }
    trail.push(current);
    current = next as Record<string, unknown>;
  }
  delete current[last];
  // Empty objects left behind by a delete are noise in the user's file.
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const parent = trail[index];
    const key = parts[index];
    const child = parent[key];
    if (typeof child === "object" && child !== null && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
}

/** Where a file lives, relative to the user's home or an explicit override. */
export function envDir(
  env: NodeJS.ProcessEnv,
  variable: string,
  homeDir: string,
  ...fallback: string[]
): string {
  const override = env[variable]?.trim();
  if (override && path.isAbsolute(override)) {
    return override;
  }
  return path.join(homeDir, ...fallback);
}

export function xdgConfigHome(env: NodeJS.ProcessEnv, homeDir: string): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) {
    return xdg;
  }
  return path.join(homeDir, ".config");
}

/** Lines of a managed block, start marker and end marker included. */
export const BLOCK_START = "# >>> neolix agent connect (managed block, do not edit)";
export const BLOCK_END = "# <<< neolix agent connect";

export interface ManagedBlocks {
  /** The file without any Neolix managed block. */
  stripped: string;
  /** How many blocks were removed. */
  removed: number;
}

/** Removes every line between a start and end marker, markers included. */
export function stripManagedBlocks(text: string): ManagedBlocks {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inside = false;
  let removed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!inside && trimmed === BLOCK_START) {
      inside = true;
      removed += 1;
      continue;
    }
    if (inside) {
      if (trimmed === BLOCK_END) {
        inside = false;
      }
      continue;
    }
    kept.push(line);
  }
  return { stripped: kept.join("\n"), removed };
}

/** The lines inside Neolix's managed blocks, markers excluded. */
export function managedBlockText(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let inside = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === BLOCK_START) {
      inside = true;
      continue;
    }
    if (inside) {
      if (trimmed === BLOCK_END) {
        inside = false;
      } else {
        kept.push(line);
      }
    }
  }
  return kept.join("\n");
}

/**
 * The top-level `key = ...` line of a TOML file: before the first table
 * header, so a key inside a table is left alone. Null when absent.
 */
export function findTopLevelLine(text: string, key: string): string | null {
  const matcher = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      return null;
    }
    if (matcher.test(line)) {
      return line;
    }
  }
  return null;
}

export function removeTopLevelLine(text: string, key: string): string {
  const matcher = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const lines = text.split("\n");
  const index = lines.findIndex((line, position) => {
    const before = lines.slice(0, position).some((earlier) => earlier.trim().startsWith("["));
    return !before && matcher.test(line);
  });
  if (index === -1) return text;
  lines.splice(index, 1);
  return lines.join("\n");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A TOML basic string, quoted and escaped. */
export function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
