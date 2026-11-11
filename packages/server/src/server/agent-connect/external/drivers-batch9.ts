import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
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
  absoluteDir,
  configHome,
  envOverride,
  isDir,
  isOnPath,
  textUndo,
  writeText,
} from "./helpers.js";

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

function readJsonString(root: Record<string, unknown>, keys: string[]): string | null {
  let current: unknown = root;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" && current.length > 0 ? current : null;
}

// ---------- DevEco Code ----------

function devecoDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "DEVECO_CONFIG_DIR");
  if (override !== null && path.isAbsolute(override)) return override;
  return path.join(configHome(environment), "deveco");
}

/** DevEco merges config.json, deveco.json and deveco.jsonc, so the first there is the one read. */
async function devecoConfigPath(environment: ConnectEnvironment): Promise<string> {
  const dir = devecoDir(environment);
  for (const name of ["deveco.json", "deveco.jsonc", "config.json"]) {
    const candidate = path.join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return path.join(dir, "deveco.json");
}

const devecoDriver: AgentConnectDriver = {
  provider: "deveco",
  external: {
    name: "DevEco Code",
    icon: "deveco-color",
    detect: async (environment) =>
      (await isOnPath("deveco", environment)) || (await isDir(devecoDir(environment))),
  },
  configPath: (environment) => path.join(devecoDir(environment), "deveco.json"),
  async read(environment) {
    const filePath = await devecoConfigPath(environment);
    const config = await readJsonIfThere(filePath);
    const model = readJsonString(config, ["model"]);
    return {
      connected: model?.startsWith(`${SLOT}/`) === true,
      model: model?.startsWith(`${SLOT}/`) === true ? model.slice(SLOT.length + 1) : null,
      baseUrl: stripNullable(readJsonString(config, ["provider", SLOT, "options", "baseURL"])),
    };
  },
  async connect(environment, model, undo) {
    const filePath = await devecoConfigPath(environment);
    const config = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, `provider.${SLOT}`);
    capture(config, captured, "model");
    setAtValue(config, `provider.${SLOT}`, {
      npm: "@ai-sdk/openai-compatible",
      name: "Neox",
      options: { baseURL: `${environment.baseUrl}/v1`, apiKey: environment.apiKey },
      models: Object.fromEntries(
        environment.models.map((entry) => [entry.id, { name: labelOf(entry) }]),
      ),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) setAtValue(config, "model", `${SLOT}/${chosen}`);
    const entry = await writeJsonWithUndo(filePath, config, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = await devecoConfigPath(environment);
    if (!(await exists(filePath))) return;
    const config = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(config, prior.values);
    await writeJsonWithUndo(filePath, config, {}, undo);
  },
};

function stripNullable(value: string | null): string | null {
  return value === null ? null : stripV1(value);
}

// ---------- Qoder CN ----------

function qoderCnDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "QODERCN_CONFIG_DIR"), [
    ".qoder-cn",
  ]);
}

function qoderCnPath(environment: ConnectEnvironment): string {
  return path.join(qoderCnDir(environment), "settings.json");
}

const qoderCnDriver: AgentConnectDriver = {
  provider: "qoder-cn",
  external: {
    name: "Qoder CN",
    icon: "qoder",
    detect: async (environment) =>
      (await isOnPath("qoderclicn", environment)) || (await isDir(qoderCnDir(environment))),
  },
  configPath: qoderCnPath,
  async read(environment) {
    const root = await readJsonIfThere(qoderCnPath(environment));
    const name = readJsonString(root, ["model", "name"]);
    const prefixed = name?.startsWith(`${SLOT}/`) === true ? name.slice(SLOT.length + 1) : null;
    return {
      connected: prefixed !== null,
      model: prefixed,
      baseUrl: readJsonString(root, ["providers", SLOT, "baseUrl"]),
    };
  },
  async connect(environment, model, undo) {
    const filePath = qoderCnPath(environment);
    const root = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of [`providers.${SLOT}`, "model.name", "model.reasoningEffort"]) {
      capture(root, captured, key);
    }
    setAtValue(root, `providers.${SLOT}`, {
      displayName: "Neox",
      protocol: "openai",
      baseUrl: `${environment.baseUrl}/v1`,
      apiKey: environment.apiKey,
      models: environment.models.map((entry) => ({
        model: entry.id,
        displayName: labelOf(entry),
      })),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(root, "model.name", `${SLOT}/${chosen}`);
      const modelNode = isRecord(root.model) ? root.model : {};
      delete modelNode.reasoningEffort;
      root.model = modelNode;
    }
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = qoderCnPath(environment);
    if (!(await exists(filePath))) return;
    const root = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(root, prior.values);
    await writeJsonWithUndo(filePath, root, {}, undo);
  },
};

