import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonObject, readTextOrNull } from "../config-files.js";
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
import {
  envOverride,
  homePath,
  isDir,
  readYamlDocument,
  textUndo,
  writeText,
  writeYamlDocument,
  yamlString,
} from "./helpers.js";

const SLOT = PROVIDER_ID;
const SEALED = "HANA-SECRET-";

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
}

function labelOf(model: { id: string; label?: string }): string {
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
  return readJsonObject(filePath).catch(() => ({})) as Promise<Record<string, unknown>>;
}

// ---------- OpenHanako ----------

/** OpenHanako's folder: $HANA_HOME (a ~ is the reader's), else ~/.hanako. */
function hanakoDir(environment: ConnectEnvironment): string {
  const set = envOverride(environment.env, "HANA_HOME");
  if (set === null) return homePath(environment, ".hanako");
  if (set === "~") return environment.homeDir;
  if (set.startsWith("~/") || set.startsWith("~\\")) {
    return path.join(environment.homeDir, set.slice(2));
  }
  return path.resolve(set);
}

function hanakoCatalog(environment: ConnectEnvironment): string {
  return path.join(hanakoDir(environment), "provider-catalog.json");
}

function hanakoPluginDir(environment: ConnectEnvironment): string {
  return path.join(hanakoDir(environment), "provider-plugins", SLOT);
}

function hanakoPluginFile(environment: ConnectEnvironment): string {
  return path.join(hanakoPluginDir(environment), "providers", `${SLOT}.json`);
}

/** OpenHanako's agents folder, and the one it opens on (myna's hanakoAgent). */
function hanakoAgentsDir(environment: ConnectEnvironment): string {
  return path.join(hanakoDir(environment), "agents");
}

async function hanakoAgent(environment: ConnectEnvironment): Promise<string> {
  const agents = hanakoAgentsDir(environment);
  const has = async (id: string): Promise<boolean> =>
    id.length > 0 && !id.includes("/") && !id.includes("\\")
      ? exists(path.join(agents, id, "config.yaml"))
      : false;
  const preferences = await readJsonIfThere(
    path.join(hanakoDir(environment), "user", "preferences.json"),
  );
  const primary = typeof preferences.primaryAgent === "string" ? preferences.primaryAgent : "";
  if (await has(primary)) return primary;
  let names: string[];
  try {
    names = await fs.readdir(agents);
  } catch {
    return "";
  }
  for (const name of names.sort()) {
    if (await has(name)) return name;
  }
  return "";
}

async function hanakoSealed(environment: ConnectEnvironment): Promise<boolean> {
  const text = await readTextOrNull(hanakoCatalog(environment));
  return text !== null && text.replace(/^﻿/, "").trimStart().startsWith(SEALED);
}

function hanakoProviderJson(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    display_name: SLOT,
    base_url: `${environment.baseUrl}/v1`,
    api: "openai-completions",
    api_key: environment.apiKey,
    models: environment.models.map((entry) => ({
      id: entry.id,
      name: labelOf(entry),
      ...(entry.contextWindow === undefined ? {} : { context: entry.contextWindow }),
      ...(entry.maxOutputTokens === undefined ? {} : { maxOutput: entry.maxOutputTokens }),
      image: entry.images === true,
    })),
  };
}

/** The provider as OpenHanako has it now: its plugin file, under the catalog's entry. */
async function hanakoCurrent(environment: ConnectEnvironment): Promise<{
  found: boolean;
  baseUrl: string | null;
}> {
  const plugin = await readJsonIfThere(hanakoPluginFile(environment));
  const catalog = await readJsonIfThere(hanakoCatalog(environment));
  const entry = isRecord(catalog.providers) ? catalog.providers[SLOT] : undefined;
  const base =
    (typeof plugin.defaultBaseUrl === "string" ? plugin.defaultBaseUrl : null) ??
    (isRecord(entry) && typeof entry.base_url === "string" ? entry.base_url : null);
  return { found: Object.keys(plugin).length > 0 || isRecord(entry), baseUrl: base };
}

interface HanakoChat {
  provider: string;
  id: string;
}

async function hanakoChat(environment: ConnectEnvironment): Promise<HanakoChat | null> {
  const agent = await hanakoAgent(environment);
  if (agent.length === 0) return null;
  const document = await readYamlDocument(
    path.join(hanakoAgentsDir(environment), agent, "config.yaml"),
  );
  const provider = yamlString(document, ["models", "chat", "provider"]) ?? "";
  const id =
    yamlString(document, ["models", "chat", "id"]) ??
    yamlString(document, ["models", "chat"]) ??
    "";
  return { provider, id };
}

function sealedError(what: string): Error {
  return new Error(
    `OpenHanako keeps its providers encrypted, so Neox can only ${what} it while it runs: open OpenHanako and try again.`,
  );
}

