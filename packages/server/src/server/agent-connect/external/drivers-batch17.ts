import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentConnectModel } from "@neolix/protocol/agent-connect";
import { readTextOrNull, tomlString } from "../config-files.js";
import {
  type AgentConnectDriver,
  type ConnectEnvironment,
  PROVIDER_ID,
  stripV1,
} from "../drivers.js";
import { readSqliteRows } from "../../llm-gateway/import-sqlite.js";
import {
  appendTomlTables,
  envOverride,
  getTomlTableKey,
  homePath,
  isDir,
  removeTomlTable,
  removeTomlTablesWithPrefix,
  removeTomlTopLevel,
  setTomlTopLevel,
  textUndo,
  writeText,
} from "./helpers.js";

const SLOT = PROVIDER_ID;

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- AtomCode ----------

/** AtomCode is told a window for every model, even one Neolix does not know. */
const ATOMCODE_CONTEXT = 128000;

function atomcodeDir(environment: ConnectEnvironment): string {
  const set = envOverride(environment.env, "ATOMCODE_HOME");
  return set !== null && path.isAbsolute(set)
    ? path.normalize(set)
    : homePath(environment, ".atomcode");
}

function atomcodePath(environment: ConnectEnvironment): string {
  return path.join(atomcodeDir(environment), "config.toml");
}

function atomcodeTop(text: string, key: string): string | null {
  let inTable = false;
  for (const line of text.split("\n")) {
    if (/^\s*\[[^[\]]+\]\s*$/.test(line)) inTable = true;
    if (inTable) continue;
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (match?.[1] !== undefined) return unquote(match[1]);
  }
  return null;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'")) return text.slice(1, -1);
  return text;
}

function atomcodeCurrent(text: string): string | null {
  const model = atomcodeTop(text, "default_model");
  if (model !== null && model.length > 0) return model;
  const provider = atomcodeTop(text, "default_provider");
  return provider !== null && provider.length > 0 ? provider : null;
}

const ATOMCODE_ACCOUNT_HEADERS = [
  `[provider_accounts.${SLOT}]`,
  `[provider_accounts."${SLOT}"]`,
  `[provider_accounts.'${SLOT}']`,
];

function atomcodeAccountValues(text: string): Record<string, string> {
  for (const header of ATOMCODE_ACCOUNT_HEADERS) {
    const base = getTomlTableKey(text, header, "base_url");
    if (base !== null) {
      return { base_url: base };
    }
  }
  return {};
}

/** A model table's reasoning_effort Neolix wrote before, kept when the model stays. */
function atomcodeEfforts(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let header: string | null = null;
  for (const line of text.split("\n")) {
    const table = /^\s*\[(.+)\]\s*$/.exec(line);
    if (table?.[1] !== undefined) {
      header = table[1].trim();
      continue;
    }
    if (header === null) continue;
    const key = unquote(header.replace(/^models\./, ""));
    if (!header.startsWith("models.") || !key.startsWith(`${SLOT}/`)) continue;
    const match = /^\s*reasoning_effort\s*=\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) out[key] = unquote(match[1]);
  }
  return out;
}

function atomcodeModelTable(entry: AgentConnectModel, effort: string | undefined): string {
  const key = `${SLOT}/${entry.id}`;
  const lines = [
    `[models.${JSON.stringify(key)}]`,
    `account = ${tomlString(SLOT)}`,
    `model = ${tomlString(entry.id)}`,
  ];
  // AtomCode compacts as it nears the window it is told.
  const window = entry.contextWindow ?? ATOMCODE_CONTEXT;
  lines.push(`context_window = ${window}`);
  if (entry.maxOutputTokens !== undefined) {
    lines.push(
      `max_tokens = ${entry.contextWindow === undefined ? Math.min(entry.maxOutputTokens, ATOMCODE_CONTEXT) : entry.maxOutputTokens}`,
    );
  }
  lines.push(`supports_vision = ${entry.images === true ? "true" : "false"}`);
  if (effort !== undefined) lines.push(`reasoning_effort = ${tomlString(effort)}`);
  return lines.join("\n");
}

