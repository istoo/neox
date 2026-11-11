import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { readJsonObject, readTextOrNull } from "../config-files.js";
import {
  type AgentConnectDriver,
  type AgentConnectUndo,
  type ConnectEnvironment,
  type PriorValue,
  stripV1,
} from "../drivers.js";
import {
  appendTomlTables,
  configHome,
  envOverride,
  getTomlTableKey,
  homePath,
  isDir,
  isOnPath,
  removeTomlTable,
  removeTomlTableKey,
  removeTomlTablesWithPrefix,
  setTomlTableKey,
  writeText,
} from "./helpers.js";

const SLOT = "neolix";

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

async function readTextIfThere(filePath: string): Promise<string | null> {
  return readTextOrNull(filePath);
}

function writeJsonText(filePath: string, value: unknown): Promise<void> {
  return writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** A key holding a dot is one literal key to these files, not a path (chat.defaultModel). */
function literalKey(root: Record<string, unknown>, key: string): PriorValue {
  return key in root ? { present: true, value: root[key] } : { present: false };
}

function restoreLiteral(root: Record<string, unknown>, key: string, prior: unknown): void {
  if (isRecord(prior) && prior.present === true) root[key] = prior.value;
  else delete root[key];
}

/** A value-level undo for a file whose shape is not a JSON object (an array, a TOML block). */
function shapedUndo(filePath: string, values: Record<string, PriorValue>): AgentConnectUndo {
  return { kind: "yaml", path: filePath, values };
}

function shapedParts(undo: AgentConnectUndo | undefined): AgentConnectUndo[] {
  if (undo === undefined) return [];
  const all: AgentConnectUndo[] =
    undo.kind === "multi" ? undo.parts.flatMap((part) => shapedParts(part)) : [undo];
  return all;
}

/** The undo of an earlier connect for one file: its prior values stand on a reconnect. */
function shapedPrior(
  undo: AgentConnectUndo | undefined,
  filePath: string,
): Extract<AgentConnectUndo, { kind: "yaml" }> | undefined {
  return shapedParts(undo).find(
    (part): part is Extract<AgentConnectUndo, { kind: "yaml" }> =>
      part.kind === "yaml" && part.path === filePath,
  );
}

function unique(paths: string[]): string[] {
  return [...new Set(paths)];
}

// ---------- Snow CLI ----------

function snowDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "SNOW_CONFIG_DIR");
  if (override !== null && path.isAbsolute(override)) return override;
  return homePath(environment, ".snow");
}

function snowProfilePath(environment: ConnectEnvironment, name: string): string {
  return path.join(snowDir(environment), "profiles", `${name}.json`);
}

/** The profile Snow starts on, as it reads it (myna's snow active()). */
async function snowActive(environment: ConnectEnvironment): Promise<string> {
  const dir = snowDir(environment);
  const active = await readJsonIfThere(path.join(dir, "active-profile.json"));
  if (typeof active.activeProfile === "string" && active.activeProfile.length > 0) {
    return active.activeProfile;
  }
  const legacy = await readTextIfThere(path.join(dir, "active-profile.txt"));
  return legacy !== null && legacy.trim().length > 0 ? legacy.trim() : "default";
}

async function snowOnOurs(environment: ConnectEnvironment): Promise<boolean> {
  if ((await snowActive(environment)) !== SLOT) return false;
  const profile = await readJsonIfThere(snowProfilePath(environment, SLOT));
  return isRecord(profile.snowcfg) && profile.snowcfg.apiKey === environment.apiKey;
}

async function snowMirror(environment: ConnectEnvironment, name: string): Promise<void> {
  const profile = await readTextIfThere(snowProfilePath(environment, name));
  if (profile !== null) await writeText(path.join(snowDir(environment), "config.json"), profile);
}

function parseProfile(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    // A profile Snow can't parse is replaced rather than kept: Neolix only
    // ever writes its own profile, and Snow rewrites config.json at start-up.
    return {};
  }
}

