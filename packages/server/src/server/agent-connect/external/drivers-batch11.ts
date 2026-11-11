import { promises as fs } from "node:fs";
import path from "node:path";
import { readJsonObject, readTextOrNull } from "../config-files.js";
// eslint-disable-next-line no-restricted-imports -- the process probe is injectable
import { runProcess } from "../process-run.js";
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
import { envOverride, homePath, isDir, isOnPath, writeText } from "./helpers.js";

const SLOT = "neolix";

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
  return readJsonObject(filePath);
}

function yamlUndo(filePath: string, values: Record<string, PriorValue>): AgentConnectUndo {
  return { kind: "yaml", path: filePath, values };
}

function yamlUndoAt(
  undo: AgentConnectUndo | undefined,
  filePath: string,
): Extract<AgentConnectUndo, { kind: "yaml" }> | undefined {
  if (undo === undefined) return undefined;
  const all = undo.kind === "multi" ? undo.parts.flatMap((part) => yamlUndoAt(part, filePath)) : [];
  if (undo.kind === "yaml" && undo.path === filePath) all.push(undo);
  return all[0];
}

// ---------- OpenPencil ----------

function openPencilDir(environment: ConnectEnvironment): string {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "openpencil");
  }
  if (environment.platform === "win32") {
    return path.join(
      envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming"),
      "openpencil",
    );
  }
  const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
  return path.join(
    xdg !== null && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"),
    "openpencil",
  );
}

function openPencilPath(environment: ConnectEnvironment): string {
  return path.join(openPencilDir(environment), "settings.json");
}

/**
 * Whether OpenPencil is open. It writes its whole settings back when it
 * quits, over what Neolix writes now (myna's openPencilRunning); Windows has
 * no probe Neolix can trust, as myna's has none there.
 */
async function openPencilRunning(environment: ConnectEnvironment): Promise<boolean> {
  if (environment.platform === "win32") return false;
  const run = environment.run ?? runProcess;
  try {
    const out = await run("ps", ["-axo", "comm="]);
    return out.split("\n").some((line) => /(^|\/)openpencil-desktop$/.test(line.trim()));
  } catch {
    return false;
  }
}

/** OpenPencil's entry: Chat Completions, the models picked for it, at most 64. */
function openPencilEntry(environment: ConnectEnvironment): Record<string, unknown> {
  const models = environment.models.slice(0, 64).map((model) => model.id);
  const entry: Record<string, unknown> = {
    id: SLOT,
    preset: "custom",
    display_name: "Neox",
    kind: "openai-compat",
    api_key: environment.apiKey,
    base_url: `${environment.baseUrl}/v1`,
    enabled: true,
  };
  if (models.length > 0) entry.model = models[0];
  if (models.length > 1) entry.models = models;
  return entry;
}

