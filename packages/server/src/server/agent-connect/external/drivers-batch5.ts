import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { parse, stringify } from "yaml";
import { readJsonObject, readTextOrNull } from "../config-files.js";
import {
  capture,
  type AgentConnectDriver,
  type AgentConnectUndo,
  type ConnectEnvironment,
  type PriorValue,
  restore,
  setAtValue,
  stripV1,
  writeJsonWithUndo,
} from "../drivers.js";
import {
  configHome,
  envOverride,
  isDir,
  isOnPath,
  readEnvFile,
  readYamlDocument,
  removeEnvValues,
  setEnvValues,
  writeText,
  writeYamlDocument,
} from "./helpers.js";

const SLOT = "neolix";

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
}

function labelOf(model: AgentConnectModel): string {
  return model.label ?? model.id;
}

function readJsonString(root: Record<string, unknown>, jsonPath: string[]): string | null {
  let current: unknown = root;
  for (const key of jsonPath) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
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

async function restoreJsonFile(
  filePath: string,
  undo: AgentConnectUndo | undefined,
): Promise<void> {
  if (!(await exists(filePath))) return;
  const root = await readJsonObject(filePath);
  const prior =
    undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : undefined;
  if (prior) restore(root, prior.values);
  await writeJsonWithUndo(filePath, root, {}, undo);
}

async function readJsonIfThere(filePath: string): Promise<Record<string, unknown>> {
  if (!(await exists(filePath))) return {};
  return readJsonObject(filePath);
}

/** The OpenCode config OpenChamber runs on: the same file Neolix's OpenCode provider writes. */
function openCodeConfigPath(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "OPENCODE_CONFIG_DIR");
  const dir =
    override !== null && path.isAbsolute(override)
      ? override
      : path.join(configHome(environment), "opencode");
  return path.join(dir, "opencode.json");
}

function openCodeProvider(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Neox",
    options: {
      baseURL: `${environment.baseUrl}/v1`,
      apiKey: environment.apiKey,
    },
    models: Object.fromEntries(environment.models.map((entry) => [entry.id, openCodeModel(entry)])),
  };
}

/** A model in OpenCode's provider shape, with what the catalog knows of it. */
function openCodeModel(model: AgentConnectModel): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: labelOf(model) };
  if (model.contextWindow !== undefined) {
    entry.limit = {
      context: model.contextWindow,
      ...(model.maxOutputTokens === undefined ? {} : { output: model.maxOutputTokens }),
    };
  }
  if (model.images === true) {
    entry.modalities = { input: ["text", "image"], output: ["text"] };
  }
  return entry;
}

// ---------- ZCode ----------

function zcodeDir(environment: ConnectEnvironment): string {
  return path.join(environment.homeDir, ".zcode");
}

function zcodeConfigPath(environment: ConnectEnvironment): string {
  return path.join(zcodeDir(environment), "v2", "config.json");
}

function zcodeRulesPath(environment: ConnectEnvironment): string {
  return path.join(zcodeDir(environment), "v2", "provider_config.json");
}

function zcodeRuleConfig(environment: ConnectEnvironment, ids: string[]): Record<string, unknown> {
  return {
    group: "standard-personal",
    access: { type: "api-key", apiKey: environment.apiKey },
    api: { type: "anthropic-messages", baseUrl: environment.baseUrl },
    personalModelIds: ids,
    modelOrder: ids,
  };
}

function zcodeProviderRule(
  environment: ConnectEnvironment,
  ids: string[],
): Record<string, unknown> {
  return {
    providerId: SLOT,
    providerName: "Neox",
    enabled: true,
    config: zcodeRuleConfig(environment, ids),
  };
}

/** A model as config.json lists it, with the window and inputs the catalog knows. */
function zcodeModel(model: AgentConnectModel): Record<string, unknown> {
  const limit: Record<string, number> = {};
  if (model.contextWindow !== undefined) limit.context = model.contextWindow;
  if (model.maxOutputTokens !== undefined) {
    // ZCode offers whatever is here as the reply's limit, so a vendor that
    // reports its window there is cut to what Neolix lets a reply take.
    limit.output = Math.min(model.maxOutputTokens, 128000);
  }
  return {
    name: labelOf(model),
    ...(Object.keys(limit).length === 0 ? {} : { limit }),
    modalities: {
      input: model.images === true ? ["text", "image"] : ["text"],
      output: ["text"],
    },
  };
}

