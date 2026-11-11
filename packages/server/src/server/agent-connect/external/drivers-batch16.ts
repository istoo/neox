import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { deleteAt, readJsonObject, readTextOrNull } from "../config-files.js";
import {
  capture,
  type AgentConnectDriver,
  type AgentConnectUndo,
  type ConnectEnvironment,
  PROVIDER_ID,
  type PriorValue,
  restore,
  setAtValue,
  stripV1,
  writeJsonWithUndo,
} from "../drivers.js";
import { envOverride, homePath, isDir, textUndo, writeText } from "./helpers.js";
import { modelEfforts } from "../../llm-gateway/model-prefs.js";

const SLOT = PROVIDER_ID;

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
}

function labelOf(model: AgentConnectModel): string {
  return model.label ?? model.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfThere(filePath: string): Promise<Record<string, unknown>> {
  if (!(await exists(filePath))) return {};
  return readJsonObject(filePath);
}

function readJsonString(root: Record<string, unknown>, keys: string[]): string | null {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

function priorPart(
  undo: AgentConnectUndo | undefined,
  kind: "json" | "text",
  target: string,
): AgentConnectUndo | null {
  if (undo === undefined) return null;
  const parts = undo.kind === "multi" ? undo.parts : [undo];
  for (const part of parts) {
    if (part.kind === "text" && kind === "text" && part.path === target) return part;
    if (part.kind === "json" && kind === "json" && part.files.some((f) => f.path === target)) {
      return part;
    }
  }
  return null;
}

function jsonPrior(
  undo: AgentConnectUndo | undefined,
  filePath: string,
): { values: Record<string, PriorValue> } | null {
  const part = priorPart(undo, "json", filePath);
  if (part === null || part.kind !== "json") return null;
  return part.files.find((file) => file.path === filePath) ?? null;
}

// ---------- QwenPaw ----------

/**
 * QwenPaw's working folder: QWENPAW_WORKING_DIR, else a legacy ~/.copaw,
 * else ~/.qwenpaw. The legacy check needs the disk, so the async resolver
 * caches it for the synchronous configPath the snapshot asks for.
 */
const qwenpawWork = new Map<string, string>();

function qwenpawCacheKey(environment: ConnectEnvironment): string {
  return `${environment.homeDir}\u0000${envOverride(environment.env, "QWENPAW_WORKING_DIR") ?? ""}`;
}

function qwenpawWorking(environment: ConnectEnvironment): string {
  return qwenpawWork.get(qwenpawCacheKey(environment)) ?? homePath(environment, ".qwenpaw");
}

async function qwenpawWorkingAt(environment: ConnectEnvironment): Promise<string> {
  const set = envOverride(environment.env, "QWENPAW_WORKING_DIR");
  let work: string;
  if (set !== null) work = expandHome(environment, set);
  else {
    const legacy = homePath(environment, ".copaw");
    work = (await isDir(legacy)) ? legacy : homePath(environment, ".qwenpaw");
  }
  qwenpawWork.set(qwenpawCacheKey(environment), work);
  return work;
}

function expandHome(environment: ConnectEnvironment, value: string): string {
  if (value === "~") return environment.homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(environment.homeDir, value.slice(2));
  }
  return value;
}

/** QwenPaw's secret folder: QWENPAW_SECRET_DIR (env or .env), else "<working folder>.secret". */
async function qwenpawSecret(environment: ConnectEnvironment, work: string): Promise<string> {
  let dir = envOverride(environment.env, "QWENPAW_SECRET_DIR");
  if (dir === null) {
    const env = await readTextOrNull(path.join(work, ".env"));
    dir = env === null ? null : dotenvValue(env, "QWENPAW_SECRET_DIR");
  }
  return dir === null || dir.length === 0 ? `${work}.secret` : expandHome(environment, dir);
}

function dotenvValue(text: string, key: string): string | null {
  let value: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    const cut = line.indexOf("=");
    if (cut <= 0 || line.slice(0, cut).trim() !== key) continue;
    let found = line.slice(cut + 1).trim();
    if (found.length >= 2 && (found[0] === '"' || found[0] === "'")) {
      const end = found.indexOf(found[0], 1);
      if (end > 0) found = found.slice(1, end);
    } else {
      const comment = found.indexOf(" #");
      if (comment >= 0) found = found.slice(0, comment).trim();
    }
    value = found;
  }
  return value;
}

