import { homedir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import {
  envDir,
  findTopLevelLine,
  readJsonObject,
  readTextOrNull,
  removeTopLevelLine,
  writeJsonObject,
} from "../agent-connect/config-files.js";

/**
 * Applying tune's advice to the agent's own settings, myna's `TuneApply` and
 * `TuneUndo` (`internal/agent/tune.go`): Claude Code's `settings.json`
 * (`modelSettings.<model>.autoCompactWindow`, `promptCacheTtl`) and Codex's
 * `config.toml` top-level `model_auto_compact_token_limit`. What was there
 * before is stashed the first time, so Undo puts it back, or removes the key
 * when there was none — unless the user changed it since, when it is theirs.
 *
 * Only the user's Apply writes; the daemon never tunes on its own.
 */

export type TuneAgent = "claude" | "codex";
export type TuneKnob = "compact" | "cache_ttl";

/** How an agent has a setting now, as myna's TuneSetting reads it. */
export interface TuneSettingState {
  value: string | null;
  /** `settings`, `model`, or `env` for a variable that takes precedence. */
  source: "settings" | "model" | "env" | null;
  /** The variable that takes precedence, which Apply refuses to fight. */
  locked?: string;
  /** Neolix put the value in, and Undo has what to put back. */
  ours?: boolean;
}

interface TuneStash {
  had: boolean;
  /** The value as the file had it, or null when the key was absent. */
  raw: string | null;
  /** The value Neolix put in. */
  set: string;
}

const CLAUDE_COMPACT_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const CLAUDE_CACHE_ENVS = ["FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_PROMPT_CACHE_TTL"];
const STASH_FILENAME = "gateway-tune.json";

export interface TunePaths {
  claudeSettings: string;
  codexConfig: string;
  stashFile: string;
}

export function tunePaths(
  neolixHome: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): TunePaths {
  return {
    claudeSettings: path.join(
      envDir(env, "CLAUDE_CONFIG_DIR", homeDir, ".claude"),
      "settings.json",
    ),
    codexConfig: path.join(envDir(env, "CODEX_HOME", homeDir, ".codex"), "config.toml"),
    stashFile: path.join(neolixHome, STASH_FILENAME),
  };
}

/** How the agent has the setting now. */
export async function readTuneSetting(
  input: { agent: TuneAgent; knob: TuneKnob; model?: string; neolixHome: string },
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): Promise<TuneSettingState> {
  const paths = tunePaths(input.neolixHome, env, homeDir);
  if (input.agent === "codex") {
    const text = (await readTextOrNull(paths.codexConfig)) ?? "";
    const raw = getTomlTopKey(text, "model_auto_compact_token_limit");
    return raw === null ? { value: null, source: null } : { value: raw, source: "settings" };
  }
  if (input.knob === "cache_ttl") {
    const locked = await lockedEnv(paths.claudeSettings, CLAUDE_CACHE_ENVS, env);
    if (locked !== null) {
      return {
        value: locked.name === "FORCE_PROMPT_CACHING_5M" ? "5m" : locked.value,
        source: "env",
        locked: locked.name,
      };
    }
    const settings = await readJsonObject(paths.claudeSettings);
    const value = getAt(settings, ["promptCacheTtl"]);
    return typeof value === "string" && value !== "auto"
      ? { value, source: "settings" }
      : { value: null, source: null };
  }
  const locked = await lockedEnv(paths.claudeSettings, [CLAUDE_COMPACT_ENV], env);
  if (locked !== null) {
    return { value: locked.value, source: "env", locked: locked.name };
  }
  const settings = await readJsonObject(paths.claudeSettings);
  const model = input.model ?? "";
  const own = getAt(settings, ["modelSettings", model, "autoCompactWindow"]);
  if (typeof own === "number") {
    return { value: String(own), source: "model" };
  }
  const top = getAt(settings, ["autoCompactWindow"]);
  return typeof top === "number"
    ? { value: String(top), source: "settings" }
    : { value: null, source: null };
}

/** The flag file's stash, if Apply has run for this setting. */
export async function tuneStashed(
  neolixHome: string,
  agent: TuneAgent,
  knob: TuneKnob,
  model: string | undefined,
): Promise<boolean> {
  const all = await readStash(path.join(neolixHome, STASH_FILENAME));
  return all[stashKey(agent, knob, model)] !== undefined;
}

/** Puts `value` in, keeping what was there for Undo. */
export async function applyTune(
  input: {
    agent: TuneAgent;
    knob: TuneKnob;
    model?: string;
    value: string;
    neolixHome: string;
  },
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): Promise<TuneSettingState> {
  const current = await readTuneSetting(input, env, homeDir);
  if (current.locked !== undefined) {
    throw new Error(`${current.locked} is set and comes before the setting: take it out first`);
  }
  const paths = tunePaths(input.neolixHome, env, homeDir);
  const stashFile = paths.stashFile;
  const key = stashKey(input.agent, input.knob, input.model);
  if (input.agent === "codex") {
    const number = tokenCount(input.value);
    const text = (await readTextOrNull(paths.codexConfig)) ?? "";
    const prior = getTomlTopKey(text, "model_auto_compact_token_limit");
    await writeStash(stashFile, key, {
      had: prior !== null,
      raw: prior,
      set: String(number),
    });
    await writeFileAtomic(paths.codexConfig, setTomlTopKey(text, String(number)));
    return { value: String(number), source: "settings", ours: true };
  }
  const settings = await readJsonObject(paths.claudeSettings);
  const base = structuredClone(settings);
  if (input.knob === "cache_ttl") {
    const ttl = cacheTtl(input.value);
    const prior = getAt(settings, ["promptCacheTtl"]);
    await writeStash(stashFile, key, {
      had: prior !== undefined,
      raw: prior === undefined ? null : JSON.stringify(prior),
      set: ttl,
    });
    setAt(settings, ["promptCacheTtl"], ttl);
    await writeJsonObject(paths.claudeSettings, settings, base);
    return { value: ttl, source: "settings", ours: true };
  }
  const model = input.model ?? "";
  const number = claudeWindow(input.value);
  const prior = getAt(settings, ["modelSettings", model, "autoCompactWindow"]);
  await writeStash(stashFile, key, {
    had: prior !== undefined,
    raw: prior === undefined ? null : JSON.stringify(prior),
    set: String(number),
  });
  setAt(settings, ["modelSettings", model, "autoCompactWindow"], number);
  await writeJsonObject(paths.claudeSettings, settings, base);
  return { value: String(number), source: "model", ours: true };
}

/**
 * Puts back what was there before Apply, unless the user changed it since:
 * then it is theirs and is only forgotten. A key Apply added goes, and a
 * `modelSettings.<model>` left empty goes with it.
 */
export async function undoTune(
  input: { agent: TuneAgent; knob: TuneKnob; model?: string; neolixHome: string },
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): Promise<TuneSettingState> {
  const paths = tunePaths(input.neolixHome, env, homeDir);
  const key = stashKey(input.agent, input.knob, input.model);
  const all = await readStash(paths.stashFile);
  const stash = all[key];
  if (stash === undefined) {
    throw new Error("Neox didn't set this setting");
  }
  const current = await readTuneSetting(input, env, homeDir);
  await forget(paths.stashFile, key);
  if (current.value !== stash.set) {
    // The user changed it after Neolix did: theirs stays.
    return current;
  }
  if (input.agent === "codex") {
    const text = (await readTextOrNull(paths.codexConfig)) ?? "";
    const next =
      stash.had && stash.raw !== null
        ? setTomlTopKey(text, stash.raw)
        : removeTopLevelLine(text, "model_auto_compact_token_limit");
    await writeFileAtomic(paths.codexConfig, next);
    return readTuneSetting(input, env, homeDir);
  }
  const settings = await readJsonObject(paths.claudeSettings);
  const base = structuredClone(settings);
  if (input.knob === "cache_ttl") {
    applyPrior(settings, ["promptCacheTtl"], stash);
  } else {
    const model = input.model ?? "";
    applyPrior(settings, ["modelSettings", model, "autoCompactWindow"], stash);
    removeEmptyModelSettings(settings, model);
  }
  await writeJsonObject(paths.claudeSettings, settings, base);
  return readTuneSetting(input, env, homeDir);
}

function applyPrior(root: Record<string, unknown>, at: string[], stash: TuneStash): void {
  if (!stash.had) {
    deleteAt(root, at);
    return;
  }
  let prior: unknown = stash.raw;
  if (stash.raw !== null) {
    try {
      prior = JSON.parse(stash.raw);
    } catch {
      prior = stash.raw;
    }
  }
  setAt(root, at, prior);
}

/** A `modelSettings.<model>` or `modelSettings` left as `{}` goes too. */
function removeEmptyModelSettings(settings: Record<string, unknown>, model: string): void {
  const modelSettings = settings.modelSettings;
  if (typeof modelSettings !== "object" || modelSettings === null || Array.isArray(modelSettings)) {
    return;
  }
  const entries = modelSettings as Record<string, unknown>;
  const own = entries[model];
  if (typeof own === "object" && own !== null && Object.keys(own).length === 0) {
    delete entries[model];
  }
  if (Object.keys(entries).length === 0) {
    delete settings.modelSettings;
  }
}

function tokenCount(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`"${value}" is no token count`);
  }
  return number;
}