function snowConfig(environment: ConnectEnvironment, model: string): Record<string, unknown> {
  const picked = environment.models.find((entry) => entry.id === model);
  const context = picked?.contextWindow ?? 200000;
  const output = Math.min(picked?.maxOutputTokens ?? 64000, context);
  return {
    maxContextTokens: context,
    maxTokens: output,
    supportsVision: picked?.images === true,
    baseUrl: `${environment.baseUrl}/v1`,
    baseUrlMode: "base",
    apiKey: environment.apiKey,
    requestMethod: "chat",
    advancedModel: model,
    basicModel: model,
  };
}

/** The profile Neolix writes, from the one the reader was on (myna's snowProfileFor). */
function snowProfile(
  base: Record<string, unknown>,
  environment: ConnectEnvironment,
  model: string,
): Record<string, unknown> {
  const root = structuredClone(base);
  const cfg = isRecord(root.snowcfg) ? root.snowcfg : {};
  delete cfg.oauth;
  for (const key of [
    "visionModel",
    "visionBaseUrl",
    "visionBaseUrlMode",
    "visionApiKey",
    "visionRequestMethod",
  ]) {
    delete cfg[key];
  }
  root.snowcfg = { ...cfg, ...snowConfig(environment, model) };
  return root;
}

const snowDriver: AgentConnectDriver = {
  provider: "snow",
  external: {
    name: "Snow CLI",
    icon: "snow",
    detect: async (environment) =>
      (await isOnPath("snow", environment)) || (await isDir(snowDir(environment))),
  },
  configPath: (environment) => snowProfilePath(environment, SLOT),
  async read(environment) {
    if (!(await snowOnOurs(environment))) {
      return { connected: false, model: null, baseUrl: null };
    }
    const profile = await readJsonIfThere(snowProfilePath(environment, SLOT));
    const cfg = isRecord(profile.snowcfg) ? profile.snowcfg : {};
    const model = typeof cfg.advancedModel === "string" ? cfg.advancedModel : null;
    const base = typeof cfg.baseUrl === "string" ? cfg.baseUrl : null;
    return { connected: model !== null, model, baseUrl: base === null ? null : stripV1(base) };
  },
  async connect(environment, model, _undo) {
    const dir = snowDir(environment);
    const activeFile = path.join(dir, "active-profile.json");
    const configFile = path.join(dir, "config.json");
    const priorActive = await readTextIfThere(activeFile);
    const priorProfile = await readTextIfThere(snowProfilePath(environment, SLOT));
    const priorConfig = await readTextIfThere(configFile);
    const active = await snowActive(environment);
    const base =
      (await readTextIfThere(snowProfilePath(environment, active))) ?? priorConfig ?? "{}";
    const chosen = chosenModel(environment, model) ?? environment.models[0]?.id ?? "";
    const profile = snowProfile(parseProfile(base), environment, chosen);
    await writeJsonText(snowProfilePath(environment, SLOT), profile);
    await writeJsonText(activeFile, { activeProfile: SLOT });
    await snowMirror(environment, SLOT);
    return shapedUndo(activeFile, {
      active: priorActive === null ? { present: false } : { present: true, value: priorActive },
      profile: priorProfile === null ? { present: false } : { present: true, value: priorProfile },
      config: priorConfig === null ? { present: false } : { present: true, value: priorConfig },
    });
  },
  async disconnect(environment, undo) {
    const part = shapedParts(undo).find((entry) => entry.kind === "yaml");
    if (part === undefined) return;
    const values = part.values;
    const activeFile = path.join(snowDir(environment), "active-profile.json");
    const configFile = path.join(snowDir(environment), "config.json");
    const profileFile = snowProfilePath(environment, SLOT);
    for (const [file, key] of [
      [activeFile, "active"],
      [profileFile, "profile"],
      [configFile, "config"],
    ] as const) {
      const prior = values[key];
      if (isRecord(prior) && prior.present === true && typeof prior.value === "string") {
        await writeText(file, prior.value);
      } else {
        await fs.rm(file, { force: true });
      }
    }
  },
};

// ---------- jcode ----------

const JCODE_TABLE = "[providers.neolix]";
const JCODE_MODELS_PREFIX = "[[providers.neolix.models]]";

function jcodeDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "JCODE_HOME");
  if (override !== null && path.isAbsolute(override)) return override;
  return homePath(environment, ".jcode");
}

function jcodeModels(models: AgentConnectModel[]): string {
  const entries = models.map((model) => {
    const parts = [`id = ${JSON.stringify(model.id)}`];
    // jcode takes a model for a 128K one without this.
    parts.push(`context_window = ${String(model.contextWindow ?? 128000)}`);
    parts.push(
      `input = [${
        model.images === true
          ? `${JSON.stringify("text")}, ${JSON.stringify("image")}`
          : JSON.stringify("text")
      }]`,
    );
    return `  { ${parts.join(", ")} },`;
  });
  return `models = [\n${entries.join("\n")}\n]`;
}

function jcodeTable(environment: ConnectEnvironment, models: AgentConnectModel[]): string {
  return [
    JCODE_TABLE,
    'type = "openai-compatible"',
    `base_url = ${JSON.stringify(`${environment.baseUrl}/v1`)}`,
    `api_key = ${JSON.stringify(environment.apiKey)}`,
    "requires_api_key = true",
    jcodeModels(models),
  ].join("\n");
}

const jcodeDriver: AgentConnectDriver = {
  provider: "jcode",
  external: {
    name: "jcode",
    icon: "jcode",
    detect: async (environment) =>
      (await isOnPath("jcode", environment)) || (await isDir(jcodeDir(environment))),
  },
  configPath: (environment) => path.join(jcodeDir(environment), "config.toml"),
  async read(environment) {
    const filePath = path.join(jcodeDir(environment), "config.toml");
    const text = (await readTextIfThere(filePath)) ?? "";
    const provider = getTomlTableKey(text, "[provider]", "default_provider");
    const model = getTomlTableKey(text, "[provider]", "default_model");
    const base = getTomlTableKey(text, JCODE_TABLE, "base_url");
    return {
      connected: provider === SLOT,
      model: provider === SLOT ? model : null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = path.join(jcodeDir(environment), "config.toml");
    const before = (await readTextIfThere(filePath)) ?? "";
    const chosen = chosenModel(environment, model);
    const prior: Record<string, PriorValue> = {
      default_provider:
        getTomlTableKey(before, "[provider]", "default_provider") === null
          ? { present: false }
          : {
              present: true,
              value: getTomlTableKey(before, "[provider]", "default_provider"),
            },
      default_model:
        getTomlTableKey(before, "[provider]", "default_model") === null
          ? { present: false }
          : { present: true, value: getTomlTableKey(before, "[provider]", "default_model") },
      table: { present: before.includes(JCODE_TABLE), value: before },
    };
    let text = removeTomlTablesWithPrefix(before, JCODE_MODELS_PREFIX);
    text = removeTomlTable(text, JCODE_TABLE);
    text = appendTomlTables(text, [jcodeTable(environment, environment.models)]);
    text = setTomlTableKey(text, "[provider]", "default_provider", SLOT);
    if (chosen !== null) text = setTomlTableKey(text, "[provider]", "default_model", chosen);
    await writeText(filePath, text);
    return shapedUndo(filePath, prior);
  },
  async disconnect(environment, undo) {
    const filePath = path.join(jcodeDir(environment), "config.toml");
    if (!(await exists(filePath))) return;
    const part = shapedParts(undo).find(
      (entry): entry is Extract<AgentConnectUndo, { kind: "yaml" }> =>
        entry.kind === "yaml" && entry.path === filePath,
    );
    if (part === undefined) return;
    let text = (await readTextIfThere(filePath)) ?? "";
    text = removeTomlTablesWithPrefix(text, JCODE_MODELS_PREFIX);
    text = removeTomlTable(text, JCODE_TABLE);
    // A pick the reader made in jcode since is theirs and stands (myna's unwire).
    if (getTomlTableKey(text, "[provider]", "default_provider") === SLOT) {
      for (const key of ["default_provider", "default_model"]) {
        const prior = part.values[key];
        if (isRecord(prior) && prior.present === true && typeof prior.value === "string") {
          text = setTomlTableKey(text, "[provider]", key, prior.value);
        } else {
          text = removeTomlTableKey(text, "[provider]", key);
        }
      }
    }
    await writeText(filePath, text);
  },
};

// ---------- VS Code ----------

export type VSCodeVendor = "customendpoint" | "customoai";

export interface VSCodeKind {
  id: string;
  folder: string;
  extFolder: string;
  bin: string;
  /** "auto": the vendor the Copilot Chat installed for this build declares. */
  vendor: VSCodeVendor | "auto";
}

const VSCODE_STABLE: VSCodeKind = {
  id: "vscode",
  folder: "Code",
  extFolder: ".vscode",
  bin: "code",
  vendor: "customendpoint",
};

function vscodeUserDir(environment: ConnectEnvironment, kind: VSCodeKind): string {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    return path.join(home, "Library", "Application Support", kind.folder, "User");
  }
  if (environment.platform === "win32") {
    const appdata = envOverride(environment.env, "APPDATA");
    const root = appdata ?? path.join(home, "AppData", "Roaming");
    return path.join(root, kind.folder, "User");
  }
  return path.join(configHome(environment), kind.folder, "User");
}

