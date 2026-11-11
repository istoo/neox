import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { writeFileAtomic } from "../atomic-file.js";
import {
  codexCatalogJson,
  type CodexCatalogModel,
  type CodexCatalogOptions,
} from "../codex-catalog.js";
import type { GatewayConfig } from "../llm-gateway/config.js";
import { modelEfforts } from "../llm-gateway/model-prefs.js";
import {
  getTomlTableKey,
  removeTomlTable,
  removeTomlTableKey,
  removeTomlTopLevel,
  setTomlTableKey,
  setTomlTableRawKey,
  setTomlTopLevel,
} from "./external/helpers.js";
import {
  BLOCK_END,
  BLOCK_START,
  contentHash,
  deleteAt,
  envDir,
  findTopLevelLine,
  getString,
  managedBlockText,
  parseJsonc,
  pathExists,
  readJsonObject,
  readTextOrNull,
  removeTopLevelLine,
  setString,
  stripManagedBlocks,
  tomlString,
  writeJsonObject,
  xdgConfigHome,
} from "./config-files.js";
import { copilotDriver } from "./external/drivers-copilot.js";
import { ompDriver } from "./external/drivers-omp.js";
import {
  parseProcessList,
  restartCommands,
  staleCopies as staleCopiesOf,
  type StaleCopy,
  type StaleKind,
} from "./stale-copies.js";

/**
 * The Codex-wide settings Neolix's gateway holds (myna's AGENT_PREFS rows):
 * what the catalog says, what Codex's own config carries, and which window
 * its models are told.
 */
export interface ConnectCodexSettings {
  /** OpenAI's own models say multi-agent V1 (myna's CodexAgentsV1). */
  agentsV1: boolean;
  /** Every subagent's model, "" for the lead's pick, "lead" for its own. */
  subagentModel: string;
  /** The auto-review model, "" for Codex's own pick, "session" for the conversation's. */
  autoReview: string;
  /** Tell a model's whole window, not the compacting one. */
  fullContext: boolean;
  /** The window to compact at, in tokens; 0 is the working window (272k). */
  compactAt: number;
  /** Codex compacts long conversations in the background. */
  asyncCompact: boolean;
  /** The share of the window background compaction starts at; 0 is Codex's 65. */
  asyncCompactPercent: number;
  /** The model Codex writes its memories with; "" is Codex's own. */
  memories: string;
  /** How Codex takes Neolix's models: "", "chatgpt" or "api" (myna's settings). */
  login: string;
  /** Ids of OpenAI's own models, whose entries say V1. */
  openAiModels: string[];
}

/** An agent-wide preference Neolix keeps for the agent, as myna keeps its settings. */
export type AgentPrefKey = "codexSubagentModel" | "codexLogin" | "codexMemories";

