import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import {
  contentHash,
  deleteAt,
  readJsonObject,
  readTextOrNull,
  tomlString,
} from "../config-files.js";
import { runProcess } from "../process-run.js";
import {
  hasAgyShellFunction,
  installAgyShellFunction,
  removeAgyShellFunction,
} from "./shell-function.js";
import { BATCH2_AGENT_DRIVERS } from "./drivers-batch2.js";
import { BATCH3_AGENT_DRIVERS } from "./drivers-batch3.js";
import { BATCH4_AGENT_DRIVERS } from "./drivers-batch4.js";
import { BATCH5_AGENT_DRIVERS } from "./drivers-batch5.js";
import { BATCH6_AGENT_DRIVERS } from "./drivers-batch6.js";
import { BATCH7_AGENT_DRIVERS } from "./drivers-batch7.js";
import { BATCH8_AGENT_DRIVERS } from "./drivers-batch8.js";
import { BATCH9_AGENT_DRIVERS } from "./drivers-batch9.js";
import { BATCH10_AGENT_DRIVERS } from "./drivers-batch10.js";
import { BATCH11_AGENT_DRIVERS } from "./drivers-batch11.js";
import { BATCH12_AGENT_DRIVERS } from "./drivers-batch12.js";
import { BATCH13_AGENT_DRIVERS } from "./drivers-batch13.js";
import { BATCH14_AGENT_DRIVERS } from "./drivers-batch14.js";
import { BATCH15_AGENT_DRIVERS } from "./drivers-batch15.js";
import { BATCH16_AGENT_DRIVERS } from "./drivers-batch16.js";
import { BATCH17_AGENT_DRIVERS } from "./drivers-batch17.js";
import { BATCH18_AGENT_DRIVERS } from "./drivers-batch18.js";
import { BATCH19_AGENT_DRIVERS } from "./drivers-batch19.js";
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
  appendTomlTables,
  configHome,
  envOverride,
  getTomlTableKey,
  homePath,
  isDir,
  isOnPath,
  readEnvFile,
  readYamlDocument,
  removeEnvValues,
  removeTomlTable,
  removeTomlTableKey,
  removeTomlTablesWithPrefix,
  removeTomlTopLevel,
  setEnvValues,
  setTomlTableKey,
  setTomlTableRawKey,
  setTomlTopLevel,
  textUndo,
  writeText,
  writeYamlDocument,
  yamlString,
} from "./helpers.js";

const SLOT = "neolix";

/** The model the agent starts on: the picked one, else the gateway's first. */
function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  if (model !== null) return model;
  return environment.models[0]?.id ?? null;
}

function labelOf(model: AgentConnectModel): string {
  return model.label ?? model.id;
}

function jsonUndo(entries: Awaited<ReturnType<typeof writeJsonWithUndo>>[]): AgentConnectUndo {
  return { kind: "json", files: entries };
}