function vscodeExtensionsDir(environment: ConnectEnvironment, kind: VSCodeKind): string {
  return path.join(environment.homeDir, kind.extFolder, "extensions");
}

/** VS Code's profiles: each one's settings.json and chatLanguageModels.json. */
async function vscodeProfiles(userDir: string): Promise<{ settings: string[]; models: string[] }> {
  const storage = await readJsonIfThere(path.join(userDir, "globalStorage", "storage.json"));
  const settings: string[] = [];
  const models: string[] = [];
  if (!Array.isArray(storage.userDataProfiles)) return { settings, models };
  for (const entry of storage.userDataProfiles) {
    if (!isRecord(entry)) continue;
    const location = entry.location;
    let at: string | null = null;
    if (typeof location === "string" && location.length > 0) {
      at = path.join(userDir, "profiles", location);
    } else if (isRecord(location)) {
      const fsPath = typeof location.fsPath === "string" ? location.fsPath : null;
      const raw = typeof location.path === "string" ? location.path : null;
      at = fsPath ?? (raw === null ? null : raw.replace(/^\/([a-zA-Z]:)/, "$1"));
    }
    if (at === null || !(await isDir(at))) continue;
    const flags = isRecord(entry.useDefaultFlags) ? entry.useDefaultFlags : {};
    if (flags.settings !== true) settings.push(path.join(at, "settings.json"));
    if (flags.languageModels !== true) models.push(path.join(at, "chatLanguageModels.json"));
  }
  return { settings, models };
}

interface VSCodeGroup {
  name: string;
  vendor: string;
  apiType?: string;
  models: unknown[];
}

function vscodeGroupOf(list: unknown[], vendor: VSCodeVendor): VSCodeGroup | null {
  for (const entry of list) {
    if (isRecord(entry) && entry.vendor === vendor && entry.name === SLOT) {
      return entry as unknown as VSCodeGroup;
    }
  }
  return null;
}

function vscodeGroup(environment: ConnectEnvironment, vendor: VSCodeVendor): VSCodeGroup {
  if (vendor === "customoai") {
    // The OpenAI Compatible provider VSCodium's Copilot Chat registers: its
    // window is maxInputTokens plus maxOutputTokens, and x-api-key carries it.
    return {
      name: SLOT,
      vendor,
      models: environment.models.map((model) => ({
        id: model.id,
        name: labelOf(model),
        url: `${environment.baseUrl}/v1/chat/completions`,
        toolCalling: true,
        vision: model.images === true,
        // Its window is maxInputTokens plus maxOutputTokens.
        maxInputTokens: Math.max(
          1,
          (model.contextWindow ?? 128000) - (model.maxOutputTokens ?? 8192),
        ),
        maxOutputTokens: model.maxOutputTokens ?? 8192,
        requestHeaders: { "x-api-key": environment.apiKey },
      })),
    };
  }
  return {
    name: SLOT,
    vendor,
    apiType: "chat-completions",
    models: environment.models.map((model) => ({
      id: model.id,
      name: labelOf(model),
      url: `${environment.baseUrl}/v1/chat/completions`,
      toolCalling: true,
      vision: model.images === true,
      // VS Code takes a model of unknown window for a 128K one.
      contextWindow: model.contextWindow ?? 128000,
      maxOutputTokens: model.maxOutputTokens ?? 8192,
      requestHeaders: { Authorization: `Bearer ${environment.apiKey}` },
    })),
  };
}