export interface ConnectEnvironment {
  homeDir: string;
  env: NodeJS.ProcessEnv;
  /** The gateway's origin as an agent on this host reaches it, no trailing slash. */
  baseUrl: string;
  apiKey: string;
  models: AgentConnectModel[];
  /** Neolix's provider id inside the agent's own config; fixed so a reconnect finds what it wrote. */
  providerId?: string;
  /** Writes a secret to the OS credential store, for an agent that keeps its key there. */
  writeCredential?: (url: string, key: string) => Promise<void>;
  /** The host's platform, for a launch line in the right shell. */
  platform?: NodeJS.Platform;
  /** Runs a host command and answers its stdout; injectable so tests never touch the system. */
  run?: (command: string, args: string[], input?: string) => Promise<string>;
  /** The host's HTTP client, for an agent that keeps its settings behind its own API (Alma). */
  fetch?: typeof fetch;
  /**
   * A Copilot account's session token and API, for its `/models` list only:
   * read once, kept in memory, never stored or logged. Null when Neolix has
   * no Copilot sign-in to read.
   */
  copilotModels?: () => Promise<{ token: string; apiBase: string } | null>;
  /** The gateway's image generation models, for an agent whose image picker Neolix fills (Alma). */
  gatewayImageModels?: string[];
  /** Runs a host command with its own environment (Claude Science's daemon reads its address from it). */
  runWithEnv?: (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  /** The daemon's own folder, for backups of files outside an agent's config. */
  neolixHome?: string;
  /** Neolix providers whose config already points at the gateway, for an agent that runs another as its harness. */
  connectedAgents?: string[];
  /** The host's own row of a multi-agent config (QwenPaw's agents), by id. */
  variant?: string;
  /** The WSL distro an agent lives in, whose home the scoped environment names. */
  wsl?: { distro: string; home: string };
  /** Codex's own settings, for the catalog and config Neolix writes for it. */
  codex?: ConnectCodexSettings;
  /** The gateway config, for the model capabilities Neolix writes into an agent's own list. */
  config?: GatewayConfig;
  /**
   * The gateway models this agent's own list leaves out (myna's
   * HiddenModels per agent), for a driver that writes the list itself.
   */
  hiddenModels?: string[];
  /**
   * Writes an agent-wide preference Neolix keeps for the agent (myna's own
   * settings, not the agent's config); `undefined` takes it out.
   */
  writeAgentPref?: (key: AgentPrefKey, value: string | undefined) => Promise<void>;
}

export interface ConnectReadResult {
  connected: boolean;
  model: string | null;
  /** The gateway origin the agent's config names, without `/v1`; null when it names none. */
  baseUrl: string | null;
}

export type PriorValue =
  | { present: true; value: unknown }
  /** `parentPresent`: the object holding the key was there (an empty `providers` stays). */
  | { present: false; parentPresent?: boolean };

interface JsonFileUndo {
  path: string;
  values: Record<string, PriorValue>;
}

/** A TOML table Neolix's Codex settings wrote, and what its keys held before. */
export interface CodexTableEdit {
  header: string;
  /** Neolix wrote the table itself, so turning the setting off removes it. */
  created: boolean;
  restore: { key: string; value: string | null }[];
}

export type AgentConnectUndo =
  | { kind: "json"; files: JsonFileUndo[] }
  | {
      kind: "toml";
      path: string;
      before: string | null;
      wrote: string;
      displaced: Record<string, string | null>;
      /** Tables Neolix's Codex settings wrote, and the keys they displaced. */
      tables?: CodexTableEdit[];
    }
  | { kind: "env"; path: string; values: Record<string, string | null> }
  | {
      kind: "toml-tables";
      path: string;
      before: string | null;
      wrote: string;
      /** Table headers Neolix wrote, removed when the file changed under it. */
      sections: string[];
      /** Keys Neolix set, with the value each displaced, for surgical cleanup. */
      restore: { header: string; key: string; value: string | null }[];
    }
  | { kind: "yaml"; path: string; values: Record<string, PriorValue> }
  | { kind: "text"; path: string; before: string | null; wrote: string }
  | { kind: "user-env"; values: Record<string, string | null> }
  | { kind: "multi"; parts: AgentConnectUndo[] };

/** One of an agent's own fields, drawn in the agent's row. */
export interface ExternalAgentField {
  id: string;
  label: string;
  /** The gateway model the field holds, null when it holds none. */
  model: string | null;
}

/**
 * One of an agent's own settings, as myna's `myna <agent> <field>` takes
 * it: what it reads as now and, for a pick, the values it accepts.
 */
export interface AgentConnectFieldSetting {
  key: string;
  label: string;
  value: string;
  options?: string[];
}

/** An agent Neolix lists itself, detected on the host, rather than a provider snapshot row. */
export interface ExternalAgentInfo {
  name: string;
  /** myna's bundled icon slug. */
  icon: string;
  detect(environment: ConnectEnvironment): Promise<boolean>;
  /** Detected, but myna cannot wire it to the gateway either. */
  noConnect?: boolean;
  /** Its model list is Neolix's to refresh when the gateway's catalog changes (myna's Sync). */
  refreshModels?: boolean;
  /**
   * The agent's own rows beyond the host one (QwenPaw keeps several agents):
   * each id is listed as `provider#id`, and `environment.variant` carries it
   * to read, connect and disconnect.
   */
  variants?(environment: ConnectEnvironment): Promise<{ id: string; name: string }[]>;
  /**
   * The agent's own fields, all shown in its one row (Aside's four model
   * roles), each a pick written as `provider#id`. Empty when it has none.
   */
  fields?(environment: ConnectEnvironment): Promise<ExternalAgentField[]>;
  /** A shell line that starts the agent on the gateway, for one that reads its endpoint from the environment. */
  launch?(
    environment: ConnectEnvironment,
    model: string | null,
  ): Promise<string | null> | string | null;
  /** An agent that runs another agent as its harness, which the service connects with it. */
  harness?: {
    backends: { backend: string; agent: string }[];
    current(environment: ConnectEnvironment): Promise<string | null>;
  };
  /**
   * A deeplink the agent's app takes to add Neolix as a provider, for one that
   * keeps its providers in its own database (myna's Import).
   */
  importLink?(environment: ConnectEnvironment): string | null;
  /** A shell function Neolix can add to the reader's profile, for an agent started by typing its name. */
  shell?: {
    installed(environment: ConnectEnvironment): Promise<boolean>;
    install(environment: ConnectEnvironment, model: string | null): Promise<void>;
    remove(environment: ConnectEnvironment): Promise<void>;
  };
}

export interface AgentConnectDriver {
  provider: string;
  external?: ExternalAgentInfo;
  /** Whether Neolix writes this agent's own model list, so entries can be hidden from it. */
  modelFilter?: boolean;
  /** The version of the agent's own CLI, read by running it (myna's cliTag). */
  version?(environment: ConnectEnvironment): Promise<string | null>;
  /** Copies still running on the list they started with (myna's StaleCopies). */
  staleCopies?(environment: ConnectEnvironment): Promise<StaleCopy[]>;
  /** Restarts one kind of such a copy; false when the reader must reopen it. */
  restartStale?(
    environment: ConnectEnvironment,
    kind: StaleKind,
    bundle?: string,
  ): Promise<boolean>;
  configPath(environment: ConnectEnvironment): string;
  /** The agent's own fields, read from its config (myna's Field). */
  settings?(environment: ConnectEnvironment): Promise<AgentConnectFieldSetting[]>;
  /** Writes one of `settings`; "" puts it back to the agent's own default. */
  setSetting?(environment: ConnectEnvironment, key: string, value: string): Promise<void>;
  read(environment: ConnectEnvironment): Promise<ConnectReadResult>;
  connect(
    environment: ConnectEnvironment,
    model: string | null,
    undo: AgentConnectUndo | undefined,
    /** The backend a harness runner should use, chosen by the service. */
    hint?: string,
  ): Promise<AgentConnectUndo>;
  disconnect(environment: ConnectEnvironment, undo: AgentConnectUndo | undefined): Promise<void>;
}

export const PROVIDER_ID = "neolix";

export function gatewayModels(models: AgentConnectModel[]): AgentConnectModel[] {
  return models.map((model) => ({
    id: model.id,
    ...(model.label === undefined ? {} : { label: model.label }),
  }));
}

/** The gateway models this agent's own list keeps (myna's per-agent HiddenModels). */
function agentModels(environment: ConnectEnvironment): AgentConnectModel[] {
  const hidden = new Set(environment.hiddenModels ?? []);
  return environment.models.filter((model) => !hidden.has(model.id));
}

/** The levels the user keeps of one gateway model, or null when they said nothing (myna's ModelEfforts). */
function effortsOf(environment: ConnectEnvironment, id: string): string[] | null {
  const config = environment.config;
  const slash = id.indexOf("/");
  if (config === undefined || slash <= 0) {
    return null;
  }
  return modelEfforts(config, id.slice(0, slash), id.slice(slash + 1));
}

export async function readJsoncObject(filePath: string): Promise<Record<string, unknown>> {
  const text = await readTextOrNull(filePath);
  if (text === null || text.trim() === "") {
    return {};
  }
  // Comments stay: a write edits the file where it changed (writeJsonObject).
  const parsed = parseJsonc(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} does not hold a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function capture(
  root: Record<string, unknown>,
  values: Record<string, PriorValue>,
  jsonPath: string,
): void {
  const parts = jsonPath.split(".");
  let current: unknown = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] as string;
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      values[jsonPath] = { present: false };
      return;
    }
    if (!(part in (current as Record<string, unknown>))) {
      // The key is absent. The object that holds it was there (an empty
      // `providers` the reader had stays after disconnect), except when the
      // walk stopped at the top level and the holder is the file itself.
      values[jsonPath] = index > 0 ? { present: false, parentPresent: true } : { present: false };
      return;
    }
    current = (current as Record<string, unknown>)[part];
  }
  // A clone: the caller mutates the tree after capturing, and an undo record
  // that shares the object would record the value Neolix just wrote.
  values[jsonPath] = {
    present: true,
    value: typeof current === "object" && current !== null ? structuredClone(current) : current,
  };
}

export function restore(root: Record<string, unknown>, values: Record<string, PriorValue>): void {
  for (const [jsonPath, prior] of Object.entries(values)) {
    if (prior.present) {
      setAtValue(root, jsonPath, prior.value);
      continue;
    }
    const parent = jsonPath.split(".").slice(0, -1).join(".");
    deleteAt(root, jsonPath);
    // The reader's own empty holder comes back: a delete prunes empty
    // objects, which is noise for one Neolix made and not for one they had.
    if (prior.parentPresent === true && parent.length > 0 && !hasAt(root, parent)) {
      setAtValue(root, parent, {});
    }
  }
}