function stripPrefix(value: string | null, prefix: string): string | null {
  if (value === null) return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function stripNullableV1(value: string | null): string | null {
  return value === null ? null : stripV1(value);
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

/** Restores the JSON values Neolix displaced, then writes the file back. */
async function restoreJsonFile(
  filePath: string,
  undo: AgentConnectUndo | undefined,
): Promise<void> {
  if (!(await exists(filePath))) return;
  const root = await readJsonObject(filePath);
  const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
  if (prior) {
    restore(root, prior.values);
  }
  await writeJsonWithUndo(filePath, root, {}, undo);
}

// ---------- Gemini CLI ----------

function geminiPaths(environment: ConnectEnvironment): { settings: string; env: string } {
  const dir = homePath(environment, ".gemini");
  return { settings: path.join(dir, "settings.json"), env: path.join(dir, ".env") };
}

const geminiDriver: AgentConnectDriver = {
  provider: "gemini",
  external: {
    name: "Gemini CLI",
    icon: "geminicli-color",
    detect: (environment) => isOnPath("gemini", environment),
  },
  configPath: (environment) => geminiPaths(environment).settings,
  async read(environment) {
    const paths = geminiPaths(environment);
    const settings = await readJsonObject(paths.settings);
    const env = await readEnvFile(paths.env);
    const baseUrl = env.GOOGLE_GEMINI_BASE_URL ?? null;
    const authType = readJsonString(settings, ["security", "auth", "selectedType"]);
    return {
      connected: baseUrl === environment.baseUrl && authType === "gemini-api-key",
      model: readJsonString(settings, ["model", "name"]),
      baseUrl,
    };
  },
  async connect(environment, model, undo) {
    const paths = geminiPaths(environment);
    const settings = await readJsonObject(paths.settings);
    const captured: Record<string, PriorValue> = {};
    for (const key of ["security.auth.selectedType", "model.name", "model"]) {
      capture(settings, captured, key);
    }
    setAtValue(settings, "security.auth.selectedType", "gemini-api-key");
    if (model !== null) {
      setAtValue(settings, "model.name", model);
    }
    const entry = await writeJsonWithUndo(paths.settings, settings, captured, undo);
    const priorEnv =
      undo?.kind === "env" && undo.path === paths.env
        ? undo.values
        : undoParts(undo)
            .filter(
              (part): part is Extract<AgentConnectUndo, { kind: "env" }> => part.kind === "env",
            )
            .find((part) => part.path === paths.env)?.values;
    const env = await readEnvFile(paths.env);
    const envUndo: AgentConnectUndo = {
      kind: "env",
      path: paths.env,
      values: priorEnv ?? {
        GOOGLE_GEMINI_BASE_URL: env.GOOGLE_GEMINI_BASE_URL ?? null,
        GEMINI_API_KEY: env.GEMINI_API_KEY ?? null,
      },
    };
    await setEnvValues(paths.env, {
      GOOGLE_GEMINI_BASE_URL: environment.baseUrl,
      GEMINI_API_KEY: environment.apiKey,
    });
    return { kind: "multi", parts: [jsonUndo([entry]), envUndo] };
  },
  async disconnect(environment, undo) {
    const paths = geminiPaths(environment);
    const parts = undoParts(undo);
    const json = parts.find((part) => part.kind === "json");
    await restoreJsonFile(paths.settings, json);
    const envUndo = parts.find((part) => part.kind === "env");
    if (envUndo?.kind !== "env") return;
    const entries = Object.entries(envUndo.values);
    await removeEnvValues(
      paths.env,
      entries.filter(([, value]) => value === null).map(([key]) => key),
    );
    const kept = Object.fromEntries(
      entries.filter((entry): entry is [string, string] => entry[1] !== null),
    );
    if (Object.keys(kept).length > 0) {
      await setEnvValues(paths.env, kept);
    }
  },
};

// ---------- Antigravity CLI (agy) ----------

function agyPath(environment: ConnectEnvironment): string {
  return path.join(environment.homeDir, ".gemini", "antigravity-cli", "settings.json");
}

interface AgyModel {
  apiProvider: string;
  modelName: string;
}

function agyModelsOf(root: Record<string, unknown>): Record<string, AgyModel> {
  const config = root.customModelsConfig;
  if (typeof config !== "object" || config === null) return {};
  const models = (config as Record<string, unknown>).customModels;
  if (typeof models !== "object" || models === null || Array.isArray(models)) return {};
  return models as Record<string, AgyModel>;
}

const agyDriver: AgentConnectDriver = {
  provider: "agy",
  external: {
    name: "Antigravity CLI",
    icon: "antigravity-color",
    detect: async (environment) =>
      (await isOnPath("agy", environment)) || (await exists(agyPath(environment))),
    // agy takes the endpoint and key only from its environment; the row
    // carries the line that starts it with them.
    launch: (environment, model) => agyLaunch(environment, model),
    // typing agy in a new shell sets the variables and the model, as myna does.
    shell: {
      installed: hasAgyShellFunction,
      install: installAgyShellFunction,
      remove: removeAgyShellFunction,
    },
  },
  configPath: agyPath,
  async read(environment) {
    const root = await readJsonObject(agyPath(environment));
    const selected = readJsonString(root, ["model"]);
    const provider = readJsonString(root, ["modelProvider"]);
    const prefixed = stripPrefix(selected, `${SLOT}/`);
    return {
      connected:
        provider === "gemini" &&
        prefixed !== null &&
        agyModelsOf(root)[selected ?? ""] !== undefined,
      model: prefixed,
      // The endpoint comes from the environment agy starts with, not its file.
      baseUrl: null,
    };
  },
  async connect(environment, model, undo) {
    const filePath = agyPath(environment);
    const root = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of ["model", "modelProvider", "customModelsConfig"]) {
      capture(root, captured, key);
    }
    const chosen = chosenModel(environment, model);
    const custom: Record<string, AgyModel> = {};
    for (const [key, value] of Object.entries(agyModelsOf(root))) {
      if (!key.startsWith(`${SLOT}/`)) custom[key] = value;
    }
    if (chosen !== null) {
      custom[`${SLOT}/${chosen}`] = {
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        modelName: chosen,
      };
    }
    setAtValue(root, "modelProvider", "gemini");
    if (chosen !== null) setAtValue(root, "model", `${SLOT}/${chosen}`);
    setAtValue(root, "customModelsConfig", { customModels: custom });
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(agyPath(environment), undo);
  },
};

function agyLaunch(environment: ConnectEnvironment, model: string | null): string | null {
  if (environment.baseUrl.length === 0 || model === null) return null;
  const base = shellQuote(environment.baseUrl);
  const key = shellQuote(environment.apiKey);
  const modelArg = shellQuote(model);
  if ((environment.platform ?? process.platform) === "win32") {
    return `$env:GEMINI_API_KEY=${key}; $env:GOOGLE_GEMINI_BASE_URL=${base}; agy --model ${modelArg}`;
  }
  return `GEMINI_API_KEY=${key} GOOGLE_GEMINI_BASE_URL=${base} agy --model ${modelArg}`;
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

// ---------- Cursor CLI ----------

const cursorDriver: AgentConnectDriver = {
  provider: "cursor",
  external: {
    name: "Cursor CLI",
    icon: "cursor",
    // The Cursor editor makes ~/.cursor with no CLI; only the file or the command says it is here.
    detect: async (environment) =>
      (await isOnPath("cursor-agent", environment)) ||
      (await exists(path.join(environment.homeDir, ".cursor", "cli-config.json"))),
    // myna only picks Cursor's own model here; it has no gateway provider to write.
    noConnect: true,
  },
  configPath: (environment) => path.join(environment.homeDir, ".cursor", "cli-config.json"),
  async read(environment) {
    const root = await readJsonObject(cursorDriver.configPath(environment));
    return { connected: false, model: readJsonString(root, ["model", "modelId"]), baseUrl: null };
  },
  async connect(_environment, _model, undo) {
    return undo ?? jsonUndo([]);
  },
  async disconnect() {
    // Nothing of Cursor's is written.
  },
};

// ---------- Qoder ----------

function qoderDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "QODER_CONFIG_DIR"), [".qoder"]);
}