async function readJsonArray(filePath: string): Promise<unknown[]> {
  const text = await readTextIfThere(filePath);
  if (text === null || text.trim() === "") return [];
  const parsed: unknown = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [];
}

/** Neolix's group as it was before this connect, an earlier one's record standing on a reconnect. */
async function vscodePriorGroup(
  undo: AgentConnectUndo | undefined,
  filePath: string,
  vendor: VSCodeVendor,
): Promise<unknown> {
  const prior = shapedPrior(undo, filePath);
  if (prior !== undefined && prior.values.group !== undefined) return prior.values.group;
  return vscodeGroupOf(await readJsonArray(filePath), vendor);
}

async function vscodeWriteGroup(filePath: string, group: VSCodeGroup): Promise<void> {
  const list = await readJsonArray(filePath);
  const at = list.findIndex(
    (entry) => isRecord(entry) && entry.vendor === group.vendor && entry.name === SLOT,
  );
  if (at >= 0) list[at] = group;
  else list.push(group);
  await writeJsonText(filePath, list);
}

/** The vendor Neolix's group is written for: the installed Copilot Chat's. */
async function vscodeVendorFor(
  environment: ConnectEnvironment,
  kind: VSCodeKind,
): Promise<VSCodeVendor> {
  if (kind.vendor !== "auto") return kind.vendor;
  const exts = vscodeExtensionsDir(environment, kind);
  let names: string[];
  try {
    names = await fs.readdir(exts);
  } catch {
    return "customendpoint";
  }
  for (const name of names) {
    if (!name.toLowerCase().startsWith("github.copilot-chat-")) continue;
    const pkg = await readTextIfThere(path.join(exts, name, "package.json"));
    if (pkg !== null && pkg.includes('"customoai"')) return "customoai";
  }
  return "customendpoint";
}

async function vscodeConnected(
  environment: ConnectEnvironment,
  kind: VSCodeKind,
): Promise<boolean> {
  const userDir = vscodeUserDir(environment, kind);
  const vendor = await vscodeVendorFor(environment, kind);
  const list = await readJsonArray(path.join(userDir, "chatLanguageModels.json"));
  return vscodeGroupOf(list, vendor) !== null;
}

async function vscodeModel(
  environment: ConnectEnvironment,
  kind: VSCodeKind,
): Promise<string | null> {
  const userDir = vscodeUserDir(environment, kind);
  const settings = await readJsonIfThere(path.join(userDir, "settings.json"));
  const model = settings["chat.defaultModel"];
  if (typeof model !== "string" || model.length === 0) return null;
  const vendor = await vscodeVendorFor(environment, kind);
  const list = await readJsonArray(path.join(userDir, "chatLanguageModels.json"));
  const group = vscodeGroupOf(list, vendor);
  if (group === null) return null;
  const listed = group.models.some((entry) => isRecord(entry) && entry.id === model);
  return listed ? model : null;
}

/** The gateway the group's models are sent to: its first model's URL, less the chat path. */
async function vscodeGroupBase(
  environment: ConnectEnvironment,
  kind: VSCodeKind,
): Promise<string | null> {
  const vendor = await vscodeVendorFor(environment, kind);
  const list = await readJsonArray(
    path.join(vscodeUserDir(environment, kind), "chatLanguageModels.json"),
  );
  const group = vscodeGroupOf(list, vendor);
  const first = group?.models[0];
  const url = isRecord(first) && typeof first.url === "string" ? first.url : null;
  return url === null ? null : stripV1(url.replace(/\/chat\/completions\/?$/, ""));
}