function hasAt(root: Record<string, unknown>, jsonPath: string): boolean {
  let current: unknown = root;
  for (const part of jsonPath.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return false;
    if (!(part in (current as Record<string, unknown>))) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

export function setAtValue(root: Record<string, unknown>, jsonPath: string, value: unknown): void {
  const parts = jsonPath.split(".");
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

/** The gateway origin a config's `/v1` base names. */
export function stripV1(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export function priorJsonFiles(undo: AgentConnectUndo | undefined): JsonFileUndo[] {
  return undo?.kind === "json" ? undo.files : [];
}

function mergeJsonUndo(
  existing: AgentConnectUndo | undefined,
  filePath: string,
  values: Record<string, PriorValue>,
): JsonFileUndo {
  const previous = priorJsonFiles(existing).find((file) => file.path === filePath);
  return { path: filePath, values: previous?.values ?? values };
}

export async function writeJsonWithUndo(
  filePath: string,
  root: Record<string, unknown>,
  captured: Record<string, PriorValue>,
  existing: AgentConnectUndo | undefined,
  base?: Record<string, unknown>,
): Promise<JsonFileUndo> {
  await writeJsonObject(filePath, root, base);
  return mergeJsonUndo(existing, filePath, captured);
}

// ---------- Claude Code ----------

const CLAUDE_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
];

function claudeSettingsPath(environment: ConnectEnvironment): string {
  return path.join(
    envDir(environment.env, "CLAUDE_CONFIG_DIR", environment.homeDir, ".claude"),
    "settings.json",
  );
}

function claudeOwnedPaths(model: string | null): string[] {
  const paths = ["env.ANTHROPIC_BASE_URL", "env.ANTHROPIC_AUTH_TOKEN"];
  if (model !== null) {
    paths.push(
      "model",
      "env.ANTHROPIC_MODEL",
      "env.ANTHROPIC_DEFAULT_OPUS_MODEL",
      "env.ANTHROPIC_DEFAULT_SONNET_MODEL",
      "env.ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "env.ANTHROPIC_DEFAULT_FABLE_MODEL",
      "env.ANTHROPIC_SMALL_FAST_MODEL",
    );
  }
  return paths;
}

/** The agent's CLI version, as the CLI itself says it (myna's cliTag). */
async function cliVersion(
  environment: ConnectEnvironment,
  command: string,
): Promise<string | null> {
  if (environment.run === undefined) return null;
  try {
    const output = await environment.run(command, ["--version"]);
    return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/u.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** myna's claude aliases: values Claude Code takes for a model besides ids. */
const CLAUDE_MODEL_ALIASES = ["default", "best", "opus", "sonnet", "haiku", "fable", "opusplan"];

/** The levels Claude Code starts with; max lives in the env (myna's claudeEfforts). */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The levels a fixed member may carry (myna's provider.MemberEfforts). */
const MEMBER_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Claude models Claude Code won't run its auto-mode classifier on (myna's claudeNoClassifier). */
const CLAUDE_NO_CLASSIFIER = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5"]);

/** The models Claude Code reads the top-level effortLevel for (myna's claudeTopEffort). */
const CLAUDE_TOP_EFFORT = new Set([
  "claude-opus-4",
  "claude-sonnet-4",
  "claude-opus-4-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-fable-5-1",
]);

const CLAUDE_NAME_RE = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:[^0-9]|$)/u;

/** A value at a dotted path, or undefined. */
function jsonAt(root: Record<string, unknown>, jsonPath: string): unknown {
  let current: unknown = root;
  for (const part of jsonPath.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The Claude model an id names, "" for another vendor's (myna's claudeName). */
function claudeName(model: string): string {
  const dashed = model.replace(/(\d)\.(\d)/gu, "$1-$2").toLowerCase();
  const match = CLAUDE_NAME_RE.exec(dashed);
  if (match?.[1] === undefined || match[2] === undefined) return "";
  const name = `claude-${match[1]}-${match[2]}`;
  return match[3] === undefined ? name : `${name}-${match[3]}`;
}

/** The levels Claude Code sends a model at (myna's claudeEffortsFor). */
function claudeEffortsFor(model: string): string[] {
  switch (claudeName(model)) {
    case "claude-opus-4-5":
      return ["low", "medium", "high"];
    case "claude-opus-4-6":
    case "claude-sonnet-4-6":
      return ["low", "medium", "high", "max"];
    case "claude-haiku-4-5":
    case "claude-sonnet-4-5":
    case "claude-opus-4":
    case "claude-sonnet-4":
      return [];
    case "":
      if (model.toLowerCase().includes("claude-3")) return [];
  }
  return [...CLAUDE_EFFORTS];
}

function claudeReadsTop(model: string): boolean {
  const name = claudeName(model);
  return name === "" || CLAUDE_TOP_EFFORT.has(name);
}

/** The level Claude Code runs a model at when set to v (myna's claudeClamp). */
function claudeClamp(value: string, levels: readonly string[]): string {
  if (levels.length === 0) return "";
  if (value === "" || levels.includes(value)) return value;
  const at = CLAUDE_EFFORTS.indexOf(value);
  if (at < 0) return value;
  let out = levels[0] ?? "";
  for (const level of levels) {
    if (CLAUDE_EFFORTS.indexOf(level) <= at) out = level;
  }
  return out;
}

/** A model fixed at an effort, as myna writes it: "model:effort", [1m] kept last. */
function memberWithEffort(model: string, effort: string): string {
  if (model === "" || effort === "") return model;
  const marked = model.endsWith("[1m]");
  const bare = marked ? model.slice(0, -4) : model;
  return `${bare}:${effort}${marked ? "[1m]" : ""}`;
}

/** Splits "model:effort" the way myna's tierAt does. */
function splitMemberEffort(value: string): { model: string; effort: string } {
  const marked = value.endsWith("[1m]");
  const bare = marked ? value.slice(0, -4) : value;
  const at = bare.lastIndexOf(":");
  if (at <= 0) return { model: value, effort: "" };
  const effort = bare.slice(at + 1);
  if (!MEMBER_EFFORTS.includes(effort)) return { model: value, effort: "" };
  return { model: `${bare.slice(0, at)}${marked ? "[1m]" : ""}`, effort };
}

/** The env keys Neolix writes the main model into for Claude Code's tiers. */
function claudeTierEnvKeys(): string[] {
  return [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
  ];
}

/** Whether a statusLine command is Neolix's own (`neox statusline`). */
function claudeStatuslineOurs(command: string | null): boolean {
  if (command === null) return false;
  const words = command.trim().split(/\s+/u);
  const first = words[0];
  if (first === undefined) return false;
  const base = (first.split(/[\\/]/u).pop() ?? "").toLowerCase().replace(/\.exe$/u, "");
  if (base !== "neox") return false;
  return words.length > 1 && words.slice(1).every((word) => word === "statusline");
}

/** myna's refusal for a bare word given as Claude Code's model. */
function claudeModelWord(value: string, model: string): void {
  const word = value.endsWith("[1m]") ? value.slice(0, -4) : value;
  if (CLAUDE_MODEL_ALIASES.includes(word) || /[-./:_0-9]/u.test(word)) return;
  if (word === "ultra" || word === "ultracode") {
    throw new Error(
      "ultracode is a switch of Claude Code's, not a model: neox claude ultracode on",
    );
  }
  if (CLAUDE_EFFORTS.includes(word)) {
    claudeTakes(model, word);
  }
  throw new Error(
    `"${value}" is no model of Claude Code's: give a model id (claude-…), one of its aliases (${CLAUDE_MODEL_ALIASES.join(", ")}) or a model Neox serves`,
  );
}

/** myna's refusal for an effort a model doesn't take. */
function claudeTakes(model: string, value: string): void {
  const levels = claudeEffortsFor(model);
  if (value === "" || levels.includes(value)) return;
  if (levels.length === 0) {
    throw new Error(`Claude Code sends ${model} no effort`);
  }
  throw new Error(
    `Claude Code runs ${model} at ${levels.join(", ")}, not ${value} (it would send ${claudeClamp(value, levels)})`,
  );
}

// A field per row myna's claude.go lists, each with its own read rule.
// eslint-disable-next-line complexity
async function readClaudeSettings(
  environment: ConnectEnvironment,
): Promise<AgentConnectFieldSetting[]> {
  const settings = await readJsonObject(claudeSettingsPath(environment));
  const model = getString(settings, "env.ANTHROPIC_MODEL") ?? getString(settings, "model") ?? "";
  const levels = claudeEffortsFor(model);
  const name = claudeName(model);
  const envEffort = getString(settings, "env.CLAUDE_CODE_EFFORT_LEVEL") ?? "";
  const modelEffort =
    name === "" ? "" : (getString(settings, `modelSettings.${name}.effortLevel`) ?? "");
  const topEffort = getString(settings, "effortLevel") ?? "";
  let effort = "";
  if (envEffort !== "") {
    effort = claudeClamp(envEffort, levels);
  } else if (name !== "" && modelEffort !== "") {
    effort = claudeClamp(modelEffort, levels);
  } else if (claudeReadsTop(model)) {
    effort = claudeClamp(topEffort, levels);
  }
  const subagent = splitMemberEffort(getString(settings, "env.CLAUDE_CODE_SUBAGENT_MODEL") ?? "");
  const xhigh = levels.includes("xhigh");
  const connected = getString(settings, "env.ANTHROPIC_BASE_URL") === environment.baseUrl;
  const token = getString(settings, "env.ANTHROPIC_AUTH_TOKEN");
  const options = environment.models.map((entry) => entry.id);
  return [
    { key: "model", label: "model", value: model, options },
    {
      key: "effort",
      label: "effort",
      value: effort,
      ...(levels.length === 0 ? {} : { options: levels }),
    },
    {
      key: "ultracode",
      label: "ultracode",
      value: xhigh && jsonAt(settings, "ultracode") === true ? "on" : "",
      ...(xhigh ? { options: ["on"] } : {}),
    },
    { key: "subagent", label: "subagents", value: subagent.model, options },
    {
      key: "subagent_effort",
      label: "subagent effort",
      value: subagent.effort,
      ...(subagent.model === "" ? {} : { options: levels }),
    },
    {
      key: "auto_mode",
      label: "auto mode",
      value: getString(settings, "env.CLAUDE_CODE_AUTO_MODE_MODEL") ?? "",
      options: options.filter((id) => !CLAUDE_NO_CLASSIFIER.has(claudeName(id))),
    },
    {
      key: "login",
      label: "sign-in",
      value: connected && (token === null || token === "") ? "claudeai" : "",
      options: ["claudeai"],
    },
    {
      key: "statusline",
      label: "status line",
      value: claudeStatuslineOurs(getString(settings, "statusLine.command")) ? "on" : "",
      options: ["on"],
    },
  ];
}

// One branch per field, as myna's claude.go Set functions are.
// eslint-disable-next-line complexity
async function writeClaudeSetting(
  environment: ConnectEnvironment,
  key: string,
  value: string,
): Promise<void> {
  const filePath = claudeSettingsPath(environment);
  const settings = await readJsonObject(filePath);
  const base = structuredClone(settings);
  const model = getString(settings, "env.ANTHROPIC_MODEL") ?? getString(settings, "model") ?? "";
  const name = claudeName(model);
  switch (key) {
    case "model": {
      if (value === "") {
        deleteAt(settings, "model");
        deleteAt(settings, "env.ANTHROPIC_MODEL");
        for (const envKey of claudeTierEnvKeys()) deleteAt(settings, `env.${envKey}`);
        break;
      }
      claudeModelWord(value, model);
      setString(settings, "model", value);
      setString(settings, "env.ANTHROPIC_MODEL", value);
      for (const envKey of claudeTierEnvKeys()) setString(settings, `env.${envKey}`, value);
      break;
    }
    case "effort": {
      if (value !== "" && !CLAUDE_EFFORTS.includes(value)) {
        if (value === "ultra" || value === "ultracode") {
          throw new Error(
            "ultracode is a switch of Claude Code's beside its effort: neox claude ultracode on",
          );
        }
        throw new Error(
          `Claude Code keeps an effort of ${CLAUDE_EFFORTS.join(", ")}, not "${value}"`,
        );
      }
      claudeTakes(model, value);
      if (value === "max") {
        setString(settings, "env.CLAUDE_CODE_EFFORT_LEVEL", value);
        break;
      }
      if (getString(settings, "env.CLAUDE_CODE_EFFORT_LEVEL") !== null) {
        deleteAt(settings, "env.CLAUDE_CODE_EFFORT_LEVEL");
      }
      if (value === "") {
        const own =
          name === "" ? "" : (getString(settings, `modelSettings.${name}.effortLevel`) ?? "");
        if (name !== "") deleteAt(settings, `modelSettings.${name}.effortLevel`);
        const top = getString(settings, "effortLevel") ?? "";
        if (claudeReadsTop(model) || (top !== "" && top === own)) deleteAt(settings, "effortLevel");
        break;
      }
      setString(settings, "effortLevel", value);
      if (name !== "") setString(settings, `modelSettings.${name}.effortLevel`, value);
      break;
    }
    case "ultracode": {
      if (value === "" || value === "off") {
        deleteAt(settings, "ultracode");
        break;
      }
      if (value !== "on") {
        throw new Error(`ultracode is on or off, not "${value}"`);
      }
      if (!claudeEffortsFor(model).includes("xhigh")) {
        throw new Error(
          `Claude Code has ultracode only on a model that takes xhigh effort, and ${model === "" ? "no model" : model} doesn't`,
        );
      }
      settings.ultracode = true;
      break;
    }
    case "subagent": {
      if (value === "") {
        deleteAt(settings, "env.CLAUDE_CODE_SUBAGENT_MODEL");
        break;
      }
      if (!environment.models.some((entry) => entry.id === value)) {
        throw new Error(`subagents: "${value}" is not a model Neox serves`);
      }
      const current = splitMemberEffort(
        getString(settings, "env.CLAUDE_CODE_SUBAGENT_MODEL") ?? "",
      );
      setString(
        settings,
        "env.CLAUDE_CODE_SUBAGENT_MODEL",
        memberWithEffort(value, current.effort),
      );
      break;
    }
    case "subagent_effort": {
      if (value !== "" && !MEMBER_EFFORTS.includes(value)) {
        throw new Error(
          `subagent effort: an effort is one of ${MEMBER_EFFORTS.join(", ")}, not "${value}"`,
        );
      }
      const current = splitMemberEffort(
        getString(settings, "env.CLAUDE_CODE_SUBAGENT_MODEL") ?? "",
      );
      if (current.model === "") {
        if (value === "") break;
        throw new Error("subagents: choose their model first, then its effort goes with it");
      }
      setString(settings, "env.CLAUDE_CODE_SUBAGENT_MODEL", memberWithEffort(current.model, value));
      break;
    }
    case "auto_mode": {
      if (value === "") {
        deleteAt(settings, "env.CLAUDE_CODE_AUTO_MODE_MODEL");
        break;
      }
      if (!environment.models.some((entry) => entry.id === value)) {
        throw new Error(`auto mode: "${value}" is not a model Neox serves`);
      }
      if (CLAUDE_NO_CLASSIFIER.has(claudeName(value))) {
        throw new Error(
          `auto mode: Claude Code doesn't run its classifier on ${value}, and would take its own pick instead`,
        );
      }
      setString(settings, "env.CLAUDE_CODE_AUTO_MODE_MODEL", value);
      break;
    }
    case "login": {
      if (value !== "" && value !== "claudeai") {
        throw new Error(`sign-in is claudeai or empty (Neox's key), not "${value}"`);
      }
      if (value === "claudeai") {
        deleteAt(settings, "env.ANTHROPIC_AUTH_TOKEN");
      } else {
        setString(settings, "env.ANTHROPIC_AUTH_TOKEN", environment.apiKey);
      }
      break;
    }
    case "statusline": {
      const command = getString(settings, "statusLine.command");
      const ours = claudeStatuslineOurs(command);
      if (value === "" || value === "off") {
        if (ours) deleteAt(settings, "statusLine");
        break;
      }
      if (value !== "on") {
        throw new Error(`status line is on or off, not "${value}"`);
      }
      if (ours) break;
      if (jsonAt(settings, "statusLine") !== undefined) {
        throw new Error(
          `${filePath} has a status line of its own; Neox leaves it as it is (take it out there first, or add \`neox statusline\` to the command it runs)`,
        );
      }
      settings.statusLine = { type: "command", command: "neox statusline" };
      break;
    }
    default:
      throw new Error(`Claude Code has no field "${key}"`);
  }
  await writeJsonObject(filePath, settings, base);
}

const claudeDriver: AgentConnectDriver = {
  provider: "claude",
  version: (environment) => cliVersion(environment, "claude"),
  configPath: claudeSettingsPath,
  settings: readClaudeSettings,
  setSetting: writeClaudeSetting,
  async read(environment) {
    const settings = await readJsonObject(claudeSettingsPath(environment));
    const baseUrl = getString(settings, "env.ANTHROPIC_BASE_URL");
    return {
      connected: baseUrl === environment.baseUrl,
      model: getString(settings, "env.ANTHROPIC_MODEL") ?? getString(settings, "model"),
      baseUrl,
    };
  },
  async connect(environment, model, undo) {
    const filePath = claudeSettingsPath(environment);
    const settings = await readJsonObject(filePath);
    const base = structuredClone(settings);
    const captured: Record<string, PriorValue> = {};
    for (const key of CLAUDE_ENV_KEYS) {
      capture(settings, captured, `env.${key}`);
    }
    capture(settings, captured, "model");
    setString(settings, "env.ANTHROPIC_BASE_URL", environment.baseUrl);
    setString(settings, "env.ANTHROPIC_AUTH_TOKEN", environment.apiKey);
    if (model !== null) {
      setString(settings, "model", model);
      for (const key of [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_FABLE_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
      ]) {
        setString(settings, `env.${key}`, model);
      }
    }
    const entry = await writeJsonWithUndo(filePath, settings, captured, undo, base);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = claudeSettingsPath(environment);
    if (!(await pathExists(filePath))) {
      return;
    }
    const settings = await readJsonObject(filePath);
    const base = structuredClone(settings);
    const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
    if (prior) {
      restore(settings, prior.values);
    } else if (getString(settings, "env.ANTHROPIC_BASE_URL") === environment.baseUrl) {
      for (const owned of claudeOwnedPaths(getString(settings, "env.ANTHROPIC_MODEL"))) {
        deleteAt(settings, owned);
      }
    }
    await writeJsonObject(filePath, settings, base);
  },
};

// ---------- Codex ----------

function codexConfigPath(environment: ConnectEnvironment): string {
  return path.join(
    envDir(environment.env, "CODEX_HOME", environment.homeDir, ".codex"),
    "config.toml",
  );
}

/** The catalog `model_catalog_json` names (myna's T3 driver writes one too). */
function codexCatalogPath(environment: ConnectEnvironment): string {
  return path.join(
    envDir(environment.env, "CODEX_HOME", environment.homeDir, ".codex"),
    "neolix-codex-models.json",
  );
}

/** The keys Neolix's Codex settings may write, per table (myna's AGENT_PREFS). */
const CODEX_TABLE_KEYS: Record<string, string[]> = {
  "[memories]": ["extract_model", "consolidation_model"],
  "[features.async_compaction]": ["enabled", "model_async_compact_threshold_percent"],
};

function codexTablePresent(text: string, header: string): boolean {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*$`, "mu").test(text);
}

/** The tables Codex's settings ask for, with each key as TOML writes it. */
function codexTableWrites(
  settings: ConnectCodexSettings | undefined,
): Map<string, { key: string; value: string; quoted: boolean }[]> {
  const writes = new Map<string, { key: string; value: string; quoted: boolean }[]>();
  if (settings === undefined) return writes;
  if (settings.memories.length > 0) {
    writes.set("[memories]", [
      { key: "extract_model", value: settings.memories, quoted: true },
      { key: "consolidation_model", value: settings.memories, quoted: true },
    ]);
  }
  if (settings.asyncCompact) {
    const values = [{ key: "enabled", value: "true", quoted: false }];
    if (settings.asyncCompactPercent > 0) {
      values.push({
        key: "model_async_compact_threshold_percent",
        value: String(settings.asyncCompactPercent),
        quoted: false,
      });
    }
    writes.set("[features.async_compaction]", values);
  }
  return writes;
}

/** Puts one recorded key back: removed when it held nothing, else as its table writes it. */
function restoreCodexTableKey(
  text: string,
  header: string,
  key: string,
  value: string | null,
): string {
  if (value === null) return removeTomlTableKey(text, header, key);
  return header === "[features.async_compaction]"
    ? setTomlTableRawKey(text, header, key, value)
    : setTomlTableKey(text, header, key, value);
}

/**
 * Writes Codex's memories and background-compaction tables in place, beside
 * whatever else the user's file holds (myna's edit.SetTOMLKey), and records
 * what each key held so turning the setting off puts it back.
 */
function applyCodexTables(
  text: string,
  settings: ConnectCodexSettings | undefined,
  previous: CodexTableEdit[] | undefined,
): { text: string; tables: CodexTableEdit[] } {
  const writes = codexTableWrites(settings);
  const headers = new Set([...writes.keys(), ...(previous ?? []).map((table) => table.header)]);
  let next = text;
  const tables: CodexTableEdit[] = [];
  for (const header of headers) {
    const prior = previous?.find((table) => table.header === header);
    const desired = writes.get(header);
    if (desired !== undefined && desired.length > 0) {
      const record: CodexTableEdit = prior ?? {
        header,
        created: !codexTablePresent(next, header),
        restore: (CODEX_TABLE_KEYS[header] ?? []).map((key) => ({
          key,
          value: getTomlTableKey(next, header, key),
        })),
      };
      for (const entry of desired) {
        next = entry.quoted
          ? setTomlTableKey(next, header, entry.key, entry.value)
          : setTomlTableRawKey(next, header, entry.key, entry.value);
      }
      tables.push(record);
      continue;
    }
    if (prior === undefined) continue;
    if (prior.created) {
      next = removeTomlTable(next, header);
    } else {
      for (const entry of prior.restore) {
        next = restoreCodexTableKey(next, header, entry.key, entry.value);
      }
    }
  }
  // A picked subagent model takes away Codex's own [agents]
  // default_subagent_model, which would otherwise name another (myna's).
  const subHeader = "[agents]";
  const subKey = "default_subagent_model";
  const priorSub = previous?.find((table) => table.header === subHeader);
  if (settings !== undefined && settings.subagentModel.length > 0) {
    tables.push(
      priorSub ?? {
        header: subHeader,
        created: false,
        restore: [{ key: subKey, value: getTomlTableKey(next, subHeader, subKey) }],
      },
    );
    next = removeTomlTableKey(next, subHeader, subKey);
  } else if (priorSub !== undefined) {
    for (const entry of priorSub.restore) {
      next = restoreCodexTableKey(next, subHeader, entry.key, entry.value);
    }
  }
  return { text: next, tables };
}

function codexCatalogOptions(
  settings: ConnectCodexSettings | undefined,
): CodexCatalogOptions | undefined {
  if (settings === undefined) return undefined;
  return {
    agentsV1: settings.agentsV1,
    openAiModels: settings.openAiModels,
    autoReview: settings.autoReview,
    fullContext: settings.fullContext,
    compactAt: settings.compactAt,
  };
}

function codexBlocks(
  baseUrl: string,
  apiKey: string,
  model: string | null,
  catalogPath: string,
): string[] {
  const top = [BLOCK_START, `model_provider = ${tomlString(PROVIDER_ID)}`];
  if (model !== null) {
    top.push(`model = ${tomlString(model)}`);
  }
  top.push(`model_catalog_json = ${tomlString(catalogPath)}`);
  top.push(BLOCK_END);
  const table = [
    BLOCK_START,
    `[model_providers.${PROVIDER_ID}]`,
    `name = "Neox"`,
    `base_url = ${tomlString(`${baseUrl}/v1`)}`,
    `wire_api = "responses"`,
    `experimental_bearer_token = ${tomlString(apiKey)}`,
    BLOCK_END,
  ];
  return [...top, "", "", ...table];
}

function undoParts(undo: AgentConnectUndo | undefined): AgentConnectUndo[] {
  if (undo === undefined) {
    return [];
  }
  return undo.kind === "multi" ? undo.parts : [undo];
}

/** A prior connect's TOML undo, whether it stood alone or in a multi. */
function codexTomlPart(
  undo: AgentConnectUndo | undefined,
  filePath: string,
): Extract<AgentConnectUndo, { kind: "toml" }> | null {
  for (const part of undoParts(undo)) {
    if (part.kind === "toml" && part.path === filePath) {
      return part;
    }
  }
  return null;
}

function codexTextPart(
  undo: AgentConnectUndo | undefined,
  filePath: string,
): Extract<AgentConnectUndo, { kind: "text" }> | null {
  for (const part of undoParts(undo)) {
    if (part.kind === "text" && part.path === filePath) {
      return part;
    }
  }
  return null;
}

/** The model a Codex config names at the top level, managed block first. */
function codexModel(text: string): string {
  const managed = managedBlockText(text);
  const line = findTopLevelLine(managed, "model") ?? findTopLevelLine(text, "model");
  return line === null ? "" : (tomlStringValue(line) ?? "");
}

/** Sets the managed block's `model` line (or the top-level one when unwired). */
function setCodexModel(text: string, value: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(BLOCK_START);
  const end = lines.indexOf(BLOCK_END);
  if (start >= 0 && end > start) {
    for (let index = start + 1; index < end; index += 1) {
      if (!/^\s*model\s*=/u.test(lines[index] ?? "")) continue;
      if (value === "") lines.splice(index, 1);
      else lines[index] = `model = ${tomlString(value)}`;
      return lines.join("\n");
    }
    if (value !== "") lines.splice(start + 1, 0, `model = ${tomlString(value)}`);
    return lines.join("\n");
  }
  return value === "" ? removeTomlTopLevel(text, "model") : setTomlTopLevel(text, "model", value);
}

/** The levels a gateway model offers, with Codex's own as the fallback. */
function codexEffortsFor(environment: ConnectEnvironment, model: string): string[] {
  if (model !== "") {
    const levels = effortsOf(environment, model);
    if (levels !== null && levels.length > 0) return levels;
  }
  return ["low", "medium", "high", "xhigh"];
}

async function readCodexSettings(
  environment: ConnectEnvironment,
): Promise<AgentConnectFieldSetting[]> {
  const text = (await readTextOrNull(codexConfigPath(environment))) ?? "";
  const model = codexModel(text);
  const effort = topLevelString(text, "model_reasoning_effort");
  const subagent = getTomlTableKey(text, "[agents]", "default_subagent_model") ?? "";
  const subagentEffort =
    getTomlTableKey(text, "[agents]", "default_subagent_reasoning_effort") ?? "";
  // COMPAT(agentPrefsInGateway): the gateway's codexMemories still answers
  // for a config Neolix has not written the [memories] table into yet.
  const memories =
    getTomlTableKey(text, "[memories]", "extract_model") ?? environment.codex?.memories ?? "";
  const options = environment.models.map((entry) => entry.id);
  return [
    { key: "model", label: "model", value: model, options },
    { key: "effort", label: "effort", value: effort, options: codexEffortsFor(environment, model) },
    { key: "subagent", label: "subagents", value: subagent, options },
    // COMPAT(agentPrefsInGateway): these two are myna's own settings, not
    // Codex's config; Neolix keeps them in gateway.json, written only by
    // this field RPC since the AGENT_PREFS rows moved here.
    {
      key: "subagent_model",
      label: "subagent model",
      value: environment.codex?.subagentModel ?? "",
      options: [...options, "lead"],
    },
    {
      key: "subagent_effort",
      label: "subagent effort",
      value: subagentEffort,
      options: codexEffortsFor(environment, subagent),
    },
    { key: "memories", label: "memories", value: memories, options },
    {
      key: "login",
      label: "sign-in",
      value: environment.codex?.login ?? "",
      options: ["chatgpt", "api"],
    },
  ];
}

/** A top-level TOML string, "" when it is absent. */
function topLevelString(text: string, key: string): string {
  const line = findTopLevelLine(text, key);
  return line === null ? "" : (tomlStringValue(line) ?? "");
}

// One branch per field, as myna's codex.go Set functions are.
// eslint-disable-next-line complexity
async function writeCodexSetting(
  environment: ConnectEnvironment,
  key: string,
  value: string,
): Promise<void> {
  const filePath = codexConfigPath(environment);
  const original = (await readTextOrNull(filePath)) ?? "";
  let text = original;
  switch (key) {
    case "model":
      text = setCodexModel(text, value);
      break;
    case "effort":
      text =
        value === ""
          ? removeTomlTopLevel(text, "model_reasoning_effort")
          : setTomlTopLevel(text, "model_reasoning_effort", value);
      break;
    case "subagent":
      text =
        value === ""
          ? removeTomlTableKey(text, "[agents]", "default_subagent_model")
          : setTomlTableKey(text, "[agents]", "default_subagent_model", value);
      break;
    case "subagent_model": {
      if (
        value !== "" &&
        value !== "lead" &&
        !environment.models.some((entry) => entry.id === value)
      ) {
        throw new Error(`subagent model: "${value}" is not a model Neox serves`);
      }
      if (environment.writeAgentPref === undefined) {
        throw new Error("Neox cannot keep Codex's subagent model on this host");
      }
      await environment.writeAgentPref("codexSubagentModel", value === "" ? undefined : value);
      if (getTomlTableKey(text, "[agents]", "default_subagent_model") !== null) {
        // One setting for the subagents' model: a pick — Default included —
        // takes away Codex's own default (myna's subagent_model).
        text = removeTomlTableKey(text, "[agents]", "default_subagent_model");
        text = removeTomlTableKey(text, "[agents]", "default_subagent_reasoning_effort");
      }
      break;
    }
    case "subagent_effort": {
      const subModel = getTomlTableKey(text, "[agents]", "default_subagent_model") ?? "";
      const levels = codexEffortsFor(environment, subModel);
      if (value !== "" && !levels.includes(value)) {
        throw new Error(
          `Codex runs ${subModel === "" ? "its subagents" : subModel} at ${levels.join(", ")}, not "${value}": it would refuse to start a subagent`,
        );
      }
      text =
        value === ""
          ? removeTomlTableKey(text, "[agents]", "default_subagent_reasoning_effort")
          : setTomlTableKey(text, "[agents]", "default_subagent_reasoning_effort", value);
      break;
    }
    case "memories": {
      for (const memoriesKey of ["extract_model", "consolidation_model"]) {
        text =
          value === ""
            ? removeTomlTableKey(text, "[memories]", memoriesKey)
            : setTomlTableKey(text, "[memories]", memoriesKey, value);
      }
      // The config is the truth now; the gateway's old value goes so a
      // later connect cannot write over this one.
      await environment.writeAgentPref?.("codexMemories", undefined);
      break;
    }
    case "login": {
      if (value !== "" && value !== "api" && value !== "chatgpt") {
        throw new Error(`sign-in is api, chatgpt or empty (ChatGPT), not "${value}"`);
      }
      if (environment.writeAgentPref === undefined) {
        throw new Error("Neox cannot keep Codex's sign-in on this host");
      }
      await environment.writeAgentPref("codexLogin", value === "" ? undefined : value);
      return;
    }
    default:
      throw new Error(`Codex has no field "${key}"`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, text.endsWith("\n") ? text : `${text}\n`);
}

const codexDriver: AgentConnectDriver = {
  provider: "codex",
  settings: readCodexSettings,
  setSetting: writeCodexSetting,
  modelFilter: true,
  version: (environment) => cliVersion(environment, "codex"),
  async staleCopies(environment) {
    const platform = environment.platform ?? process.platform;
    // Windows lists its processes slowly and without their start; myna only
    // follows its daemon there, which Neolix does not manage.
    if (platform === "win32" || environment.run === undefined) return [];
    const filePath = codexConfigPath(environment);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat === null) return [];
    const output = await environment.run("ps", ["-axo", "pid=,etime=,command="]).catch(() => "");
    if (output.length === 0) return [];
    return staleCopiesOf({
      agent: "codex",
      processes: parseProcessList(output),
      changedAt: stat.mtimeMs,
    });
  },
  async restartStale(environment, kind, bundle) {
    if ((environment.platform ?? process.platform) === "win32") return false;
    const commands = restartCommands("codex", kind, bundle);
    if (commands === null || environment.run === undefined) return false;
    for (const entry of commands) {
      await environment.run(entry.command, entry.args);
    }
    return true;
  },
  configPath: codexConfigPath,
  async read(environment) {
    const filePath = codexConfigPath(environment);
    const text = (await readTextOrNull(filePath)) ?? "";
    const managed = managedBlockText(text);
    const provider = findTopLevelLine(managed, "model_provider");
    const connected = provider !== null && provider.includes(tomlString(PROVIDER_ID));
    const modelLine = findTopLevelLine(managed, "model");
    const model = modelLine === null ? null : tomlStringValue(modelLine);
    const base = /^\s*base_url\s*=\s*"([^"]*)"/m.exec(managed)?.[1] ?? null;
    return { connected, model, baseUrl: base === null ? null : stripV1(base) };
  },
  async connect(environment, model, undo) {
    const filePath = codexConfigPath(environment);
    const original = (await readTextOrNull(filePath)) ?? "";
    const previous = codexTomlPart(undo, filePath);
    const stripped = stripManagedBlocks(original).stripped;
    const displaced = previous?.displaced ?? {
      model_provider: findTopLevelLine(stripped, "model_provider"),
      model: findTopLevelLine(stripped, "model"),
    };
    let body = stripped;
    if (displaced.model_provider !== null) {
      body = removeTopLevelLine(body, "model_provider");
    }
    if (model !== null && displaced.model !== null) {
      body = removeTopLevelLine(body, "model");
    }
    const catalogPath = codexCatalogPath(environment);
    const catalogBefore = await readTextOrNull(catalogPath);
    // The models this agent's list leaves out are left out of its catalog
    // too (myna's HiddenModels written through codexcat).
    const hidden = new Set(environment.hiddenModels ?? []);
    // A model's reasoning levels are the user's, where they kept some
    // (myna's ModelEfforts: none at all is a model that does not reason).
    const visibleModels: CodexCatalogModel[] = [];
    for (const entry of environment.models) {
      if (hidden.has(entry.id)) continue;
      const efforts = effortsOf(environment, entry.id);
      visibleModels.push(efforts === null ? entry : { ...entry, efforts });
    }
    const catalogText = codexCatalogJson(visibleModels, codexCatalogOptions(environment.codex));
    await fs.mkdir(path.dirname(catalogPath), { recursive: true });
    await writeFileAtomic(catalogPath, catalogText);
    // Memories, background compaction and the subagent default go in place,
    // beside the user's own keys (myna's AGENT_PREFS).
    const applied = applyCodexTables(body, environment.codex, previous?.tables);
    body = applied.text;
    const blocks = codexBlocks(environment.baseUrl, environment.apiKey, model, catalogPath);
    const text = `${blocks.join("\n")}\n${body.trimStart()}`;
    const wrote = text.endsWith("\n") ? text : `${text}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomic(filePath, wrote);
    return {
      kind: "multi",
      parts: [
        {
          kind: "toml",
          path: filePath,
          before: previous?.before ?? (original === "" ? null : original),
          wrote: contentHash(wrote),
          displaced,
          tables: applied.tables,
        },
        {
          kind: "text",
          path: catalogPath,
          before: catalogBefore,
          wrote: contentHash(catalogText),
        },
      ],
    };
  },
  async disconnect(environment, undo) {
    const filePath = codexConfigPath(environment);
    const tomlPart = codexTomlPart(undo, filePath);
    const text = await readTextOrNull(filePath);
    if (text !== null) {
      if (tomlPart !== null && contentHash(text) === tomlPart.wrote) {
        if (tomlPart.before === null) {
          await fs.rm(filePath, { force: true });
        } else {
          await writeFileAtomic(filePath, tomlPart.before);
        }
      } else {
        await restoreCodexConfig(filePath, text, tomlPart);
      }
    }
    const catalogPath = codexCatalogPath(environment);
    const catalogPart = codexTextPart(undo, catalogPath);
    if (catalogPart !== null && catalogPart.before === null) {
      await fs.rm(catalogPath, { force: true });
    } else if (catalogPart !== null) {
      await writeFileAtomic(catalogPath, catalogPart.before ?? "");
    }
  },
};

/** Removes the managed block and puts back the lines it displaced. */
async function restoreCodexConfig(
  filePath: string,
  text: string,
  tomlPart: Extract<AgentConnectUndo, { kind: "toml" }> | null,
): Promise<void> {
  const stripped = stripManagedBlocks(text).stripped.trimStart();
  let tables = stripped;
  for (const table of tomlPart?.tables ?? []) {
    if (table.created) {
      tables = removeTomlTable(tables, table.header);
      continue;
    }
    for (const entry of table.restore) {
      tables = restoreCodexTableKey(tables, table.header, entry.key, entry.value);
    }
  }
  const restored: string[] = [];
  if (tomlPart !== null) {
    for (const line of Object.values(tomlPart.displaced)) {
      if (line !== null) {
        restored.push(line);
      }
    }
  }
  const next = restored.length === 0 ? tables : `${restored.join("\n")}\n${tables}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, next.endsWith("\n") ? next : `${next}\n`);
}

/** The value of a `key = "value"` TOML line, unquoted; null when not a string. */
function tomlStringValue(line: string): string | null {
  const match = /=\s*"((?:\\.|[^"\\])*)"/.exec(line);
  if (!match?.[1]) return null;
  return match[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

// ---------- Pi ----------

function piAgentDir(environment: ConnectEnvironment): string {
  const override = environment.env.PI_CODING_AGENT_DIR?.trim();
  if (override) {
    const resolved = override.startsWith("~")
      ? path.join(environment.homeDir, override.slice(1))
      : override;
    if (path.isAbsolute(resolved)) {
      return resolved;
    }
  }
  return path.join(environment.homeDir, ".pi", "agent");
}

function piSettingsPath(environment: ConnectEnvironment): string {
  return path.join(piAgentDir(environment), "settings.json");
}

function piModelsPath(environment: ConnectEnvironment): string {
  return path.join(piAgentDir(environment), "models.json");
}

function piProviderBlock(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    name: "Neox",
    baseUrl: `${environment.baseUrl}/v1`,
    api: "openai-completions",
    apiKey: environment.apiKey,
    models: gatewayModels(agentModels(environment)).map((model) => ({
      id: model.id,
      name: model.label ?? model.id,
    })),
  };
}

async function readPiSettings(
  environment: ConnectEnvironment,
): Promise<AgentConnectFieldSetting[]> {
  const settings = await readJsonObject(piSettingsPath(environment));
  const model =
    getString(settings, "defaultProvider") === PROVIDER_ID
      ? (getString(settings, "defaultModel") ?? "")
      : "";
  return [
    {
      key: "model",
      label: "model",
      value: model,
      options: environment.models.map((entry) => entry.id),
    },
  ];
}

async function writePiSetting(
  environment: ConnectEnvironment,
  key: string,
  value: string,
): Promise<void> {
  if (key !== "model") throw new Error(`Pi has no field "${key}"`);
  if (value !== "" && !environment.models.some((entry) => entry.id === value)) {
    throw new Error(`model: "${value}" is not a model Neox serves`);
  }
  const settingsPath = piSettingsPath(environment);
  const modelsPath = piModelsPath(environment);
  const settings = await readJsonObject(settingsPath);
  const settingsBase = structuredClone(settings);
  if (value === "") {
    deleteAt(settings, "defaultProvider");
    deleteAt(settings, "defaultModel");
  } else {
    setString(settings, "defaultProvider", PROVIDER_ID);
    setString(settings, "defaultModel", value);
    const models = await readJsonObject(modelsPath);
    const modelsBase = structuredClone(models);
    setAtValue(models, `providers.${PROVIDER_ID}`, piProviderBlock(environment));
    await writeJsonObject(modelsPath, models, modelsBase);
  }
  await writeJsonObject(settingsPath, settings, settingsBase);
}

const piDriver: AgentConnectDriver = {
  provider: "pi",
  settings: readPiSettings,
  setSetting: writePiSetting,
  version: (environment) => cliVersion(environment, "pi"),
  configPath: piSettingsPath,
  async read(environment) {
    const settings = await readJsonObject(piSettingsPath(environment));
    const models = await readJsonObject(piModelsPath(environment));
    const base = getString(models, `providers.${PROVIDER_ID}.baseUrl`);
    return {
      connected: getString(settings, "defaultProvider") === PROVIDER_ID,
      model: getString(settings, "defaultModel"),
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, undo) {
    const settingsPath = piSettingsPath(environment);
    const modelsPath = piModelsPath(environment);
    const settings = await readJsonObject(settingsPath);
    const models = await readJsonObject(modelsPath);
    const settingsBase = structuredClone(settings);
    const modelsBase = structuredClone(models);
    const settingsPrior: Record<string, PriorValue> = {};
    const modelsPrior: Record<string, PriorValue> = {};
    capture(settings, settingsPrior, "defaultProvider");
    capture(settings, settingsPrior, "defaultModel");
    capture(models, modelsPrior, `providers.${PROVIDER_ID}`);
    setString(settings, "defaultProvider", PROVIDER_ID);
    if (model !== null) {
      setString(settings, "defaultModel", model);
    }
    setAtValue(models, `providers.${PROVIDER_ID}`, piProviderBlock(environment));
    const settingsEntry = await writeJsonWithUndo(
      settingsPath,
      settings,
      settingsPrior,
      undo,
      settingsBase,
    );
    const modelsEntry = await writeJsonWithUndo(modelsPath, models, modelsPrior, undo, modelsBase);
    return { kind: "json", files: [settingsEntry, modelsEntry] };
  },
  async disconnect(environment, undo) {
    for (const [filePath, fallback] of [
      [piSettingsPath(environment), ["defaultProvider", "defaultModel"]],
      [piModelsPath(environment), [`providers.${PROVIDER_ID}`]],
    ] as const) {
      if (!(await pathExists(filePath))) continue;
      const root = await readJsonObject(filePath);
      const base = structuredClone(root);
      const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
      if (prior) {
        restore(root, prior.values);
      } else {
        for (const key of fallback) deleteAt(root, key);
      }
      await writeJsonObject(filePath, root, base);
    }
  },
};

// ---------- OpenCode ----------

function openCodeDir(environment: ConnectEnvironment): string {
  const override = environment.env.OPENCODE_CONFIG_DIR?.trim();
  if (override && path.isAbsolute(override)) {
    return override;
  }
  return path.join(xdgConfigHome(environment.env, environment.homeDir), "opencode");
}

async function openCodeConfigPath(environment: ConnectEnvironment): Promise<string> {
  const dir = openCodeDir(environment);
  for (const name of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const candidate = path.join(dir, name);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return path.join(dir, "opencode.json");
}

/** The provider block OpenCode reads the gateway's models from. */
function openCodeProviderBlock(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Neox",
    options: {
      baseURL: `${environment.baseUrl}/v1`,
      apiKey: environment.apiKey,
    },
    models: Object.fromEntries(
      gatewayModels(agentModels(environment)).map((entry) => [
        entry.id,
        { name: entry.label ?? entry.id },
      ]),
    ),
  };
}

/** A model ref without OpenCode's provider prefix, as the field shows it. */
function openCodeModelValue(raw: string | null): string {
  const value = raw ?? "";
  return value.startsWith(`${PROVIDER_ID}/`) ? value.slice(PROVIDER_ID.length + 1) : value;
}

async function readOpenCodeSettings(
  environment: ConnectEnvironment,
): Promise<AgentConnectFieldSetting[]> {
  const config = await readJsoncObject(await openCodeConfigPath(environment));
  const options = environment.models.map((entry) => entry.id);
  return [
    {
      key: "model",
      label: "model",
      value: openCodeModelValue(getString(config, "model")),
      options,
    },
    {
      key: "small",
      label: "small",
      value: openCodeModelValue(getString(config, "small_model")),
      options,
    },
  ];
}

async function writeOpenCodeSetting(
  environment: ConnectEnvironment,
  key: string,
  value: string,
): Promise<void> {
  if (key !== "model" && key !== "small") throw new Error(`OpenCode has no field "${key}"`);
  if (value !== "" && !environment.models.some((entry) => entry.id === value)) {
    throw new Error(`${key}: "${value}" is not a model Neox serves`);
  }
  const filePath = await openCodeConfigPath(environment);
  const config = await readJsoncObject(filePath);
  const base = structuredClone(config);
  const jsonKey = key === "model" ? "model" : "small_model";
  if (value === "") {
    deleteAt(config, jsonKey);
    const usesGateway =
      (getString(config, "model") ?? "").startsWith(`${PROVIDER_ID}/`) ||
      (getString(config, "small_model") ?? "").startsWith(`${PROVIDER_ID}/`);
    if (!usesGateway) deleteAt(config, `provider.${PROVIDER_ID}`);
  } else {
    setAtValue(config, `provider.${PROVIDER_ID}`, openCodeProviderBlock(environment));
    setString(config, jsonKey, `${PROVIDER_ID}/${value}`);
  }
  await writeJsonObject(filePath, config, base);
}

const openCodeDriver: AgentConnectDriver = {
  provider: "opencode",
  settings: readOpenCodeSettings,
  setSetting: writeOpenCodeSetting,
  configPath(environment) {
    return path.join(openCodeDir(environment), "opencode.json");
  },
  async read(environment) {
    const filePath = await openCodeConfigPath(environment);
    const config = await readJsoncObject(filePath);
    const baseUrl = getString(config, `provider.${PROVIDER_ID}.options.baseURL`);
    const model = getString(config, "model");
    return {
      connected:
        baseUrl === `${environment.baseUrl}/v1` || model?.startsWith(`${PROVIDER_ID}/`) === true,
      model:
        model?.startsWith(`${PROVIDER_ID}/`) === true ? model.slice(PROVIDER_ID.length + 1) : null,
      baseUrl: baseUrl === null ? null : stripV1(baseUrl),
    };
  },
  async connect(environment, model, undo) {
    const filePath = await openCodeConfigPath(environment);
    const config = await readJsoncObject(filePath);
    const base = structuredClone(config);
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, `provider.${PROVIDER_ID}`);
    capture(config, captured, "model");
    setAtValue(config, `provider.${PROVIDER_ID}`, {
      npm: "@ai-sdk/openai-compatible",
      name: "Neox",
      options: {
        baseURL: `${environment.baseUrl}/v1`,
        apiKey: environment.apiKey,
      },
      models: Object.fromEntries(
        gatewayModels(agentModels(environment)).map((entry) => [
          entry.id,
          { name: entry.label ?? entry.id },
        ]),
      ),
    });
    if (model !== null) {
      setString(config, "model", `${PROVIDER_ID}/${model}`);
    }
    const entry = await writeJsonWithUndo(filePath, config, captured, undo, base);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = await openCodeConfigPath(environment);
    if (!(await pathExists(filePath))) return;
    const config = await readJsoncObject(filePath);
    const base = structuredClone(config);
    const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
    if (prior) {
      restore(config, prior.values);
    } else {
      deleteAt(config, `provider.${PROVIDER_ID}`);
      if (getString(config, "model")?.startsWith(`${PROVIDER_ID}/`)) {
        deleteAt(config, "model");
      }
    }
    await writeJsonObject(filePath, config, base);
  },
};

export const AGENT_CONNECT_DRIVERS: AgentConnectDriver[] = [
  claudeDriver,
  codexDriver,
  openCodeDriver,
  piDriver,
  ompDriver,
  copilotDriver,
];

/** Providers Neolix can name but has no writer for; the page says why. */
export const AGENT_CONNECT_UNSUPPORTED = [] as const;
