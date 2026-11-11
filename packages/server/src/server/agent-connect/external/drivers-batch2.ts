import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { contentHash, readJsonObject, readTextOrNull } from "../config-files.js";
import {
  capture,
  type AgentConnectDriver,
  type AgentConnectUndo,
  type ConnectEnvironment,
  type PriorValue,
  priorJsonFiles,
  restore,
  setAtValue,
  stripV1,
  writeJsonWithUndo,
} from "../drivers.js";
import {
  absoluteDir,
  configHome,
  envOverride,
  getTomlTableKey,
  isDir,
  isOnPath,
  readYamlDocument,
  removeTomlTable,
  setTomlTableKey,
  setTomlTableRawKey,
  textUndo,
  writeText,
  writeYamlDocument,
  yamlString,
} from "./helpers.js";

const SLOT = "neolix";

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
}

function labelOf(model: AgentConnectModel): string {
  return model.label ?? model.id;
}

function jsonUndo(entries: Awaited<ReturnType<typeof writeJsonWithUndo>>[]): AgentConnectUndo {
  return { kind: "json", files: entries };
}

function undoParts(undo: AgentConnectUndo | undefined): AgentConnectUndo[] {
  if (undo === undefined) return [];
  return undo.kind === "multi" ? undo.parts : [undo];
}

function readJsonString(root: Record<string, unknown>, jsonPath: string[]): string | null {
  let current: unknown = root;
  for (const key of jsonPath) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
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
  const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
  if (prior) restore(root, prior.values);
  await writeJsonWithUndo(filePath, root, {}, undo);
}

// ---------- Qwen Code ----------

function qwenDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "QWEN_HOME"), [".qwen"]);
}

function qwenPath(environment: ConnectEnvironment): string {
  return path.join(qwenDir(environment), "settings.json");
}

const QWEN_ENV_KEY = "NEOLIX_QWEN_API_KEY";

interface QwenEntry {
  baseUrl: string;
  envKey: string;
  id: string;
  name: string;
}

function qwenEntries(root: Record<string, unknown>): QwenEntry[] {
  const providers = root.modelProviders;
  if (typeof providers !== "object" || providers === null) return [];
  const openai = (providers as Record<string, unknown>).openai;
  return Array.isArray(openai) ? (openai as QwenEntry[]) : [];
}

const qwenDriver: AgentConnectDriver = {
  provider: "qwen",
  external: {
    name: "Qwen Code",
    icon: "qwen-color",
    detect: async (environment) =>
      (await isOnPath("qwen", environment)) || (await isDir(qwenDir(environment))),
  },
  configPath: qwenPath,
  async read(environment) {
    const root = await readJsonObject(qwenPath(environment));
    const auth = readJsonString(root, ["security", "auth", "selectedType"]);
    const key = readJsonString(root, ["env", QWEN_ENV_KEY]);
    const name = readJsonString(root, ["model", "name"]);
    return {
      connected: auth === "openai" && key === environment.apiKey && name !== null,
      model: name,
      baseUrl: readJsonString(root, ["model", "baseUrl"]),
    };
  },
  async connect(environment, model, undo) {
    const filePath = qwenPath(environment);
    const root = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of [
      "modelProviders.openai",
      "model.name",
      "model.baseUrl",
      "security.auth.selectedType",
      `env.${QWEN_ENV_KEY}`,
    ]) {
      capture(root, captured, key);
    }
    const ours = environment.models.map((entry) => ({
      baseUrl: `${environment.baseUrl}/v1`,
      envKey: QWEN_ENV_KEY,
      id: entry.id,
      name: labelOf(entry),
    }));
    const kept = qwenEntries(root).filter((entry) => entry.envKey !== QWEN_ENV_KEY);
    setAtValue(root, "modelProviders.openai", [...kept, ...ours]);
    setAtValue(root, `env.${QWEN_ENV_KEY}`, environment.apiKey);
    setAtValue(root, "security.auth.selectedType", "openai");
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(root, "model.name", chosen);
      setAtValue(root, "model.baseUrl", `${environment.baseUrl}/v1`);
    }
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(qwenPath(environment), undo);
  },
};

// ---------- Hermes Agent ----------

function hermesDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "HERMES_HOME"), [".hermes"]);
}

function hermesPath(environment: ConnectEnvironment): string {
  return path.join(hermesDir(environment), "config.yaml");
}