interface QwenpawProfile {
  id: string;
  dir: string;
}

/** QwenPaw's agents, in agent_order with the default first, switched-off ones left out. */
async function qwenpawProfiles(
  environment: ConnectEnvironment,
  work: string,
): Promise<QwenpawProfile[]> {
  const raw = await readJsonIfThere(path.join(work, "config.json"));
  const agents = isRecord(raw.agents) ? raw.agents : {};
  const profiles = isRecord(agents.profiles) ? agents.profiles : {};
  const dirOf = (id: string): string => {
    const entry = isRecord(profiles[id]) ? profiles[id] : {};
    const dir = typeof entry.workspace_dir === "string" ? entry.workspace_dir.trim() : "";
    if (dir.length === 0) return path.join(work, "workspaces", id);
    return expandHome(environment, dir);
  };
  const order = Array.isArray(agents.agent_order)
    ? agents.agent_order.filter((id): id is string => typeof id === "string")
    : [];
  const rest = Object.keys(profiles)
    .filter((id) => !order.includes(id))
    .sort();
  const out: QwenpawProfile[] = [{ id: "default", dir: dirOf("default") }];
  for (const id of [...order, ...rest]) {
    if (id === "default" || !qwenpawIdOk(id) || out.some((entry) => entry.id === id)) continue;
    const entry = isRecord(profiles[id]) ? profiles[id] : {};
    if (entry.enabled === false) continue;
    out.push({ id, dir: dirOf(id) });
  }
  return out;
}

/** An agent id as QwenPaw takes one: letters, digits, _ and -, 2 to 64, no _ or - at either end. */
function qwenpawIdOk(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  return /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(id);
}

function qwenpawProfileFor(
  environment: ConnectEnvironment,
  profiles: QwenpawProfile[],
): QwenpawProfile | null {
  const wanted = environment.variant ?? "default";
  return profiles.find((entry) => entry.id === wanted) ?? null;
}

function qwenpawProviderPath(secret: string): string {
  return path.join(secret, "providers", "custom", `${SLOT}.json`);
}

function qwenpawModel(entry: AgentConnectModel): Record<string, unknown> {
  const model: Record<string, unknown> = {
    id: entry.id,
    name: labelOf(entry),
    source: "user",
    supports_image: entry.images === true,
    supports_multimodal: entry.images === true,
    supports_tool_calling: true,
  };
  if (entry.contextWindow !== undefined && entry.contextWindow >= 1000) {
    model.max_input_length = entry.contextWindow;
    model.max_input_length_configured = true;
  }
  if (entry.maxOutputTokens !== undefined) model.max_output_length = entry.maxOutputTokens;
  return model;
}

/** What QwenPaw keeps beside the provider and models Neolix names. */
function qwenpawProvider(
  environment: ConnectEnvironment,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const defaults: Record<string, unknown> = {
    enabled: true,
    support_model_discovery: false,
    support_connection_check: false,
    models: [],
    generate_kwargs: {},
    custom_headers: {},
    snapshot_schema_version: 2,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in out)) out[key] = value;
  }
  out.id = SLOT;
  out.name = "Neox";
  out.base_url = environment.baseUrl;
  out.chat_model = "OpenAIChatModel";
  out.is_custom = true;
  if (typeof out.api_key !== "string" || out.api_key.length === 0) {
    out.api_key = environment.apiKey;
  }
  out.extra_models = environment.models.map(qwenpawModel);
  return out;
}

async function qwenpawNamesNeolix(environment: ConnectEnvironment, work: string): Promise<boolean> {
  for (const profile of await qwenpawProfiles(environment, work)) {
    const file = path.join(profile.dir, "agent.json");
    if (!(await exists(file))) continue;
    const agent = await readJsonIfThere(file).catch((): Record<string, unknown> => ({}));
    if (readJsonString(agent, ["active_model", "provider_id"]) === SLOT) return true;
    if (readJsonString(agent, ["subagent_model", "provider_id"]) === SLOT) return true;
    const fallbacks = Array.isArray(agent.fallback_models) ? agent.fallback_models : [];
    if (fallbacks.some((entry) => isRecord(entry) && entry.provider_id === SLOT)) return true;
  }
  return false;
}