function claudeWindow(value: string): number {
  const number = tokenCount(value);
  if (number < 100_000 || number > 1_000_000) {
    throw new Error(`Claude Code takes a window of 100000 to 1000000 tokens, not ${number}`);
  }
  return number;
}

function cacheTtl(value: string): string {
  if (value !== "5m" && value !== "1h") {
    throw new Error(`the cache is kept 5m or 1h, not "${value}"`);
  }
  return value;
}

function stashKey(agent: TuneAgent, knob: TuneKnob, model: string | undefined): string {
  return model === undefined || model.length === 0
    ? `${agent}.${knob}`
    : `${agent}.${knob}.${model}`;
}

async function readStash(filePath: string): Promise<Record<string, TuneStash>> {
  try {
    const text = await readTextOrNull(filePath);
    if (text === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, TuneStash>)
      : {};
  } catch {
    return {};
  }
}

async function writeStash(filePath: string, key: string, stash: TuneStash): Promise<void> {
  const all = await readStash(filePath);
  all[key] = stash;
  await writeFileAtomic(filePath, `${JSON.stringify(all, null, 2)}\n`);
}

async function forget(filePath: string, key: string): Promise<void> {
  const all = await readStash(filePath);
  delete all[key];
  await writeFileAtomic(filePath, `${JSON.stringify(all, null, 2)}\n`);
}

