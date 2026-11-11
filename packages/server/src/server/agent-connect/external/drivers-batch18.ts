import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import {
  capture,
  type AgentConnectDriver,
  type ConnectEnvironment,
  PROVIDER_ID,
  type PriorValue,
  restore,
  setAtValue,
  stripV1,
  writeJsonWithUndo,
} from "../drivers.js";
import { envOverride, homePath, isDir, isOnPath } from "./helpers.js";

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
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readJsonString(root: Record<string, unknown>, keys: string[]): string | null {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

// ---------- Alma: its local REST API ----------

const ALMA_API = "http://localhost:23001";

/** Where Alma keeps its data (myna's almaDir), the first folder that is there. */
async function almaDir(environment: ConnectEnvironment): Promise<string | null> {
  const home = environment.homeDir;
  const dirs: string[] = [];
  if (environment.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "alma"));
  } else if (environment.platform === "win32") {
    dirs.push(
      path.join(
        envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming"),
        "alma",
      ),
    );
  } else {
    const config = envOverride(environment.env, "XDG_CONFIG_HOME") ?? path.join(home, ".config");
    dirs.push(path.join(config, "alma"));
    const data = envOverride(environment.env, "ALMA_DATA_DIR");
    if (data !== null) dirs.push(data);
    const share =
      envOverride(environment.env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share");
    dirs.push(path.join(share, "alma"));
  }
  for (const dir of dirs) {
    if (await isDir(dir)) return dir;
  }
  return dirs[0] ?? null;
}