const qwenpawDriver: AgentConnectDriver = {
  provider: "qwenpaw",
  external: {
    name: "QwenPaw",
    icon: "qwenpaw",
    detect: async (environment) => isDir(await qwenpawWorkingAt(environment)),
    // Each agent QwenPaw keeps is a row of its own (myna's qwenpawAgents).
    variants: async (environment) => {
      const work = await qwenpawWorkingAt(environment);
      const out: { id: string; name: string }[] = [];
      for (const profile of (await qwenpawProfiles(environment, work)).slice(1)) {
        const file = path.join(profile.dir, "agent.json");
        const agent = await readJsonIfThere(file).catch(() => null);
        if (agent === null) continue;
        const backend = readJsonString(agent, ["backend"]) ?? "qwenpaw";
        if (backend !== "qwenpaw") continue;
        const name = readJsonString(agent, ["name"]) ?? profile.id;
        out.push({ id: profile.id, name: `QwenPaw · ${name}` });
      }
      return out;
    },
  },
  configPath(environment) {
    const work = qwenpawWorking(environment);
    return path.join(qwenpawDirSync(work, environment.variant ?? "default"), "agent.json");
  },
  async read(environment) {
    const work = await qwenpawWorkingAt(environment);
    const profile = qwenpawProfileFor(environment, await qwenpawProfiles(environment, work));
    if (profile === null) return { connected: false, model: null, baseUrl: null };
    const agent = await readJsonIfThere(path.join(profile.dir, "agent.json")).catch(
      (): Record<string, unknown> => ({}),
    );
    const wired = readJsonString(agent, ["active_model", "provider_id"]) === SLOT;
    const secret = await qwenpawSecret(environment, work);
    const provider = wired
      ? await readJsonIfThere(qwenpawProviderPath(secret)).catch(
          (): Record<string, unknown> => ({}),
        )
      : {};
    const base = typeof provider.base_url === "string" ? provider.base_url : null;
    return {
      connected: wired,
      model: wired ? readJsonString(agent, ["active_model", "model"]) : null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const work = await qwenpawWorkingAt(environment);
    const profile = qwenpawProfileFor(environment, await qwenpawProfiles(environment, work));
    if (profile === null) throw new Error("QwenPaw has no such agent.");
    const filePath = path.join(profile.dir, "agent.json");
    if (!(await exists(filePath))) {
      throw new Error(
        `QwenPaw has no ${filePath} yet: start QwenPaw once (qwenpaw app) so it writes its agents' settings, then connect it.`,
      );
    }
    const agent = await readJsonObject(filePath);
    const backend = readJsonString(agent, ["backend"]) ?? "qwenpaw";
    if (backend !== "qwenpaw") {
      throw new Error(
        `This QwenPaw agent runs on the ${backend} backend, which does not use QwenPaw's models.`,
      );
    }
    const captured: Record<string, PriorValue> = {};
    capture(agent, captured, "active_model");
    const current = isRecord(agent.active_model) ? agent.active_model : {};
    const chosen = chosenModel(environment, model);
    setAtValue(agent, "active_model", {
      ...current,
      provider_id: SLOT,
      ...(chosen === null ? {} : { model: chosen }),
    });
    const agentUndo = await writeJsonWithUndo(filePath, agent, captured, undefined);

    const secret = await qwenpawSecret(environment, work);
    const providerPath = qwenpawProviderPath(secret);
    const before = await readTextOrNull(providerPath);
    const provider = qwenpawProvider(
      environment,
      before === null ? {} : (JSON.parse(before) as Record<string, unknown>),
    );
    const text = `${JSON.stringify(provider, null, 2)}\n`;
    await fs.mkdir(path.dirname(providerPath), { recursive: true, mode: 0o700 });
    await writeText(providerPath, text);
    // QwenPaw keeps its provider files to its user alone.
    await fs.chmod(providerPath, 0o600);
    return {
      kind: "multi",
      parts: [{ kind: "json", files: [agentUndo] }, textUndo(providerPath, before, text)],
    };
  },
  async disconnect(environment, undo) {
    const work = await qwenpawWorkingAt(environment);
    const profile = qwenpawProfileFor(environment, await qwenpawProfiles(environment, work));
    if (profile === null) return;
    const filePath = path.join(profile.dir, "agent.json");
    if (await exists(filePath)) {
      const agent = await readJsonIfThere(filePath);
      const prior = jsonPrior(undo, filePath);
      if (prior !== null) restore(agent, prior.values);
      else deleteAt(agent, "active_model");
      await writeJsonWithUndo(filePath, agent, {}, undo);
    }
    if (await qwenpawNamesNeolix(environment, work)) return;
    // debt: when another agent connected after this one, its undo holds
    // Neolix's provider file rather than the reader's, so Neolix's file is
    // left in place instead of risk restoring over theirs.
    const secret = await qwenpawSecret(environment, work);
    const providerPath = qwenpawProviderPath(secret);
    const part = priorPart(undo, "text", providerPath);
    if (part === null || part.kind !== "text") return;
    if (part.before === null) {
      await fs.rm(providerPath, { force: true });
      return;
    }
    let theirs = true;
    try {
      const parsed: unknown = JSON.parse(part.before);
      theirs = !(isRecord(parsed) && parsed.id === SLOT);
    } catch {
      theirs = true;
    }
    if (theirs) await writeText(providerPath, part.before);
  },
};

/**
 * The row's config path. QwenPaw lets a profile live outside its default
 * layout; the file is read for read/connect/disconnect, while this path is
 * the default one the row shows and the backup the service takes.
 */
function qwenpawDirSync(work: string, id: string): string {
  return path.join(work, "workspaces", id);
}

// ---------- T3 Code ----------

function t3Base(environment: ConnectEnvironment): string {
  const set = envOverride(environment.env, "T3CODE_HOME");
  return set === null ? homePath(environment, ".t3") : expandHome(environment, set);
}

function t3SettingsPath(environment: ConnectEnvironment): string {
  return path.join(t3Base(environment), "userdata", "settings.json");
}

function t3CatalogPath(environment: ConnectEnvironment): string {
  return path.join(t3Base(environment), "userdata", `${SLOT}-codex-models.json`);
}

async function t3AppInstalled(environment: ConnectEnvironment): Promise<boolean> {
  if (environment.platform !== "darwin") return false;
  const folders = [path.join(environment.homeDir, "Applications"), "/Applications"];
  for (const folder of folders) {
    for (const name of ["T3 Code (Alpha).app", "T3 Code.app"]) {
      if (await isDir(path.join(folder, name))) return true;
    }
  }
  return false;
}

/** Claude Code reads a dotted Claude version as a different name (myna's ClaudeSpelled). */
function claudeSpelled(id: string): string {
  return id.replace(/(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/gi, "$1-$2");
}

/** Claude Code's levels for a model, as 2.1.285 sends them (myna's claudeEffortsFor). */
function claudeEffortsFor(id: string): string[] {
  const match = /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:[^0-9]|$)/i.exec(
    claudeSpelled(id).toLowerCase(),
  );
  if (match === null) {
    return id.toLowerCase().includes("claude-3") ? [] : ALL_EFFORTS;
  }
  const name = `claude-${match[1]}-${match[2]}${match[3] === undefined ? "" : `-${match[3]}`}`;
  if (name === "claude-opus-4-5") return ["low", "medium", "high"];
  if (name === "claude-opus-4-6" || name === "claude-sonnet-4-6") {
    return ["low", "medium", "high", "max"];
  }
  if (
    ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4", "claude-sonnet-4"].includes(name)
  ) {
    return [];
  }
  return ALL_EFFORTS;
}

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function t3Capabilities(id: string): Record<string, unknown> | null {
  const efforts = claudeEffortsFor(id);
  const options: { id: string; label: string; isDefault?: boolean }[] = efforts.map((level) => ({
    id: level,
    label: EFFORT_LABELS[level],
  }));
  const descriptors: Record<string, unknown>[] = [];
  if (options.length > 0) {
    const fallback = options.find((entry) => entry.id === "medium") ?? options[0];
    if (fallback !== undefined) fallback.isDefault = true;
    descriptors.push({
      id: "effort",
      label: "Reasoning",
      type: "select",
      options,
    });
  }
  if (efforts.some((level) => level !== "none")) {
    descriptors.push({
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    });
  }
  return descriptors.length === 0 ? null : { optionDescriptors: descriptors };
}

/** A model's slug in T3: Claude Code's spelling, [1m] when its window is a million. */
function t3Slug(entry: AgentConnectModel): string {
  const spelled = claudeSpelled(entry.id);
  if (spelled.endsWith("[1m]")) return spelled;
  return (entry.contextWindow ?? 0) >= 1_000_000 ? `${spelled}[1m]` : spelled;
}

function t3CustomModels(environment: ConnectEnvironment): Record<string, unknown>[] {
  return environment.models.map((entry) => {
    const capabilities = t3Capabilities(entry.id);
    return {
      slug: t3Slug(entry),
      name: labelOf(entry),
      ...(capabilities === null ? {} : { capabilities }),
    };
  });
}

function t3Carried(settings: Record<string, unknown>, driver: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["binaryPath", "homePath"]) {
    const instance = readJsonString(settings, ["providerInstances", driver, "config", key]);
    const legacy = readJsonString(settings, ["providers", driver, key]);
    const value = (instance ?? legacy)?.trim();
    if (value !== undefined && value.length > 0) out[key] = value;
  }
  return out;
}