function zcodeModelRule(model: AgentConnectModel): Record<string, unknown> {
  const properties: Record<string, unknown> = { supportsNativeWebSearch: true };
  if (model.contextWindow !== undefined) properties.contextWindow = model.contextWindow;
  if (model.images !== undefined) {
    properties.inputFormat = { supportsImage: model.images };
  }
  return {
    providerId: SLOT,
    modelId: model.id,
    config: { properties },
  };
}

/** The rule list under a dotted path, or [] when ZCode (or the user) left none. */
function zcodeRulesAt(rules: Record<string, unknown>, keys: string[]): unknown[] {
  let current: unknown = rules;
  for (const key of keys) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function zcodeIsOurs(value: unknown): boolean {
  return isRecord(value) && value.providerId === SLOT;
}

function zcodeConnected(rules: Record<string, unknown>): boolean {
  return zcodeRulesAt(rules, ["config", "providerConfigRules", "providerRules"]).some(zcodeIsOurs);
}

function zcodeStripOurs(rules: Record<string, unknown>): Record<string, unknown> {
  const config = isRecord(rules.config) ? rules.config : {};
  const providerConfigRules = isRecord(config.providerConfigRules)
    ? config.providerConfigRules
    : {};
  const modelConfigRules = isRecord(config.modelConfigRules) ? config.modelConfigRules : {};
  providerConfigRules.providerRules = zcodeRulesAt(config, [
    "providerConfigRules",
    "providerRules",
  ]).filter((entry) => !zcodeIsOurs(entry));
  modelConfigRules.providerModelRules = zcodeRulesAt(config, [
    "modelConfigRules",
    "providerModelRules",
  ]).filter((entry) => !zcodeIsOurs(entry));
  config.providerConfigRules = providerConfigRules;
  config.modelConfigRules = modelConfigRules;
  return { ...rules, schemaVersion: rules.schemaVersion ?? 1, config };
}

const zcodeDriver: AgentConnectDriver = {
  provider: "zcode",
  external: {
    name: "ZCode",
    icon: "zcode",
    detect: async (environment) =>
      (await isOnPath("zcode", environment)) || (await isDir(zcodeDir(environment))),
  },
  configPath: zcodeConfigPath,
  async read(environment) {
    const config = await readJsonIfThere(zcodeConfigPath(environment));
    const rules = await readJsonIfThere(zcodeRulesPath(environment));
    const provider = config.provider;
    const entry = isRecord(provider) ? provider[SLOT] : undefined;
    const rule = zcodeRulesAt(rules, ["config", "providerConfigRules", "providerRules"]).find(
      zcodeIsOurs,
    );
    const ruleConfig = isRecord(rule) && isRecord(rule.config) ? rule.config : {};
    const ruleApi = isRecord(ruleConfig.api) ? ruleConfig.api : {};
    const ruleBase = typeof ruleApi.baseUrl === "string" ? ruleApi.baseUrl : null;
    return {
      connected: isRecord(entry) || zcodeConnected(rules),
      // ZCode picks a model per task in its own window; it keeps no pick in a file.
      model: null,
      baseUrl: stripNullable(
        readJsonString(config, ["provider", SLOT, "options", "baseURL"]) ?? ruleBase,
      ),
    };
  },
  async connect(environment, _model, undo) {
    const config = await readJsonIfThere(zcodeConfigPath(environment));
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, `provider.${SLOT}`);
    setAtValue(config, `provider.${SLOT}`, {
      name: "Neox",
      kind: "anthropic",
      enabled: true,
      source: "custom",
      options: { apiKey: environment.apiKey, baseURL: environment.baseUrl },
      models: Object.fromEntries(environment.models.map((entry) => [entry.id, zcodeModel(entry)])),
    });
    const configFile = await writeJsonWithUndo(
      zcodeConfigPath(environment),
      config,
      captured,
      undo,
    );

    // ZCode 3.14 on reads provider_config.json only (myna's zcodeRules); both
    // files are written so an older ZCode sees the provider too.
    const rules = await readJsonIfThere(zcodeRulesPath(environment));
    const ids = environment.models.map((entry) => entry.id);
    const stripped = zcodeStripOurs(rules);
    const configNode = isRecord(stripped.config) ? stripped.config : {};
    const pcr = isRecord(configNode.providerConfigRules) ? configNode.providerConfigRules : {};
    const mcr = isRecord(configNode.modelConfigRules) ? configNode.modelConfigRules : {};
    pcr.providerRules = [
      ...(Array.isArray(pcr.providerRules) ? pcr.providerRules : []),
      zcodeProviderRule(environment, ids),
    ];
    mcr.providerModelRules = [
      ...(Array.isArray(mcr.providerModelRules) ? mcr.providerModelRules : []),
      ...environment.models.map(zcodeModelRule),
    ];
    configNode.providerConfigRules = pcr;
    configNode.modelConfigRules = mcr;
    await writeText(
      zcodeRulesPath(environment),
      `${JSON.stringify({ ...stripped, config: configNode }, null, 2)}\n`,
    );
    return { kind: "json", files: [configFile] };
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(zcodeConfigPath(environment), undo);
    const rulesPath = zcodeRulesPath(environment);
    if (!(await exists(rulesPath))) return;
    const rules = zcodeStripOurs(await readJsonObject(rulesPath));
    await writeText(rulesPath, `${JSON.stringify(rules, null, 2)}\n`);
  },
};

