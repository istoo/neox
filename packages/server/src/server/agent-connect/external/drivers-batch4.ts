import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { readJsonObject } from "../config-files.js";
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
  readYamlDocument,
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

/** The providers list as plain values; Raycast's own entries are kept as they are. */
function raycastProviders(document: { toJS(): unknown }): unknown[] {
  const value = document.toJS();
  if (!isRecord(value) || !Array.isArray(value.providers)) return [];
  return value.providers;
}

// ---------- Raycast AI ----------

function raycastPath(environment: ConnectEnvironment): string {
  return path.join(environment.homeDir, ".config", "raycast", "ai", "providers.yaml");
}

function raycastEntry(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    id: SLOT,
    name: "Neox",
    base_url: `${environment.baseUrl}/v1`,
    api_keys: { [SLOT]: environment.apiKey },
    models: environment.models.map((model) => ({
      id: model.id,
      name: labelOf(model),
      abilities: {
        temperature: { supported: true },
        vision: { supported: model.images === true },
        system_message: { supported: true },
        tools: { supported: true },
        reasoning_effort: { supported: false },
      },
    })),
  };
}

const raycastDriver: AgentConnectDriver = {
  provider: "raycast",
  external: {
    name: "Raycast",
    icon: "raycast",
    detect: (environment) => isDir(path.join(environment.homeDir, ".config", "raycast")),
  },
  configPath: raycastPath,
  async read(environment) {
    const document = await readYamlDocument(raycastPath(environment));
    for (const entry of raycastProviders(document)) {
      const value = entry;
      if (!isRecord(value) || value.id !== SLOT) continue;
      const base = typeof value.base_url === "string" ? value.base_url : null;
      return { connected: true, model: null, baseUrl: base === null ? null : stripV1(base) };
    }
    return { connected: false, model: null, baseUrl: null };
  },
  async connect(environment, _model, _undo) {
    const filePath = raycastPath(environment);
    const document = await readYamlDocument(filePath);
    const captured: Record<string, PriorValue> = {};
    capture({ providers: raycastProviders(document) }, captured, "providers");
    const kept = raycastProviders(document).filter(
      (entry) => !(isRecord(entry) && entry.id === SLOT),
    );
    document.setIn(["providers"], [...kept, document.createNode(raycastEntry(environment))]);
    await writeYamlDocument(filePath, document);
    return { kind: "yaml", path: filePath, values: captured };
  },
  async disconnect(environment, undo) {
    const filePath = raycastPath(environment);
    if (!(await exists(filePath))) return;
    const yamlUndo = findYamlUndo(undo);
    if (yamlUndo === undefined) return;
    const document = await readYamlDocument(filePath);
    const prior = yamlUndo.values.providers;
    if (prior?.present) document.setIn(["providers"], document.createNode(prior.value));
    else document.deleteIn(["providers"]);
    await writeYamlDocument(filePath, document);
  },
};

// ---------- MiMo Code ----------