const hermesDriver: AgentConnectDriver = {
  provider: "hermes",
  external: {
    name: "Hermes Agent",
    icon: "hermes",
    detect: async (environment) =>
      (await isOnPath("hermes", environment)) || (await isDir(hermesDir(environment))),
  },
  configPath: hermesPath,
  async read(environment) {
    const document = await readYamlDocument(hermesPath(environment));
    const provider = yamlString(document, ["model", "provider"]);
    return {
      connected: provider === SLOT,
      model: yamlString(document, ["model", "default"]),
      baseUrl: yamlString(document, ["providers", SLOT, "base_url"]),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = hermesPath(environment);
    const document = await readYamlDocument(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const yamlPath of [`providers.${SLOT}`, "model.provider", "model.default"]) {
      const parts = yamlPath.split(".");
      captured[yamlPath] = document.hasIn(parts)
        ? { present: true, value: document.getIn(parts) }
        : { present: false };
    }
    document.setIn(["providers", SLOT], {
      name: "Neox",
      base_url: `${environment.baseUrl}/v1`,
      api_key: environment.apiKey,
      api_mode: "chat_completions",
      headers: { "User-Agent": "hermes-agent" },
      models: environment.models.map((entry) => entry.id),
    });
    document.setIn(["model", "provider"], SLOT);
    const chosen = chosenModel(environment, model);
    if (chosen !== null) document.setIn(["model", "default"], chosen);
    await writeYamlDocument(filePath, document);
    return { kind: "yaml", path: filePath, values: captured };
  },
  async disconnect(environment, undo) {
    const filePath = hermesPath(environment);
    const yamlUndo = undoParts(undo).find((part) => part.kind === "yaml");
    if (yamlUndo?.kind !== "yaml" || !(await exists(filePath))) return;
    const document = await readYamlDocument(filePath);
    for (const [yamlPath, prior] of Object.entries(yamlUndo.values)) {
      const parts = yamlPath.split(".");
      if (prior.present) document.setIn(parts, prior.value);
      else document.deleteIn(parts);
    }
    dropEmptyMap(document, ["providers"]);
    dropEmptyMap(document, ["model"]);
    await writeYamlDocument(filePath, document);
  },
};

// ---------- Grok App ----------

function grokAppDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "GROK_APP_HOME");
  if (override !== null && path.isAbsolute(override)) return override;
  const home = environment.homeDir;
  if ((environment.platform ?? process.platform) === "darwin") {
    return path.join(home, "Library", "Application Support", "com.grokapp.grok-app");
  }
  if ((environment.platform ?? process.platform) === "win32") {
    const appData = environment.env.APPDATA?.trim() ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "grokapp", "grok-app", "data");
  }
  const data = environment.env.XDG_DATA_HOME?.trim();
  return path.join(
    data && path.isAbsolute(data) ? data : path.join(home, ".local", "share"),
    "grok-app",
  );
}

function grokAppPath(environment: ConnectEnvironment): string {
  return path.join(grokAppDir(environment), "agent-home", "config.toml");
}

const GROK_APP_TABLE = `[model.${SLOT}]`;