function t3ClaudeInstance(
  environment: ConnectEnvironment,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const vars = [
    { name: "ANTHROPIC_BASE_URL", value: environment.baseUrl, sensitive: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: environment.apiKey, sensitive: false },
    { name: "ENABLE_TOOL_SEARCH", value: "true", sensitive: false },
  ];
  return {
    driver: "claudeAgent",
    displayName: "Neox",
    enabled: true,
    environment: vars,
    config: {
      customModels: t3CustomModels(environment),
      ...t3Carried(settings, "claudeAgent"),
    },
  };
}

function t3TOML(value: string): string {
  return JSON.stringify(value);
}

function t3Arg(key: string, value: string): string {
  const escaped = `${key}=${value}`
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
  return `-c "${escaped}"`;
}

function t3CodexArgs(environment: ConnectEnvironment): string {
  const provider = `model_providers.${SLOT}.`;
  return [
    t3Arg("model_provider", t3TOML(SLOT)),
    t3Arg(`${provider}name`, t3TOML("Neox")),
    t3Arg(`${provider}base_url`, t3TOML(`${environment.baseUrl}/v1`)),
    t3Arg(`${provider}wire_api`, t3TOML("responses")),
    t3Arg(`${provider}experimental_bearer_token`, t3TOML(environment.apiKey)),
    t3Arg(`${provider}http_headers`, `{"x-openai-actor-authorization"="${SLOT}"}`),
    t3Arg("model_catalog_json", t3TOML(t3CatalogPath(environment))),
  ].join(" ");
}

