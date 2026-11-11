import { promises as fs } from "node:fs";
import path from "node:path";
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
import { envOverride, homePath, isDir, readYamlDocument, writeYamlDocument } from "./helpers.js";

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

type YamlUndo = Extract<AgentConnectUndo, { kind: "yaml" }>;

function yamlUndo(filePath: string, values: Record<string, PriorValue>): AgentConnectUndo {
  return { kind: "yaml", path: filePath, values };
}

function yamlParts(undo: AgentConnectUndo | undefined, filePath?: string): YamlUndo[] {
  if (undo === undefined) return [];
  const all = undo.kind === "multi" ? undo.parts.flatMap((part) => yamlParts(part)) : [undo];
  return all.filter(
    (part): part is YamlUndo =>
      part.kind === "yaml" && (filePath === undefined || part.path === filePath),
  );
}

// ---------- fx ----------

const FX_MAX_MODELS = 256;

function fxPath(environment: ConnectEnvironment): string {
  return homePath(environment, ".fx", "settings.json");
}

function fxProvider(environment: ConnectEnvironment): Record<string, unknown> {
  const models = environment.models.slice(0, FX_MAX_MODELS);
  return {
    protocol: "openai-chat-completions",
    base_url: `${environment.baseUrl}/v1`,
    auth: { type: "none" },
    tool_choice_mode: "send",
    model_metadata: Object.fromEntries(
      models.map((model) => {
        const context = model.contextWindow;
        const output = model.maxOutputTokens;
        return [
          model.id,
          {
            supports_tool_use: true,
            supports_vision: model.images === true,
            // Only what the catalog says; a model without a window keeps
            // fx's own default, and fx refuses an output not below it.
            ...(context === undefined ? {} : { context_window: context }),
            ...(output === undefined || (context !== undefined && output >= context)
              ? {}
              : { max_output_tokens: output }),
          },
        ];
      }),
    ),
  };
}