const grokAppDriver: AgentConnectDriver = {
  provider: "grok-app",
  external: {
    name: "Grok App",
    icon: "grok",
    detect: (environment) => isDir(grokAppDir(environment)),
  },
  configPath: grokAppPath,
  async read(environment) {
    const filePath = grokAppPath(environment);
    const text = (await readTextOrNull(filePath)) ?? "";
    const model = getTomlTableKey(text, GROK_APP_TABLE, "model");
    return {
      connected: model !== null,
      model,
      baseUrl: stripV1OrNull(getTomlTableKey(text, GROK_APP_TABLE, "base_url")),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = grokAppPath(environment);
    const before = await readTextOrNull(filePath);
    const chosen = chosenModel(environment, model);
    let next = before ?? "";
    const set = (key: string, value: string): void => {
      next = setTomlTableKey(next, GROK_APP_TABLE, key, value);
    };
    if (chosen !== null) set("model", chosen);
    set("base_url", `${environment.baseUrl}/v1`);
    set("name", "Neox");
    set("api_key", environment.apiKey);
    set("api_backend", "chat_completions");
    set("app_provider_mode", "generic");
    set(
      "app_models",
      JSON.stringify(environment.models.map((entry) => ({ id: entry.id, name: labelOf(entry) }))),
    );
    set("app_efforts", "[]");
    next = setTomlTableRawKey(next, GROK_APP_TABLE, "supports_reasoning_effort", "false");
    const wrote = next.endsWith("\n") ? next : `${next}\n`;
    await writeText(filePath, wrote);
    return {
      kind: "toml-tables",
      path: filePath,
      before,
      wrote: contentHash(wrote),
      sections: [GROK_APP_TABLE],
      restore: [],
    };
  },
  async disconnect(environment, undo) {
    const filePath = grokAppPath(environment);
    const text = await readTextOrNull(filePath);
    if (text === null) return;
    if (
      undo?.kind === "toml-tables" &&
      undo.path === filePath &&
      contentHash(text) === undo.wrote
    ) {
      if (undo.before === null) await fs.rm(filePath, { force: true });
      else await writeText(filePath, undo.before);
      return;
    }
    await writeText(filePath, removeTomlTable(text, GROK_APP_TABLE));
  },
};

function stripV1OrNull(value: string | null): string | null {
  return value === null ? null : stripV1(value);
}

// ---------- CodeBuddy / WorkBuddy models.json ----------

interface BuddyEntry {
  id?: unknown;
  vendor?: unknown;
  apiKey?: unknown;
  [key: string]: unknown;
}

interface BuddyFile {
  entries: BuddyEntry[];
  rest: Record<string, unknown> | null;
}

function readBuddyFile(text: string): BuddyFile {
  if (text.trim().length === 0) return { entries: [], rest: null };
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) return { entries: parsed as BuddyEntry[], rest: null };
  if (typeof parsed === "object" && parsed !== null) {
    const rest = parsed as Record<string, unknown>;
    const entries = Array.isArray(rest.models) ? (rest.models as BuddyEntry[]) : [];
    return { entries, rest };
  }
  return { entries: [], rest: null };
}

function isOurs(entry: BuddyEntry, apiKey: string): boolean {
  return entry.vendor === SLOT || entry.apiKey === apiKey;
}

function buddyModel(environment: ConnectEnvironment, entry: AgentConnectModel): BuddyEntry {
  return {
    id: entry.id,
    name: labelOf(entry),
    vendor: SLOT,
    apiKey: environment.apiKey,
    url: `${environment.baseUrl}/v1/chat/completions`,
    maxInputTokens: entry.contextWindow ?? 128000,
    supportsToolCall: true,
    supportsImages: entry.images === true,
    supportsReasoning: false,
  };
}

function writeBuddyFile(file: BuddyFile, entries: BuddyEntry[]): string {
  const value = file.rest === null ? entries : { ...file.rest, models: entries };
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function connectBuddyModels(
  filePath: string,
  environment: ConnectEnvironment,
): Promise<string | null> {
  const before = await readTextOrNull(filePath);
  const file = readBuddyFile(before ?? "");
  const kept = file.entries.filter((entry) => !isOurs(entry, environment.apiKey));
  const ours = environment.models.map((entry) => buddyModel(environment, entry));
  await writeText(filePath, writeBuddyFile(file, [...kept, ...ours]));
  return before;
}

function codebuddyDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "CODEBUDDY_CONFIG_DIR"), [
    ".codebuddy",
  ]);
}

const codebuddyDriver: AgentConnectDriver = {
  provider: "codebuddy",
  external: {
    name: "CodeBuddy",
    icon: "codebuddy-color",
    detect: async (environment) =>
      (await isOnPath("codebuddy", environment)) || (await isDir(codebuddyDir(environment))),
  },
  configPath: (environment) => path.join(codebuddyDir(environment), "models.json"),
  async read(environment) {
    const dir = codebuddyDir(environment);
    const modelsPath = path.join(dir, "models.json");
    const settingsPath = path.join(dir, "settings.json");
    const file = readBuddyFile((await readTextOrNull(modelsPath)) ?? "");
    const settings = await readJsonObject(settingsPath);
    const model = readJsonString(settings, ["model"]);
    const wired = file.entries.some(
      (entry) => isOurs(entry, environment.apiKey) && entry.id === model,
    );
    return { connected: wired, model: wired ? model : null, baseUrl: null };
  },
  async connect(environment, model, undo) {
    const dir = codebuddyDir(environment);
    const modelsPath = path.join(dir, "models.json");
    const settingsPath = path.join(dir, "settings.json");
    const before = await connectBuddyModels(modelsPath, environment);
    const afterModels = (await readTextOrNull(modelsPath)) ?? "";
    const settings = await readJsonObject(settingsPath);
    const captured: Record<string, PriorValue> = {};
    capture(settings, captured, "model");
    const chosen = chosenModel(environment, model);
    if (chosen !== null) setAtValue(settings, "model", chosen);
    const entry = await writeJsonWithUndo(settingsPath, settings, captured, undo);
    return {
      kind: "multi",
      parts: [jsonUndo([entry]), textUndo(modelsPath, before, afterModels)],
    };
  },
  async disconnect(environment, undo) {
    const dir = codebuddyDir(environment);
    const jsonPart = undoParts(undo).find((part) => part.kind === "json");
    await restoreJsonFile(path.join(dir, "settings.json"), jsonPart);
    const modelsPath = path.join(dir, "models.json");
    const textUndoPart = undoParts(undo).find(
      (part): part is Extract<AgentConnectUndo, { kind: "text" }> => part.kind === "text",
    );
    if (textUndoPart?.kind === "text") {
      if (textUndoPart.before === null) await fs.rm(modelsPath, { force: true });
      else await writeText(modelsPath, textUndoPart.before);
    }
  },
};

function workbuddyDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "WORKBUDDY_CONFIG_DIR"), [
    ".workbuddy",
  ]);
}

const workbuddyDriver: AgentConnectDriver = {
  provider: "workbuddy",
  external: {
    name: "WorkBuddy",
    icon: "workbuddy-color",
    detect: (environment) => isDir(workbuddyDir(environment)),
  },
  configPath: (environment) => path.join(workbuddyDir(environment), "models.json"),
  async read(environment) {
    const filePath = path.join(workbuddyDir(environment), "models.json");
    const file = readBuddyFile((await readTextOrNull(filePath)) ?? "");
    const ours = file.entries.find((entry) => isOurs(entry, environment.apiKey));
    return { connected: ours !== undefined, model: null, baseUrl: null };
  },
  async connect(environment, _model, _undo) {
    const filePath = path.join(workbuddyDir(environment), "models.json");
    const before = await connectBuddyModels(filePath, environment);
    return textUndo(filePath, before, (await readTextOrNull(filePath)) ?? "");
  },
  async disconnect(environment, undo) {
    const filePath = path.join(workbuddyDir(environment), "models.json");
    const part = undoParts(undo).find(
      (entry): entry is Extract<AgentConnectUndo, { kind: "text" }> => entry.kind === "text",
    );
    if (part?.kind !== "text") return;
    if (part.before === null) await fs.rm(filePath, { force: true });
    else await writeText(filePath, part.before);
  },
};

// ---------- Command Code ----------

function commandCodeDir(environment: ConnectEnvironment): string {
  return path.join(environment.homeDir, ".commandcode");
}

function commandCodePath(environment: ConnectEnvironment): string {
  return path.join(commandCodeDir(environment), "settings.json");
}

const commandCodeDriver: AgentConnectDriver = {
  provider: "commandcode",
  external: {
    name: "Command Code",
    icon: "commandcode",
    detect: async (environment) =>
      (await isOnPath("command-code", environment)) || (await isDir(commandCodeDir(environment))),
  },
  configPath: commandCodePath,
  async read(environment) {
    const root = await readJsonObject(commandCodePath(environment));
    return {
      connected: readJsonString(root, ["modelProvider"]) === SLOT,
      model: readJsonString(root, ["model"]),
      baseUrl: readJsonString(root, ["provider", SLOT, "baseURL"]),
    };
  },
  async connect(environment, model, undo) {
    const filePath = commandCodePath(environment);
    const root = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of [`provider.${SLOT}`, "model", "modelProvider"]) {
      capture(root, captured, key);
    }
    setAtValue(root, `provider.${SLOT}`, {
      name: "Neox",
      api: "openai-completions",
      baseURL: `${environment.baseUrl}/v1`,
      apiKey: false,
      models: Object.fromEntries(
        environment.models.map((entry) => [entry.id, { name: labelOf(entry) }]),
      ),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) setAtValue(root, "model", chosen);
    setAtValue(root, "modelProvider", SLOT);
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(commandCodePath(environment), undo);
  },
};

// ---------- MiniMax Code ----------

function miniMaxDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "MINIMAX_DATA_DIR"), [".minimax"]);
}

function miniMaxPath(environment: ConnectEnvironment): string {
  return path.join(miniMaxDir(environment), "config.yaml");
}

const MINIMAX_ENTRY = `custom_provider.${SLOT}`;