function stripNullable(value: string | null): string | null {
  return value === null ? null : stripV1(value);
}

// ---------- OpenChamber ----------

function openChamberDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "OPENCHAMBER_DATA_DIR");
  if (override !== null && path.isAbsolute(override)) return override;
  return path.join(environment.homeDir, ".config", "openchamber");
}

function openChamberPrefsPath(environment: ConnectEnvironment): string {
  return path.join(openChamberDir(environment), "preferences.json");
}

function openChamberSettingsPath(environment: ConnectEnvironment): string {
  return path.join(openChamberDir(environment), "settings.json");
}

/** OpenChamber's profile key, in preferences.json first as OpenChamber reads it (myna's ocStore). */
function openChamberValue(
  prefs: Record<string, unknown>,
  settings: Record<string, unknown>,
  key: string,
): string | null {
  const fields = isRecord(prefs.fields) ? prefs.fields : {};
  const pref = isRecord(fields[key]) ? fields[key] : {};
  const value = readJsonString(pref, ["value"]) ?? readJsonString(settings, [key]);
  return value;
}

/** Writes a key to both files, or removes it from both for null. */
function openChamberSet(
  prefs: Record<string, unknown>,
  settings: Record<string, unknown>,
  hasPrefs: boolean,
  hasSettings: boolean,
  key: string,
  value: string | null,
): void {
  if (hasPrefs) {
    if (value === null) {
      const fields = isRecord(prefs.fields) ? prefs.fields : {};
      delete fields[key];
      prefs.fields = fields;
    } else {
      setAtValue(prefs, `fields.${key}`, { value, updatedAt: Date.now() });
    }
  }
  if (hasSettings || !hasPrefs) {
    if (value === null) {
      delete settings[key];
    } else {
      settings[key] = value;
    }
  }
}