async function almaRequest(
  environment: ConnectEnvironment,
  method: string,
  route: string,
  body?: unknown,
): Promise<unknown> {
  const client = environment.fetch ?? fetch;
  let response: Response;
  try {
    response = await client(`${ALMA_API}${route}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(1500),
    });
  } catch (cause) {
    throw new Error("Alma is not running — open Alma and try again.", { cause });
  }
  if (!response.ok) throw new Error(`Alma answered ${response.status} for ${route}.`);
  const text = await response.text();
  if (text.trim().length === 0) return null;
  return JSON.parse(text) as unknown;
}

interface AlmaProvider {
  id: string;
  name: string;
  type: string;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

function almaProviders(value: unknown): AlmaProvider[] {
  if (!Array.isArray(value)) return [];
  const out: AlmaProvider[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      type: typeof entry.type === "string" ? entry.type : "",
      baseURL: typeof entry.baseURL === "string" ? entry.baseURL : "",
      apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
      enabled: entry.enabled !== false,
    });
  }
  return out;
}

function sameHost(baseUrl: string, gateway: string): boolean {
  try {
    return new URL(baseUrl).host === new URL(gateway).host;
  } catch {
    return false;
  }
}

/** Neolix's provider in Alma: its own name, or one already on this gateway. */
function almaMine(
  providers: AlmaProvider[],
  environment: ConnectEnvironment,
): AlmaProvider | undefined {
  const named = providers.find(
    (entry) => entry.name === SLOT && (entry.type === "openai" || entry.type === "custom"),
  );
  if (named !== undefined) return named;
  return providers.find(
    (entry) =>
      (entry.type === "openai" || entry.type === "custom") &&
      entry.baseURL.length > 0 &&
      sameHost(entry.baseURL, `${environment.baseUrl}/v1`),
  );
}

function almaModel(entry: AgentConnectModel): Record<string, unknown> {
  const caps: Record<string, unknown> = { functionCalling: true };
  if (entry.images === true) caps.vision = true;
  if (entry.contextWindow !== undefined) caps.contextWindow = entry.contextWindow;
  if (entry.maxOutputTokens !== undefined) caps.maxOutputTokens = entry.maxOutputTokens;
  return { id: entry.id, name: labelOf(entry), capabilityOverrides: caps };
}

function almaDefault(settings: Record<string, unknown>): string {
  return readJsonString(settings, ["chat", "defaultModel"]) ?? "";
}

async function almaSettings(environment: ConnectEnvironment): Promise<Record<string, unknown>> {
  const value = await almaRequest(environment, "GET", "/api/settings");
  return isRecord(value) ? value : {};
}

const almaDriver: AgentConnectDriver = {
  provider: "alma",
  external: {
    name: "Alma",
    icon: "alma",
    detect: async (environment) => {
      const dir = await almaDir(environment);
      return dir !== null && isDir(dir);
    },
  },
  configPath: () => ALMA_API,
  async read(environment) {
    try {
      const providers = almaProviders(await almaRequest(environment, "GET", "/api/providers"));
      const settings = await almaSettings(environment);
      const mine = almaMine(providers, environment);
      const value = almaDefault(settings);
      const cut = value.indexOf(":");
      if (mine === undefined || cut <= 0 || value.slice(0, cut) !== mine.id) {
        return { connected: false, model: null, baseUrl: null };
      }
      return {
        connected: true,
        model: value.slice(cut + 1),
        baseUrl: mine.baseURL.length > 0 ? stripV1(mine.baseURL) : null,
      };
    } catch {
      return { connected: false, model: null, baseUrl: null };
    }
  },
  async connect(environment, model) {
    const chosen = chosenModel(environment, model);
    if (chosen === null) throw new Error("Alma needs a model from the gateway.");
    const listed = almaProviders(await almaRequest(environment, "GET", "/api/providers"));
    let mine = almaMine(listed, environment);
    if (mine === undefined) {
      const made = await almaRequest(environment, "POST", "/api/providers", {
        name: "Neox",
        type: "openai",
        apiKey: environment.apiKey,
        baseURL: `${environment.baseUrl}/v1`,
        enabled: true,
      });
      mine =
        isRecord(made) && typeof made.id === "string"
          ? almaProviders([made])[0]
          : almaMine(
              almaProviders(await almaRequest(environment, "GET", "/api/providers")),
              environment,
            );
      if (mine === undefined) throw new Error("Alma did not keep Neox's provider.");
    } else if (mine.baseURL !== `${environment.baseUrl}/v1` || !mine.enabled) {
      await almaRequest(environment, "PUT", `/api/providers/${mine.id}`, {
        baseURL: `${environment.baseUrl}/v1`,
        apiKey: environment.apiKey,
        enabled: true,
      });
    }
    await almaRequest(environment, "PUT", `/api/providers/${mine.id}/models`, {
      models: environment.models.map((entry) => entry.id),
      availableModels: environment.models.map((entry) => almaModel(entry)),
    });
    const settings = await almaSettings(environment);
    const chat = isRecord(settings.chat) ? { ...settings.chat } : {};
    chat.defaultModel = `${mine.id}:${chosen}`;
    settings.chat = chat;
    // Alma's image picker on Auto takes the gateway's image model, so
    // drawing through Neolix works without picking one there (myna's
    // almaSetImage). One the reader picked stays theirs.
    const image = isRecord(settings.imageGen) ? { ...settings.imageGen } : {};
    const imageModel = environment.gatewayImageModels?.[0];
    if (imageModel !== undefined && (typeof image.model !== "string" || image.model.length === 0)) {
      image.model = `${mine.id}:${imageModel}`;
      settings.imageGen = image;
    }
    await almaRequest(environment, "PUT", "/api/settings", settings);
    return { kind: "json", files: [] };
  },
  async disconnect(environment) {
    const providers = almaProviders(await almaRequest(environment, "GET", "/api/providers"));
    const mine = almaMine(providers, environment);
    if (mine === undefined) return;
    const settings = await almaSettings(environment);
    const value = almaDefault(settings);
    const image = isRecord(settings.imageGen) ? { ...settings.imageGen } : {};
    let changed = false;
    if (value.startsWith(`${mine.id}:`)) {
      const chat = isRecord(settings.chat) ? { ...settings.chat } : {};
      chat.defaultModel = "";
      settings.chat = chat;
      changed = true;
    }
    if (typeof image.model === "string" && image.model.startsWith(`${mine.id}:`)) {
      image.model = "";
      settings.imageGen = image;
      changed = true;
    }
    if (changed) await almaRequest(environment, "PUT", "/api/settings", settings);
    await almaRequest(environment, "DELETE", `/api/providers/${mine.id}`);
  },
};

// ---------- Aside: per-account files, with Pi's provider block ----------

interface AsidePaths {
  dir: string;
  settings: string;
  models: string;
}

/** The Aside account Neolix configures: the one Aside has active, else u0. */
async function asidePaths(environment: ConnectEnvironment): Promise<AsidePaths> {
  const root = homePath(environment, ".aside");
  let account = 0;
  const accounts = await readJsonIfThere(path.join(root, "accounts.json"));
  const current = accounts.currentAccountId;
  if (typeof current === "number" && Number.isInteger(current) && current >= 0) account = current;
  else if (typeof current === "string" && /^\d+$/.test(current.trim())) {
    account = Number(current.trim());
  }
  let dir = path.join(root, "u", String(account));
  if (!(await isDir(dir))) dir = path.join(root, "u", "0");
  return {
    dir,
    settings: path.join(dir, "settings.json"),
    models: path.join(dir, "models.json"),
  };
}

function asideSelection(raw: unknown): string {
  if (!isRecord(raw)) return "";
  const provider = typeof raw.provider === "string" ? raw.provider : "";
  const model = typeof raw.modelId === "string" ? raw.modelId : "";
  return provider.length > 0 && model.length > 0 ? `${provider}/${model}` : "";
}

function asideBlock(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    name: "Neox",
    baseUrl: `${environment.baseUrl}/v1`,
    api: "openai-completions",
    apiKey: environment.apiKey,
    compat: { sendSessionAffinityHeaders: true },
    models: environment.models.map((entry) => ({
      id: entry.id,
      name: labelOf(entry),
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      ...(entry.maxOutputTokens === undefined ? {} : { maxTokens: entry.maxOutputTokens }),
      ...(entry.images === undefined ? {} : { input: entry.images ? ["text", "image"] : ["text"] }),
    })),
  };
}

/** Aside's model roles, each one a row of its own (myna's fast/standard/deep/visual fields). */
const ASIDE_ROLES = ["fast", "standard", "deep", "visual"];

/** The four roles as the account's settings hold them, and whether Neolix's provider is there. */
async function asideRead(environment: ConnectEnvironment): Promise<{
  roles: Record<string, string | null>;
  wired: boolean;
  baseUrl: string | null;
}> {
  const paths = await asidePaths(environment);
  const settings = await readJsonIfThere(paths.settings);
  const models = await readJsonIfThere(paths.models);
  const providers = isRecord(models.providers) ? models.providers : {};
  const wired = isRecord(providers[SLOT]);
  const base = readJsonString(models, ["providers", SLOT, "baseUrl"]);
  const roles: Record<string, string | null> = {};
  for (const role of ASIDE_ROLES) {
    const selection = asideSelection(asideValueAt(settings, role));
    roles[role] =
      wired && selection.startsWith(`${SLOT}/`) ? selection.slice(SLOT.length + 1) : null;
  }
  return { roles, wired, baseUrl: base === null ? null : stripV1(base) };
}

function asideKeyPath(variant: string | undefined): string {
  return variant === undefined ? "defaultModel" : `modelCategories.${variant}`;
}

function asideValueAt(settings: Record<string, unknown>, variant: string | undefined): unknown {
  if (variant === undefined) return settings.defaultModel;
  const roles = isRecord(settings.modelCategories) ? settings.modelCategories : {};
  return roles[variant];
}

const ASIDE_OK = "NEOLIX_ASIDE_OK";

/**
 * Applies a selection in the running Aside, as myna does through its repl,
 * and says whether it took it. When it doesn't answer — Aside not running,
 * or its console gone — the settings file Neolix writes is the staged
 * change Aside reads at its next start.
 */
async function asideApplyLive(
  environment: ConnectEnvironment,
  paths: AsidePaths,
  key: string,
  value: unknown,
): Promise<boolean> {
  if (environment.run === undefined) return false;
  const raw = JSON.stringify(value);
  const expression =
    environment.variant === undefined
      ? `aside.settings.set(${JSON.stringify(key)},${raw});`
      : `const c=aside.settings.get("modelCategories")||{};c[${JSON.stringify(environment.variant)}]=${raw};aside.settings.set("modelCategories",c);`;
  try {
    const out = await environment.run("aside", [
      "repl",
      "--account",
      `u${path.basename(paths.dir)}`,
      "--host",
      "local",
      `${expression}console.log('${ASIDE_OK}')`,
    ]);
    return out.includes(ASIDE_OK);
  } catch {
    return false;
  }
}

const asideDriver: AgentConnectDriver = {
  provider: "aside",
  external: {
    name: "Aside",
    icon: "aside",
    detect: async (environment) =>
      isDir(homePath(environment, ".aside")) || (await isOnPath("aside", environment)),
    // Aside's four model roles are fields of its one row, as myna shows
    // them in the agent's own sheet.
    fields: async (environment) => {
      const { roles } = await asideRead(environment);
      return ASIDE_ROLES.map((role) => ({
        id: role,
        label: role.charAt(0).toUpperCase() + role.slice(1),
        model: roles[role],
      }));
    },
  },
  configPath: (environment) => path.join(environment.homeDir, ".aside"),
  async read(environment) {
    const { roles, wired, baseUrl } = await asideRead(environment);
    if (environment.variant !== undefined) {
      const selection = roles[environment.variant] ?? null;
      return { connected: wired && selection !== null, model: selection, baseUrl };
    }
    // The row is connected when every role points at the gateway.
    return {
      connected: wired && ASIDE_ROLES.every((role) => roles[role] !== null),
      model: null,
      baseUrl,
    };
  },
  async connect(environment, model, _undo) {
    const paths = await asidePaths(environment);
    if (!(await isDir(paths.dir))) {
      throw new Error(
        `Aside has no account folder at ${paths.dir}: open Aside once so it writes its settings, then connect it.`,
      );
    }
    const models = await readJsonIfThere(paths.models);
    const modelsPrior: Record<string, PriorValue> = {};
    capture(models, modelsPrior, `providers.${SLOT}`);
    setAtValue(models, `providers.${SLOT}`, asideBlock(environment));
    // The provider block alone is the row's connect: each role is a field,
    // picked on its own, as myna's four role fields are.
    if (environment.variant === undefined) {
      const entry = await writeJsonWithUndo(paths.models, models, modelsPrior, undefined);
      return { kind: "json", files: [entry] };
    }
    const chosen = chosenModel(environment, model);
    if (chosen === null) throw new Error("Aside needs a model from the gateway.");
    const settings = await readJsonIfThere(paths.settings);
    const settingsPrior: Record<string, PriorValue> = {};
    const key = asideKeyPath(environment.variant);
    capture(settings, settingsPrior, key);
    const current = asideValueAt(settings, environment.variant);
    const previous = isRecord(current) ? current : {};
    const selection = { ...previous, provider: SLOT, modelId: chosen };
    setAtValue(settings, key, selection);
    // A running Aside takes it now; the file below is what a restart reads.
    await asideApplyLive(environment, paths, key, selection);
    const settingsEntry = await writeJsonWithUndo(
      paths.settings,
      settings,
      settingsPrior,
      undefined,
    );
    const modelsEntry = await writeJsonWithUndo(paths.models, models, modelsPrior, undefined);
    return { kind: "json", files: [settingsEntry, modelsEntry] };
  },
  async disconnect(environment, undo) {
    const paths = await asidePaths(environment);
    const key = asideKeyPath(environment.variant);
    const files = undo?.kind === "json" ? undo.files : [];
    // A running Aside is put back the way myna leaves it: the prior
    // selection through its repl, and the files either way. The row's own
    // connect wrote no selection, only the provider block.
    const settingsPrior = files.find((file) => file.path === paths.settings);
    if (settingsPrior !== undefined) {
      const priorSelection = settingsPrior.values[key];
      if (priorSelection?.present === true) {
        await asideApplyLive(environment, paths, key, priorSelection.value);
      }
      if (await exists(paths.settings)) {
        const settings = await readJsonIfThere(paths.settings);
        restore(settings, settingsPrior.values);
        await writeJsonWithUndo(paths.settings, settings, {}, undefined);
      }
    }
    const modelsPrior = files.find((file) => file.path === paths.models);
    if (modelsPrior !== undefined && (await exists(paths.models))) {
      const models = await readJsonIfThere(paths.models);
      restore(models, modelsPrior.values);
      await writeJsonWithUndo(paths.models, models, {}, undefined);
    }
  },
};

export const BATCH18_AGENT_DRIVERS: AgentConnectDriver[] = [almaDriver, asideDriver];