const miniMaxDriver: AgentConnectDriver = {
  provider: "minimax-code",
  external: {
    name: "MiniMax Code",
    icon: "minimax-color",
    detect: async (environment) =>
      (await isOnPath("mcode", environment)) || (await isDir(miniMaxDir(environment))),
  },
  configPath: miniMaxPath,
  async read(environment) {
    const document = await readYamlDocument(miniMaxPath(environment));
    const defaultModel = yamlString(document, ["defaultModel"]);
    return {
      connected: defaultModel?.startsWith(`${SLOT}/`) === true,
      model:
        defaultModel?.startsWith(`${SLOT}/`) === true ? defaultModel.slice(SLOT.length + 1) : null,
      baseUrl: yamlString(document, ["custom_provider", SLOT, "options", "baseURL"]),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = miniMaxPath(environment);
    const document = await readYamlDocument(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const yamlPath of [MINIMAX_ENTRY, "defaultModel", "defaultModelVariant"]) {
      const parts = yamlPath.split(".");
      captured[yamlPath] = document.hasIn(parts)
        ? { present: true, value: document.getIn(parts) }
        : { present: false };
    }
    document.setIn(["custom_provider", SLOT], {
      name: "Neox",
      kind: "custom",
      enabled: true,
      api: "anthropic-messages",
      options: {
        apiKey: environment.apiKey,
        baseURL: environment.baseUrl,
        authMode: "api-key",
        headers: { "User-Agent": "mcode" },
      },
      models: Object.fromEntries(
        environment.models.map((entry) => [entry.id, { name: labelOf(entry) }]),
      ),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      document.setIn(["defaultModel"], `${SLOT}/${chosen}`);
      document.deleteIn(["defaultModelVariant"]);
    }
    await writeYamlDocument(filePath, document);
    return { kind: "yaml", path: filePath, values: captured };
  },
  async disconnect(environment, undo) {
    const filePath = miniMaxPath(environment);
    const yamlUndo = undoParts(undo).find((part) => part.kind === "yaml");
    if (yamlUndo?.kind !== "yaml" || !(await exists(filePath))) return;
    const document = await readYamlDocument(filePath);
    for (const [yamlPath, prior] of Object.entries(yamlUndo.values)) {
      const parts = yamlPath.split(".");
      if (prior.present) document.setIn(parts, prior.value);
      else document.deleteIn(parts);
    }
    dropEmptyMap(document, ["custom_provider"]);
    await writeYamlDocument(filePath, document);
  },
};

/** A mapping left with no keys is Neolix's, not the reader's. */
function dropEmptyMap(
  document: Awaited<ReturnType<typeof readYamlDocument>>,
  yamlPath: string[],
): void {
  const value = document.getIn(yamlPath);
  if (typeof value !== "object" || value === null) return;
  const items = (value as { items?: unknown[] }).items;
  const empty = Array.isArray(items) ? items.length === 0 : Object.keys(value).length === 0;
  if (empty) document.deleteIn(yamlPath);
}

// ---------- Devin ----------

function devinDir(environment: ConnectEnvironment): string {
  if ((environment.platform ?? process.platform) === "win32") {
    const appData = environment.env.APPDATA?.trim();
    return path.join(appData && appData.length > 0 ? appData : environment.homeDir, "devin");
  }
  return path.join(configHome(environment), "devin");
}

const devinDriver: AgentConnectDriver = {
  provider: "devin",
  external: {
    name: "Devin",
    icon: "devin",
    detect: async (environment) =>
      (await isOnPath("devin", environment)) || (await isDir(devinDir(environment))),
    // Devin's models are its own; myna only picks among them.
    noConnect: true,
  },
  configPath: (environment) => path.join(devinDir(environment), "config.json"),
  async read(environment) {
    const root = await readJsonObject(path.join(devinDir(environment), "config.json"));
    return { connected: false, model: readJsonString(root, ["agent", "model"]), baseUrl: null };
  },
  async connect(_environment, _model, undo) {
    return undo ?? jsonUndo([]);
  },
  async disconnect() {
    // Nothing of Devin's is written.
  },
};

export const BATCH2_AGENT_DRIVERS: AgentConnectDriver[] = [
  qwenDriver,
  hermesDriver,
  grokAppDriver,
  codebuddyDriver,
  workbuddyDriver,
  commandCodeDriver,
  miniMaxDriver,
  devinDriver,
];