/** A model in OpenCode's provider shape, with what the gateway catalog knows of it. */
function openCodeModel(model: {
  id: string;
  label?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  images?: boolean;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: model.label ?? model.id };
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

function mimocodeDir(environment: ConnectEnvironment): string {
  const home = envOverride(environment.env, "MIMOCODE_HOME");
  if (home !== null && path.isAbsolute(home)) return path.join(home, "config");
  return path.join(configHome(environment), "mimocode");
}

async function mimocodeConfigPath(environment: ConnectEnvironment): Promise<string> {
  const dir = mimocodeDir(environment);
  for (const name of ["mimocode.jsonc", "mimocode.json", "config.json"]) {
    const candidate = path.join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return path.join(dir, "mimocode.json");
}

const mimocodeDriver: AgentConnectDriver = {
  provider: "mimocode",
  external: {
    name: "MiMo Code",
    icon: "mimocode",
    detect: async (environment) =>
      (await isOnPath("mimo", environment)) || (await isDir(mimocodeDir(environment))),
  },
  configPath: (environment) => path.join(mimocodeDir(environment), "mimocode.json"),
  async read(environment) {
    const filePath = await mimocodeConfigPath(environment);
    const config = await readJsonObject(filePath);
    return {
      connected: readJsonString(config, ["model"])?.startsWith(`${SLOT}/`) === true,
      model: readJsonString(config, ["model"])?.slice(SLOT.length + 1) ?? null,
      baseUrl: readJsonString(config, ["provider", SLOT, "options", "baseURL"]),
    };
  },
  async connect(environment, model, undo) {
    const filePath = await mimocodeConfigPath(environment);
    const config = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, `provider.${SLOT}`);
    capture(config, captured, "model");
    setAtValue(config, `provider.${SLOT}`, {
      npm: "@ai-sdk/openai-compatible",
      name: "Neox",
      options: { baseURL: `${environment.baseUrl}/v1`, apiKey: environment.apiKey },
      models: Object.fromEntries(
        environment.models.map((entry) => [entry.id, openCodeModel(entry)]),
      ),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) setAtValue(config, "model", `${SLOT}/${chosen}`);
    const entry = await writeJsonWithUndo(filePath, config, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(await mimocodeConfigPath(environment), undo);
  },
};

// ---------- OpenClaw ----------

function openClawPath(environment: ConnectEnvironment): string {
  const direct = envOverride(environment.env, "OPENCLAW_CONFIG_PATH");
  if (direct !== null && path.isAbsolute(direct)) return direct;
  const state = envOverride(environment.env, "OPENCLAW_STATE_DIR");
  if (state !== null && path.isAbsolute(state)) return path.join(state, "openclaw.json");
  const home = envOverride(environment.env, "OPENCLAW_HOME") ?? environment.homeDir;
  const profile = envOverride(environment.env, "OPENCLAW_PROFILE");
  const folder = profile === null ? ".openclaw" : `.openclaw-${profile}`;
  return path.join(home, folder, "openclaw.json");
}

const openClawDriver: AgentConnectDriver = {
  provider: "openclaw",
  external: {
    name: "OpenClaw",
    icon: "openclaw",
    detect: async (environment) =>
      (await isOnPath("openclaw", environment)) ||
      (await isDir(path.dirname(openClawPath(environment)))),
  },
  configPath: openClawPath,
  async read(environment) {
    const root = await readJsonObject(openClawPath(environment));
    const provider = root.models;
    const providers = isRecord(provider) ? provider.providers : undefined;
    const entry = isRecord(providers) ? providers[SLOT] : undefined;
    const primary = readJsonString(root, ["agents", "defaults", "model"]);
    return {
      connected: isRecord(entry),
      model: primary?.startsWith(`${SLOT}/`) === true ? primary.slice(SLOT.length + 1) : null,
      baseUrl: isRecord(entry) && typeof entry.baseUrl === "string" ? stripV1(entry.baseUrl) : null,
    };
  },
  async connect(environment, model, undo) {
    const filePath = openClawPath(environment);
    const root = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of [`models.providers.${SLOT}`, "agents.defaults.model"]) {
      capture(root, captured, key);
    }
    setAtValue(root, `models.providers.${SLOT}`, {
      baseUrl: `${environment.baseUrl}/v1`,
      apiKey: environment.apiKey,
      api: "openai-completions",
      models: environment.models.map((entry) => ({
        id: entry.id,
        name: labelOf(entry),
        reasoning: false,
        input: entry.images === true ? ["text", "image"] : ["text"],
        contextWindow: entry.contextWindow ?? 128000,
        ...(entry.maxOutputTokens === undefined ? {} : { maxTokens: entry.maxOutputTokens }),
      })),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      const current = root.agents;
      const defaults = isRecord(current) ? current.defaults : undefined;
      const currentModel = isRecord(defaults) ? defaults.model : undefined;
      setAtValue(
        root,
        "agents.defaults.model",
        isRecord(currentModel)
          ? { ...currentModel, primary: `${SLOT}/${chosen}` }
          : `${SLOT}/${chosen}`,
      );
    }
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(openClawPath(environment), undo);
  },
};

// ---------- Claude Desktop (3p deployment) ----------

const DESKTOP_PROFILE_ID = "00000000-0000-4000-8000-706173656f";

interface DesktopSet {
  /** Desktop's own data: claude_desktop_config.json. */
  data: string;
  /** Its 3p mode's folder: the config, the profile library. */
  threeP: string;
}

function desktopEnv(environment: ConnectEnvironment, name: string, fallback: string): string {
  const value = environment.env[name]?.trim();
  return value !== undefined && value.length > 0 && path.isAbsolute(value) ? value : fallback;
}

async function windowsDir(local: string, threeP: boolean): Promise<string> {
  const name = threeP ? "Claude-3p" : "Claude";
  const exact = path.join(local, name);
  try {
    await fs.stat(exact);
    return exact;
  } catch {
    // Midway installs name it Claude… with -3p in it.
  }
  let names: string[];
  try {
    names = await fs.readdir(local);
  } catch {
    return exact;
  }
  const found = names
    .filter((entry) => entry.startsWith("Claude") && entry.includes("-3p") === threeP)
    .sort();
  return found[0] === undefined ? exact : path.join(local, found[0]);
}

/** Desktop's MSIX package's LocalCache folder, when one is installed. */
async function desktopPackage(local: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(local, "Packages"));
  } catch {
    return null;
  }
  const dirs = names
    .filter((name) => name.startsWith("Claude_") || name.startsWith("AnthropicPBC.Claude_"))
    .sort()
    .map((name) => path.join(local, "Packages", name, "LocalCache"));
  for (const dir of dirs) {
    for (const folder of [
      path.join(dir, "Roaming", "Claude"),
      path.join(dir, "Local", "Claude-3p"),
    ]) {
      try {
        await fs.stat(path.join(folder, "Local State"));
        return dir;
      } catch {
        // The next package.
      }
    }
  }
  return dirs[0] ?? null;
}

/** Every set of folders a Claude Desktop build reads (myna's desktopdir.Sets). */
async function desktopSets(environment: ConnectEnvironment): Promise<DesktopSet[]> {
  const platform = environment.platform ?? process.platform;
  if (platform === "darwin") {
    const base = path.join(environment.homeDir, "Library", "Application Support");
    return [{ data: path.join(base, "Claude"), threeP: path.join(base, "Claude-3p") }];
  }
  if (platform !== "win32") {
    const base = configHome(environment);
    return [{ data: path.join(base, "Claude"), threeP: path.join(base, "Claude-3p") }];
  }
  const home = environment.homeDir;
  const local = desktopEnv(environment, "LOCALAPPDATA", path.join(home, "AppData", "Local"));
  const roaming = desktopEnv(environment, "APPDATA", path.join(home, "AppData", "Roaming"));
  const classic: DesktopSet = {
    data: path.join(roaming, "Claude"),
    threeP: await windowsDir(local, true),
  };
  const pkg = await desktopPackage(local);
  if (pkg === null) return [classic];
  const packaged: DesktopSet = {
    data: path.join(pkg, "Roaming", "Claude"),
    threeP: path.join(pkg, "Local", "Claude-3p"),
  };
  return [packaged, classic];
}

function desktopFiles(set: DesktopSet) {
  return {
    claude: path.join(set.data, "claude_desktop_config.json"),
    threePConfig: path.join(set.threeP, "claude_desktop_config.json"),
    profile: path.join(set.threeP, "configLibrary", `${DESKTOP_PROFILE_ID}.json`),
    meta: path.join(set.threeP, "configLibrary", "_meta.json"),
  };
}

async function desktopInstalled(environment: ConnectEnvironment): Promise<boolean> {
  if ((environment.platform ?? process.platform) !== "win32") return false;
  const home = environment.homeDir;
  const local = desktopEnv(environment, "LOCALAPPDATA", path.join(home, "AppData", "Local"));
  try {
    await fs.stat(path.join(local, "AnthropicClaude", "claude.exe"));
    return true;
  } catch {
    return (await desktopPackage(local)) !== null;
  }
}

const claudeDesktopDriver: AgentConnectDriver = {
  provider: "claude-desktop",
  external: {
    name: "Claude Desktop",
    icon: "claude-color",
    // An MSIX install not opened yet has no folder of its own; it still
    // reads what Neolix writes at its first start.
    detect: async (environment) => {
      for (const set of await desktopSets(environment)) {
        if (await isDir(set.data)) return true;
        if (await isDir(set.threeP)) return true;
      }
      return desktopInstalled(environment);
    },
  },
  // The classic folder: one MSIX install has its own, which read and
  // connect find; the row's path is the one every build reads.
  configPath: (environment) => {
    const platform = environment.platform ?? process.platform;
    if (platform === "darwin") {
      return path.join(
        environment.homeDir,
        "Library",
        "Application Support",
        "Claude-3p",
        "claude_desktop_config.json",
      );
    }
    if (platform === "win32") {
      const local = desktopEnv(
        environment,
        "LOCALAPPDATA",
        path.join(environment.homeDir, "AppData", "Local"),
      );
      return path.join(local, "Claude-3p", "claude_desktop_config.json");
    }
    return path.join(configHome(environment), "Claude-3p", "claude_desktop_config.json");
  },
  async read(environment) {
    const files = desktopFiles((await desktopSets(environment))[0] as DesktopSet);
    const config = await readJsonObject(files.threePConfig);
    const meta = await readJsonObject(files.meta);
    const applied = readJsonString(meta, ["appliedId"]);
    return {
      connected:
        readJsonString(config, ["deploymentMode"]) === "3p" && applied === DESKTOP_PROFILE_ID,
      model: null,
      baseUrl: null,
    };
  },
  async connect(environment, _model, undo) {
    const entries: Awaited<ReturnType<typeof writeJsonWithUndo>>[] = [];
    for (const set of await desktopSets(environment)) {
      const files = desktopFiles(set);
      for (const filePath of [files.claude, files.threePConfig]) {
        const root = await readJsonObject(filePath);
        const captured: Record<string, PriorValue> = {};
        capture(root, captured, "deploymentMode");
        setAtValue(root, "deploymentMode", "3p");
        entries.push(await writeJsonWithUndo(filePath, root, captured, undo));
      }
      const profile = await readJsonObject(files.profile);
      const profilePrior: Record<string, PriorValue> = {};
      for (const key of [
        "inferenceProvider",
        "inferenceGatewayBaseUrl",
        "inferenceGatewayApiKey",
        "inferenceGatewayAuthScheme",
        "disableDeploymentModeChooser",
        "coworkEgressAllowedHosts",
        "toolSearchEnabled",
      ]) {
        capture(profile, profilePrior, key);
      }
      entries.push(
        await writeJsonWithUndo(
          files.profile,
          {
            inferenceProvider: "gateway",
            inferenceGatewayBaseUrl: environment.baseUrl,
            inferenceGatewayApiKey: environment.apiKey,
            inferenceGatewayAuthScheme: "bearer",
            disableDeploymentModeChooser: true,
            coworkEgressAllowedHosts: ["*"],
            toolSearchEnabled: true,
          },
          profilePrior,
          undo,
        ),
      );
      const meta = await readJsonObject(files.meta);
      const metaPrior: Record<string, PriorValue> = {};
      capture(meta, metaPrior, "appliedId");
      capture(meta, metaPrior, "entries");
      const currentEntries = Array.isArray(meta.entries) ? (meta.entries as unknown[]) : [];
      setAtValue(meta, "appliedId", DESKTOP_PROFILE_ID);
      setAtValue(meta, "entries", [
        ...currentEntries.filter((entry) => !(isRecord(entry) && entry.id === DESKTOP_PROFILE_ID)),
        { id: DESKTOP_PROFILE_ID, name: "Neox" },
      ]);
      entries.push(await writeJsonWithUndo(files.meta, meta, metaPrior, undo));
    }
    return { kind: "json", files: entries };
  },
  async disconnect(environment, undo) {
    for (const set of await desktopSets(environment)) {
      const files = desktopFiles(set);
      for (const filePath of [files.claude, files.threePConfig, files.meta, files.profile]) {
        await restoreJsonFile(filePath, undo);
      }
    }
  },
};

function findYamlUndo(
  undo: AgentConnectUndo | undefined,
): Extract<AgentConnectUndo, { kind: "yaml" }> | undefined {
  if (undo === undefined) return undefined;
  if (undo.kind === "yaml") return undo;
  if (undo.kind !== "multi") return undefined;
  return undo.parts.find(
    (part): part is Extract<AgentConnectUndo, { kind: "yaml" }> => part.kind === "yaml",
  );
}

export const BATCH4_AGENT_DRIVERS: AgentConnectDriver[] = [
  raycastDriver,
  mimocodeDriver,
  openClawDriver,
  claudeDesktopDriver,
];
