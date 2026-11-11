import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writePrivateFileAtomic } from "../private-files.js";

export type AgentConfigFormat = "json" | "yaml" | "env";

/** The format a config file is in: its declared one, else its name's. */
export function agentConfigFormat(
  configPath: string,
  declared: string | undefined,
): AgentConfigFormat {
  if (declared === "json" || declared === "yaml" || declared === "env") {
    return declared;
  }
  const base = path.basename(configPath).toLowerCase();
  if (base.startsWith(".env")) return "env";
  const extension = path.extname(base);
  if (extension === ".yaml" || extension === ".yml") return "yaml";
  if (extension === ".json" || extension === ".jsonc") return "json";
  throw new Error(`cannot tell the format of ${configPath}: declare one (json, yaml or env)`);
}

/** Expands `~` and makes the path absolute for this host. */
export function expandConfigPath(configPath: string): string {
  let expanded = configPath;
  if (configPath === "~") {
    expanded = homedir();
  } else if (configPath.startsWith("~/")) {
    expanded = path.join(homedir(), configPath.slice(2));
  }
  return path.resolve(expanded);
}

/**
 * Writes one agent integration's settings into its config: the file's own
 * values are kept, the integration's win, and the model goes at its key
 * path when one is declared. The previous file is kept beside it as
 * `.neolix.bak`. Returns what was written.
 */
export async function writeAgentWiring(input: {
  config: string;
  format?: string;
  modelPath?: string;
  settings: Record<string, unknown>;
  model: string;
}): Promise<{ path: string; keys: string[] }> {
  const filePath = expandConfigPath(input.config);
  const format = agentConfigFormat(filePath, input.format);
  const existing = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const document = parseConfig(existing, format, filePath);
  Object.assign(document, input.settings);
  if (input.modelPath !== undefined && input.modelPath !== "") {
    setPath(document, input.modelPath, input.model);
  }
  if (existing !== "") {
    await writePrivateFileAtomic(`${filePath}.neolix.bak`, existing);
  }
  await writePrivateFileAtomic(filePath, serializeConfig(document, format));
  return {
    path: filePath,
    keys: [
      ...new Set([
        ...Object.keys(input.settings),
        ...(input.modelPath === undefined || input.modelPath === "" ? [] : [input.modelPath]),
      ]),
    ],
  };
}

function parseConfig(
  text: string,
  format: AgentConfigFormat,
  filePath: string,
): Record<string, unknown> {
  if (text.trim() === "") return {};
  if (format === "env") return parseEnv(text);
  let parsed: unknown;
  try {
    parsed = format === "json" ? JSON.parse(text) : parseYaml(text);
  } catch (error) {
    throw new Error(`cannot read ${filePath} as ${format}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a ${format} object`);
  }
  return parsed as Record<string, unknown>;
}

function serializeConfig(document: Record<string, unknown>, format: AgentConfigFormat): string {
  if (format === "json") return `${JSON.stringify(document, null, 2)}\n`;
  if (format === "yaml") return stringifyYaml(document);
  return `${Object.entries(document)
    .map(([key, value]) => `${key}=${envValue(value)}`)
    .join("\n")}\n`;
}

function parseEnv(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals <= 0) continue;
    out[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1);
  }
  return out;
}

function envValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Sets a dotted key path in a JSON/YAML document. */
function setPath(document: Record<string, unknown>, keyPath: string, value: unknown): void {
  const parts = keyPath.split(".").filter((part) => part !== "");
  if (parts.length === 0) return;
  let cursor = document;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}