const openChamberDriver: AgentConnectDriver = {
  provider: "openchamber",
  external: {
    name: "OpenChamber",
    icon: "openchamber",
    detect: async (environment) =>
      (await isOnPath("openchamber", environment)) || (await isDir(openChamberDir(environment))),
  },
  configPath: openChamberPrefsPath,
  async read(environment) {
    const prefs = await readJsonIfThere(openChamberPrefsPath(environment));
    const settings = await readJsonIfThere(openChamberSettingsPath(environment));
    const openCode = await readJsonIfThere(openCodeConfigPath(environment));
    const model = openChamberValue(prefs, settings, "defaultModel");
    return {
      connected: model?.startsWith(`${SLOT}/`) === true,
      model: model?.startsWith(`${SLOT}/`) === true ? model.slice(SLOT.length + 1) : null,
      baseUrl: stripNullable(readJsonString(openCode, ["provider", SLOT, "options", "baseURL"])),
    };
  },
  async connect(environment, model, undo) {
    // OpenChamber runs an OpenCode of its own on this config, and a model is
    // "provider/model" as OpenCode names it (myna's openchamber).
    const openCodePath = openCodeConfigPath(environment);
    const openCode = await readJsonIfThere(openCodePath);
    const captured: Record<string, PriorValue> = {};
    capture(openCode, captured, `provider.${SLOT}`);
    setAtValue(openCode, `provider.${SLOT}`, openCodeProvider(environment));
    const openCodeFile = await writeJsonWithUndo(openCodePath, openCode, captured, undo);

    const prefsPath = openChamberPrefsPath(environment);
    const settingsPath = openChamberSettingsPath(environment);
    const hasPrefs = await exists(prefsPath);
    const hasSettings = await exists(settingsPath);
    const prefs = await readJsonIfThere(prefsPath);
    const settings = await readJsonIfThere(settingsPath);
    const prefsCaptured: Record<string, PriorValue> = {};
    const settingsCaptured: Record<string, PriorValue> = {};
    capture(prefs, prefsCaptured, "fields.defaultModel");
    capture(prefs, prefsCaptured, "fields.defaultVariant");
    capture(settings, settingsCaptured, "defaultModel");
    capture(settings, settingsCaptured, "defaultVariant");
    const chosen = chosenModel(environment, model);
    const ref = chosen === null ? null : `${SLOT}/${chosen}`;
    // The variant was the old model's, as OpenChamber's own picker clears it.
    openChamberSet(prefs, settings, hasPrefs, hasSettings, "defaultModel", ref);
    openChamberSet(prefs, settings, hasPrefs, hasSettings, "defaultVariant", null);
    const files = [];
    if (hasPrefs) files.push(await writeJsonWithUndo(prefsPath, prefs, prefsCaptured, undo));
    // Without preferences.json OpenChamber reads settings.json, which it makes
    // when neither file is there (myna's ocStore.set).
    if (hasSettings || !hasPrefs) {
      files.push(await writeJsonWithUndo(settingsPath, settings, settingsCaptured, undo));
    }
    return { kind: "json", files: [openCodeFile, ...files] };
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(openCodeConfigPath(environment), undo);
    await restoreJsonFile(openChamberPrefsPath(environment), undo);
    await restoreJsonFile(openChamberSettingsPath(environment), undo);
  },
};

// ---------- Crush ----------

function crushConfigPath(environment: ConnectEnvironment): string {
  if (environment.platform === "win32") {
    const app = envOverride(environment.env, "LOCALAPPDATA");
    if (app !== null) return path.join(app, "crush", "crush.json");
  }
  return path.join(configHome(environment), "crush", "crush.json");
}

function crushDataPath(environment: ConnectEnvironment): string {
  if (environment.platform === "win32") return crushConfigPath(environment);
  const xdg = envOverride(environment.env, "XDG_DATA_HOME");
  if (xdg !== null && path.isAbsolute(xdg)) return path.join(xdg, "crush", "crush.json");
  return path.join(environment.homeDir, ".local", "share", "crush", "crush.json");
}

function crushProvider(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    type: "openai",
    name: "Neox",
    base_url: `${environment.baseUrl}/v1`,
    api_key: environment.apiKey,
    models: environment.models.map((entry) => ({
      id: entry.id,
      name: labelOf(entry),
      // The catalog's facts; Crush's own defaults only for a model it has
      // none for (myna's mynaProviderJSONAt).
      context_window: entry.contextWindow ?? 200000,
      default_max_tokens: Math.min(entry.maxOutputTokens ?? 16384, entry.contextWindow ?? 200000),
      can_reason: false,
    })),
  };
}