function t3CodexInstance(
  environment: ConnectEnvironment,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return {
    driver: "codex",
    displayName: "Neox · Codex",
    enabled: true,
    config: {
      launchArgs: t3CodexArgs(environment),
      ...t3Carried(settings, "codex"),
    },
  };
}

/** What the reader set on Neolix's instance stays: its name, whether it is on, and other keys. */
function t3Merged(
  want: Record<string, unknown>,
  have: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...want };
  const name = typeof have.displayName === "string" ? have.displayName.trim() : "";
  if (name.length > 0) out.displayName = name;
  if (typeof have.enabled === "boolean") out.enabled = have.enabled;
  if (isRecord(have.config) && isRecord(want.config)) {
    out.config = { ...want.config };
    // Keys Neolix does not write (T3's own added settings, a binary path it
    // had nothing to carry) stay the reader's.
    for (const [key, value] of Object.entries(have.config)) {
      if ((out.config as Record<string, unknown>)[key] === undefined) {
        (out.config as Record<string, unknown>)[key] = value;
      }
    }
  }
  return out;
}

function t3ClaudeMerged(
  environment: ConnectEnvironment,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const want = t3ClaudeInstance(environment, settings);
  const have = isRecord(settings.providerInstances) ? settings.providerInstances[SLOT] : undefined;
  if (!isRecord(have)) return want;
  const merged = t3Merged(want, have);
  const env = Array.isArray(want.environment) ? [...want.environment] : [];
  const theirs = Array.isArray(have.environment) ? have.environment : [];
  const mine = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"]);
  for (const entry of theirs) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    if (mine.has(entry.name)) continue;
    if (entry.name === "ENABLE_TOOL_SEARCH") {
      const index = env.findIndex((item) => item.name === "ENABLE_TOOL_SEARCH");
      if (index >= 0) env.splice(index, 1);
    }
    env.push(entry);
  }
  merged.environment = env;
  return merged;
}

