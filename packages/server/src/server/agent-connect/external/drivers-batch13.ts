import { promises as fs } from "node:fs";
import path from "node:path";
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
import { envOverride, setTomlTopLevel, writeText } from "./helpers.js";

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

// ---------- StepCode ----------

function stepcodeDir(environment: ConnectEnvironment): string {
  const agentDir = envOverride(environment.env, "STEP_CODING_AGENT_DIR");
  if (agentDir !== null && path.isAbsolute(agentDir)) return path.dirname(agentDir);
  const custom = envOverride(environment.env, "STEPCODE_CONFIG_DIR");
  if (custom !== null) return path.join(environment.homeDir, custom);
  return path.join(environment.homeDir, ".stepcode");
}

function stepcodeConfigPath(environment: ConnectEnvironment): string {
  return path.join(stepcodeDir(environment), "config.toml");
}

function stepcodeModelsPath(environment: ConnectEnvironment): string {
  return path.join(stepcodeDir(environment), "models.json");
}

/** A top-level TOML key's right-hand side as written, before any table. */
function tomlTopRaw(text: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(
    text.split(/^\s*\[/m)[0] ?? "",
  );
  return match?.[1] ?? null;
}

function tomlSetTopRaw(text: string, key: string, rhs: string): string {
  const lines = text.length === 0 ? [] : text.split("\n");
  const rendered = `${key} = ${rhs}`;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*\[/.test(line)) break;
    if (new RegExp(`^\\s*${key}\\s*=`).test(line)) {
      lines[index] = rendered;
      return lines.join("\n");
    }
  }
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  lines.splice(firstTable < 0 ? lines.length : firstTable, 0, rendered);
  return lines.join("\n");
}

function tomlRemoveTop(text: string, key: string): string {
  const lines = text.split("\n");
  let inHead = true;
  return lines
    .filter((line) => {
      if (/^\s*\[/.test(line)) inHead = false;
      return !(inHead && new RegExp(`^\\s*${key}\\s*=`).test(line));
    })
    .join("\n");
}

function stepcodeScope(text: string): string[] | null {
  const raw = tomlTopRaw(text, "enabledModels");
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : null;
  } catch {
    return null;
  }
}

function stepcodeScopeRaw(scope: string[]): string {
  return `[${scope.map((entry) => JSON.stringify(entry)).join(", ")}]`;
}

function stepcodeConfigUndo(
  undo: AgentConnectUndo | undefined,
): Extract<AgentConnectUndo, { kind: "yaml" }> | undefined {
  if (undo?.kind === "yaml") return undo;
  if (undo?.kind !== "multi") return undefined;
  return undo.parts.find(
    (entry): entry is Extract<AgentConnectUndo, { kind: "yaml" }> => entry.kind === "yaml",
  );
}

function stepcodeRestoreKey(text: string, key: string, prior: unknown): string {
  if (isRecord(prior) && prior.present === true && typeof prior.value === "string") {
    return tomlSetTopRaw(text, key, prior.value);
  }
  return tomlRemoveTop(text, key);
}

/** Neolix's pick back, when it is still Neolix's, and its added allow-list entry. */
async function stepcodeRestoreConfig(
  configPath: string,
  part: Extract<AgentConnectUndo, { kind: "yaml" }>,
): Promise<void> {
  let text = (await readTextOrNull(configPath)) ?? "";
  if (tomlTopRaw(text, "defaultProvider") === `"${SLOT}"`) {
    text = stepcodeRestoreKey(text, "defaultProvider", part.values.defaultProvider);
    text = stepcodeRestoreKey(text, "defaultModel", part.values.defaultModel);
  }
  const scope = stepcodeScope(text);
  const appended = part.values.appended;
  if (
    scope !== null &&
    isRecord(appended) &&
    appended.present === true &&
    typeof appended.value === "string" &&
    scope.includes(appended.value)
  ) {
    text = tomlSetTopRaw(
      text,
      "enabledModels",
      stepcodeScopeRaw(scope.filter((entry) => entry !== appended.value)),
    );
  }
  await writeText(configPath, text);
}

async function stepcodeRestoreModels(
  modelsPath: string,
  models: Record<string, unknown>,
  undo: AgentConnectUndo | undefined,
): Promise<void> {
  const jsonPart =
    undo?.kind === "multi" ? undo.parts.find((entry) => entry.kind === "json") : null;
  if (jsonPart?.kind === "json") {
    const file = jsonPart.files.find((entry) => entry.path === modelsPath);
    if (file) restore(models, file.values);
  }
  await writeJsonWithUndo(modelsPath, models, {}, undo);
}