/** Crush saves its picker's choices to its data file, which it reads after crush.json. */
async function crushPick(
  environment: ConnectEnvironment,
  name: "large" | "small",
): Promise<Record<string, unknown> | null> {
  const data = await readJsonIfThere(crushDataPath(environment));
  const fromData = isRecord(data.models) ? data.models[name] : undefined;
  if (isRecord(fromData)) return fromData;
  const config = await readJsonIfThere(crushConfigPath(environment));
  const fromConfig = isRecord(config.models) ? config.models[name] : undefined;
  return isRecord(fromConfig) ? fromConfig : null;
}

/** Crush keeps API keys in its data file, so one Neolix makes first is owner-only. */
async function ensureCrushData(environment: ConnectEnvironment): Promise<void> {
  const dataPath = crushDataPath(environment);
  if (await exists(dataPath)) return;
  await fs.mkdir(path.dirname(dataPath), { recursive: true });
  await fs.writeFile(dataPath, "{}\n", { mode: 0o600 });
}

const crushDriver: AgentConnectDriver = {
  provider: "crush",
  external: {
    name: "Crush",
    icon: "crush",
    detect: async (environment) =>
      (await isOnPath("crush", environment)) ||
      (await isDir(path.dirname(crushConfigPath(environment)))),
  },
  configPath: crushConfigPath,
  async read(environment) {
    const config = await readJsonIfThere(crushConfigPath(environment));
    const large = await crushPick(environment, "large");
    const small = await crushPick(environment, "small");
    const onLarge = large?.provider === SLOT;
    return {
      connected: onLarge || small?.provider === SLOT,
      model: onLarge && typeof large?.model === "string" ? large.model : null,
      baseUrl: stripNullable(readJsonString(config, ["providers", SLOT, "base_url"])),
    };
  },
  async connect(environment, model, undo) {
    const configPath = crushConfigPath(environment);
    const config = await readJsonIfThere(configPath);
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, `providers.${SLOT}`);
    setAtValue(config, `providers.${SLOT}`, crushProvider(environment));
    const configFile = await writeJsonWithUndo(configPath, config, captured, undo);

    await ensureCrushData(environment);
    const dataPath = crushDataPath(environment);
    const data = await readJsonIfThere(dataPath);
    const dataCaptured: Record<string, PriorValue> = {};
    capture(data, dataCaptured, "models.large");
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(data, "models.large", { provider: SLOT, model: chosen });
    }
    const dataFile = await writeJsonWithUndo(dataPath, data, dataCaptured, undo);
    return { kind: "json", files: [configFile, dataFile] };
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(crushConfigPath(environment), undo);
    await restoreJsonFile(crushDataPath(environment), undo);
  },
};

// ---------- DeepSeek Harness (dsh) ----------

const DSH_ROUTE = SLOT;
const DSH_PLUGIN = "@deepseek-ai/dsh-llm-pi-ai";
const DSH_KEY = "NEOLIX_GATEWAY_KEY";
const DSH_MARK = "# neolix";

function dshDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "DSH_HOME");
  if (override !== null && path.isAbsolute(override)) return override;
  return path.join(environment.homeDir, ".dsh");
}

/** Every profile's patch list, the web profile first (myna's dshProfiles). */
async function dshProfiles(dir: string): Promise<string[]> {
  const root = path.join(dir, "profiles");
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    const file = path.join(root, name, "cordis.patch.yml");
    if (await exists(file)) files.push(file);
  }
  return files.sort((left, right) => rank(left) - rank(right));
}

function rank(file: string): number {
  return path.basename(path.dirname(file)) === "web" ? 0 : 1;
}

interface PatchItem {
  id: string;
  lines: string[];
}

interface PatchList {
  head: string[];
  items: PatchItem[];
}