const openPencilDriver: AgentConnectDriver = {
  provider: "openpencil",
  external: {
    name: "OpenPencil",
    icon: "generic",
    detect: async (environment) =>
      isDir(openPencilDir(environment)) || isDir(homePath(environment, ".openpencil")),
  },
  configPath: openPencilPath,
  async read(environment) {
    const file = await readJsonIfThere(openPencilPath(environment));
    const agents = Array.isArray(file.builtin_agents) ? (file.builtin_agents as unknown[]) : [];
    const ours = agents.find((entry) => isRecord(entry) && entry.id === SLOT);
    return {
      connected: ours !== undefined,
      model: null,
      baseUrl: isRecord(ours) && typeof ours.base_url === "string" ? stripV1(ours.base_url) : null,
    };
  },
  async connect(environment, _model, undo) {
    if (await openPencilRunning(environment)) {
      throw new Error(
        "OpenPencil writes its settings back when it quits, over what Neox writes now: quit OpenPencil, then try again.",
      );
    }
    const filePath = openPencilPath(environment);
    const file = await readJsonIfThere(filePath);
    // A version Neolix doesn't know is left alone: OpenPencil ignores the
    // whole file then (myna's openPencilAgents).
    if (file.version !== undefined && file.version !== 1) {
      throw new Error(
        `${filePath} says version ${String(file.version)}, not the 1 OpenPencil reads, so it was left alone.`,
      );
    }
    const captured: Record<string, PriorValue> = {};
    capture(file, captured, "builtin_agents");
    const agents = Array.isArray(file.builtin_agents) ? (file.builtin_agents as unknown[]) : [];
    const prior = agents.find((entry) => isRecord(entry) && entry.id === SLOT);
    const next = agents.filter((entry) => !(isRecord(entry) && entry.id === SLOT));
    const entry = openPencilEntry(environment);
    // The name and the switch the reader gave it in OpenPencil stay.
    if (isRecord(prior)) {
      if (typeof prior.display_name === "string") entry.display_name = prior.display_name;
      if (typeof prior.enabled === "boolean") entry.enabled = prior.enabled;
    }
    next.push(entry);
    setAtValue(file, "builtin_agents", next);
    file.version = 1;
    const written = await writeJsonWithUndo(filePath, file, captured, undo);
    return { kind: "json", files: [written] };
  },
  async disconnect(environment, undo) {
    const filePath = openPencilPath(environment);
    if (!(await exists(filePath))) return;
    const file = await readJsonIfThere(filePath);
    const agents = Array.isArray(file.builtin_agents) ? (file.builtin_agents as unknown[]) : [];
    const kept = agents.filter((entry) => !(isRecord(entry) && entry.id === SLOT));
    if (kept.length === 0) {
      delete file.version;
      delete file.builtin_agents;
      const rest = Object.keys(file);
      if (rest.length === 0) {
        await fs.rm(filePath, { force: true });
        return;
      }
    } else {
      setAtValue(file, "builtin_agents", kept);
    }
    const prior = undo?.kind === "json" ? undo.files.find((part) => part.path === filePath) : null;
    if (prior !== null && prior !== undefined) restore(file, prior.values);
    await writeJsonWithUndo(filePath, file, {}, undo);
  },
};

// ---------- Ante ----------

function anteDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "ANTE_HOME");
  if (override !== null) return override;
  return homePath(environment, ".ante");
}

function anteCatalogPath(environment: ConnectEnvironment): string {
  return path.join(anteDir(environment), "catalog.json");
}

function anteSettingsPath(environment: ConnectEnvironment): string {
  return path.join(anteDir(environment), "settings.json");
}

function anteProvider(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    display_name: "Neox",
    base_url: `${environment.baseUrl}/v1`,
    wire_style: "OpenAiCompatible",
    preferred_models: environment.models.map((model) => ({
      id: model.id,
      display_name: labelOf(model),
      ...(model.contextWindow === undefined ? {} : { context_limit: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { max_tokens: model.maxOutputTokens }),
      ...(model.images === undefined ? {} : { support_vision: model.images }),
    })),
  };
}