function t3CodexMerged(
  environment: ConnectEnvironment,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const want = t3CodexInstance(environment, settings);
  const have = isRecord(settings.providerInstances)
    ? settings.providerInstances[`${SLOT}-codex`]
    : undefined;
  return isRecord(have) ? t3Merged(want, have) : want;
}

/**
 * The levels the model is offered: the user's own list where they kept one
 * (myna's ModelEfforts, none at all for a model that does not reason),
 * otherwise the Claude model's own.
 */
function t3EffortsFor(environment: ConnectEnvironment, id: string): string[] {
  const config = environment.config;
  const slash = id.indexOf("/");
  if (config !== undefined && slash > 0) {
    const kept = modelEfforts(config, id.slice(0, slash), id.slice(slash + 1));
    if (kept !== null) return kept;
  }
  return claudeEffortsFor(id);
}

function t3Catalog(environment: ConnectEnvironment): string {
  const models = environment.models.map((entry, index) => {
    const reasoning = t3EffortsFor(environment, entry.id);
    const catalog: Record<string, unknown> = {
      slug: entry.id,
      display_name: labelOf(entry),
      description: `${labelOf(entry)} via Neox`,
      base_instructions: "",
      supported_reasoning_levels: reasoning.map((effort) => ({
        effort,
        description: EFFORT_LABELS[effort],
      })),
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: index + 1,
      support_verbosity: false,
      apply_patch_tool_type: "freeform",
      truncation_policy: { mode: "tokens", limit: 10000 },
      experimental_supported_tools: [],
      input_modalities: entry.images === true ? ["text", "image"] : ["text"],
      service_tiers: [],
      supports_search_tool: true,
      supports_parallel_tool_calls: true,
      supports_reasoning_summaries: reasoning.length > 0,
    };
    if (entry.contextWindow !== undefined) catalog.context_window = entry.contextWindow;
    return catalog;
  });
  return `${JSON.stringify({ models }, null, 1)}\n`;
}

const t3codeDriver: AgentConnectDriver = {
  provider: "t3code",
  external: {
    name: "T3 Code",
    icon: "t3code",
    detect: async (environment) =>
      isDir(t3Base(environment)) || (await t3AppInstalled(environment)),
  },
  configPath: t3SettingsPath,
  async read(environment) {
    const settings = await readJsonIfThere(t3SettingsPath(environment)).catch(
      (): Record<string, unknown> => ({}),
    );
    const instances = isRecord(settings.providerInstances) ? settings.providerInstances : {};
    const claude = isRecord(instances[SLOT]);
    const codex = isRecord(instances[`${SLOT}-codex`]);
    if (!claude && !codex) return { connected: false, model: null, baseUrl: null };
    let base: string | null = null;
    if (claude) base = t3EnvValue(settings, "ANTHROPIC_BASE_URL");
    if (base === null && codex) {
      const args = readJsonString(settings, [
        "providerInstances",
        `${SLOT}-codex`,
        "config",
        "launchArgs",
      ]);
      base = args === null ? null : t3CodexBaseOf(args);
    }
    return { connected: true, model: null, baseUrl: base === null ? null : stripV1(base) };
  },
  async connect(environment, _model, _undo) {
    const filePath = t3SettingsPath(environment);
    const settings = await readJsonIfThere(filePath).catch((): Record<string, unknown> => ({}));
    const captured: Record<string, PriorValue> = {};
    capture(settings, captured, `providerInstances.${SLOT}`);
    capture(settings, captured, `providerInstances.${SLOT}-codex`);
    setAtValue(settings, `providerInstances.${SLOT}`, t3ClaudeMerged(environment, settings));
    setAtValue(settings, `providerInstances.${SLOT}-codex`, t3CodexMerged(environment, settings));
    const settingsUndo = await writeJsonWithUndo(filePath, settings, captured, undefined);
    const catalogPath = t3CatalogPath(environment);
    const before = await readTextOrNull(catalogPath);
    const text = t3Catalog(environment);
    await writeText(catalogPath, text);
    return {
      kind: "multi",
      parts: [{ kind: "json", files: [settingsUndo] }, textUndo(catalogPath, before, text)],
    };
  },
  async disconnect(environment, undo) {
    const filePath = t3SettingsPath(environment);
    if (await exists(filePath)) {
      const settings = await readJsonIfThere(filePath);
      const prior = jsonPrior(undo, filePath);
      if (prior !== null) restore(settings, prior.values);
      await writeJsonWithUndo(filePath, settings, {}, undo);
    }
    const catalogPath = t3CatalogPath(environment);
    const part = priorPart(undo, "text", catalogPath);
    if (part === null || part.kind !== "text") return;
    if (part.before === null) await fs.rm(catalogPath, { force: true });
    else await writeText(catalogPath, part.before);
  },
};