function patchItemId(line: string): string {
  const match = /^-\s+id:\s*["']?([^"'\s#]+)/.exec(line);
  return match?.[1] ?? "";
}

/** A patch list as dsh writes it: a top-level array of {id, config} entries. */
function splitPatchList(text: string): PatchList {
  const head: string[] = [];
  const items: PatchItem[] = [];
  let current: PatchItem | null = null;
  for (const line of text.split("\n")) {
    if (/^-\s/.test(line)) {
      current = { id: patchItemId(line), lines: [line] };
      items.push(current);
      continue;
    }
    if (current === null) {
      head.push(line);
      continue;
    }
    current.lines.push(line);
  }
  return { head, items };
}

function joinPatchList(list: PatchList): string {
  const lines = [
    ...list.head.filter((line) => line !== "[]"),
    ...list.items.flatMap((item) => item.lines),
  ];
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  if (list.items.length === 0) lines.push("[]");
  return `${lines.join("\n")}\n`;
}

function findPatchItem(list: PatchList, id: string): number {
  for (let index = list.items.length - 1; index >= 0; index -= 1) {
    if (list.items[index]?.id === id) return index;
  }
  return -1;
}

function dshRouteConfig(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    displayName: "Neox",
    apiKeyEnv: DSH_KEY,
    api: "openai-completions",
    baseURL: `${environment.baseUrl}/v1`,
    models: environment.models.map((entry) => ({
      id: entry.id,
      name: labelOf(entry),
      // dsh takes every model for a 128K one writing 16K without these.
      contextWindow: entry.contextWindow ?? 128000,
      maxTokens: Math.min(
        entry.maxOutputTokens ?? 16384,
        entry.contextWindow ?? Number.MAX_SAFE_INTEGER,
      ),
      input: entry.images === true ? ["text", "image"] : ["text"],
    })),
    // llm-pi-ai's own wait is 5 minutes; the gateway's is 10 (myna's dshIdleWait).
    streamIdleTimeoutMs: 600000,
  };
}

/** Prefixes an object's YAML as one entry of a top-level sequence. */
function asPatchItem(value: Record<string, unknown>): string[] {
  return stringify(value)
    .trimEnd()
    .split("\n")
    .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));
}

function dshRouteItem(environment: ConnectEnvironment, prior: PatchItem | undefined): string[] {
  const merged: Record<string, unknown> = prior === undefined ? {} : parsePatchObject(prior);
  mergeRoute(merged, environment);
  return asPatchItem(merged);
}

function parsePatchObject(item: PatchItem): Record<string, unknown> {
  const value = parse(item.lines.join("\n"));
  const entry = Array.isArray(value) ? value[0] : value;
  return isRecord(entry) ? entry : {};
}

/** Puts Neolix's route among the entry's providers, leaving dsh's and the user's. */
function mergeRoute(item: Record<string, unknown>, environment: ConnectEnvironment): void {
  item.id = "llm-pi-ai";
  item.name = DSH_PLUGIN;
  const config = isRecord(item.config) ? item.config : {};
  const providers = isRecord(config.providers) ? config.providers : {};
  providers[DSH_ROUTE] = dshRouteConfig(environment);
  config.providers = providers;
  item.config = config;
}

function dshDefaultItem(model: string): string[] {
  return [
    `- id: agent-default-model ${DSH_MARK}`,
    "  config:",
    `    provider: ${DSH_ROUTE}`,
    `    model: ${JSON.stringify(model)}`,
  ];
}

const DSH_TEMPLATE =
  "# Your patch layer for this dsh profile, applied after every bundle layer:\n" +
  "# a top-level YAML array of loader patch entries (id-targeted config\n" +
  "# overrides, disables, and insert lists; `!!js` expressions allowed).\n" +
  "[]\n";

interface PatchUndoValues {
  [key: string]: unknown;
}

/** The prior text of an entry, and whether Neolix made the file, for disconnect. */
function dshUndoValues(list: PatchList, ids: string[], created: boolean): PatchUndoValues {
  const values: PatchUndoValues = { created };
  for (const id of ids) {
    const index = findPatchItem(list, id);
    values[id] = index < 0 ? null : list.items[index]?.lines.join("\n");
  }
  return values;
}