const atomcodeDriver: AgentConnectDriver = {
  provider: "atomcode",
  external: {
    name: "AtomCode",
    icon: "atomcode",
    detect: async (environment) => isDir(atomcodeDir(environment)),
  },
  configPath: atomcodePath,
  async read(environment) {
    const text = (await readTextOrNull(atomcodePath(environment))) ?? "";
    const current = atomcodeCurrent(text);
    if (current === null || !current.startsWith(`${SLOT}/`)) {
      return { connected: false, model: null, baseUrl: null };
    }
    const account = atomcodeAccountValues(text);
    const base = account.base_url ?? null;
    return {
      connected: true,
      model: current.slice(SLOT.length + 1),
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = atomcodePath(environment);
    const before = await readTextOrNull(filePath);
    let text = before ?? "";
    const chosen = chosenModel(environment, model);
    if (chosen === null) throw new Error("AtomCode needs a model from the gateway.");
    const efforts = atomcodeEfforts(text);
    text = removeTomlTablesWithPrefix(text, `[models.${SLOT}/`);
    text = removeTomlTablesWithPrefix(text, `[models."${SLOT}/`);
    text = removeTomlTablesWithPrefix(text, `[models.'${SLOT}/`);
    for (const header of ATOMCODE_ACCOUNT_HEADERS) text = removeTomlTable(text, header);
    const account = [
      `[provider_accounts.${JSON.stringify(SLOT)}]`,
      `provider = "openai-compatible"`,
      `base_url = ${tomlString(`${environment.baseUrl}/v1`)}`,
      `api_key = ${tomlString(environment.apiKey)}`,
    ].join("\n");
    const models = environment.models.map((entry) =>
      atomcodeModelTable(entry, efforts[`${SLOT}/${entry.id}`]),
    );
    text = appendTomlTables(text, [account, ...models]);
    const key = `${SLOT}/${chosen}`;
    text = setTomlTopLevel(text, "default_provider", key);
    text = setTomlTopLevel(text, "default_model", key);
    await writeText(filePath, text);
    return textUndo(filePath, before, text);
  },
  async disconnect(environment, undo) {
    const filePath = atomcodePath(environment);
    if (undo?.kind === "text" && undo.path === filePath && undo.before !== null) {
      await writeText(filePath, undo.before);
      return;
    }
    const text = (await readTextOrNull(filePath)) ?? "";
    let next = removeTomlTablesWithPrefix(text, `models.${SLOT}/`);
    next = removeTomlTablesWithPrefix(next, `[models."${SLOT}/`);
    next = removeTomlTablesWithPrefix(next, `[models.'${SLOT}/`);
    for (const header of ATOMCODE_ACCOUNT_HEADERS) next = removeTomlTable(next, header);
    const current = atomcodeCurrent(next);
    if (current !== null && current.startsWith(`${SLOT}/`)) {
      next = removeTomlTopLevel(removeTomlTopLevel(next, "default_model"), "default_provider");
    }
    await writeText(filePath, next);
  },
};

// ---------- NewMax ----------

const NEWMAX_ID = `${SLOT}-gateway`;
const NEWMAX_MAX_MODELS = 20;

function newMaxDir(environment: ConnectEnvironment): string {
  const set = envOverride(environment.env, "NEWMAX_USER_DATA_DIR");
  return set !== null && path.isAbsolute(set) ? set : homePath(environment, ".newmax");
}

function newMaxPath(environment: ConnectEnvironment): string {
  return path.join(newMaxDir(environment), "newmax.db");
}

async function newMaxAppInstalled(environment: ConnectEnvironment): Promise<boolean> {
  if (environment.platform !== "darwin") return false;
  for (const folder of [path.join(environment.homeDir, "Applications"), "/Applications"]) {
    if (await isDir(path.join(folder, "NewMax.app"))) return true;
  }
  return false;
}

/** NewMax holds its settings in memory while it runs (myna's newMaxRunning). */
async function newMaxRunning(environment: ConnectEnvironment): Promise<boolean> {
  if (environment.platform === "win32" || environment.run === undefined) return false;
  try {
    const out = await environment.run("ps", ["-axo", "comm="]);
    return out.split("\n").some((line) => /^(?:.*\/)?(?:NewMax|newmax)(?: |$)/.test(line.trim()));
  } catch {
    return false;
  }
}

interface NewMaxEntry {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiKeys: string[];
  apiKeyRotationEnabled: boolean;
  apiKeyField: string;
  apiFormat: string;
  models: string[];
  enabledModels: string[];
  enabled: boolean;
  canDelete: boolean;
  modelContextWindows?: Record<string, number>;
}

function newMaxEntry(environment: ConnectEnvironment): NewMaxEntry {
  const models: string[] = [];
  const windows: Record<string, number> = {};
  for (const entry of environment.models) {
    if (entry.id.length === 0 || models.includes(entry.id)) continue;
    models.push(entry.id);
    if (entry.contextWindow !== undefined) windows[entry.id] = entry.contextWindow;
    if (models.length === NEWMAX_MAX_MODELS) break;
  }
  return {
    id: NEWMAX_ID,
    name: "Neox",
    baseUrl: environment.baseUrl,
    apiKey: environment.apiKey,
    apiKeys: [environment.apiKey],
    apiKeyRotationEnabled: false,
    apiKeyField: "ANTHROPIC_AUTH_TOKEN",
    apiFormat: "anthropic",
    models,
    enabledModels: models,
    enabled: true,
    canDelete: true,
    ...(Object.keys(windows).length === 0 ? {} : { modelContextWindows: windows }),
  };
}

interface NewMaxRow {
  app: string | null;
  had: boolean;
}

function readNewMaxRow(environment: ConnectEnvironment): NewMaxRow {
  const dbPath = newMaxPath(environment);
  try {
    const rows = readSqliteRows(dbPath, "SELECT value FROM settings WHERE key = 'app'");
    const value = rows[0]?.value;
    return typeof value === "string" ? { app: value, had: true } : { app: null, had: false };
  } catch (cause) {
    throw new Error(
      "NewMax has not made its settings yet: open NewMax once, quit it, then try again.",
      { cause },
    );
  }
}

/** Writes the row in one transaction that waits on NewMax's own (myna's newMaxEdit). */
function writeNewMaxRow(environment: ConnectEnvironment, value: string | null): void {
  const dbPath = newMaxPath(environment);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (value === null) {
        db.prepare("DELETE FROM settings WHERE key = 'app'").run();
      } else {
        db.prepare(
          "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ).run(value);
      }
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
  } finally {
    db.close();
  }
}

function newMaxProviders(app: unknown): Record<string, unknown>[] {
  if (!isRecord(app)) {
    throw new Error("NewMax's settings are not JSON Neox can read, so they were left alone.");
  }
  const providers = app.providers;
  if (providers === undefined || providers === null) return [];
  if (!Array.isArray(providers)) {
    throw new Error("NewMax's providers are not a list, so they were left alone.");
  }
  return providers.filter(isRecord);
}

const NEWMAX_OURS = new Set([
  "id",
  "baseUrl",
  "apiKey",
  "apiKeys",
  "apiKeyRotationEnabled",
  "apiKeyField",
  "apiFormat",
  "models",
  "enabledModels",
  "modelContextWindows",
]);

/** Neolix's entry over the one NewMax keeps: the reader's name, on/off and added fields stay. */
function newMaxEntryMerged(
  want: NewMaxEntry,
  have: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...have };
  for (const [key, value] of Object.entries(want)) {
    if (NEWMAX_OURS.has(key)) out[key] = value;
  }
  if (typeof have.name === "string" && have.name.trim().length > 0) out.name = have.name;
  if (typeof have.enabled === "boolean") out.enabled = have.enabled;
  if (typeof have.canDelete === "boolean") out.canDelete = have.canDelete;
  return out;
}