const anteDriver: AgentConnectDriver = {
  provider: "ante",
  external: {
    name: "Ante",
    icon: "ante",
    detect: async (environment) =>
      (await isOnPath("ante", environment)) || isDir(anteDir(environment)),
  },
  configPath: anteCatalogPath,
  async read(environment) {
    const catalog = await readJsonIfThere(anteCatalogPath(environment));
    const settings = await readJsonIfThere(anteSettingsPath(environment));
    const providers = isRecord(catalog.providers) ? catalog.providers : {};
    const entry = isRecord(providers[SLOT]) ? providers[SLOT] : null;
    const wired = entry !== null && settings.provider === SLOT;
    return {
      connected: wired,
      model: wired && typeof settings.model === "string" ? settings.model : null,
      baseUrl:
        entry !== null && typeof entry.base_url === "string" ? stripV1(entry.base_url) : null,
    };
  },
  async connect(environment, model, undo) {
    const catalogPath = anteCatalogPath(environment);
    const settingsPath = anteSettingsPath(environment);
    const catalog = await readJsonIfThere(catalogPath);
    const captured: Record<string, PriorValue> = {};
    capture(catalog, captured, `providers.${SLOT}`);
    const prior = isRecord(catalog.providers) ? catalog.providers[SLOT] : undefined;
    const entry = { ...anteProvider(environment) };
    // What the reader added inside Neolix's own entry stays (auth, headers,
    // extra_body), as myna's theirsKept leaves it.
    if (isRecord(prior)) {
      for (const [key, value] of Object.entries(prior)) {
        if (!["display_name", "base_url", "wire_style", "preferred_models"].includes(key)) {
          entry[key] = value;
        }
      }
    }
    setAtValue(catalog, `providers.${SLOT}`, entry);
    const catalogFile = await writeJsonWithUndo(catalogPath, catalog, captured, undo);

    const settings = await readJsonIfThere(settingsPath);
    const settingsCaptured: Record<string, PriorValue> = {};
    capture(settings, settingsCaptured, "provider");
    capture(settings, settingsCaptured, "model");
    const chosen = chosenModel(environment, model);
    settings.provider = SLOT;
    if (chosen !== null) settings.model = chosen;
    const settingsFile = await writeJsonWithUndo(settingsPath, settings, settingsCaptured, undo);
    return { kind: "json", files: [catalogFile, settingsFile] };
  },
  async disconnect(environment, undo) {
    const settingsPath = anteSettingsPath(environment);
    if (await exists(settingsPath)) {
      const settings = await readJsonIfThere(settingsPath);
      const prior =
        undo?.kind === "json" ? undo.files.find((part) => part.path === settingsPath) : null;
      // A pick the reader made in Ante since is theirs and stands.
      if (settings.provider === SLOT) {
        if (prior !== null && prior !== undefined) restore(settings, prior.values);
        await writeJsonWithUndo(settingsPath, settings, {}, undo);
      }
    }
    const catalogPath = anteCatalogPath(environment);
    if (await exists(catalogPath)) {
      const catalog = await readJsonIfThere(catalogPath);
      const prior =
        undo?.kind === "json" ? undo.files.find((part) => part.path === catalogPath) : null;
      if (prior !== null && prior !== undefined) restore(catalog, prior.values);
      await writeJsonWithUndo(catalogPath, catalog, {}, undo);
    }
  },
};

// ---------- AstrBot ----------

const ASTRBOT_BOM = "﻿";
const ASTRBOT_SOURCE_OWNED = ["id", "provider", "type", "provider_type", "key", "api_base"];
const ASTRBOT_MODEL_OWNED = [
  "id",
  "provider_source_id",
  "model",
  "modalities",
  "max_context_tokens",
];

function astrbotRoot(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "ASTRBOT_ROOT");
  if (override !== null) return override;
  return homePath(environment, ".astrbot");
}

function astrbotPath(environment: ConnectEnvironment): string {
  return path.join(astrbotRoot(environment), "data", "cmd_config.json");
}

/** AstrBot writes its config with a UTF-8 BOM, which JSON.parse refuses. */
async function readAstrbotFile(filePath: string): Promise<Record<string, unknown>> {
  const text = (await readTextOrNull(filePath)) ?? "";
  const body = text.startsWith(ASTRBOT_BOM) ? text.slice(1) : text;
  if (body.trim() === "") return {};
  const value: unknown = JSON.parse(body);
  return isRecord(value) ? value : {};
}

function astrbotSource(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    id: SLOT,
    provider: "openai",
    type: "openai_chat_completion",
    provider_type: "chat_completion",
    enable: true,
    key: [environment.apiKey],
    api_base: `${environment.baseUrl}/v1`,
    timeout: 120,
    proxy: "",
    custom_headers: {},
  };
}