function dshWired(text: string): boolean {
  const list = splitPatchList(text);
  const index = findPatchItem(list, "llm-pi-ai");
  if (index < 0) return false;
  const entry = parsePatchObject(list.items[index] as PatchItem);
  const config = isRecord(entry.config) ? entry.config : {};
  return isRecord(config.providers) && isRecord(config.providers[DSH_ROUTE]);
}

function dshRouteBase(text: string): string | null {
  const list = splitPatchList(text);
  const index = findPatchItem(list, "llm-pi-ai");
  if (index < 0) return null;
  const entry = parsePatchObject(list.items[index] as PatchItem);
  const config = isRecord(entry.config) ? entry.config : {};
  const providers = isRecord(config.providers) ? config.providers : {};
  const route = isRecord(providers[DSH_ROUTE]) ? providers[DSH_ROUTE] : {};
  const base = typeof route.baseURL === "string" ? route.baseURL : null;
  return base === null ? null : stripV1(base);
}

function dshModel(text: string): string | null {
  const list = splitPatchList(text);
  const index = findPatchItem(list, "agent-default-model");
  if (index < 0) return null;
  const entry = parsePatchObject(list.items[index] as PatchItem);
  const config = isRecord(entry.config) ? entry.config : {};
  return config.provider === DSH_ROUTE && typeof config.model === "string" ? config.model : null;
}

function dshApply(
  list: PatchList,
  environment: ConnectEnvironment,
  chosen: string | null,
): PatchItem[] {
  const items = [...list.items];
  const routeIndex = findPatchItem(list, "llm-pi-ai");
  const routeLines = dshRouteItem(environment, routeIndex < 0 ? undefined : list.items[routeIndex]);
  const route: PatchItem = { id: "llm-pi-ai", lines: routeLines };
  if (routeIndex < 0) items.push(route);
  else items[routeIndex] = route;
  if (chosen === null) return items;
  const startIndex = findPatchItem(list, "agent-default-model");
  const start: PatchItem = { id: "agent-default-model", lines: dshDefaultItem(chosen) };
  if (startIndex < 0) items.push(start);
  else items[startIndex] = start;
  return items;
}

const dshDriver: AgentConnectDriver = {
  provider: "dsh",
  external: {
    name: "DeepSeek Harness",
    icon: "deepseek-color",
    detect: async (environment) =>
      (await isOnPath("dsh", environment)) || (await isDir(dshDir(environment))),
    // dsh's route carries the catalog, which Neolix keeps current as it changes
    // (myna's SyncCatalog calls dshSyncFresh).
    refreshModels: true,
  },
  configPath: (environment) => path.join(dshDir(environment), ".env"),
  async read(environment) {
    const dir = dshDir(environment);
    const files = await dshProfiles(dir);
    if (files.length === 0) return { connected: false, model: null, baseUrl: null };
    const text = (await readTextOrNull(files[0] as string)) ?? "";
    return {
      connected: dshWired(text),
      model: dshModel(text),
      baseUrl: dshRouteBase(text),
    };
  },
  async connect(environment, model, _undo) {
    const dir = dshDir(environment);
    const profiles = await dshProfiles(dir);
    const targets =
      profiles.length > 0 ? profiles : [path.join(dir, "profiles", "web", "cordis.patch.yml")];
    const chosen = chosenModel(environment, model);
    const parts: AgentConnectUndo[] = [];
    for (const file of targets) {
      const created = !(await exists(file));
      const before = (await readTextOrNull(file)) ?? DSH_TEMPLATE;
      const list = splitPatchList(before);
      const values = dshUndoValues(list, ["llm-pi-ai", "agent-default-model"], created);
      list.items = dshApply(list, environment, chosen);
      await writeText(file, joinPatchList(list));
      parts.push({ kind: "yaml", path: file, values: values as Record<string, PriorValue> });
    }
    parts.push(...(await dshWriteKey(dir, environment)));
    return { kind: "multi", parts };
  },
  async disconnect(environment, undo) {
    for (const part of dshParts(undo, "yaml")) {
      if (path.basename(part.path) !== "cordis.patch.yml") continue;
      await dshRestorePatch(part.path, part.values as PatchUndoValues);
    }
    await dshRemoveKey(dshDir(environment), undo);
  },
};

