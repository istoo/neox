import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { writeFileAtomic } from "../../atomic-file.js";
import { contentHash, readTextOrNull, tomlString } from "../config-files.js";
import type { AgentConnectUndo, ConnectEnvironment } from "../drivers.js";

/**
 * Where a user's tools land besides PATH: an installer run from a terminal
 * Neolix started may have written one of these after the daemon read its
 * PATH, and myna's own lookup checks them too.
 */
function userToolDirs(environment: ConnectEnvironment): string[] {
  const home = environment.homeDir;
  return [
    path.join(home, ".local", "bin"),
    path.join(home, "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".local", "share", "pnpm"),
    path.join(home, "Library", "pnpm"),
  ];
}

/** Whether `bin` runs from this host's PATH, as the daemon would find it. */
export async function isOnPath(bin: string, environment: ConnectEnvironment): Promise<boolean> {
  const env = environment.env;
  const dirs = [...(env.PATH ?? "").split(path.delimiter), ...userToolDirs(environment)].filter(
    (dir) => dir.length > 0,
  );
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((ext) => ext.length > 0)
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      try {
        await fs.access(path.join(dir, `${bin}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return false;
}

export async function isDir(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export function envOverride(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

// ---------- dotenv ----------

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  return parseEnvFile((await readTextOrNull(filePath)) ?? "");
}

/** Sets `key=value` lines in a dotenv file, keeping every other line as it is. */
export async function setEnvValues(
  filePath: string,
  values: Record<string, string>,
): Promise<void> {
  const text = (await readTextOrNull(filePath)) ?? "";
  const lines = text.length === 0 ? [] : text.split("\n");
  const pending = new Map(Object.entries(values));
  const next = lines.map((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const value = pending.get(key) ?? "";
    pending.delete(key);
    return `${key}=${dotenvValue(value)}`;
  });
  for (const [key, value] of pending) {
    next.push(`${key}=${dotenvValue(value)}`);
  }
  await writeText(filePath, `${trimTrailingBlank(next).join("\n")}\n`);
}

/** Removes the named keys from a dotenv file, leaving the rest untouched. */
export async function removeEnvValues(filePath: string, keys: string[]): Promise<void> {
  const text = await readTextOrNull(filePath);
  if (text === null) return;
  const gone = new Set(keys);
  const kept = text.split("\n").filter((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    return match?.[1] === undefined || !gone.has(match[1]);
  });
  await writeText(filePath, trimTrailingBlank(kept).join("\n"));
}

function dotenvValue(value: string): string {
  return /[\s#"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim() === "") end -= 1;
  return lines.slice(0, end);
}

export async function writeText(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, text);
}

// ---------- TOML tables ----------

interface TomlSection {
  header: string;
  /** The header line's index. */
  at: number;
  /** The first line after the section, its header aside. */
  end: number;
}

function tomlSections(lines: string[]): TomlSection[] {
  const out: TomlSection[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s*\[[^[\]]+\]\s*$/.test(line)) continue;
    out.push({ header: line.trim(), at: index, end: lines.length });
  }
  for (let index = 0; index < out.length - 1; index += 1) {
    const section = out[index];
    const next = out[index + 1];
    if (section && next) section.end = next.at;
  }
  return out;
}

export function getTomlTableKey(text: string, header: string, key: string): string | null {
  const lines = text.split("\n");
  const section = tomlSections(lines).find((entry) => entry.header === header);
  if (!section) return null;
  for (let index = section.at + 1; index < section.end; index += 1) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(lines[index] ?? "");
    if (match?.[1] !== undefined) return unquoteToml(match[1]);
  }
  return null;
}

export function setTomlTableKey(text: string, header: string, key: string, value: string): string {
  return setTomlTableValue(text, header, key, tomlString(value));
}

/** Sets a key to a TOML value written as it is, for numbers and booleans. */
export function setTomlTableRawKey(
  text: string,
  header: string,
  key: string,
  value: string,
): string {
  return setTomlTableValue(text, header, key, value);
}

export function removeTomlTableKey(text: string, header: string, key: string): string {
  const lines = text.split("\n");
  const section = tomlSections(lines).find((entry) => entry.header === header);
  if (!section) return text;
  for (let index = section.at + 1; index < section.end; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index] ?? "")) {
      lines.splice(index, 1);
      return lines.join("\n");
    }
  }
  return text;
}

function setTomlTableValue(text: string, header: string, key: string, value: string): string {
  const rendered = `${key} = ${value}`;
  const lines = text.length === 0 ? [] : text.split("\n");
  const section = tomlSections(lines).find((entry) => entry.header === header);
  if (!section) {
    const next = [...trimTrailingBlank(lines), "", header, rendered];
    return `${next.join("\n")}\n`;
  }
  for (let index = section.at + 1; index < section.end; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index] ?? "")) {
      lines[index] = rendered;
      return lines.join("\n");
    }
  }
  lines.splice(section.at + 1, 0, rendered);
  return lines.join("\n");
}

export function removeTomlTable(text: string, header: string): string {
  const lines = text.split("\n");
  const section = tomlSections(lines).find((entry) => entry.header === header);
  if (!section) return text;
  lines.splice(section.at, section.end - section.at);
  return lines.join("\n");
}

/** Appends `[header]` tables, replacing the ones of the same name. */
export function appendTomlTables(text: string, tables: string[]): string {
  let next = text;
  for (const table of tables) {
    const header = (table.split("\n")[0] ?? "").trim();
    next = removeTomlTable(next, header);
  }
  const body = trimTrailingBlank(next.split("\n"));
  const head = body.join("\n");
  const blocks = tables.join("\n\n");
  return head.length === 0 ? `${blocks}\n` : `${head}\n\n${blocks}\n`;
}

export function removeTomlTablesWithPrefix(text: string, prefix: string): string {
  const lines = text.split("\n");
  const drop = new Set<number>();
  for (const section of tomlSections(lines)) {
    if (!section.header.startsWith(prefix)) continue;
    for (let index = section.at; index < section.end; index += 1) {
      drop.add(index);
    }
  }
  return lines.filter((_, index) => !drop.has(index)).join("\n");
}

export function setTomlTopLevel(text: string, key: string, value: string): string {
  const lines = text.length === 0 ? [] : text.split("\n");
  const rendered = `${key} = ${tomlString(value)}`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*\[/.test(line)) break;
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      lines[index] = rendered;
      return lines.join("\n");
    }
  }
  return `${[rendered, ...lines].join("\n")}`;
}

export function removeTomlTopLevel(text: string, key: string): string {
  return text
    .split("\n")
    .filter((line, index, all) => {
      const beforeAnyTable = all.slice(0, index).every((entry) => !/^\s*\[/.test(entry));
      return !(beforeAnyTable && new RegExp(`^\\s*${key}\\s*=`).test(line));
    })
    .join("\n");
}

function unquoteToml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/** The undo record for a file Neolix created or rewrote, keeping its prior text. */
export function textUndo(filePath: string, before: string | null, after: string): AgentConnectUndo {
  return { kind: "text", path: filePath, before, wrote: contentHash(after) };
}

// ---------- YAML ----------

interface YamlDocumentLike {
  hasIn(path: string[]): boolean;
  getIn(path: string[]): unknown;
  setIn(path: string[], value: unknown): unknown;
  deleteIn(path: string[]): unknown;
  createNode(value: unknown): unknown;
  toJS(): unknown;
  toString(): string;
}

export async function readYamlDocument(filePath: string): Promise<YamlDocumentLike> {
  const text = (await readTextOrNull(filePath)) ?? "";
  return parseDocument(text) as unknown as YamlDocumentLike;
}

export async function writeYamlDocument(
  filePath: string,
  document: YamlDocumentLike,
): Promise<void> {
  await writeText(filePath, document.toString());
}

export function yamlString(document: YamlDocumentLike, yamlPath: string[]): string | null {
  const value = document.getIn(yamlPath);
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------- paths ----------

export function homePath(environment: ConnectEnvironment, ...parts: string[]): string {
  return path.join(environment.homeDir, ...parts);
}

export function configHome(environment: ConnectEnvironment): string {
  const xdg = environment.env.XDG_CONFIG_HOME?.trim();
  if (xdg && path.isAbsolute(xdg)) return xdg;
  return path.join(
    process.platform === "win32"
      ? environment.env.APPDATA?.trim() || environment.homeDir
      : environment.homeDir,
    ...(process.platform === "win32" ? [] : [".config"]),
  );
}

export function absoluteDir(
  environment: ConnectEnvironment,
  override: string | null,
  fallback: string[],
): string {
  if (override !== null && path.isAbsolute(override)) {
    return override;
  }
  return path.join(environment.homeDir, ...fallback);
}
