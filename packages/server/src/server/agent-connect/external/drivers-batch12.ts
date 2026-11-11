import { promises as fs } from "node:fs";
import path from "node:path";
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
import { envOverride, homePath, isDir, isOnPath } from "./helpers.js";

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

// ---------- Pi-shaped agents: OmO and Prime Agent ----------

interface PiShape {
  provider: string;
  name: string;
  icon: string;
  dir(environment: ConnectEnvironment): string;
  bin: string;
}

function piAgentDriver(shape: PiShape): AgentConnectDriver {
  const settingsPath = (environment: ConnectEnvironment) =>
    path.join(shape.dir(environment), "settings.json");
  const modelsPath = (environment: ConnectEnvironment) =>
    path.join(shape.dir(environment), "models.json");
  return {
    provider: shape.provider,
    external: {
      name: shape.name,
      icon: shape.icon,
      detect: async (environment) =>
        (await isOnPath(shape.bin, environment)) || isDir(shape.dir(environment)),
    },
    configPath: settingsPath,
    async read(environment) {
      const settings = await readJsonIfThere(settingsPath(environment));
      const models = await readJsonIfThere(modelsPath(environment));
      const base = readJsonString(models, ["providers", SLOT, "baseUrl"]);
      const wired = settings.defaultProvider === SLOT;
      return {
        connected: wired,
        model: wired ? readJsonString(settings, ["defaultModel"]) : null,
        baseUrl: base === null ? null : stripV1(base),
      };
    },
    async connect(environment, model, undo) {
      const settingsFile = settingsPath(environment);
      const modelsFile = modelsPath(environment);
      const settings = await readJsonIfThere(settingsFile);
      const models = await readJsonIfThere(modelsFile);
      const settingsPrior: Record<string, PriorValue> = {};
      const modelsPrior: Record<string, PriorValue> = {};
      capture(settings, settingsPrior, "defaultProvider");
      capture(settings, settingsPrior, "defaultModel");
      capture(models, modelsPrior, `providers.${SLOT}`);
      settings.defaultProvider = SLOT;
      const chosen = chosenModel(environment, model);
      if (chosen !== null) settings.defaultModel = chosen;
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
      const settingsEntry = await writeJsonWithUndo(settingsFile, settings, settingsPrior, undo);
      const modelsEntry = await writeJsonWithUndo(modelsFile, models, modelsPrior, undo);
      return { kind: "json", files: [settingsEntry, modelsEntry] };
    },
    async disconnect(environment, undo) {
      for (const [filePath, keys] of [
        [settingsPath(environment), ["defaultProvider", "defaultModel"]],
        [modelsPath(environment), [`providers.${SLOT}`]],
      ] as const) {
        if (!(await exists(filePath))) continue;
        const root = await readJsonIfThere(filePath);
        const prior =
          undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
        if (prior) restore(root, prior.values);
        else for (const key of keys) delete root[key];
        await writeJsonWithUndo(filePath, root, {}, undo);
      }
    },
  };
}

function omoDir(environment: ConnectEnvironment): string {
  for (const name of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR"]) {
    const value = envOverride(environment.env, name);
    if (value !== null && path.isAbsolute(value)) return value;
  }
  return homePath(environment, ".omo", "agent");
}

function primeAgentDir(environment: ConnectEnvironment): string {
  const value = envOverride(environment.env, "PRIME_AGENT_CODING_AGENT_DIR");
  if (value !== null) {
    let expanded = value;
    if (value === "~" || value.startsWith("~/")) {
      expanded = path.join(environment.homeDir, value.slice(1));
    }
    if (path.isAbsolute(expanded)) return expanded;
  }
  return homePath(environment, ".prime", "agent");
}

const omoDriver = piAgentDriver({
  provider: "omo",
  name: "OmO",
  icon: "omo",
  dir: omoDir,
  bin: "omo",
});

const primeAgentDriver = piAgentDriver({
  provider: "prime-agent",
  name: "Prime Agent",
  icon: "prime-agent",
  dir: primeAgentDir,
  bin: "prime-agent",
});

// ---------- Empryo ----------

function empryoPath(environment: ConnectEnvironment): string {
  return homePath(environment, ".empryo", "config.json");
}

const empryoDriver: AgentConnectDriver = {
  provider: "empryo",
  external: {
    name: "Empryo",
    icon: "empryo-color",
    detect: async (environment) =>
      (await isOnPath("empryo", environment)) || isDir(homePath(environment, ".empryo")),
  },
  configPath: empryoPath,
  async read(environment) {
    const config = await readJsonIfThere(empryoPath(environment));
    const model = readJsonString(config, ["defaultModel"]);
    const wired = model?.startsWith(`${SLOT}/`) === true;
    const providers = Array.isArray(config.providers) ? (config.providers as unknown[]) : [];
    const entry = providers.find((item) => isRecord(item) && item.id === SLOT);
    return {
      connected: wired && entry !== undefined,
      model: wired ? model.slice(SLOT.length + 1) : null,
      baseUrl: isRecord(entry) && typeof entry.baseURL === "string" ? stripV1(entry.baseURL) : null,
    };
  },
  async connect(environment, model, undo) {
    const filePath = empryoPath(environment);
    const config = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, "providers");
    capture(config, captured, "defaultModel");
    const providers = Array.isArray(config.providers) ? (config.providers as unknown[]) : [];
    const kept = providers.filter((item) => !(isRecord(item) && item.id === SLOT));
    kept.push({
      id: SLOT,
      name: "Neox",
      // Keyless: Empryo sends no key of the reader's, and the gateway takes
      // a request from this machine without one (myna's empryo).
      baseURL: `${environment.baseUrl}/v1`,
      modelsAPI: `${environment.baseUrl}/v1/models`,
    });
    setAtValue(config, "providers", kept);
    const chosen = chosenModel(environment, model);
    if (chosen !== null) config.defaultModel = `${SLOT}/${chosen}`;
    const entry = await writeJsonWithUndo(filePath, config, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = empryoPath(environment);
    if (!(await exists(filePath))) return;
    const config = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) {
      restore(config, prior.values);
    } else {
      const providers = Array.isArray(config.providers) ? (config.providers as unknown[]) : [];
      setAtValue(
        config,
        "providers",
        providers.filter((item) => !(isRecord(item) && item.id === SLOT)),
      );
      if (readJsonString(config, ["defaultModel"])?.startsWith(`${SLOT}/`) === true) {
        delete config.defaultModel;
      }
    }
    await writeJsonWithUndo(filePath, config, {}, undo);
  },
};

export const BATCH12_AGENT_DRIVERS: AgentConnectDriver[] = [
  omoDriver,
  primeAgentDriver,
  empryoDriver,
];
