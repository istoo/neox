import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { copilotApiHeaders } from "../../llm-gateway/copilot-signin.js";
import { modelEfforts } from "../../llm-gateway/model-prefs.js";
import { pathExists, readJsonObject } from "../config-files.js";
import {
  type AgentConnectDriver,
  type AgentConnectFieldSetting,
  type ConnectEnvironment,
  PROVIDER_ID,
  type PriorValue,
  capture,
  priorJsonFiles,
  restore,
  setAtValue,
  stripV1,
  writeJsonWithUndo,
} from "../drivers.js";

/**
 * GitHub Copilot CLI reads its own model providers from providers.json
 * ($COPILOT_HOME or ~/.copilot): {"providers": [...], "models": [...]}, and
 * picks a model as <provider>/<id> in settings.json. Neolix owns the provider
 * entry named "neolix" and the models that name it; every other entry and key
 * stays (myna's copilot_byok.go). This needs no GitHub sign-in.
 */

function copilotDir(environment: ConnectEnvironment): string {
  const moved = environment.env.COPILOT_HOME;
  if (moved !== undefined && moved.length > 0) return moved;
  return path.join(environment.homeDir, ".copilot");
}

function copilotSettingsPath(environment: ConnectEnvironment): string {
  return path.join(copilotDir(environment), "settings.json");
}