function qoderPath(environment: ConnectEnvironment): string {
  return path.join(qoderDir(environment), "settings.json");
}

const qoderDriver: AgentConnectDriver = {
  provider: "qoder",
  external: {
    name: "Qoder",
    icon: "qoder",
    detect: async (environment) => {
      if (await isOnPath("qodercli", environment)) return true;
      const filePath = qoderPath(environment);
      if (!(await exists(filePath))) return false;
      try {
        const keys = Object.keys(await readJsonObject(filePath));
        // The JetBrains plugin writes a settings.json of enabledPlugins alone.
        return keys.length > 1 || (keys.length === 1 && keys[0] !== "enabledPlugins");
      } catch {
        return false;
      }
    },
  },
  configPath: qoderPath,
  async read(environment) {
    const root = await readJsonObject(qoderPath(environment));
    const prefixed = stripPrefix(readJsonString(root, ["model", "name"]), `${SLOT}/`);
    return {
      connected: prefixed !== null,
      model: prefixed,
      baseUrl: readJsonString(root, ["providers", SLOT, "baseUrl"]),
    };
  },
  async connect(environment, model, undo) {
    const filePath = qoderPath(environment);
    const root = await readJsonObject(filePath);
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
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        ...(entry.maxOutputTokens === undefined ? {} : { maxOutputTokens: entry.maxOutputTokens }),
        capabilities: { tools: true, vision: entry.images === true },
      })),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(root, "model.name", `${SLOT}/${chosen}`);
      deleteAt(root, "model.reasoningEffort");
    }
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(qoderPath(environment), undo);
  },
};

// ---------- Grok Build ----------

function grokPath(environment: ConnectEnvironment): string {
  const dir = absoluteDir(environment, envOverride(environment.env, "GROK_HOME"), [".grok"]);
  return path.join(dir, "config.toml");
}