/** One of Neolix's instance environment values, as T3 keeps it. */
function t3EnvValue(settings: Record<string, unknown>, name: string): string | null {
  const instances = isRecord(settings.providerInstances) ? settings.providerInstances : {};
  const instance = isRecord(instances[SLOT]) ? instances[SLOT] : {};
  const vars = Array.isArray(instance.environment) ? instance.environment : [];
  for (const entry of vars) {
    if (isRecord(entry) && entry.name === name && typeof entry.value === "string") {
      return entry.value;
    }
  }
  return null;
}

/** The base URL T3's launch arguments give Neolix's Codex provider (myna's t3CodexBaseOf). */
function t3CodexBaseOf(args: string): string | null {
  const tokens = t3Tokens(args);
  let base: string | null = null;
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    if (tokens[index] !== "-c" && tokens[index] !== "--config") continue;
    const pair = tokens[index + 1] ?? "";
    index += 1;
    const cut = pair.indexOf("=");
    if (cut < 0 || pair.slice(0, cut).trim() !== `model_providers.${SLOT}.base_url`) continue;
    const value = pair.slice(cut + 1).trim();
    try {
      const parsed: unknown = JSON.parse(value);
      base = typeof parsed === "string" ? parsed : value.replace(/^["']|["']$/g, "");
    } catch {
      base = value.replace(/^["']|["']$/g, "");
    }
  }
  return base;
}

/** T3 Code's tokenizeCliArgs, for reading back an instance's launch arguments. */
function t3Tokens(input: string): string[] {
  const text = [...input.trim()];
  const out: string[] = [];
  const state = { current: "", quote: "", quoted: false, index: 0 };
  while (state.index < text.length) {
    const char = text[state.index] as string;
    const next = text[state.index + 1] ?? "";
    if (state.quote.length > 0) {
      t3QuotedStep(state, char, next);
      continue;
    }
    if (char === "'" || char === '"') {
      state.quote = char;
      state.quoted = true;
      state.index += 1;
    } else if (T3_SPACES.includes(char)) {
      if (state.current.length > 0 || state.quoted) {
        out.push(state.current);
        state.current = "";
        state.quoted = false;
      }
      state.index += 1;
    } else if (char === "\\" && (T3_SPACES.includes(next) || "'\"".includes(next))) {
      state.current += next;
      state.index += 2;
    } else {
      state.current += char;
      state.index += 1;
    }
  }
  if (state.current.length > 0 || state.quoted) out.push(state.current);
  return out;
}

const T3_SPACES = " \t\n\r\f\v";

/** One character inside a quoted argument, as T3's tokenizer reads it. */
function t3QuotedStep(
  state: { current: string; quote: string; quoted: boolean; index: number },
  char: string,
  next: string,
): void {
  if (char === state.quote) {
    state.quote = "";
    state.quoted = true;
    state.index += 1;
    return;
  }
  if (char === "\\" && state.quote === '"' && '"\\$`'.includes(next)) {
    state.current += next;
    state.index += 2;
    return;
  }
  state.current += char;
  state.index += 1;
}

export const BATCH16_AGENT_DRIVERS: AgentConnectDriver[] = [qwenpawDriver, t3codeDriver];