function astrbotModel(model: { id: string }): Record<string, unknown> {
  return {
    id: `${SLOT}/${model.id}`,
    enable: true,
    provider_source_id: SLOT,
    model: model.id,
    modalities: ["text", "tool_use"],
    custom_extra_body: {},
    max_context_tokens: 0,
  };
}

/** Neolix's entries with the keys the reader changed in AstrBot's WebUI kept. */
function astrbotKeep(
  want: Record<string, unknown>,
  prior: unknown,
  owned: string[],
): Record<string, unknown> {
  const entry = { ...want };
  if (!isRecord(prior)) return entry;
  for (const [key, value] of Object.entries(prior)) {
    if (!owned.includes(key)) entry[key] = value;
  }
  return entry;
}

function astrbotList(
  file: Record<string, unknown>,
  key: string,
  isOurs: (entry: unknown) => boolean,
) {
  const list = Array.isArray(file[key]) ? (file[key] as unknown[]) : [];
  return { kept: list.filter((entry) => !isOurs(entry)), ours: list.filter(isOurs) };
}

const astrbotDriver: AgentConnectDriver = {
  provider: "astrbot",
  external: {
    name: "AstrBot",
    icon: "astrbot",
    detect: async (environment) =>
      (await isOnPath("astrbot", environment)) || (await exists(astrbotPath(environment))),
  },
  configPath: astrbotPath,
  async read(environment) {
    const filePath = astrbotPath(environment);
    if (!(await exists(filePath))) return { connected: false, model: null, baseUrl: null };
    const file = await readAstrbotFile(filePath);
    const sources = Array.isArray(file.provider_sources)
      ? (file.provider_sources as unknown[])
      : [];
    const source = sources.find((entry) => isRecord(entry) && entry.id === SLOT);
    const base = isRecord(source) && typeof source.api_base === "string" ? source.api_base : null;
    return {
      connected: source !== undefined,
      model: null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = astrbotPath(environment);
    const before = await readTextOrNull(filePath);
    const file = await readAstrbotFile(filePath);
    const hadBom = before?.startsWith(ASTRBOT_BOM) === true;
    const sourceList = astrbotList(
      file,
      "provider_sources",
      (entry) => isRecord(entry) && entry.id === SLOT,
    );
    const modelList = astrbotList(
      file,
      "provider",
      (entry) => isRecord(entry) && entry.provider_source_id === SLOT,
    );
    const priorPick = astrbotPickValue(file);
    const priorLegacy = astrbotLegacyValue(file);
    const captured: Record<string, PriorValue> = {
      source: {
        present: sourceList.ours.length > 0,
        value: sourceList.ours[0],
      },
      models: { present: modelList.ours.length > 0, value: modelList.ours },
      providerId: priorPick === null ? { present: false } : { present: true, value: priorPick },
      legacyId: priorLegacy === null ? { present: false } : { present: true, value: priorLegacy },
    };
    file.provider_sources = [
      ...sourceList.kept,
      astrbotKeep(astrbotSource(environment), sourceList.ours[0], ASTRBOT_SOURCE_OWNED),
    ];
    file.provider = [
      ...modelList.kept,
      ...environment.models.map((entry) => {
        const id = `${SLOT}/${entry.id}`;
        const prior = modelList.ours.find((other) => isRecord(other) && other.id === id);
        return astrbotKeep(astrbotModel(entry), prior, ASTRBOT_MODEL_OWNED);
      }),
    ];
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(file, "agent_runner.config.model.provider_id", `${SLOT}/${chosen}`);
    }
    // A file from before agent_runner names the pick here (myna's
    // astrbotLegacy).
    if (priorLegacy !== null) {
      file.provider_settings = {
        ...(isRecord(file.provider_settings) ? file.provider_settings : {}),
        default_provider_id: `${SLOT}/${chosen ?? ""}`,
      };
    }
    if (before !== null && !(await exists(`${filePath}.before-neolix`))) {
      await writeText(`${filePath}.before-neolix`, before);
    }
    const text = `${JSON.stringify(file, null, 2)}\n`;
    await writeText(filePath, hadBom ? `${ASTRBOT_BOM}${text}` : text);
    return yamlUndo(filePath, captured);
  },
  async disconnect(environment, undo) {
    const filePath = astrbotPath(environment);
    if (!(await exists(filePath))) return;
    const part = yamlUndoAt(undo, filePath);
    const before = await readTextOrNull(filePath);
    const hadBom = before?.startsWith(ASTRBOT_BOM) === true;
    const file = await readAstrbotFile(filePath);
    const sourceList = astrbotList(
      file,
      "provider_sources",
      (entry) => isRecord(entry) && entry.id === SLOT,
    );
    const modelList = astrbotList(
      file,
      "provider",
      (entry) => isRecord(entry) && entry.provider_source_id === SLOT,
    );
    const priorSource = part?.values.source;
    const priorModels = part?.values.models;
    file.provider_sources = [
      ...sourceList.kept,
      ...(isRecord(priorSource) && priorSource.present === true ? [priorSource.value] : []),
    ];
    file.provider = [
      ...modelList.kept,
      ...(isRecord(priorModels) && priorModels.present === true && Array.isArray(priorModels.value)
        ? priorModels.value
        : []),
    ];
    if (readAstrbotPick(file) === SLOT) restoreAstrbotPick(file, part?.values.providerId);
    if (readAstrbotLegacy(file) === SLOT) restoreAstrbotLegacy(file, part?.values.legacyId);
    const text = `${JSON.stringify(file, null, 2)}\n`;
    await writeText(filePath, hadBom ? `${ASTRBOT_BOM}${text}` : text);
  },
};

