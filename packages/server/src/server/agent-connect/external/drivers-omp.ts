import { promises as fs } from "node:fs";
import path from "node:path";
import { type Document, isMap, isScalar, isSeq, parseDocument, type YAMLSeq } from "yaml";
import { modelEfforts } from "../../llm-gateway/model-prefs.js";
import { pathExists, readJsonObject, readTextOrNull } from "../config-files.js";
import {
  type AgentConnectDriver,
  type AgentConnectFieldSetting,
  type AgentConnectUndo,
  type ConnectEnvironment,
  PROVIDER_ID,
  type PriorValue,
  capture,
  stripV1,
} from "../drivers.js";
import { isDir, isOnPath, writeText } from "./helpers.js";

/**
 * omp (oh-my-pi, a fork of Pi) reads its settings from ~/.omp/agent:
 * config.yml (model roles) and models.yml (the user's providers), each falling
 * back to .yaml. PI_CONFIG_DIR renames the root, OMP_PROFILE/PI_PROFILE move
 * the folder to profiles/<name>/agent, and PI_CODING_AGENT_DIR moves it
 * outright. Neolix adds the provider "neolix" to models.yml and makes the
 * default role start on neolix/<model>; omp matches a model as
 * provider/id, so the gateway's ids sit under Neolix's provider.
 *
 * enabledModels holds a new session to its list: a default role outside it
 * never starts, so Neolix adds neolix/** there when the list already exists
 * (myna's omp_scope.go). No list is ever created.
 */

const OMP_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The first omp whose compat takes the prompt-cache session header. */
const OMP_SESSION_SINCE = "16.0.6";

/** The first omp whose models.yml takes max as a thinking effort. */
const OMP_MAX_SINCE = "16.4.0";

/** The first omp whose models.yml takes a model's kind and openai-images (myna's ompKindSince). */
const OMP_KIND_SINCE = "18.7.0";

/** omp's model roles, as myna's omp.go lists them: the default's field is "model". */
const OMP_ROLES: { key: string; label: string; role: string }[] = [
  { key: "model", label: "model", role: "default" },
  { key: "subagent", label: "subagents", role: "task" },
  { key: "small", label: "smol", role: "smol" },
  { key: "slow", label: "slow", role: "slow" },
  { key: "plan", label: "plan", role: "plan" },
  { key: "vision", label: "vision", role: "vision" },
  { key: "advisor", label: "advisor", role: "advisor" },
  { key: "commit", label: "commit", role: "commit" },
  { key: "tiny", label: "tiny", role: "tiny" },
  { key: "memory", label: "memory", role: "memory" },
];

/** A role's thinking levels, auto and off included (myna's role thinking field). */
const OMP_THINKING = ["auto", "off", ...OMP_EFFORTS];

/** Where omp's config names models (myna's ompRefKeys). */
const OMP_REF_KEYS = [
  "modelRoles",
  "retry.fallbackChains",
  "enabledModels",
  "task.agentModelOverrides",
];

const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const RESERVED_PROFILE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/iu;

/** omp's profile rule (pi-utils dirs.ts): "default" names none. */
function ompProfileOk(name: string): boolean {
  return (
    name !== "" &&
    name !== "default" &&
    PROFILE_NAME.test(name) &&
    !name.endsWith(".") &&
    !RESERVED_PROFILE.test(name)
  );
}

function ompRoot(environment: ConnectEnvironment): string {
  // A distro's own variables that move it aren't read (myna's ompIn).
  if (environment.wsl !== undefined) return path.join(environment.homeDir, ".omp");
  const renamed = environment.env.PI_CONFIG_DIR?.trim();
  return renamed ? path.join(environment.homeDir, renamed) : path.join(environment.homeDir, ".omp");
}

/** The profile OMP_PROFILE/PI_PROFILE names for the host row, "" when none. */
function ompDefaultProfile(environment: ConnectEnvironment): string {
  if (environment.wsl !== undefined) return "";
  return (environment.env.OMP_PROFILE ?? environment.env.PI_PROFILE ?? "").trim();
}

/** The named profile this row is (a variant), null for the host row. */
function ompVariantOf(environment: ConnectEnvironment): string | null {
  const variant = environment.variant?.trim() ?? "";
  return ompProfileOk(variant) ? variant : null;
}