// ---------- WorkBuddy AI ----------

function workbuddyAiDir(environment: ConnectEnvironment): string {
  return path.join(environment.homeDir, ".workbuddy-ai");
}

function workbuddyAiPath(environment: ConnectEnvironment): string {
  return path.join(workbuddyAiDir(environment), "models.json");
}

interface BuddyEntry {
  id?: string;
  name?: string;
  vendor?: string;
  apiKey?: string;
  url?: string;
  [key: string]: unknown;
}

/** models.json is a list, or CodeBuddy Code's {"models":[…],"availableModels":[…]} (myna's workbuddyRead). */
function readBuddyFile(text: string): {
  rest: Record<string, unknown> | null;
  entries: BuddyEntry[];
} {
  const parsed: unknown = text.trim() === "" ? [] : JSON.parse(text);
  if (Array.isArray(parsed)) return { rest: null, entries: parsed as BuddyEntry[] };
  if (isRecord(parsed)) {
    const models = Array.isArray(parsed.models) ? (parsed.models as BuddyEntry[]) : [];
    return { rest: parsed, entries: models };
  }
  return { rest: null, entries: [] };
}

function workbuddyAiModel(environment: ConnectEnvironment, model: AgentConnectModel): BuddyEntry {
  return {
    id: model.id,
    name: labelOf(model),
    vendor: SLOT,
    apiKey: environment.apiKey,
    url: `${environment.baseUrl}/v1/chat/completions`,
    maxInputTokens: model.contextWindow ?? 128000,
    supportsToolCall: true,
    supportsImages: model.images === true,
    supportsReasoning: false,
  };
}

function workbuddyAiOurs(entry: BuddyEntry, apiKey: string): boolean {
  return entry.vendor === SLOT && entry.apiKey === apiKey;
}

const workbuddyAiDriver: AgentConnectDriver = {
  provider: "workbuddy-ai",
  external: {
    name: "WorkBuddy AI",
    icon: "workbuddy-color",
    detect: async (environment) => isDir(workbuddyAiDir(environment)),
  },
  configPath: workbuddyAiPath,
  async read(environment) {
    const filePath = workbuddyAiPath(environment);
    if (!(await exists(filePath))) return { connected: false, model: null, baseUrl: null };
    const file = readBuddyFile((await readTextOrNull(filePath)) ?? "");
    const ours = file.entries.find((entry) => workbuddyAiOurs(entry, environment.apiKey));
    return {
      connected: ours !== undefined,
      model: null,
      baseUrl:
        ours?.url === undefined ? null : stripV1(ours.url.replace(/\/chat\/completions\/?$/, "")),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = workbuddyAiPath(environment);
    const before = await readTextOrNull(filePath);
    const file = readBuddyFile(before ?? "");
    const kept = file.entries.filter((entry) => !workbuddyAiOurs(entry, environment.apiKey));
    const chosen = chosenModel(environment, model);
    const picked = environment.models.find((entry) => entry.id === chosen);
    const ours =
      chosen === null ? [] : [workbuddyAiModel(environment, { id: chosen, label: picked?.label })];
    const value =
      file.rest === null ? [...kept, ...ours] : { ...file.rest, models: [...kept, ...ours] };
    await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
    return textUndo(filePath, before, (await readTextOrNull(filePath)) ?? "");
  },
  async disconnect(environment, undo) {
    const filePath = workbuddyAiPath(environment);
    let parts: AgentConnectUndo[] = [];
    if (undo !== undefined) parts = undo.kind === "multi" ? undo.parts : [undo];
    const part = parts.find(
      (entry): entry is Extract<AgentConnectUndo, { kind: "text" }> => entry.kind === "text",
    );
    if (part === undefined) return;
    if (part.before === null) await fs.rm(filePath, { force: true });
    else await writeText(filePath, part.before);
  },
};

export const BATCH9_AGENT_DRIVERS: AgentConnectDriver[] = [
  devecoDriver,
  qoderCnDriver,
  workbuddyAiDriver,
];