/** Every undo part, through any nesting (a harness may join several). */
function collectUndo(undo: AgentConnectUndo | undefined): AgentConnectUndo[] {
  if (undo === undefined) return [];
  return undo.kind === "multi" ? undo.parts.flatMap(collectUndo) : [undo];
}

function dshParts(undo: AgentConnectUndo | undefined, kind: "yaml" | "env") {
  return collectUndo(undo).filter(
    (part): part is Extract<AgentConnectUndo, { kind: "yaml" } | { kind: "env" }> =>
      part.kind === kind,
  );
}

async function dshRestorePatch(file: string, values: PatchUndoValues): Promise<void> {
  if (!(await exists(file))) return;
  const text = (await readTextOrNull(file)) ?? "";
  const list = splitPatchList(text);
  for (const id of ["llm-pi-ai", "agent-default-model"]) {
    const index = findPatchItem(list, id);
    if (index < 0) continue;
    const prior = values[id];
    if (typeof prior === "string") {
      list.items[index] = { id, lines: prior.split("\n") };
    } else {
      list.items.splice(index, 1);
    }
  }
  if (values.created === true && list.items.length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await writeText(file, joinPatchList(list));
}

/** Writes the gateway key where dsh CLI and its desktop app read it. */
async function dshWriteKey(
  dir: string,
  environment: ConnectEnvironment,
): Promise<AgentConnectUndo[]> {
  const envPath = path.join(dir, ".env");
  const priorEnv = await readEnvFile(envPath);
  await setEnvValues(envPath, { [DSH_KEY]: environment.apiKey });
  const envUndo: AgentConnectUndo = {
    kind: "env",
    path: envPath,
    values: { [DSH_KEY]: priorEnv[DSH_KEY] ?? null },
  };
  const credsPath = path.join(dir, ".credentials.yaml");
  const creds = await readYamlDocument(credsPath);
  const priorCred = dshCredential(creds);
  creds.setIn(["refs", DSH_KEY], environment.apiKey);
  await writeYamlDocument(credsPath, creds);
  try {
    await fs.chmod(credsPath, 0o600);
  } catch {
    // A filesystem without modes (Windows) keeps the file as it is.
  }
  const credsUndo: AgentConnectUndo = {
    kind: "yaml",
    path: credsPath,
    values: {
      [DSH_KEY]: priorCred === null ? { present: false } : { present: true, value: priorCred },
    },
  };
  return [envUndo, credsUndo];
}

function dshCredential(document: Awaited<ReturnType<typeof readYamlDocument>>): string | null {
  const value = document.getIn(["refs", DSH_KEY]);
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function dshRemoveKey(dir: string, undo: AgentConnectUndo | undefined): Promise<void> {
  const envParts = dshParts(undo, "env");
  for (const part of envParts) {
    if (part.values[DSH_KEY] === null) {
      await removeEnvValues(part.path, [DSH_KEY]);
    } else if (part.values[DSH_KEY] !== undefined) {
      await setEnvValues(part.path, { [DSH_KEY]: part.values[DSH_KEY] as string });
    }
  }
  const credsPath = path.join(dir, ".credentials.yaml");
  if (!(await exists(credsPath))) return;
  const creds = await readYamlDocument(credsPath);
  const prior = dshCredential(creds);
  if (prior === null) return;
  const credsUndo = dshParts(undo, "yaml").find((part) => part.path === credsPath);
  const recorded = credsUndo?.values[DSH_KEY];
  const restoreValue = isRecord(recorded) && recorded.present === true ? recorded.value : null;
  if (restoreValue === null) creds.deleteIn(["refs", DSH_KEY]);
  else creds.setIn(["refs", DSH_KEY], restoreValue);
  await writeYamlDocument(credsPath, creds);
}

export const BATCH5_AGENT_DRIVERS: AgentConnectDriver[] = [
  zcodeDriver,
  openChamberDriver,
  crushDriver,
  dshDriver,
];