function copilotProvidersPath(environment: ConnectEnvironment): string {
  const moved = environment.env.COPILOT_PROVIDERS_CONFIG;
  if (moved !== undefined && moved.length > 0) return moved;
  return path.join(copilotDir(environment), "providers.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listOf(root: Record<string, unknown>, key: string): unknown[] {
  const value = root[key];
  return Array.isArray(value) ? value : [];
}

function ownedEntry(entry: unknown, key: string): boolean {
  return isRecord(entry) && entry[key] === PROVIDER_ID;
}

/** Neolix's provider entry, keeping the keys Neolix does not write. */
function copilotProvider(environment: ConnectEnvironment, prior: unknown): Record<string, unknown> {
  const entry: Record<string, unknown> = isRecord(prior) ? { ...prior } : {};
  entry.name = PROVIDER_ID;
  entry.type = "openai";
  entry.baseUrl = `${environment.baseUrl}/v1`;
  entry.apiKey = environment.apiKey;
  return entry;
}

/** Neolix's models for Copilot, from the gateway's catalog. */
function copilotModels(environment: ConnectEnvironment): Record<string, unknown>[] {
  return environment.models
    .filter((model) => model.kind !== "image")
    .map((model) => {
      const entry: Record<string, unknown> = {
        id: model.id,
        provider: PROVIDER_ID,
      };
      if (model.label !== undefined) entry.name = model.label;
      const output = model.maxOutputTokens;
      if (output !== undefined) entry.maxOutputTokens = output;
      if (model.contextWindow !== undefined) {
        entry.maxContextWindowTokens = model.contextWindow;
        let prompt = model.contextWindow;
        if (output !== undefined && output < prompt) prompt -= output;
        entry.maxPromptTokens = prompt;
      }
      return entry;
    });
}

/**
 * How long Copilot's own model list stands: myna asks an account's vendor
 * again once its list is accountListAge old (45 minutes), and retries a
 * failed ask after a minute.
 */
const COPILOT_MODELS_AGE_MS = 45 * 60_000;
const COPILOT_MODELS_RETRY_MS = 60_000;

let copilotModelsCache: { at: number; efforts: Map<string, string[]> | null } | null = null;

/** Forgets the cached list; a test. */
export function clearCopilotModelsCache(): void {
  copilotModelsCache = null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The reasoning levels Copilot lists for each model, asked of its own
 * `/models` with the account's session token (myna's copilotModels:
 * capabilities.supports.reasoning_effort). Null when Neolix has no
 * sign-in or the ask failed, so the caller falls back.
 */
async function copilotLiveEfforts(
  environment: ConnectEnvironment,
): Promise<Map<string, string[]> | null> {
  const cached = copilotModelsCache;
  if (cached !== null) {
    const age = Date.now() - cached.at;
    if (cached.efforts === null ? age < COPILOT_MODELS_RETRY_MS : age < COPILOT_MODELS_AGE_MS) {
      return cached.efforts;
    }
  }
  const source = environment.copilotModels;
  if (source === undefined) {
    copilotModelsCache = { at: Date.now(), efforts: null };
    return null;
  }
  try {
    const account = await source();
    if (account === null) {
      copilotModelsCache = { at: Date.now(), efforts: null };
      return null;
    }
    const fetchImpl = environment.fetch ?? fetch;
    const response = await fetchImpl(`${account.apiBase.replace(/\/+$/u, "")}/models`, {
      method: "GET",
      headers: {
        ...copilotApiHeaders(),
        authorization: `Bearer ${account.token}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      copilotModelsCache = { at: Date.now(), efforts: null };
      return null;
    }
    const body = recordOf(await response.json());
    const data = Array.isArray(body?.data) ? body.data : [];
    const efforts = new Map<string, string[]>();
    for (const entry of data) {
      const model = recordOf(entry);
      const id = typeof model?.id === "string" ? model.id : "";
      const capabilities = recordOf(model?.capabilities);
      const supports = recordOf(capabilities?.supports);
      const levels = Array.isArray(supports?.reasoning_effort)
        ? supports.reasoning_effort.filter((level): level is string => typeof level === "string")
        : [];
      if (id !== "" && levels.length > 0) efforts.set(id, levels);
    }
    copilotModelsCache = { at: Date.now(), efforts };
    return efforts;
  } catch {
    copilotModelsCache = { at: Date.now(), efforts: null };
    return null;
  }
}

/**
 * The levels a Copilot model takes: Copilot's live list, then Neolix's own
 * per-model list, then myna's low to xhigh fallback.
 */
async function copilotEfforts(environment: ConnectEnvironment, model: string): Promise<string[]> {
  const live = await copilotLiveEfforts(environment);
  const listed = live?.get(model);
  if (listed !== undefined && listed.length > 0) return listed;
  const config = environment.config;
  const slash = model.indexOf("/");
  if (config !== undefined && slash > 0) {
    const kept = modelEfforts(config, model.slice(0, slash), model.slice(slash + 1)) ?? [];
    if (kept.length > 0) return kept;
  }
  return ["low", "medium", "high", "xhigh"];
}

async function copilotSettings(
  environment: ConnectEnvironment,
): Promise<AgentConnectFieldSetting[]> {
  const settings = await readJsonObject(copilotSettingsPath(environment));
  const model = typeof settings.model === "string" ? settings.model : "";
  const effort = typeof settings.effortLevel === "string" ? settings.effortLevel : "";
  const prefix = `${PROVIDER_ID}/`;
  const bare = model.startsWith(prefix) ? model.slice(prefix.length) : "";
  return [
    {
      key: "effort",
      label: "effort",
      value: effort,
      options: await copilotEfforts(environment, bare),
    },
  ];
}

async function copilotSetSetting(
  environment: ConnectEnvironment,
  key: string,
  value: string,
): Promise<void> {
  if (key !== "effort") throw new Error(`Copilot CLI has no field "${key}"`);
  const filePath = copilotSettingsPath(environment);
  const settings = await readJsonObject(filePath);
  if (value === "") {
    delete settings.effortLevel;
  } else {
    setAtValue(settings, "effortLevel", value);
  }
  await writeJsonWithUndo(filePath, settings, {}, undefined);
}

/** The executable a bare command name resolves to on this host's PATH. */
async function findExecutable(
  bin: string,
  environment: ConnectEnvironment,
): Promise<string | null> {
  const env = environment.env;
  const platform = environment.platform ?? process.platform;
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter((ext) => ext.length > 0)
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${bin}${extension}`);
      try {
        await fs.access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

/** A folder named as a build's short commit hash is: ten lowercase hex digits. */
function commitHashName(name: string): boolean {
  return /^[0-9a-f]{10}$/u.test(name);
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether bin is a launcher an editor ships, not the CLI it is named after
 * (myna's editorLauncher): an editor's install is told by the product.json
 * it keeps beside its program, three folders up at most, including VS
 * Code's <install>/<commit>/resources/app layout. A link is judged where it
 * points.
 */
async function isEditorLauncher(bin: string): Promise<boolean> {
  let real = bin;
  try {
    real = await fs.realpath(bin);
  } catch {
    // A link that cannot be resolved is judged where it stands.
  }
  let dir = path.dirname(path.resolve(real));
  for (let step = 0; step < 3; step += 1) {
    if (
      (await isFile(path.join(dir, "product.json"))) ||
      (await isFile(path.join(dir, "resources", "app", "product.json")))
    ) {
      return true;
    }
    let entries: { isDirectory(): boolean; name: string }[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        commitHashName(entry.name) &&
        (await isFile(path.join(dir, entry.name, "resources", "app", "product.json")))
      ) {
        return true;
      }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

/** Puts Neolix's provider and models into providers.json, everything else as it was. */
function writeProviders(root: Record<string, unknown>, environment: ConnectEnvironment): void {
  const providers = listOf(root, "providers");
  const models = listOf(root, "models");
  let prior: unknown;
  const keptProviders: unknown[] = [];
  let placed = false;
  for (const entry of providers) {
    if (!ownedEntry(entry, "name")) {
      keptProviders.push(entry);
      continue;
    }
    if (placed) continue;
    placed = true;
    prior = entry;
  }
  keptProviders.push(copilotProvider(environment, prior));
  let first = -1;
  const keptModels: unknown[] = [];
  for (const entry of models) {
    if (ownedEntry(entry, "provider")) {
      if (first < 0) first = keptModels.length;
      continue;
    }
    keptModels.push(entry);
  }
  if (first < 0) first = keptModels.length;
  const mine = copilotModels(environment);
  keptModels.splice(first, 0, ...mine);
  setAtValue(root, "providers", keptProviders);
  setAtValue(root, "models", keptModels);
}

export const copilotDriver: AgentConnectDriver = {
  provider: "copilot",
  version: async (environment) => {
    if (environment.run === undefined) return null;
    // An editor's copilot-shim only asks for the CLI to be installed; its
    // version says nothing of the CLI (myna's binNot, #3269).
    const bin = await findExecutable("copilot", environment);
    if (bin !== null && (await isEditorLauncher(bin))) return null;
    try {
      const output = await environment.run("copilot", ["--version"]);
      return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/u.exec(output)?.[1] ?? null;
    } catch {
      return null;
    }
  },
  configPath: copilotSettingsPath,
  settings: copilotSettings,
  setSetting: copilotSetSetting,
  async read(environment) {
    const settings = await readJsonObject(copilotSettingsPath(environment));
    const providersFile = await readJsonObject(copilotProvidersPath(environment));
    const model = typeof settings.model === "string" ? settings.model : null;
    const prefix = `${PROVIDER_ID}/`;
    const own = listOf(providersFile, "providers").find((entry) => ownedEntry(entry, "name"));
    const base = isRecord(own) && typeof own.baseUrl === "string" ? String(own.baseUrl) : null;
    return {
      connected: model !== null && model.startsWith(prefix),
      model: model !== null && model.startsWith(prefix) ? model.slice(prefix.length) : null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, undo) {
    const chosen = model ?? environment.models[0]?.id ?? null;
    if (chosen === null) throw new Error("The gateway serves no models for Copilot CLI.");
    // Nothing configured and only an editor's launcher on PATH: that is not
    // the CLI, and writing a config for it would connect nothing.
    if (!(await pathExists(copilotSettingsPath(environment)))) {
      const bin = await findExecutable("copilot", environment);
      if (bin !== null && (await isEditorLauncher(bin))) {
        throw new Error(
          "VS Code's copilot launcher is not the Copilot CLI: install the CLI (npm install -g @github/copilot), then connect again.",
        );
      }
    }
    const settingsPath = copilotSettingsPath(environment);
    const providersPath = copilotProvidersPath(environment);
    const settings = await readJsonObject(settingsPath);
    const providers = await readJsonObject(providersPath);
    const settingsPrior: Record<string, PriorValue> = {};
    const providersPrior: Record<string, PriorValue> = {};
    capture(settings, settingsPrior, "model");
    capture(providers, providersPrior, "providers");
    capture(providers, providersPrior, "models");
    setAtValue(settings, "model", `${PROVIDER_ID}/${chosen}`);
    writeProviders(providers, environment);
    const settingsEntry = await writeJsonWithUndo(settingsPath, settings, settingsPrior, undo);
    const providersEntry = await writeJsonWithUndo(providersPath, providers, providersPrior, undo);
    return { kind: "json", files: [settingsEntry, providersEntry] };
  },
  async disconnect(environment, undo) {
    const settingsPath = copilotSettingsPath(environment);
    const providersPath = copilotProvidersPath(environment);
    const priorSettings = priorJsonFiles(undo).find((file) => file.path === settingsPath);
    if (priorSettings !== undefined) {
      const settings = await readJsonObject(settingsPath);
      restore(settings, priorSettings.values);
      await writeJsonWithUndo(settingsPath, settings, {}, undo);
    } else {
      const settings = await readJsonObject(settingsPath);
      const model = typeof settings.model === "string" ? settings.model : "";
      if (model.startsWith(`${PROVIDER_ID}/`)) {
        delete settings.model;
        await writeJsonWithUndo(settingsPath, settings, {}, undo);
      }
    }
    const priorProviders = priorJsonFiles(undo).find((file) => file.path === providersPath);
    if (priorProviders !== undefined) {
      const providers = await readJsonObject(providersPath);
      restore(providers, priorProviders.values);
      await writeJsonWithUndo(providersPath, providers, {}, undo);
      return;
    }
    const providers = await readJsonObject(providersPath);
    const nextProviders = listOf(providers, "providers").filter(
      (entry) => !ownedEntry(entry, "name"),
    );
    const nextModels = listOf(providers, "models").filter(
      (entry) => !ownedEntry(entry, "provider"),
    );
    if (
      nextProviders.length === listOf(providers, "providers").length &&
      nextModels.length === listOf(providers, "models").length
    ) {
      return;
    }
    setAtValue(providers, "providers", nextProviders);
    setAtValue(providers, "models", nextModels);
    await writeJsonWithUndo(providersPath, providers, {}, undo);
  },
};