const grokDriver: AgentConnectDriver = {
  provider: "grok",
  external: {
    name: "Grok Build",
    icon: "xai",
    detect: async (environment) =>
      (await isDir(path.dirname(grokPath(environment)))) || (await isOnPath("grok", environment)),
  },
  configPath: grokPath,
  async read(environment) {
    const filePath = grokPath(environment);
    const text = (await readTextOrNull(filePath)) ?? "";
    const prefixed = stripPrefix(getTomlTableKey(text, "[models]", "default"), `${SLOT}/`);
    const baseUrl =
      prefixed === null ? null : getTomlTableKey(text, `[model."${SLOT}/${prefixed}"]`, "base_url");
    return { connected: prefixed !== null, model: prefixed, baseUrl: stripNullableV1(baseUrl) };
  },
  async connect(environment, model, undo) {
    const filePath = grokPath(environment);
    const before = await readTextOrNull(filePath);
    const chosen = chosenModel(environment, model);
    const tables = environment.models.map((entry) =>
      [
        `[model."${SLOT}/${entry.id}"]`,
        `model = ${tomlString(entry.id)}`,
        `name = ${tomlString(labelOf(entry))}`,
        `base_url = ${tomlString(`${environment.baseUrl}/v1`)}`,
        `api_key = ${tomlString(environment.apiKey)}`,
        `api_backend = "chat_completions"`,
      ].join("\n"),
    );
    let next = appendTomlTables(before ?? "", tables);
    const priorDefault = getTomlTableKey(next, "[models]", "default");
    const priorCampaigns = getTomlTableKey(next, "[features]", "campaigns");
    if (chosen !== null) {
      next = setTomlTableKey(next, "[models]", "default", `${SLOT}/${chosen}`);
    }
    // A launch campaign would otherwise overwrite the default on start-up.
    next = setTomlTableRawKey(next, "[features]", "campaigns", "false");
    const wrote = next.endsWith("\n") ? next : `${next}\n`;
    await writeText(filePath, wrote);
    const previous = undo?.kind === "toml-tables" && undo.path === filePath ? undo : null;
    return {
      kind: "toml-tables",
      path: filePath,
      before: previous?.before ?? before,
      wrote: contentHash(wrote),
      sections: environment.models.map((entry) => `[model."${SLOT}/${entry.id}"]`),
      restore: previous?.restore ?? [
        { header: "[models]", key: "default", value: priorDefault },
        { header: "[features]", key: "campaigns", value: priorCampaigns },
      ],
    };
  },
  async disconnect(environment, undo) {
    const filePath = grokPath(environment);
    const text = await readTextOrNull(filePath);
    if (text === null) return;
    if (
      undo?.kind === "toml-tables" &&
      undo.path === filePath &&
      contentHash(text) === undo.wrote
    ) {
      if (undo.before === null) {
        await fs.rm(filePath, { force: true });
      } else {
        await writeText(filePath, undo.before);
      }
      return;
    }
    let next = removeTomlTablesWithPrefix(text, `[model."${SLOT}/`);
    if (undo?.kind === "toml-tables" && undo.path === filePath) {
      for (const entry of undo.restore) {
        next =
          entry.value === null
            ? removeTomlTableKey(next, entry.header, entry.key)
            : setTomlTableKey(next, entry.header, entry.key, entry.value);
      }
    }
    await writeText(filePath, next);
  },
};

// ---------- Kimi Code ----------

async function kimiDir(environment: ConnectEnvironment): Promise<string> {
  const override = envOverride(environment.env, "KIMI_CODE_HOME");
  if (override !== null && path.isAbsolute(override)) return override;
  const code = homePath(environment, ".kimi-code");
  if (await isDir(code)) return code;
  const share = envOverride(environment.env, "KIMI_SHARE_DIR");
  if (share !== null && path.isAbsolute(share)) return share;
  const legacy = homePath(environment, ".kimi");
  if (await isDir(legacy)) return legacy;
  return code;
}

const kimiDriver: AgentConnectDriver = {
  provider: "kimi",
  external: {
    name: "Kimi Code",
    icon: "kimi",
    detect: async (environment) =>
      (await isOnPath("kimi", environment)) || (await isDir(await kimiDir(environment))),
  },
  configPath: (environment) => path.join(environment.homeDir, ".kimi-code", "config.toml"),
  async read(environment) {
    const filePath = path.join(await kimiDir(environment), "config.toml");
    const text = (await readTextOrNull(filePath)) ?? "";
    const prefixed = stripPrefix(findTomlTopLevel(text, "default_model"), `${SLOT}/`);
    return {
      connected: prefixed !== null,
      model: prefixed,
      baseUrl: stripNullableV1(getTomlTableKey(text, `[providers.${SLOT}]`, "base_url")),
    };
  },
  async connect(environment, model, undo) {
    const filePath = path.join(await kimiDir(environment), "config.toml");
    const before = await readTextOrNull(filePath);
    const chosen = chosenModel(environment, model);
    let next = before ?? "";
    next = setTomlTableKey(next, `[providers.${SLOT}]`, "type", "kimi");
    next = setTomlTableKey(next, `[providers.${SLOT}]`, "base_url", `${environment.baseUrl}/v1`);
    next = setTomlTableKey(next, `[providers.${SLOT}]`, "api_key", environment.apiKey);
    next = appendTomlTables(
      next,
      environment.models.map((entry) =>
        [
          `[models."${SLOT}/${entry.id}"]`,
          `provider = ${tomlString(SLOT)}`,
          `model = ${tomlString(entry.id)}`,
          `max_context_size = ${String(entry.contextWindow ?? 128000)}`,
          ...(labelOf(entry) === entry.id ? [] : [`display_name = ${tomlString(labelOf(entry))}`]),
        ].join("\n"),
      ),
    );
    const priorDefault = findTomlTopLevel(next, "default_model");
    if (chosen !== null) {
      next = setTomlTopLevel(next, "default_model", `${SLOT}/${chosen}`);
    }
    const wrote = next.endsWith("\n") ? next : `${next}\n`;
    await writeText(filePath, wrote);
    const previous = undo?.kind === "toml-tables" && undo.path === filePath ? undo : null;
    return {
      kind: "toml-tables",
      path: filePath,
      before: previous?.before ?? before,
      wrote: contentHash(wrote),
      sections: [
        `[providers.${SLOT}]`,
        ...environment.models.map((entry) => `[models."${SLOT}/${entry.id}"]`),
      ],
      restore: previous?.restore ?? [{ header: "", key: "default_model", value: priorDefault }],
    };
  },
  async disconnect(environment, undo) {
    const filePath = path.join(await kimiDir(environment), "config.toml");
    const text = await readTextOrNull(filePath);
    if (text === null) return;
    if (
      undo?.kind === "toml-tables" &&
      undo.path === filePath &&
      contentHash(text) === undo.wrote
    ) {
      if (undo.before === null) {
        await fs.rm(filePath, { force: true });
      } else {
        await writeText(filePath, undo.before);
      }
      return;
    }
    let next = removeTomlTable(
      removeTomlTablesWithPrefix(text, `[models."${SLOT}/`),
      `[providers.${SLOT}]`,
    );
    if (undo?.kind === "toml-tables" && undo.path === filePath) {
      const prior = undo.restore.find((entry) => entry.key === "default_model");
      next =
        prior?.value == null
          ? removeTomlTopLevel(next, "default_model")
          : setTomlTopLevel(next, "default_model", prior.value);
    }
    await writeText(filePath, next);
  },
};