function newMaxOrder(app: Record<string, unknown>): string[] {
  const order = app.providerOrder;
  if (order === undefined || order === null) return [];
  if (!Array.isArray(order) || order.some((entry) => typeof entry !== "string")) {
    throw new Error("NewMax's providerOrder is not a list of names, so it was left alone.");
  }
  return order as string[];
}

const newMaxDriver: AgentConnectDriver = {
  provider: "newmax",
  external: {
    name: "NewMax",
    icon: "generic",
    detect: async (environment) =>
      isDir(newMaxDir(environment)) || (await newMaxAppInstalled(environment)),
  },
  configPath: newMaxPath,
  async read(environment) {
    let row: NewMaxRow;
    try {
      row = readNewMaxRow(environment);
    } catch {
      return { connected: false, model: null, baseUrl: null };
    }
    if (!row.had || row.app === null) return { connected: false, model: null, baseUrl: null };
    let app: unknown;
    try {
      app = JSON.parse(row.app);
    } catch {
      return { connected: false, model: null, baseUrl: null };
    }
    if (!isRecord(app)) return { connected: false, model: null, baseUrl: null };
    const found = newMaxProviders(app).find((entry) => entry.id === NEWMAX_ID);
    if (found === undefined) return { connected: false, model: null, baseUrl: null };
    return {
      connected: true,
      model: null,
      baseUrl: typeof found.baseUrl === "string" ? stripV1(found.baseUrl) : null,
    };
  },
  async connect(environment, _model, _undo) {
    if (await newMaxRunning(environment)) {
      throw new Error(
        "NewMax writes its settings back over what Neox writes now: quit NewMax, then try again.",
      );
    }
    const row = readNewMaxRow(environment);
    const app = row.had && row.app !== null ? (JSON.parse(row.app) as unknown) : {};
    if (!isRecord(app)) {
      throw new Error("NewMax's settings are not JSON Neox can read, so they were left alone.");
    }
    const want = newMaxEntry(environment);
    const providers = newMaxProviders(app);
    const index = providers.findIndex((entry) => entry.id === NEWMAX_ID);
    if (index >= 0) {
      providers[index] = newMaxEntryMerged(want, providers[index] as Record<string, unknown>);
    } else {
      providers.push({ ...want });
    }
    app.providers = providers;
    const order = newMaxOrder(app);
    if (!order.includes(NEWMAX_ID)) {
      app.providerOrder = order.length === 0 ? ["default", NEWMAX_ID] : [...order, NEWMAX_ID];
    }
    const text = JSON.stringify(app);
    writeNewMaxRow(environment, text);
    return textUndo(newMaxPath(environment), row.app, text);
  },
  async disconnect(environment, undo) {
    if (await newMaxRunning(environment)) {
      throw new Error(
        "NewMax writes its settings back over what Neox writes now: quit NewMax, then try again.",
      );
    }
    const row = readNewMaxRow(environment);
    if (!row.had || row.app === null) return;
    if (undo?.kind === "text" && undo.path === newMaxPath(environment)) {
      writeNewMaxRow(environment, undo.before);
      return;
    }
    let app: unknown;
    try {
      app = JSON.parse(row.app);
    } catch {
      return;
    }
    if (!isRecord(app)) return;
    const providers = newMaxProviders(app).filter((entry) => entry.id !== NEWMAX_ID);
    app.providers = providers;
    const order = newMaxOrder(app).filter((id) => id !== NEWMAX_ID);
    if (Array.isArray(app.providerOrder)) app.providerOrder = order;
    if (app.providerId === NEWMAX_ID) {
      app.providerId = "default";
      app.model = "default";
    }
    // The row Neolix made: its empty list and NewMax's default order.
    const onlyOurs =
      Object.keys(app).length === 2 &&
      providers.length === 0 &&
      JSON.stringify(app.providerOrder) === '["default"]';
    writeNewMaxRow(environment, onlyOurs ? null : JSON.stringify(app));
  },
};

export const BATCH17_AGENT_DRIVERS: AgentConnectDriver[] = [atomcodeDriver, newMaxDriver];