/** The first of `names` set in settings' env or the process, if any. */
async function lockedEnv(
  settingsPath: string,
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ name: string; value: string } | null> {
  const settings = await readJsonObject(settingsPath);
  for (const name of names) {
    const fromFile = getAt(settings, ["env", name]);
    const value = typeof fromFile === "string" && fromFile.length > 0 ? fromFile : env[name];
    if (typeof value === "string" && value !== "" && value !== "0" && value !== "false") {
      return { name, value };
    }
  }
  return null;
}

function getTomlTopKey(text: string, key: string): string | null {
  const line = findTopLevelLine(text, key);
  if (line === null) {
    return null;
  }
  const value = line.slice(line.indexOf("=") + 1).trim();
  return value.replace(/^["'](.*)["']$/u, "$1");
}

function setTomlTopKey(text: string, raw: string): string {
  const line = `model_auto_compact_token_limit = ${raw}`;
  const existing = findTopLevelLine(text, "model_auto_compact_token_limit");
  if (existing !== null) {
    return text
      .split("\n")
      .map((entry) => (entry === existing ? line : entry))
      .join("\n");
  }
  const body = text.replace(/^\s+/u, "");
  return body.length === 0 ? `${line}\n` : `${line}\n${body}`;
}

function getAt(root: Record<string, unknown>, at: string[]): unknown {
  let current: unknown = root;
  for (const part of at) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setAt(root: Record<string, unknown>, at: string[], value: unknown): void {
  const parts = [...at];
  const last = parts.pop();
  if (last === undefined) {
    return;
  }
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

function deleteAt(root: Record<string, unknown>, at: string[]): void {
  const parts = [...at];
  const last = parts.pop();
  if (last === undefined) {
    return;
  }
  let current: Record<string, unknown> = root;
  for (const part of parts) {
    const next = current[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return;
    }
    current = next as Record<string, unknown>;
  }
  delete current[last];
}