function readAstrbotPick(file: Record<string, unknown>): string | null {
  const runner = isRecord(file.agent_runner) ? file.agent_runner : {};
  const config = isRecord(runner.config) ? runner.config : {};
  const model = isRecord(config.model) ? config.model : {};
  const id = model.provider_id;
  return typeof id === "string" ? (id.split("/")[0] ?? null) : null;
}

function astrbotPickValue(file: Record<string, unknown>): string | null {
  const runner = isRecord(file.agent_runner) ? file.agent_runner : {};
  const config = isRecord(runner.config) ? runner.config : {};
  const model = isRecord(config.model) ? config.model : {};
  return typeof model.provider_id === "string" ? model.provider_id : null;
}

function restoreAstrbotPick(file: Record<string, unknown>, prior: unknown): void {
  const runner = isRecord(file.agent_runner) ? file.agent_runner : {};
  const config = isRecord(runner.config) ? runner.config : {};
  const model = isRecord(config.model) ? config.model : {};
  if (isRecord(prior) && prior.present === true) model.provider_id = prior.value;
  else delete model.provider_id;
}

function astrbotLegacyValue(file: Record<string, unknown>): string | null {
  const settings = isRecord(file.provider_settings) ? file.provider_settings : {};
  return typeof settings.default_provider_id === "string" ? settings.default_provider_id : null;
}

function readAstrbotLegacy(file: Record<string, unknown>): string | null {
  const id = astrbotLegacyValue(file);
  return id === null ? null : (id.split("/")[0] ?? null);
}

function restoreAstrbotLegacy(file: Record<string, unknown>, prior: unknown): void {
  const settings = isRecord(file.provider_settings) ? file.provider_settings : {};
  if (isRecord(prior) && prior.present === true) settings.default_provider_id = prior.value;
  else delete settings.default_provider_id;
  file.provider_settings = settings;
}

export const BATCH11_AGENT_DRIVERS: AgentConnectDriver[] = [
  openPencilDriver,
  anteDriver,
  astrbotDriver,
];
