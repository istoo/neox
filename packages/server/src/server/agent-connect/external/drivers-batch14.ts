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
import { envOverride, homePath, isDir } from "./helpers.js";

const SLOT = "neolix";

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
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

// ---------- Antigravity ----------

function antigravityPath(environment: ConnectEnvironment): string {
  return homePath(environment, ".antigravity", "settings.json");
}

const antigravityDriver: AgentConnectDriver = {
  provider: "antigravity",
  external: {
    name: "Antigravity",
    icon: "antigravity-color",
    // myna's app, not its IDE or CLI: ~/.antigravity is shared by all three,
    // so only the settings file its backend writes says the app is here.
    detect: async (environment) => exists(antigravityPath(environment)),
  },
  configPath: antigravityPath,
  async read(environment) {
    const settings = await readJsonIfThere(antigravityPath(environment));
    const gateway = isRecord(settings.gateway) ? settings.gateway : {};
    const wired = gateway.enabled === true && gateway.apiKey === environment.apiKey;
    return {
      connected: wired,
      model: wired ? readJsonString(settings, ["models", "defaultModelId"]) : null,
      baseUrl: wired && typeof gateway.url === "string" ? stripV1(gateway.url) : null,
    };
  },
  async connect(environment, model, undo) {
    const filePath = antigravityPath(environment);
    const settings = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of ["gateway", "models.defaultModelId", "models.list"]) {
      capture(settings, captured, key);
    }
    // A list of the reader's would hide Neolix's models from the app's
    // picker; it is stashed with their gateway (myna's antigravity field).
    if (isRecord(settings.models)) delete settings.models.list;
    settings.gateway = {
      ...(isRecord(settings.gateway) ? settings.gateway : {}),
      enabled: true,
      url: environment.baseUrl,
      apiKey: environment.apiKey,
      wireProtocol: "openai",
    };
    const chosen = chosenModel(environment, model);
    if (chosen !== null) setAtValue(settings, "models.defaultModelId", chosen);
    const entry = await writeJsonWithUndo(filePath, settings, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = antigravityPath(environment);
    if (!(await exists(filePath))) return;
    const settings = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(settings, prior.values);
    await writeJsonWithUndo(filePath, settings, {}, undo);
  },
};

// ---------- Lody: its import link only ----------

function lodyLink(environment: ConnectEnvironment): string | null {
  const url = new URL(environment.baseUrl);
  // Lody takes loopback HTTP only, never a LAN key or a vendor credential.
  if (url.protocol !== "http:") return null;
  const host = url.hostname;
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) return null;
  const shownHost = host === "::1" ? "[::1]" : host;
  const port = url.port;
  const base = `http://${shownHost}${port === "" || port === "80" ? "" : `:${port}`}`;
  const v1 = `${base}/v1`;
  const payload = {
    kind: "custom",
    id: SLOT,
    name: "Neox",
    auth: { method: "apiKey", apiKey: environment.apiKey },
    endpoints: [
      {
        protocol: "anthropic-messages",
        baseUrl: base,
        targets: ["claude-code"],
        modelsUrl: `${v1}/models`,
      },
      {
        protocol: "openai-responses",
        baseUrl: v1,
        targets: ["codex"],
        modelsUrl: `${v1}/models`,
      },
      {
        protocol: "openai-chat",
        baseUrl: v1,
        targets: ["pi", "dsh", "kimi-code", "grok", "bub"],
        modelsUrl: `${v1}/models`,
      },
    ],
  };
  return `lody://provider/import?v=1&data=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

const LODY_MARKS = ["workspace-catalog.json", "loro-repo", "agent-binaries", "code-collab-v2"];

async function lodyHome(environment: ConnectEnvironment): Promise<string | null> {
  for (const name of [".lody", ".lody-oss"]) {
    const dir = homePath(environment, name);
    for (const mark of LODY_MARKS) {
      if (await exists(path.join(dir, mark))) return dir;
    }
  }
  return null;
}

function lodyConfigDir(environment: ConnectEnvironment): string {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  if (environment.platform === "win32") {
    return envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming");
  }
  const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
  return xdg !== null && path.isAbsolute(xdg) ? xdg : path.join(home, ".config");
}

const lodyDriver: AgentConnectDriver = {
  provider: "lody",
  external: {
    name: "Lody",
    icon: "lody",
    noConnect: true,
    detect: async (environment) => {
      if ((await lodyHome(environment)) !== null) return true;
      for (const name of ["Lody", "Lody OSS", "Lody Nightly"]) {
        if (await isDir(path.join(lodyConfigDir(environment), name))) return true;
      }
      return false;
    },
    importLink: lodyLink,
  },
  configPath: (environment) => homePath(environment, ".lody"),
  async read() {
    return { connected: false, model: null, baseUrl: null };
  },
  async connect() {
    throw new Error("Lody takes a provider only through its own import link.");
  },
  async disconnect() {},
};

export const BATCH14_AGENT_DRIVERS: AgentConnectDriver[] = [antigravityDriver, lodyDriver];