export function vscodeDriver(kind: VSCodeKind, name: string, icon: string): AgentConnectDriver {
  const userDir = (environment: ConnectEnvironment) => vscodeUserDir(environment, kind);
  return {
    provider: kind.id,
    external: {
      name,
      icon,
      detect: async (environment) =>
        (await isDir(userDir(environment))) || (await isOnPath(kind.bin, environment)),
    },
    configPath: (environment) => path.join(userDir(environment), "chatLanguageModels.json"),
    async read(environment) {
      const connected = await vscodeConnected(environment, kind);
      const model = await vscodeModel(environment, kind);
      const base = connected ? await vscodeGroupBase(environment, kind) : null;
      return { connected, model, baseUrl: base };
    },
    async connect(environment, model, undo) {
      const dir = userDir(environment);
      const vendor = await vscodeVendorFor(environment, kind);
      const profiles = await vscodeProfiles(dir);
      const modelsFiles = unique([path.join(dir, "chatLanguageModels.json"), ...profiles.models]);
      const settingsFiles = unique([path.join(dir, "settings.json"), ...profiles.settings]);
      const chosen = chosenModel(environment, model);
      const parts: AgentConnectUndo[] = [];
      for (const file of modelsFiles) {
        const priorGroup = await vscodePriorGroup(undo, file, vendor);
        await vscodeWriteGroup(file, vscodeGroup(environment, vendor));
        parts.push(
          shapedUndo(file, {
            group: priorGroup === null ? { present: false } : { present: true, value: priorGroup },
          }),
        );
      }
      for (const file of settingsFiles) {
        const settings = await readJsonIfThere(file);
        const prior =
          shapedPrior(undo, file)?.values.defaultModel ?? literalKey(settings, "chat.defaultModel");
        if (chosen !== null) settings["chat.defaultModel"] = chosen;
        await writeJsonText(file, settings);
        parts.push(shapedUndo(file, { defaultModel: prior }));
      }
      return { kind: "multi", parts };
    },
    async disconnect(environment, undo) {
      const vendor = await vscodeVendorFor(environment, kind);
      for (const part of shapedParts(undo)) {
        if (part.kind !== "yaml") continue;
        if (path.basename(part.path) === "chatLanguageModels.json") {
          if (!(await exists(part.path))) continue;
          const list = await readJsonArray(part.path);
          const at = list.findIndex(
            (entry) => isRecord(entry) && entry.vendor === vendor && entry.name === SLOT,
          );
          if (at < 0) continue;
          const prior = part.values.group;
          if (isRecord(prior) && prior.present === true) list[at] = prior.value;
          else list.splice(at, 1);
          await writeJsonText(part.path, list);
          continue;
        }
        if (path.basename(part.path) !== "settings.json" || !(await exists(part.path))) continue;
        const settings = await readJsonIfThere(part.path);
        restoreLiteral(settings, "chat.defaultModel", part.values.defaultModel);
        await writeJsonText(part.path, settings);
      }
    },
  };
}

const vscodeKindDriver = vscodeDriver(VSCODE_STABLE, "VS Code", "vscode");

// ---------- Zoo Code ----------

const ZOO_EXTENSION = "zoocodeorganization.zoo-code";

function zooImportPath(environment: ConnectEnvironment): string {
  return path.join(
    vscodeUserDir(environment, VSCODE_STABLE),
    "globalStorage",
    ZOO_EXTENSION,
    "settings",
    "neolix-import.json",
  );
}

async function zooInstalled(environment: ConnectEnvironment): Promise<boolean> {
  const exts = vscodeExtensionsDir(environment, VSCODE_STABLE);
  let names: string[];
  try {
    names = await fs.readdir(exts);
  } catch {
    return false;
  }
  return names.some((name) => name.toLowerCase().startsWith(`${ZOO_EXTENSION}-`));
}