const stepcodeDriver: AgentConnectDriver = {
  provider: "stepcode",
  external: {
    name: "StepCode",
    icon: "stepfun-color",
    detect: async (environment) => exists(stepcodeConfigPath(environment)),
  },
  configPath: stepcodeConfigPath,
  async read(environment) {
    const text = (await readTextOrNull(stepcodeConfigPath(environment))) ?? "";
    const provider = tomlTopRaw(text, "defaultProvider");
    const model = tomlTopRaw(text, "defaultModel");
    const models = await readJsonIfThere(stepcodeModelsPath(environment));
    const base = readJsonString(models, ["providers", SLOT, "baseUrl"]);
    return {
      connected: provider === `"${SLOT}"`,
      model: provider === `"${SLOT}"` && model !== null ? model.replace(/^"|"$/g, "") : null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, undo) {
    const configPath = stepcodeConfigPath(environment);
    const modelsPath = stepcodeModelsPath(environment);
    const before = (await readTextOrNull(configPath)) ?? "";
    const priorScope = stepcodeScope(before);
    const chosen = chosenModel(environment, model);
    const ref = chosen === null ? null : `${SLOT}/${chosen}`;
    const prior: Record<string, PriorValue> = {
      defaultProvider:
        tomlTopRaw(before, "defaultProvider") === null
          ? { present: false }
          : { present: true, value: tomlTopRaw(before, "defaultProvider") },
      defaultModel:
        tomlTopRaw(before, "defaultModel") === null
          ? { present: false }
          : { present: true, value: tomlTopRaw(before, "defaultModel") },
      enabledModels:
        priorScope === null ? { present: false } : { present: true, value: priorScope },
      appended: { present: ref !== null, value: ref },
    };
    let text = setTomlTopLevel(before, "defaultProvider", SLOT);
    if (chosen !== null) text = setTomlTopLevel(text, "defaultModel", chosen);
    // A reader's allow-list gains the model Neolix starts on, as StepCode
    // requires a listed model (myna's enabledModels handling).
    if (priorScope !== null && priorScope.length > 0 && ref !== null && !priorScope.includes(ref)) {
      text = tomlSetTopRaw(text, "enabledModels", stepcodeScopeRaw([...priorScope, ref]));
    }
    await writeText(configPath, text);

    const models = await readJsonIfThere(modelsPath);
    const captured: Record<string, PriorValue> = {};
    capture(models, captured, `providers.${SLOT}`);
    setAtValue(models, `providers.${SLOT}`, {
      name: "Neox",
      baseUrl: `${environment.baseUrl}/v1`,
      api: "openai-completions",
      apiKey: environment.apiKey,
      models: environment.models.map((entry) => ({
        id: entry.id,
        name: labelOf(entry),
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        ...(entry.maxOutputTokens === undefined ? {} : { maxTokens: entry.maxOutputTokens }),
        ...(entry.images === undefined
          ? {}
          : { input: entry.images ? ["text", "image"] : ["text"] }),
      })),
    });
    const modelsFile = await writeJsonWithUndo(modelsPath, models, captured, undo);
    return {
      kind: "multi",
      parts: [
        { kind: "yaml", path: configPath, values: prior },
        { kind: "json", files: [modelsFile] },
      ],
    };
  },
  async disconnect(environment, undo) {
    const configPart = stepcodeConfigUndo(undo);
    const configPath = stepcodeConfigPath(environment);
    if (configPart !== undefined && (await exists(configPath))) {
      await stepcodeRestoreConfig(configPath, configPart);
    }
    const modelsPath = stepcodeModelsPath(environment);
    if (await exists(modelsPath)) {
      const models = await readJsonIfThere(modelsPath);
      await stepcodeRestoreModels(modelsPath, models, undo);
    }
  },
};

// ---------- Copilot (JetBrains) ----------

const COPILOT_JB_PLUGIN = "github-copilot-intellij";

function copilotByokPath(environment: ConnectEnvironment): string {
  const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
  if (xdg !== null && path.isAbsolute(xdg)) return path.join(xdg, "github-copilot", "byok.json");
  if (environment.platform === "win32") {
    return path.join(environment.homeDir, "AppData", "Local", "github-copilot", "byok.json");
  }
  return path.join(environment.homeDir, ".config", "github-copilot", "byok.json");
}

async function copilotJbInstalled(environment: ConnectEnvironment): Promise<boolean> {
  const home = environment.homeDir;
  let base: string;
  let sub = "plugins";
  if (environment.platform === "darwin") {
    base = path.join(home, "Library", "Application Support");
  } else if (environment.platform === "win32") {
    base = envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming");
  } else {
    base = envOverride(environment.env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share");
    sub = "";
  }
  for (const vendor of ["JetBrains", "Google"]) {
    let products: string[];
    try {
      products = await fs.readdir(path.join(base, vendor));
    } catch {
      continue;
    }
    for (const product of products) {
      const plugin =
        sub === ""
          ? path.join(base, vendor, product, COPILOT_JB_PLUGIN)
          : path.join(base, vendor, product, sub, COPILOT_JB_PLUGIN);
      try {
        if ((await fs.stat(plugin)).isDirectory()) return true;
      } catch {
        // Try the next product.
      }
    }
  }
  return false;
}

function copilotJbModels(environment: ConnectEnvironment, prior: unknown): Record<string, unknown> {
  const hidden =
    isRecord(prior) && typeof prior === "object"
      ? Object.fromEntries(
          Object.entries(prior).map(([id, entry]) => [
            id,
            isRecord(entry) && entry.isRegistered === false,
          ]),
        )
      : {};
  return Object.fromEntries(
    environment.models.map((model) => {
      const context = model.contextWindow ?? 128000;
      // The output is reserved out of the window the prompt fills, at most a
      // quarter of it; myna's copilotJetBrainsAt (outputOr).
      const output = model.maxOutputTokens ?? 16000;
      return [
        model.id,
        {
          deploymentUrl: `${environment.baseUrl}/v1/chat/completions`,
          isRegistered: hidden[model.id] !== true,
          isCustomModel: true,
          modelCapabilities: {
            name: labelOf(model),
            maxInputTokens: context,
            maxOutputTokens: Math.min(output, Math.floor(context / 4)),
            toolCalling: true,
            vision: model.images === true,
          },
        },
      ];
    }),
  );
}

const copilotJetBrainsDriver: AgentConnectDriver = {
  provider: "copilot-jetbrains",
  external: {
    name: "Copilot (JetBrains)",
    icon: "githubcopilot",
    detect: async (environment) => {
      const byok = await readJsonIfThere(copilotByokPath(environment));
      return `${SLOT}-provider-config` in byok || (await copilotJbInstalled(environment));
    },
  },
  configPath: copilotByokPath,
  async read(environment) {
    const filePath = copilotByokPath(environment);
    if (!(await exists(filePath))) return { connected: false, model: null, baseUrl: null };
    const byok = await readJsonIfThere(filePath);
    const models = byok[`${SLOT}-models-config`];
    const first = isRecord(models) ? Object.values(models)[0] : undefined;
    const url =
      isRecord(first) && typeof first.deploymentUrl === "string" ? first.deploymentUrl : null;
    return {
      connected: `${SLOT}-provider-config` in byok,
      model: null,
      baseUrl: url === null ? null : stripV1(url.replace(/\/chat\/completions\/?$/, "")),
    };
  },
  async connect(environment, _model, undo) {
    const filePath = copilotByokPath(environment);
    if (!(await exists(filePath))) {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(filePath, "{}\n", { mode: 0o600 });
    }
    const byok = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of [`${SLOT}-provider-config`, `${SLOT}-api-key`, `${SLOT}-models-config`]) {
      capture(byok, captured, key);
    }
    byok[`${SLOT}-provider-config`] = { groupName: SLOT, apiType: "chatCompletions" };
    byok[`${SLOT}-api-key`] = environment.apiKey;
    byok[`${SLOT}-models-config`] = copilotJbModels(environment, byok[`${SLOT}-models-config`]);
    const entry = await writeJsonWithUndo(filePath, byok, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = copilotByokPath(environment);
    if (!(await exists(filePath))) return;
    const byok = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) {
      restore(byok, prior.values);
    } else {
      for (const key of [`${SLOT}-provider-config`, `${SLOT}-api-key`, `${SLOT}-models-config`]) {
        delete byok[key];
      }
    }
    await writeJsonWithUndo(filePath, byok, {}, undo);
  },
};

export const BATCH13_AGENT_DRIVERS: AgentConnectDriver[] = [stepcodeDriver, copilotJetBrainsDriver];