function findTomlTopLevel(text: string, key: string): string | null {
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) return null;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`).exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

// ---------- Cline ----------

function clineDir(environment: ConnectEnvironment): string {
  return absoluteDir(environment, envOverride(environment.env, "CLINE_DIR"), [".cline"]);
}

function clinePaths(environment: ConnectEnvironment): { providers: string; models: string } {
  const dataOverride = envOverride(environment.env, "CLINE_DATA_DIR");
  const data =
    dataOverride !== null && path.isAbsolute(dataOverride)
      ? dataOverride
      : path.join(clineDir(environment), "data");
  return {
    providers: path.join(data, "settings", "providers.json"),
    models: path.join(data, "settings", "models.json"),
  };
}

const CLINE_SLOT = "openai-compatible";

const clineDriver: AgentConnectDriver = {
  provider: "cline",
  external: {
    name: "Cline",
    icon: "cline",
    detect: async (environment) =>
      (await isOnPath("cline", environment)) || (await isDir(clineDir(environment))),
  },
  configPath: (environment) => clinePaths(environment).providers,
  async read(environment) {
    const paths = clinePaths(environment);
    const providers = await readJsonObject(paths.providers);
    return {
      connected: readJsonString(providers, ["lastUsedProvider"]) === CLINE_SLOT,
      model: readJsonString(providers, ["providers", CLINE_SLOT, "settings", "model"]),
      baseUrl: readJsonString(providers, ["providers", CLINE_SLOT, "settings", "baseUrl"]),
    };
  },
  async connect(environment, model, undo) {
    const paths = clinePaths(environment);
    const chosen = chosenModel(environment, model);
    const providers = await readJsonObject(paths.providers);
    const providerPrior: Record<string, PriorValue> = {};
    capture(providers, providerPrior, `providers.${CLINE_SLOT}`);
    capture(providers, providerPrior, "lastUsedProvider");
    setAtValue(providers, `providers.${CLINE_SLOT}`, {
      settings: {
        provider: CLINE_SLOT,
        apiKey: environment.apiKey,
        model: chosen ?? "",
        baseUrl: `${environment.baseUrl}/v1`,
        headers: { "User-Agent": "cline" },
      },
      updatedAt: new Date().toISOString(),
      tokenSource: "manual",
    });
    setAtValue(providers, "lastUsedProvider", CLINE_SLOT);
    const providerEntry = await writeJsonWithUndo(paths.providers, providers, providerPrior, undo);
    const models = await readJsonObject(paths.models);
    const modelsPrior: Record<string, PriorValue> = {};
    capture(models, modelsPrior, `providers.${CLINE_SLOT}`);
    setAtValue(models, `providers.${CLINE_SLOT}`, {
      models: environment.models.map((entry) => ({ id: entry.id, name: labelOf(entry) })),
    });
    const modelsEntry = await writeJsonWithUndo(paths.models, models, modelsPrior, undo);
    return jsonUndo([providerEntry, modelsEntry]);
  },
  async disconnect(environment, undo) {
    const paths = clinePaths(environment);
    for (const [filePath, fallback] of [
      [paths.providers, [`providers.${CLINE_SLOT}`, "lastUsedProvider"]],
      [paths.models, [`providers.${CLINE_SLOT}`]],
    ] as const) {
      if (!(await exists(filePath))) continue;
      const root = await readJsonObject(filePath);
      const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
      if (prior) {
        restore(root, prior.values);
      } else {
        for (const key of fallback) deleteAt(root, key);
      }
      await writeJsonWithUndo(filePath, root, {}, undo);
    }
  },
};

// ---------- Droid ----------

function droidPath(environment: ConnectEnvironment): string {
  const home = envOverride(environment.env, "FACTORY_HOME_OVERRIDE") ?? environment.homeDir;
  return path.join(home, ".factory", "settings.json");
}

const DROID_PREFIX = `custom:${SLOT}/`;

const droidDriver: AgentConnectDriver = {
  provider: "droid",
  external: {
    name: "Droid",
    icon: "factory",
    detect: async (environment) =>
      (await isOnPath("droid", environment)) || (await isDir(path.dirname(droidPath(environment)))),
  },
  configPath: droidPath,
  async read(environment) {
    const root = await readJsonObject(droidPath(environment));
    const prefixed = stripPrefix(
      readJsonString(root, ["sessionDefaultSettings", "model"]),
      DROID_PREFIX,
    );
    return { connected: prefixed !== null, model: prefixed, baseUrl: null };
  },
  async connect(environment, model, undo) {
    const filePath = droidPath(environment);
    const root = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of ["customModels", "sessionDefaultSettings.model"]) {
      capture(root, captured, key);
    }
    const kept = Array.isArray(root.customModels)
      ? (root.customModels as unknown[]).filter(
          (entry) =>
            !(
              typeof entry === "object" &&
              entry !== null &&
              String((entry as { id?: unknown }).id ?? "").startsWith(DROID_PREFIX)
            ),
        )
      : [];
    const ours = environment.models.map((entry) => ({
      model: entry.id,
      id: `${DROID_PREFIX}${entry.id}`,
      displayName: labelOf(entry),
      baseUrl: `${environment.baseUrl}/v1`,
      apiKey: environment.apiKey,
      provider: "generic-chat-completion-api",
      noImageSupport: true,
    }));
    setAtValue(root, "customModels", [...kept, ...ours]);
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(root, "sessionDefaultSettings.model", `${DROID_PREFIX}${chosen}`);
    }
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(droidPath(environment), undo);
  },
};

// ---------- Cursor Private Inference ----------

const CURSOR_LOCAL_VARS = ["CURSOR_LOCAL_AGENT_BASE_URL", "CURSOR_LOCAL_AGENT_API_KEY"];

/** The apps folders the build installs into; a test sets its own. */
function cursorLocalRoots(environment: ConnectEnvironment): string[] {
  const override = envOverride(environment.env, "NEOLIX_CURSOR_LOCAL_ROOTS");
  if (override !== null) return override.split(path.delimiter).filter((dir) => dir.length > 0);
  return [path.join(environment.homeDir, "Applications"), "/Applications"];
}

async function cursorLocalApp(environment: ConnectEnvironment): Promise<string | null> {
  if ((environment.platform ?? process.platform) !== "darwin") return null;
  for (const root of cursorLocalRoots(environment)) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const app = path.join(root, entry);
      try {
        const product = JSON.parse(
          await fs.readFile(path.join(app, "Contents", "Resources", "app", "product.json"), "utf8"),
        ) as { nameShort?: unknown };
        if (product.nameShort === "Cursor Private Inference") return app;
      } catch {
        // Not that app, or not readable.
      }
    }
  }
  return null;
}

function commandRunner(environment: ConnectEnvironment) {
  return environment.run ?? runProcess;
}

async function readUserEnv(environment: ConnectEnvironment, name: string): Promise<string | null> {
  try {
    const value = await commandRunner(environment)("launchctl", ["getenv", name]);
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

const cursorLocalDriver: AgentConnectDriver = {
  provider: "cursor-local",
  external: {
    name: "Cursor Private Inference",
    icon: "cursor",
    detect: async (environment) => (await cursorLocalApp(environment)) !== null,
    launch: async (environment, _model) => {
      const app = await cursorLocalApp(environment);
      if (app === null) return null;
      return `CURSOR_LOCAL_AGENT_BASE_URL=${shellQuote(`${environment.baseUrl}/v1`)} CURSOR_LOCAL_AGENT_API_KEY=${shellQuote(environment.apiKey)} ${shellQuote(app)}`;
    },
  },
  configPath: () => "launchctl",
  async read(environment) {
    const values = await Promise.all(
      CURSOR_LOCAL_VARS.map((name) => readUserEnv(environment, name)),
    );
    return {
      connected: values[0] === `${environment.baseUrl}/v1` && values[1] === environment.apiKey,
      model: null,
      baseUrl: values[0]?.replace(/\/v1\/?$/, "") ?? null,
    };
  },
  async connect(environment, _model, _undo) {
    const runner = commandRunner(environment);
    const previous: Record<string, string | null> = {};
    for (const name of CURSOR_LOCAL_VARS) {
      previous[name] = await readUserEnv(environment, name);
    }
    const values: Record<string, string> = {
      CURSOR_LOCAL_AGENT_BASE_URL: `${environment.baseUrl}/v1`,
      CURSOR_LOCAL_AGENT_API_KEY: environment.apiKey,
    };
    for (const [name, value] of Object.entries(values)) {
      await runner("launchctl", ["setenv", name, value]);
    }
    return { kind: "user-env", values: previous };
  },
  async disconnect(environment, undo) {
    const prior =
      undo?.kind === "user-env"
        ? undo.values
        : undoParts(undo).find(
            (part): part is Extract<AgentConnectUndo, { kind: "user-env" }> =>
              part.kind === "user-env",
          )?.values;
    if (prior === undefined) return;
    const runner = commandRunner(environment);
    for (const name of CURSOR_LOCAL_VARS) {
      const value = prior[name];
      if (value === null || value === undefined) {
        await runner("launchctl", ["unsetenv", name]);
      } else {
        await runner("launchctl", ["setenv", name, value]);
      }
    }
  },
};

// ---------- Goose ----------

function gooseDir(environment: ConnectEnvironment): string {
  return path.join(configHome(environment), "goose");
}

function gooseConfigPath(environment: ConnectEnvironment): string {
  return path.join(gooseDir(environment), "config.yaml");
}

function gooseProviderPath(environment: ConnectEnvironment): string {
  return path.join(gooseDir(environment), "custom_providers", `${SLOT}.json`);
}

const gooseDriver: AgentConnectDriver = {
  provider: "goose",
  external: {
    name: "Goose",
    icon: "goose",
    detect: async (environment) =>
      (await isDir(gooseDir(environment))) || (await isOnPath("goose", environment)),
  },
  configPath: gooseConfigPath,
  async read(environment) {
    const document = await readYamlDocument(gooseConfigPath(environment));
    const provider =
      yamlString(document, ["active_provider"]) ?? yamlString(document, ["GOOSE_PROVIDER"]);
    const model =
      (provider !== null ? yamlString(document, ["providers", provider, "model"]) : null) ??
      yamlString(document, ["GOOSE_MODEL"]);
    const providerFile = await readJsonObject(gooseProviderPath(environment));
    return {
      connected: provider === SLOT && model !== null,
      model,
      baseUrl: typeof providerFile.base_url === "string" ? providerFile.base_url : null,
    };
  },
  async connect(environment, model, _undo) {
    const configPath = gooseConfigPath(environment);
    const providerPath = gooseProviderPath(environment);
    const chosen = chosenModel(environment, model);
    const providerJson = `${JSON.stringify(
      {
        name: SLOT,
        engine: "openai",
        display_name: "Neox",
        api_key_env: "",
        base_url: `${environment.baseUrl}/v1`,
        headers: { Authorization: `Bearer ${environment.apiKey}` },
        requires_auth: false,
        skip_canonical_filtering: true,
        dynamic_models: false,
        models: environment.models.map((entry) => ({ name: entry.id })),
      },
      null,
      2,
    )}\n`;
    const beforeProvider = await readTextOrNull(providerPath);
    await writeText(providerPath, providerJson);
    const document = await readYamlDocument(configPath);
    const captured: Record<string, PriorValue> = {};
    for (const yamlPath of [
      "active_provider",
      "GOOSE_PROVIDER",
      "GOOSE_MODEL",
      `providers.${SLOT}`,
    ]) {
      const parts = yamlPath.split(".");
      captured[yamlPath] = document.hasIn(parts)
        ? { present: true, value: document.getIn(parts) }
        : { present: false };
    }
    const newLayout = document.hasIn(["providers"]) || document.hasIn(["active_provider"]);
    if (newLayout) {
      document.setIn(["active_provider"], SLOT);
      document.setIn(["providers", SLOT, "enabled"], true);
      if (chosen !== null) document.setIn(["providers", SLOT, "model"], chosen);
      document.setIn(["providers", SLOT, "configured"], true);
      document.deleteIn(["GOOSE_PROVIDER"]);
      document.deleteIn(["GOOSE_MODEL"]);
    } else {
      document.setIn(["GOOSE_PROVIDER"], SLOT);
      if (chosen !== null) document.setIn(["GOOSE_MODEL"], chosen);
    }
    await writeYamlDocument(configPath, document);
    return {
      kind: "multi",
      parts: [
        { kind: "yaml", path: configPath, values: captured },
        textUndo(providerPath, beforeProvider, providerJson),
      ],
    };
  },
  async disconnect(environment, undo) {
    const parts = undoParts(undo);
    const configPath = gooseConfigPath(environment);
    const yamlUndo = parts.find((part) => part.kind === "yaml");
    if (yamlUndo?.kind === "yaml" && (await exists(configPath))) {
      const document = await readYamlDocument(configPath);
      for (const [yamlPath, prior] of Object.entries(yamlUndo.values)) {
        const yamlParts = yamlPath.split(".");
        if (prior.present) {
          document.setIn(yamlParts, prior.value);
        } else {
          document.deleteIn(yamlParts);
        }
      }
      await writeYamlDocument(configPath, document);
    }
    const providerUndo = parts.find((part) => part.kind === "text");
    if (providerUndo?.kind === "text") {
      if (providerUndo.before === null) {
        await fs.rm(gooseProviderPath(environment), { force: true });
      } else {
        await writeText(gooseProviderPath(environment), providerUndo.before);
      }
    }
  },
};

// ---------- Zed ----------

function zedDir(environment: ConnectEnvironment): string {
  const configured = envOverride(environment.env, "MYNA_ZED_CONFIG_DIR");
  if (configured !== null && path.isAbsolute(configured)) return configured;
  if (process.platform === "darwin") {
    return path.join(environment.homeDir, ".config", "zed");
  }
  if (process.platform === "win32") {
    const appData = environment.env.APPDATA?.trim();
    return path.join(appData && appData.length > 0 ? appData : environment.homeDir, "Zed");
  }
  return path.join(configHome(environment), "zed");
}

function zedPath(environment: ConnectEnvironment): string {
  return path.join(zedDir(environment), "settings.json");
}

const ZED_PROVIDER_PATH = ["language_models", "openai_compatible", SLOT];

const zedDriver: AgentConnectDriver = {
  provider: "zed",
  external: {
    name: "Zed",
    icon: "zed",
    detect: async (environment) =>
      (await isOnPath("zed", environment)) || (await isDir(zedDir(environment))),
  },
  configPath: zedPath,
  async read(environment) {
    const root = await readJsonObject(zedPath(environment));
    const url = readJsonString(root, [...ZED_PROVIDER_PATH, "api_url"]);
    return {
      connected:
        url === `${environment.baseUrl}/v1` &&
        readJsonString(root, ["agent", "default_model", "provider"]) === SLOT,
      model: readJsonString(root, ["agent", "default_model", "model"]),
      baseUrl: url,
    };
  },
  async connect(environment, model, undo) {
    const filePath = zedPath(environment);
    const url = `${environment.baseUrl}/v1`;
    // Zed keeps this key in the OS credential store, not in settings.json.
    if (environment.writeCredential) {
      await environment.writeCredential(url, environment.apiKey);
    }
    const root = await readJsonObject(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(root, captured, ZED_PROVIDER_PATH.join("."));
    capture(root, captured, "agent.default_model");
    setAtValue(root, ZED_PROVIDER_PATH.join("."), {
      api_url: url,
      available_models: environment.models.map((entry) => ({
        name: entry.id,
        display_name: labelOf(entry),
        max_tokens: entry.maxOutputTokens ?? entry.contextWindow ?? 128000,
        capabilities: {
          tools: true,
          images: entry.images === true,
          chat_completions: true,
        },
      })),
    });
    const chosen = chosenModel(environment, model);
    if (chosen !== null) {
      setAtValue(root, "agent.default_model", { provider: SLOT, model: chosen });
    }
    const entry = await writeJsonWithUndo(filePath, root, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    await restoreJsonFile(zedPath(environment), undo);
  },
};

export const EXTERNAL_AGENT_DRIVERS: AgentConnectDriver[] = [
  geminiDriver,
  agyDriver,
  cursorDriver,
  cursorLocalDriver,
  qoderDriver,
  grokDriver,
  kimiDriver,
  clineDriver,
  droidDriver,
  gooseDriver,
  zedDriver,
  ...BATCH2_AGENT_DRIVERS,
  ...BATCH3_AGENT_DRIVERS,
  ...BATCH4_AGENT_DRIVERS,
  ...BATCH5_AGENT_DRIVERS,
  ...BATCH6_AGENT_DRIVERS,
  ...BATCH7_AGENT_DRIVERS,
  ...BATCH8_AGENT_DRIVERS,
  ...BATCH9_AGENT_DRIVERS,
  ...BATCH10_AGENT_DRIVERS,
  ...BATCH11_AGENT_DRIVERS,
  ...BATCH12_AGENT_DRIVERS,
  ...BATCH13_AGENT_DRIVERS,
  ...BATCH14_AGENT_DRIVERS,
  ...BATCH15_AGENT_DRIVERS,
  ...BATCH16_AGENT_DRIVERS,
  ...BATCH17_AGENT_DRIVERS,
  ...BATCH18_AGENT_DRIVERS,
  ...BATCH19_AGENT_DRIVERS,
];