/** omp's agent folder, found as omp's own dirs.ts finds it. */
function ompAgentDir(environment: ConnectEnvironment): string {
  const root = ompRoot(environment);
  const variant = ompVariantOf(environment);
  if (variant !== null) return path.join(root, "profiles", variant, "agent");
  // A distro's omp keeps its default folder whatever its variables say.
  if (environment.wsl !== undefined) return path.join(root, "agent");
  const profile = ompDefaultProfile(environment);
  if (ompProfileOk(profile)) {
    return path.join(root, "profiles", profile, "agent");
  }
  const moved = environment.env.PI_CODING_AGENT_DIR?.trim();
  if (moved !== undefined && moved.length > 0 && path.isAbsolute(moved)) {
    return path.resolve(moved);
  }
  return path.join(root, "agent");
}

function ompProfilesRoot(environment: ConnectEnvironment): string {
  return path.join(ompRoot(environment), "profiles");
}

/**
 * The named omp profiles under ~/.omp/profiles (myna's ompProfiles): each is
 * an agent of its own with its own config.yml and models.yml. The profile
 * the host row already picks is left out.
 */
async function ompProfiles(
  environment: ConnectEnvironment,
): Promise<{ id: string; name: string }[]> {
  let entries;
  try {
    entries = await fs.readdir(ompProfilesRoot(environment), { withFileTypes: true });
  } catch {
    return [];
  }
  const current = ompDefaultProfile(environment);
  const names = entries
    .filter((entry) => entry.isDirectory() && ompProfileOk(entry.name) && entry.name !== current)
    .map((entry) => entry.name)
    .sort();
  return names.map((name) => ({ id: name, name: `omp · ${name}` }));
}

/** Whether omp is here (myna's Detected): its config, its folder, its command or a profile. */
async function ompDetected(environment: ConnectEnvironment): Promise<boolean> {
  if (await pathExists(ompConfigPath(environment))) return true;
  const moved = environment.env.PI_CODING_AGENT_DIR?.trim();
  const shared =
    environment.wsl === undefined &&
    environment.variant === undefined &&
    moved !== undefined &&
    moved.length > 0 &&
    path.isAbsolute(moved);
  if (!shared && (await isDir(ompAgentDir(environment)))) return true;
  if (await isOnPath("omp", environment)) return true;
  if (environment.variant === undefined) {
    return (await ompProfiles(environment)).length > 0;
  }
  return false;
}

/** omp reads <name>.yml and falls back to <name>.yaml. */
async function pickYaml(dir: string, name: string): Promise<string> {
  const yml = path.join(dir, `${name}.yml`);
  if (await pathExists(yml)) return yml;
  const yaml = path.join(dir, `${name}.yaml`);
  return (await pathExists(yaml)) ? yaml : yml;
}

/** The path configPath names: the .yml omp writes when it has neither file. */
function ompConfigPath(environment: ConnectEnvironment): string {
  return path.join(ompAgentDir(environment), "config.yml");
}

async function ompConfigFile(environment: ConnectEnvironment): Promise<string> {
  return pickYaml(ompAgentDir(environment), "config");
}

async function ompModelsFile(environment: ConnectEnvironment): Promise<string> {
  return pickYaml(ompAgentDir(environment), "models");
}

async function readYaml(filePath: string): Promise<Document> {
  const text = (await readTextOrNull(filePath)) ?? "";
  return parseDocument(text) as Document;
}

