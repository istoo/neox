import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { readJsonObject } from "../config-files.js";
import {
  capture,
  type AgentConnectDriver,
  type ConnectEnvironment,
  type PriorValue,
  restore,
  setAtValue,
  stripV1,
  writeJsonWithUndo,
} from "../drivers.js";
import { configHome, envOverride, homePath, isDir, isOnPath } from "./helpers.js";
import { type VSCodeKind, vscodeDriver } from "./drivers-batch6.js";

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

function readJsonString(root: Record<string, unknown>, keys: string[]): string | null {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

// ---------- VS Code Insiders and VSCodium ----------

export const VSCODE_INSIDERS: VSCodeKind = {
  id: "vscode-insiders",
  folder: "Code - Insiders",
  extFolder: ".vscode-insiders",
  bin: "code-insiders",
  vendor: "customendpoint",
};

export const VSCODIUM: VSCodeKind = {
  id: "vscodium",
  folder: "VSCodium",
  extFolder: ".vscode-oss",
  bin: "codium",
  vendor: "auto",
};

// ---------- MothX ----------

function mothxDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "MOTHX_DIR");
  if (override !== null) return override;
  if (environment.platform === "win32") {
    const appdata = envOverride(environment.env, "APPDATA");
    return appDataDir(environment, appdata);
  }
  return homePath(environment, ".mothx");
}

function appDataDir(environment: ConnectEnvironment, appdata: string | null): string {
  return path.join(appdata ?? path.join(environment.homeDir, "AppData", "Roaming"), "mothx");
}

function mothxProvider(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    baseUrl: `${environment.baseUrl}/v1`,
    api: "openai-chat",
    apiKey: environment.apiKey,
    // MothX asks every model for a level as reasoning_effort, which the
    // gateway carries to each vendor's own form (myna's mothxProvider).
    thinkingFormat: "openai",
    models: environment.models.map((model) => ({
      id: model.id,
      name: labelOf(model),
      reasoning: false,
      input: model.images === true ? ["text", "image"] : ["text"],
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens }),
    })),
  };
}

const mothxDriver: AgentConnectDriver = {
  provider: "mothx",
  external: {
    name: "MothX",
    icon: "mothx",
    detect: async (environment) =>
      (await isOnPath("mothx", environment)) || (await isDir(mothxDir(environment))),
  },
  configPath: (environment) => path.join(mothxDir(environment), "settings.json"),
  async read(environment) {
    const settings = await readJsonIfThere(path.join(mothxDir(environment), "settings.json"));
    const provider = settings.defaultProvider;
    return {
      connected: provider === SLOT,
      model: provider === SLOT ? readJsonString(settings, ["defaultModel"]) : null,
      baseUrl: stripNullable(readJsonString(settings, ["providers", SLOT, "baseUrl"])),
    };
  },
  async connect(environment, model, undo) {
    const filePath = path.join(mothxDir(environment), "settings.json");
    const settings = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(settings, captured, `providers.${SLOT}`);
    capture(settings, captured, "defaultProvider");
    capture(settings, captured, "defaultModel");
    setAtValue(settings, `providers.${SLOT}`, mothxProvider(environment));
    settings.defaultProvider = SLOT;
    const chosen = chosenModel(environment, model);
    if (chosen !== null) settings.defaultModel = chosen;
    const entry = await writeJsonWithUndo(filePath, settings, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = path.join(mothxDir(environment), "settings.json");
    if (!(await exists(filePath))) return;
    const settings = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(settings, prior.values);
    await writeJsonWithUndo(filePath, settings, {}, undo);
  },
};

function stripNullable(value: string | null): string | null {
  return value === null ? null : stripV1(value);
}

// ---------- Muse Code ----------

function musePath(environment: ConnectEnvironment): string {
  return path.join(configHome(environment), "muse", "settings.json");
}

const museDriver: AgentConnectDriver = {
  provider: "muse",
  external: {
    name: "Muse Code",
    icon: "meta-color",
    detect: async (environment) =>
      (await isOnPath("muse", environment)) ||
      (await isDir(path.join(configHome(environment), "muse"))),
  },
  configPath: musePath,
  async read(environment) {
    const settings = await readJsonIfThere(musePath(environment));
    const transport = isRecord(settings.endpoint_transport) ? settings.endpoint_transport : {};
    const base = typeof transport.base_url === "string" ? transport.base_url : null;
    const model = typeof settings.model === "string" ? settings.model : null;
    return {
      connected: base === `${environment.baseUrl}/v1`,
      model: base === `${environment.baseUrl}/v1` ? model : null,
      baseUrl: stripNullable(base),
    };
  },
  async connect(environment, model, undo) {
    const filePath = musePath(environment);
    const settings = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(settings, captured, "endpoint_transport");
    capture(settings, captured, "model");
    settings.endpoint_transport = {
      base_url: `${environment.baseUrl}/v1`,
      auth: "none",
    };
    const chosen = chosenModel(environment, model);
    if (chosen !== null) settings.model = chosen;
    const entry = await writeJsonWithUndo(filePath, settings, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = musePath(environment);
    if (!(await exists(filePath))) return;
    const settings = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(settings, prior.values);
    await writeJsonWithUndo(filePath, settings, {}, undo);
  },
};

export const BATCH7_AGENT_DRIVERS: AgentConnectDriver[] = [
  vscodeDriver(VSCODE_INSIDERS, "VS Code Insiders", "vscode"),
  vscodeDriver(VSCODIUM, "VSCodium", "vscodium"),
  mothxDriver,
  museDriver,
];