const fxDriver: AgentConnectDriver = {
  provider: "fx",
  external: {
    name: "fx",
    icon: "fx",
    detect: async (environment) => isDir(homePath(environment, ".fx")),
  },
  configPath: fxPath,
  async read(environment) {
    const settings = await readJsonIfThere(fxPath(environment));
    const models = isRecord(settings.models) ? settings.models : {};
    const provider = isRecord(settings.providers) ? settings.providers[SLOT] : undefined;
    const model = typeof models[SLOT] === "string" ? models[SLOT] : null;
    const base =
      isRecord(provider) && typeof provider.base_url === "string" ? provider.base_url : null;
    return {
      connected: isRecord(provider),
      model: isRecord(provider) ? model : null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, undo) {
    const filePath = fxPath(environment);
    const settings = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    for (const key of [`providers.${SLOT}`, "provider", `models.${SLOT}`]) {
      capture(settings, captured, key);
    }
    setAtValue(settings, `providers.${SLOT}`, fxProvider(environment));
    settings.provider = SLOT;
    const chosen = chosenModel(environment, model);
    if (chosen !== null) setAtValue(settings, `models.${SLOT}`, chosen);
    const entry = await writeJsonWithUndo(filePath, settings, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = fxPath(environment);
    if (!(await exists(filePath))) return;
    const settings = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(settings, prior.values);
    await writeJsonWithUndo(filePath, settings, {}, undo);
  },
};

// ---------- Mister Morph ----------

const MORPH_KEYS = [
  "inference_provider",
  "endpoint",
  "api_key",
  "model",
  "context_window_tokens",
  "headers",
] as const;

function morphPath(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "MISTER_MORPH_CONFIG");
  if (override !== null && path.isAbsolute(override)) return override;
  return homePath(environment, ".morph", "config.yaml");
}

function morphPrior(
  document: Awaited<ReturnType<typeof readYamlDocument>>,
): Record<string, PriorValue> {
  const values: Record<string, PriorValue> = {};
  for (const key of MORPH_KEYS) {
    const present = document.hasIn(["llm", key]);
    values[key] = present
      ? { present: true, value: document.getIn(["llm", key]) }
      : { present: false };
  }
  return values;
}

const morphDriver: AgentConnectDriver = {
  provider: "morph",
  external: {
    name: "Mister Morph",
    icon: "morph",
    detect: async (environment) =>
      (await exists(morphPath(environment))) || isDir(homePath(environment, ".morph")),
  },
  configPath: morphPath,
  async read(environment) {
    const filePath = morphPath(environment);
    if (!(await exists(filePath))) return { connected: false, model: null, baseUrl: null };
    const document = await readYamlDocument(filePath);
    const apiKey = document.getIn(["llm", "api_key"]);
    const endpoint = document.getIn(["llm", "endpoint"]);
    const model = document.getIn(["llm", "model"]);
    const ours = apiKey === environment.apiKey;
    return {
      connected: ours,
      model: ours && typeof model === "string" ? model : null,
      baseUrl: typeof endpoint === "string" && endpoint.length > 0 ? stripV1(endpoint) : null,
    };
  },
  async connect(environment, model, undo) {
    const filePath = morphPath(environment);
    const document = await readYamlDocument(filePath);
    // An earlier connect's record stands on a reconnect: it has what the
    // reader had before Neolix's first write.
    const values = yamlParts(undo, filePath)[0]?.values ?? morphPrior(document);
    const headers = document.getIn(["llm", "headers"]);
    const chosen = chosenModel(environment, model) ?? environment.models[0]?.id ?? "";
    document.setIn(["llm", "inference_provider"], "openai_response_compatible");
    document.setIn(["llm", "endpoint"], `${environment.baseUrl}/v1`);
    document.setIn(["llm", "api_key"], environment.apiKey);
    document.setIn(["llm", "model"], chosen);
    const picked = environment.models.find((entry) => entry.id === chosen);
    document.setIn(["llm", "context_window_tokens"], picked?.contextWindow ?? 128000);
    document.setIn(["llm", "headers"], {
      ...(isRecord(headers) ? headers : {}),
      "User-Agent": "mistermorph",
    });
    await writeYamlDocument(filePath, document);
    return yamlUndo(filePath, values);
  },
  async disconnect(environment, undo) {
    const filePath = morphPath(environment);
    const part = yamlParts(undo, filePath)[0];
    if (part === undefined || !(await exists(filePath))) return;
    const document = await readYamlDocument(filePath);
    for (const key of MORPH_KEYS) {
      const prior = part.values[key];
      if (isRecord(prior) && prior.present === true) document.setIn(["llm", key], prior.value);
      else document.deleteIn(["llm", key]);
    }
    const llm = document.getIn(["llm"]);
    if (isRecord(llm) && Object.keys(llm).length === 0) document.deleteIn(["llm"]);
    await writeYamlDocument(filePath, document);
  },
};

// ---------- AionUi and Cindy: detection only ----------

/** myna's AionUiLink: its add-model form, filled in for the reader to confirm. */
function aionuiLink(environment: ConnectEnvironment): string {
  const params = new URLSearchParams({
    api_key: environment.apiKey,
    base_url: `${environment.baseUrl}/v1`,
    name: "Neox",
    platform: "custom",
  });
  return `aionui://add-provider?${params.toString()}`;
}

const aionuiDriver: AgentConnectDriver = {
  provider: "aionui",
  external: {
    name: "AionUi",
    icon: "aionui",
    importLink: aionuiLink,
    // It keeps its providers, keys encrypted, in its own database; myna only
    // takes a new one through its deeplink, which Neolix has no row for.
    noConnect: true,
    detect: async (environment) => isDir(path.join(configDir(environment), "AionUi")),
  },
  configPath: (environment) => path.join(configDir(environment), "AionUi"),
  async read() {
    return { connected: false, model: null, baseUrl: null };
  },
  async connect() {
    throw new Error("AionUi takes a provider only through its own add-model form.");
  },
  async disconnect() {},
};

/** myna's CindyLink: its provider import, the gateway as one custom provider. */
function cindyLink(environment: ConnectEnvironment): string {
  const v1 = `${environment.baseUrl}/v1`;
  const payload = {
    kind: "custom",
    name: "Neox",
    id: SLOT,
    auth: { method: "apiKey", apiKey: environment.apiKey },
    endpoints: [
      {
        protocol: "anthropic-messages",
        baseUrl: environment.baseUrl,
        targets: ["claude-code"],
        modelsUrl: `${v1}/models`,
      },
      { protocol: "openai-responses", baseUrl: v1, targets: ["codex"], modelsUrl: `${v1}/models` },
      { protocol: "openai-chat", baseUrl: v1, targets: ["pi"], modelsUrl: `${v1}/models` },
    ],
  };
  return `cindy://provider/import?v=1&data=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

const cindyDriver: AgentConnectDriver = {
  provider: "cindy",
  external: {
    name: "Cindy",
    icon: "cindy",
    importLink: cindyLink,
    // Its providers live in its own database, taken only through its
    // `cindy://provider/import` link.
    noConnect: true,
    detect: async (environment) =>
      isDir(path.join(configDir(environment), "Cindy")) ||
      isDir(path.join(configDir(environment), "CindyGlobal")),
  },
  configPath: (environment) => path.join(configDir(environment), "Cindy"),
  async read() {
    return { connected: false, model: null, baseUrl: null };
  },
  async connect() {
    throw new Error("Cindy takes a provider only through its own import link.");
  },
  async disconnect() {},
};

/** The OS's user config folder, as the app itself reads it. */
function configDir(environment: ConnectEnvironment): string {
  if (environment.platform === "darwin") {
    return path.join(environment.homeDir, "Library", "Application Support");
  }
  if (environment.platform === "win32") {
    return (
      envOverride(environment.env, "APPDATA") ??
      path.join(environment.homeDir, "AppData", "Roaming")
    );
  }
  const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
  return xdg !== null && path.isAbsolute(xdg) ? xdg : path.join(environment.homeDir, ".config");
}

export const BATCH8_AGENT_DRIVERS: AgentConnectDriver[] = [
  fxDriver,
  morphDriver,
  aionuiDriver,
  cindyDriver,
];