async function writeYaml(filePath: string, document: Document): Promise<void> {
  await writeText(filePath, document.toString());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first three parts of a semantic version, compared as numbers. */
function atLeast(version: string | null, since: string): boolean {
  if (version === null) return false;
  const installed = /^(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  const wanted = /^(\d+)\.(\d+)\.(\d+)/u.exec(since);
  if (installed === null || wanted === null) return false;
  for (let index = 1; index <= 3; index += 1) {
    const left = Number(installed[index]);
    const right = Number(wanted[index]);
    if (left !== right) return left > right;
  }
  return true;
}

async function probeOmpVersion(environment: ConnectEnvironment): Promise<string | null> {
  if (environment.run === undefined) return null;
  try {
    const output = await environment.run("omp", ["--version"]);
    return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/u.exec(output)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** A role's model and thinking level, as omp's splitThinkingSuffix reads them. */
function splitOmpValue(value: string): { model: string; level: string; one: boolean } {
  if (value.includes(",")) return { model: value, level: "", one: false };
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const level = value.slice(colon + 1);
    if (level === "off" || level === "auto" || OMP_EFFORTS.some((entry) => entry === level)) {
      return { model: value.slice(0, colon), level, one: true };
    }
  }
  return { model: value, level: "", one: true };
}

/** The gateway model id a role's value names, or null when it names another provider. */
function ompModelOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const { model, one } = splitOmpValue(value.trim());
  if (!one) return null;
  const prefix = `${PROVIDER_ID}/`;
  return model.startsWith(prefix) ? model.slice(prefix.length) : null;
}

/** omp's enabledModels entry for Neolix's whole catalog. */
function ompEvery(): string {
  return `${PROVIDER_ID}/**`;
}

function stripLevel(value: string): string {
  const level = splitOmpValue(value);
  return level.level === "" ? value : level.model;
}

/** Whether one enabledModels entry takes model in (Bun.Glob's * stops at a slash). */
function ompTakes(pattern: string, model: string): boolean {
  const candidate = stripLevel(pattern.trim()).toLowerCase();
  const wanted = model.toLowerCase();
  if (candidate.endsWith("**")) {
    const base = candidate.slice(0, -2);
    if (!/[*?[]/u.test(base)) return wanted.startsWith(base);
  }
  return candidate === wanted;
}

function enabledModelsOf(document: Document): YAMLSeq | null {
  const contents = document.contents;
  if (!isMap(contents)) return null;
  const pair = contents.items.find(
    (item) => isScalar(item.key) && item.key.value === "enabledModels",
  );
  return pair !== undefined && isSeq(pair.value) ? pair.value : null;
}

/**
 * Lets a new session start on model when enabledModels has plain entries and
 * none takes it in. For Neolix's models the whole catalog joins as neolix/**,
 * replacing the plain neolix/<model> entries an earlier write added; a list
 * that names no plain entry is never created or made non-empty.
 */
function ompScopeWith(document: Document, model: string): void {
  const sequence = enabledModelsOf(document);
  if (sequence === null) return;
  const values = sequence.items
    .filter((item) => isScalar(item) && typeof item.value === "string")
    .map((item) => String((item as { value: unknown }).value).trim());
  if (values.length === 0) return;
  if (values.some((entry) => ompTakes(entry, model))) return;
  const own = values.some((entry) => {
    const bare = stripLevel(entry);
    const glob = /[*?[]/u.test(bare);
    return (
      (glob && ompTakes(bare, model)) ||
      (bare.toLowerCase().startsWith(`${PROVIDER_ID}/`) &&
        (glob || splitOmpValue(entry).level !== ""))
    );
  });
  if (own) {
    sequence.items.push(document.createNode(model));
    return;
  }
  const kept = sequence.items.filter((item) => {
    if (!isScalar(item) || typeof item.value !== "string") return true;
    const value = item.value.trim();
    return !(!/[*?[]/u.test(value) && value.toLowerCase().startsWith(`${PROVIDER_ID}/`));
  });
  kept.push(document.createNode(ompEvery()));
  sequence.items = kept;
}

/** Takes Neolix's entries out of enabledModels on a disconnect with no undo. */
function ompScopeWithout(document: Document): void {
  const sequence = enabledModelsOf(document);
  if (sequence === null) return;
  const kept = sequence.items.filter((item) => {
    if (!isScalar(item) || typeof item.value !== "string") return true;
    const value = item.value.trim();
    return !(
      value.toLowerCase() === ompEvery().toLowerCase() ||
      (!/[*?[]/u.test(value) && value.toLowerCase().startsWith(`${PROVIDER_ID}/`))
    );
  });
  if (kept.length === sequence.items.length) return;
  if (kept.length === 0) {
    document.deleteIn(["enabledModels"]);
    return;
  }
  sequence.items = kept;
}

type YamlValues = Record<string, PriorValue>;

function captureYaml(document: Document, values: YamlValues, at: string[]): void {
  capture(document.toJS() as Record<string, unknown>, values, at.join("."));
}

function restoreYaml(document: Document, values: YamlValues): void {
  for (const [key, prior] of Object.entries(values)) {
    const at = key.split(".");
    if (prior.present) {
      document.setIn(at, prior.value);
      continue;
    }
    document.deleteIn(at);
    const parent = at.slice(0, -1);
    if (prior.parentPresent === true && parent.length > 0 && !document.hasIn(parent)) {
      document.setIn(parent, {});
    }
  }
}

function yamlUndo(filePath: string, values: YamlValues): AgentConnectUndo {
  return { kind: "yaml", path: filePath, values };
}

function yamlParts(
  undo: AgentConnectUndo | undefined,
): Extract<AgentConnectUndo, { kind: "yaml" }>[] {
  if (undo === undefined) return [];
  if (undo.kind === "yaml") return [undo];
  if (undo.kind === "multi") return undo.parts.flatMap(yamlParts);
  return [];
}

function effortsFor(environment: ConnectEnvironment, id: string, version: string | null): string[] {
  const config = environment.config;
  const slash = id.indexOf("/");
  if (config === undefined || slash <= 0) return [];
  const kept = modelEfforts(config, id.slice(0, slash), id.slice(slash + 1)) ?? [];
  if (kept.length === 0) return [];
  const takesMax = version !== null && atLeast(version, OMP_MAX_SINCE);
  const levels = new Set<string>();
  for (const effort of kept) {
    if (effort === "max" && !takesMax) {
      levels.add("xhigh");
      continue;
    }
    levels.add(effort);
  }
  return OMP_EFFORTS.filter((effort) => levels.has(effort));
}

/**
 * The gateway's image models as omp's image role takes them (myna's
 * ompImageModels): kind image on openai-images, which omp's generate_image
 * posts to baseUrl + /images/generations. An omp before 18.7.0 or one whose
 * version isn't known writes none: its schema turns the whole file away.
 */
function ompImageModels(
  environment: ConnectEnvironment,
  version: string | null,
  chat: { id?: unknown }[],
): Record<string, unknown>[] {
  if (!atLeast(version, OMP_KIND_SINCE)) return [];
  return (environment.gatewayImageModels ?? [])
    .filter((id) => !chat.some((model) => String(model.id) === id))
    .map((id) => ({ id, name: id, api: "openai-images", kind: "image", input: ["text"] }));
}

/** Neolix's entry in models.yml, as omp 16 and later read it. */
function ompProvider(
  environment: ConnectEnvironment,
  version: string | null,
): Record<string, unknown> {
  const models = environment.models
    .filter((model) => model.kind !== "image")
    .map((model) => {
      const entry: Record<string, unknown> = {
        id: model.id,
        name: model.label ?? model.id,
        reasoning: false,
      };
      if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow;
      if (model.maxOutputTokens !== undefined) entry.maxTokens = model.maxOutputTokens;
      if (model.images !== undefined) {
        entry.input = model.images ? ["text", "image"] : ["text"];
      }
      const efforts = effortsFor(environment, model.id, version);
      if (efforts.length > 0) {
        entry.reasoning = true;
        entry.thinking = { mode: "effort", efforts };
      }
      return entry;
    });
  models.push(...ompImageModels(environment, version, models));
  const provider: Record<string, unknown> = {
    baseUrl: `${environment.baseUrl}/v1`,
    api: "openai-completions",
    apiKey: environment.apiKey,
    headers: { "User-Agent": "omp" },
    models,
  };
  if (atLeast(version, OMP_SESSION_SINCE)) {
    provider.compat = { promptCacheSessionHeader: "x-session-affinity" };
  }
  return provider;
}

/** Writes Neolix's provider entry into models.yml without an undo (a field write). */
async function ompWriteProvider(environment: ConnectEnvironment): Promise<void> {
  const modelsPath = await ompModelsFile(environment);
  let models = await readYaml(modelsPath);
  if ((await readTextOrNull(modelsPath)) === null) {
    const legacy = path.join(ompAgentDir(environment), "models.json");
    if (await pathExists(legacy)) {
      models = parseDocument(JSON.stringify(await readJsonObject(legacy))) as Document;
    }
  }
  models.setIn(
    ["providers", PROVIDER_ID],
    ompProvider(environment, await probeOmpVersion(environment)),
  );
  await writeYaml(modelsPath, models);
}

/** Every string in a config that a model may be named in. */
function ompRefStrings(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) walk(entry);
    }
  };
  for (const key of OMP_REF_KEYS) {
    const parts = key.split(".");
    let current: unknown = config;
    for (const part of parts) {
      current = isRecord(current) ? current[part] : undefined;
    }
    if (current !== undefined) walk(current);
  }
  return out;
}

function ompNamed(value: string): boolean {
  return value.split(",").some((entry) => stripLevel(entry.trim()).startsWith(`${PROVIDER_ID}/`));
}

/** Drops Neolix's provider once no role, chain or list names it (myna's dropMyna). */
async function ompDropIfUnused(environment: ConnectEnvironment, config: Document): Promise<void> {
  const strings = ompRefStrings(config.toJS() as Record<string, unknown>);
  if (strings.some((entry) => ompNamed(entry))) return;
  const modelsPath = await ompModelsFile(environment);
  if (!(await pathExists(modelsPath))) return;
  const models = await readYaml(modelsPath);
  models.deleteIn(["providers", PROVIDER_ID]);
  await writeYaml(modelsPath, models);
}

function ompRoleRaw(config: Record<string, unknown>, role: string): string {
  const roles = isRecord(config.modelRoles) ? config.modelRoles : {};
  return typeof roles[role] === "string" ? roles[role] : "";
}

/** The models a role can pick: the gateway's, then whatever it holds now. */
function ompRoleOptions(environment: ConnectEnvironment, current: string): string[] {
  const options = environment.models.map((model) => `${PROVIDER_ID}/${model.id}`);
  return current !== "" && !options.includes(current) ? [...options, current] : options;
}

/** The agent's own fields, as myna's omp.go Fields read them. */
async function ompSettings(environment: ConnectEnvironment): Promise<AgentConnectFieldSetting[]> {
  const config = ((await readYaml(await ompConfigFile(environment))).toJS() ?? {}) as Record<
    string,
    unknown
  >;
  const out: AgentConnectFieldSetting[] = [];
  for (const [index, role] of OMP_ROLES.entries()) {
    const current = ompRoleRaw(config, role.role);
    out.push({
      key: role.key,
      label: role.label,
      value: current,
      options: ompRoleOptions(environment, current),
    });
    if (index === 0) continue;
    const split = splitOmpValue(current);
    out.push({
      key: `${role.key}_thinking`,
      label: `${role.label} thinking`,
      value: current === "" || !split.one ? "" : split.level,
      ...(current === "" || !split.one ? {} : { options: OMP_THINKING }),
    });
  }
  const thinking = config.defaultThinkingLevel;
  out.push({
    key: "effort",
    label: "thinking",
    value: typeof thinking === "string" ? thinking : "",
    options: ["auto", ...OMP_EFFORTS],
  });
  return out;
}

/** Writes one of omp's own fields (myna's Field.Set), never a reconnect. */
async function ompSetSetting(
  environment: ConnectEnvironment,
  key: string,
  value: string,
): Promise<void> {
  const configPath = await ompConfigFile(environment);
  const config = await readYaml(configPath);
  const snapshot = config.toJS() as Record<string, unknown>;
  if (key === "effort") {
    if (value === "") {
      config.deleteIn(["defaultThinkingLevel"]);
    } else {
      if (!["auto", ...OMP_EFFORTS].includes(value)) {
        throw new Error(`"${value}" is not one of omp's thinking levels`);
      }
      config.setIn(["defaultThinkingLevel"], value);
    }
    await writeYaml(configPath, config);
    return;
  }
  const thinking = key.endsWith("_thinking");
  const role = OMP_ROLES.find((entry) => (thinking ? `${entry.key}_thinking` : entry.key) === key);
  if (role === undefined) throw new Error(`omp has no field "${key}"`);
  const current = ompRoleRaw(snapshot, role.role);
  if (thinking) {
    const split = splitOmpValue(current);
    if (current === "" || !split.one) {
      if (value === "") return;
      throw new Error(`omp's ${role.label} role is not on one model: pick its model first`);
    }
    if (value !== "" && !OMP_THINKING.includes(value)) {
      throw new Error(`"${value}" is not one of omp's thinking levels`);
    }
    const next = value === "" ? split.model : `${split.model}:${value}`;
    await ompApplyRole(environment, config, role, next);
    await writeYaml(configPath, config);
    return;
  }
  if (value === "") {
    config.deleteIn(["modelRoles", role.role]);
    if (role.role === "default") ompScopeWithout(config);
    await ompDropIfUnused(environment, config);
    await writeYaml(configPath, config);
    return;
  }
  let next = value.startsWith(`${PROVIDER_ID}/`) ? value : `${PROVIDER_ID}/${value}`;
  const split = splitOmpValue(next);
  const was = splitOmpValue(current);
  // another model keeps the role's thinking level, as myna's Set does
  if (split.level === "" && was.one && was.level !== "" && was.model !== split.model) {
    next += `:${was.level}`;
  }
  await ompApplyRole(environment, config, role, next);
  await writeYaml(configPath, config);
}

async function ompApplyRole(
  environment: ConnectEnvironment,
  config: Document,
  role: { key: string; label: string; role: string },
  value: string,
): Promise<void> {
  if (value.startsWith(`${PROVIDER_ID}/`)) {
    await ompWriteProvider(environment);
  }
  config.setIn(["modelRoles", role.role], value);
  if (role.role === "default") ompScopeWith(config, stripLevel(value));
}

export const ompDriver: AgentConnectDriver = {
  provider: "omp",
  external: {
    name: "omp",
    icon: "omp",
    detect: ompDetected,
    variants: ompProfiles,
    // A gateway catalog change rewrites the list Neolix keeps (myna's Sync).
    refreshModels: true,
  },
  version: (environment) => probeOmpVersion(environment),
  configPath: ompConfigPath,
  settings: ompSettings,
  setSetting: ompSetSetting,
  async read(environment) {
    const config = ((await readYaml(await ompConfigFile(environment))).toJS() ?? {}) as Record<
      string,
      unknown
    >;
    const models = ((await readYaml(await ompModelsFile(environment))).toJS() ?? {}) as Record<
      string,
      unknown
    >;
    const roles = isRecord(config.modelRoles) ? config.modelRoles : {};
    const providers = isRecord(models.providers) ? models.providers : {};
    const role = roles.default;
    const entry = providers[PROVIDER_ID];
    const base = isRecord(entry) && typeof entry.baseUrl === "string" ? entry.baseUrl : null;
    return {
      connected: ompModelOf(role) !== null,
      model: ompModelOf(role),
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const chosen = model ?? environment.models[0]?.id ?? null;
    if (chosen === null) throw new Error("The gateway serves no models for omp.");
    const configPath = await ompConfigFile(environment);
    const modelsPath = await ompModelsFile(environment);
    const config = await readYaml(configPath);
    let models = await readYaml(modelsPath);
    // omp moves its older models.json to models.yml only while models.yml is
    // still missing, so a models.yml Neolix writes first has to carry it over.
    if ((await readTextOrNull(modelsPath)) === null) {
      const legacy = path.join(ompAgentDir(environment), "models.json");
      if (await pathExists(legacy)) {
        models = parseDocument(JSON.stringify(await readJsonObject(legacy))) as Document;
      }
    }
    const configValues: YamlValues = {};
    const modelsValues: YamlValues = {};
    captureYaml(config, configValues, ["modelRoles", "default"]);
    captureYaml(config, configValues, ["enabledModels"]);
    captureYaml(models, modelsValues, ["providers", PROVIDER_ID]);
    const version = await probeOmpVersion(environment);
    models.setIn(["providers", PROVIDER_ID], ompProvider(environment, version));
    const value = `${PROVIDER_ID}/${chosen}`;
    config.setIn(["modelRoles", "default"], value);
    ompScopeWith(config, value);
    await writeYaml(modelsPath, models);
    await writeYaml(configPath, config);
    return {
      kind: "multi",
      parts: [yamlUndo(modelsPath, modelsValues), yamlUndo(configPath, configValues)],
    };
  },
  async disconnect(environment, undo) {
    const parts = yamlParts(undo);
    if (parts.length > 0) {
      for (const part of parts) {
        if (!(await pathExists(part.path))) continue;
        const document = await readYaml(part.path);
        restoreYaml(document, part.values);
        await writeYaml(part.path, document);
      }
      return;
    }
    const configPath = await ompConfigFile(environment);
    const modelsPath = await ompModelsFile(environment);
    if (await pathExists(modelsPath)) {
      const models = await readYaml(modelsPath);
      models.deleteIn(["providers", PROVIDER_ID]);
      await writeYaml(modelsPath, models);
    }
    if (await pathExists(configPath)) {
      const config = await readYaml(configPath);
      if (ompModelOf(config.getIn(["modelRoles", "default"])) !== null) {
        config.deleteIn(["modelRoles", "default"]);
      }
      ompScopeWithout(config);
      await writeYaml(configPath, config);
    }
  },
};