const hanakoDriver: AgentConnectDriver = {
  provider: "hanako",
  external: {
    name: "OpenHanako",
    icon: "hanako",
    detect: async (environment) => isDir(hanakoDir(environment)),
  },
  configPath: hanakoCatalog,
  async read(environment) {
    const chat = await hanakoChat(environment);
    const current = await hanakoCurrent(environment);
    const wired = chat?.provider === SLOT && current.found;
    return {
      connected: wired,
      model: wired && chat.id.length > 0 ? chat.id : null,
      baseUrl: wired && current.baseUrl !== null ? stripV1(current.baseUrl) : null,
    };
  },
  async connect(environment, model, undo) {
    const chosen = chosenModel(environment, model);
    if (chosen === null) throw new Error("OpenHanako needs a model from the gateway.");
    const agent = await hanakoAgent(environment);
    if (agent.length === 0) {
      throw new Error("OpenHanako has no agent yet — open it once to make one, then connect it.");
    }
    const parts: AgentConnectUndo[] = [];
    const catalogPath = hanakoCatalog(environment);
    const provider = hanakoProviderJson(environment);
    if (await hanakoSealed(environment)) {
      const pluginFile = hanakoPluginFile(environment);
      if (!(await exists(pluginFile))) throw sealedError("add Neox to");
      const before = await readTextOrNull(pluginFile);
      const current = await readJsonIfThere(pluginFile);
      const text = `${JSON.stringify(
        {
          ...current,
          displayName: provider.display_name,
          defaultBaseUrl: provider.base_url,
          defaultApi: provider.api,
          models: provider.models,
        },
        null,
        2,
      )}\n`;
      await writeText(pluginFile, text);
      parts.push(textUndo(pluginFile, before, text));
    } else {
      const catalog = await readJsonIfThere(catalogPath);
      const captured: Record<string, PriorValue> = {};
      capture(catalog, captured, `providers.${SLOT}`);
      capture(catalog, captured, "meta.deletedProviders");
      if (Object.keys(catalog).length === 0) catalog.catalogVersion = 2;
      if (!isRecord(catalog.providers)) catalog.providers = {};
      setAtValue(catalog, `providers.${SLOT}`, provider);
      // A provider OpenHanako marked deleted comes back unless the mark goes.
      if (isRecord(catalog.meta) && Array.isArray(catalog.meta.deletedProviders)) {
        catalog.meta.deletedProviders = catalog.meta.deletedProviders.filter((id) => id !== SLOT);
      }
      const entry = await writeJsonWithUndo(catalogPath, catalog, captured, undo);
      parts.push({ kind: "json", files: [entry] });
      await fs.rm(hanakoPluginDir(environment), { recursive: true, force: true });
    }
    const configPath = path.join(hanakoAgentsDir(environment), agent, "config.yaml");
    const before = await readTextOrNull(configPath);
    const document = await readYamlDocument(configPath);
    document.setIn(["models", "chat"], { id: chosen, provider: SLOT });
    await writeYamlDocument(configPath, document);
    parts.push(textUndo(configPath, before, document.toString()));
    return { kind: "multi", parts };
  },
  async disconnect(environment, undo) {
    let parts: AgentConnectUndo[] = [];
    if (undo?.kind === "multi") parts = undo.parts;
    else if (undo !== undefined) parts = [undo];
    const catalogPath = hanakoCatalog(environment);
    const catalogUndo = parts.find(
      (part): part is Extract<AgentConnectUndo, { kind: "json" }> =>
        part.kind === "json" && part.files.some((file) => file.path === catalogPath),
    );
    if (!(await hanakoSealed(environment))) {
      const catalog = await readJsonIfThere(catalogPath);
      if (catalogUndo !== undefined) {
        const prior = catalogUndo.files.find((file) => file.path === catalogPath);
        if (prior !== undefined) restore(catalog, prior.values);
        else delete catalog.providers;
      } else {
        if (isRecord(catalog.providers)) delete catalog.providers[SLOT];
      }
      // OpenHanako marks a provider it removes deleted, or its start-up
      // brings it back from its models.json.
      if (isRecord(catalog.providers) && Object.keys(catalog.providers).length === 0) {
        delete catalog.providers;
      }
      if (isRecord(catalog.meta) && Array.isArray(catalog.meta.deletedProviders)) {
        const ids = catalog.meta.deletedProviders;
        if (!ids.includes(SLOT)) catalog.meta.deletedProviders = [...ids, SLOT];
      } else if (isRecord(catalog.meta)) {
        catalog.meta.deletedProviders = [SLOT];
      } else if (Object.keys(catalog).length > 0) {
        catalog.meta = { deletedProviders: [SLOT] };
      }
      await writeJsonWithUndo(catalogPath, catalog, {}, undefined);
      await fs.rm(hanakoPluginDir(environment), { recursive: true, force: true });
    }
    for (const part of parts) {
      if (part.kind !== "text") continue;
      if (part.before === null) await fs.rm(part.path, { force: true });
      else await writeText(part.path, part.before);
    }
  },
};

export const BATCH19_AGENT_DRIVERS: AgentConnectDriver[] = [hanakoDriver];