function zooProfiles(environment: ConnectEnvironment, model: string): Record<string, unknown> {
  return {
    currentApiConfigName: SLOT,
    apiConfigs: {
      [SLOT]: {
        id: SLOT,
        apiProvider: "openai",
        openAiBaseUrl: `${environment.baseUrl}/v1`,
        openAiApiKey: environment.apiKey,
        openAiModelId: model,
        openAiStreamingEnabled: true,
        openAiCustomModelInfo: zooModelInfo(environment, model),
      },
    },
  };
}

/** Zoo Code's modelInfo for the model it starts on, from the catalog. */
function zooModelInfo(environment: ConnectEnvironment, model: string): Record<string, unknown> {
  const picked = environment.models.find((entry) => entry.id === model);
  return {
    supportsPromptCache: false,
    supportsImages: picked?.images === true,
    contextWindow: picked?.contextWindow ?? 128000,
    ...(picked?.maxOutputTokens === undefined ? {} : { maxTokens: picked.maxOutputTokens }),
  };
}

/** The settings files Zoo Code's auto-import setting goes in: the default and each profile. */
async function zooSettingsFiles(environment: ConnectEnvironment): Promise<string[]> {
  const dir = vscodeUserDir(environment, VSCODE_STABLE);
  const profiles = await vscodeProfiles(dir);
  return [path.join(dir, "settings.json"), ...profiles.settings];
}

const zooCodeDriver: AgentConnectDriver = {
  provider: "zoo-code",
  external: {
    name: "Zoo Code",
    icon: "zoo-code",
    detect: zooInstalled,
  },
  configPath: zooImportPath,
  async read(environment) {
    const settings = await readJsonIfThere(
      path.join(vscodeUserDir(environment, VSCODE_STABLE), "settings.json"),
    );
    const importPath = zooImportPath(environment);
    const pointed = settings["zoo-code.autoImportSettingsPath"] === importPath;
    const file = await readJsonIfThere(importPath);
    const profiles = isRecord(file.providerProfiles) ? file.providerProfiles : {};
    const configs = isRecord(profiles.apiConfigs) ? profiles.apiConfigs : {};
    const ours = isRecord(configs[SLOT]) ? configs[SLOT] : null;
    const model =
      ours !== null && typeof ours.openAiModelId === "string" ? ours.openAiModelId : null;
    const base =
      ours !== null && typeof ours.openAiBaseUrl === "string" ? ours.openAiBaseUrl : null;
    return {
      connected: pointed && ours !== null,
      model,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const chosen = chosenModel(environment, model) ?? environment.models[0]?.id ?? "";
    const importPath = zooImportPath(environment);
    const priorFile = await readTextIfThere(importPath);
    await writeJsonText(importPath, { providerProfiles: zooProfiles(environment, chosen) });
    const parts: AgentConnectUndo[] = [
      shapedUndo(importPath, {
        file: priorFile === null ? { present: false } : { present: true, value: priorFile },
      }),
    ];
    for (const file of await zooSettingsFiles(environment)) {
      const settings = await readJsonIfThere(file);
      const prior = literalKey(settings, "zoo-code.autoImportSettingsPath");
      settings["zoo-code.autoImportSettingsPath"] = importPath;
      await writeJsonText(file, settings);
      parts.push(shapedUndo(file, { importPath: prior }));
    }
    return { kind: "multi", parts };
  },
  async disconnect(environment, undo) {
    for (const part of shapedParts(undo)) {
      if (part.kind !== "yaml") continue;
      if (part.path !== zooImportPath(environment)) {
        if (!(await exists(part.path)) || part.values.importPath === undefined) continue;
        const settings = await readJsonIfThere(part.path);
        restoreLiteral(settings, "zoo-code.autoImportSettingsPath", part.values.importPath);
        await writeJsonText(part.path, settings);
        continue;
      }
      const prior = part.values.file;
      if (isRecord(prior) && prior.present === true && typeof prior.value === "string") {
        await writeText(part.path, prior.value);
      } else {
        await fs.rm(part.path, { force: true });
      }
    }
  },
};

export const BATCH6_AGENT_DRIVERS: AgentConnectDriver[] = [
  snowDriver,
  jcodeDriver,
  vscodeKindDriver,
  zooCodeDriver,
];
