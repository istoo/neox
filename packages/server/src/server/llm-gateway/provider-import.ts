import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readSqliteRows } from "./import-sqlite.js";

/**
 * Providers other apps already have set up, offered for the user to bring over.
 * Every source is read, never written; the app shows them for confirmation and
 * writes the chosen ones into `gateway.json` through the ordinary config save.
 */

export interface ImportedProvider {
  /** The app the entry came from. */
  source: string;
  /** Stable within its source. */
  ref: string;
  name: string;
  protocol: "openai" | "openai-responses" | "anthropic" | "gemini";
  baseUrl: string;
  apiKey?: string;
  models: string[];
  /** Headers the other app sent with every request. */
  headers?: Record<string, string>;
  /** False when the other app had it switched off. */
  enabled?: boolean;
}

export interface ImportSourceResult {
  id: string;
  name: string;
  path: string;
  found: boolean;
  error?: string;
  providers: ImportedProvider[];
}

interface SourceReader {
  id: string;
  name: string;
  path: (home: string) => Promise<string> | string;
  read: (file: string) => Promise<ImportedProvider[]>;
}

const OPENAI_DEFAULT = "https://api.openai.com/v1";

export async function readImportSources(home = homedir()): Promise<ImportSourceResult[]> {
  const results: ImportSourceResult[] = [];
  for (const reader of READERS) {
    const file = await reader.path(home);
    try {
      const providers = await reader.read(file);
      results.push({ id: reader.id, name: reader.name, path: file, found: true, providers });
    } catch (error) {
      if (isMissingFile(error)) {
        results.push({ id: reader.id, name: reader.name, path: file, found: false, providers: [] });
        continue;
      }
      results.push({
        id: reader.id,
        name: reader.name,
        path: file,
        found: true,
        error: error instanceof Error ? error.message : String(error),
        providers: [],
      });
    }
  }
  return results;
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(text: unknown): Record<string, unknown> {
  if (typeof text !== "string") {
    return {};
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

async function readJson(file: string): Promise<unknown> {
  const raw = await readFile(file, "utf8");
  const text = raw.replace(/^﻿/, "");
  try {
    return JSON.parse(text);
  } catch {
    // Claude Code and CC Switch write JSONC; comments are the only difference
    // that matters here.
    return JSON.parse(stripJsonComments(text));
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const id = typeof entry === "string" ? entry : asString(asRecord(entry).id);
    if (id.length > 0 && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

function cleanBase(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:";
  } catch {
    return false;
  }
}

// ---- Claude Code -----------------------------------------------------------

const claudeSettings: SourceReader = {
  id: "claude-code",
  name: "Claude Code",
  path: (home) => path.join(claudeDir(home), "settings.json"),
  read: async (file) => {
    const settings = asRecord(await readJson(file));
    const env = asRecord(settings.env);
    const base = cleanBase(asString(env.ANTHROPIC_BASE_URL));
    // No base URL means Anthropic's own endpoint, which is the agent's sign-in,
    // not a provider with a key.
    if (base.length === 0 || !isHttpUrl(base)) {
      return [];
    }
    const key = asString(env.ANTHROPIC_AUTH_TOKEN) || asString(env.ANTHROPIC_API_KEY);
    const models = [
      asString(env.ANTHROPIC_MODEL),
      asString(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
      asString(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
      asString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      asString(env.ANTHROPIC_SMALL_FAST_MODEL),
    ].filter((id, index, all) => id.length > 0 && all.indexOf(id) === index);
    return [
      {
        source: "Claude Code",
        ref: "settings",
        name: hostOf(base),
        protocol: "anthropic",
        baseUrl: base,
        ...(key.length === 0 ? {} : { apiKey: key }),
        models,
      },
    ];
  },
};

function claudeDir(home: string): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(home, ".claude");
}

// ---- Codex -----------------------------------------------------------------

const codex: SourceReader = {
  id: "codex",
  name: "Codex",
  path: (home) => path.join(home, ".codex", "config.toml"),
  read: async (file) => {
    const config = await readFile(file, "utf8");
    const { top, tables } = parseToml(config);
    const providerId = top.model_provider ?? "";
    const table = tables[`model_providers.${providerId}`] ?? {};
    const base = cleanBase(table.base_url ?? "");
    const authFile = path.join(path.dirname(file), "auth.json");
    const auth = await readJson(authFile).catch(() => ({}));
    const key =
      asString(asRecord(auth).OPENAI_API_KEY) || asString(table.experimental_bearer_token);
    if (base.length === 0 && key.length === 0) {
      return [];
    }
    const baseUrl = base.length === 0 ? OPENAI_DEFAULT : base;
    if (!isHttpUrl(baseUrl)) {
      return [];
    }
    const wire = (table.wire_api ?? "").toLowerCase();
    return [
      {
        source: "Codex",
        ref: providerId.length === 0 ? "default" : providerId,
        name: providerId.length === 0 ? "Codex" : providerId,
        protocol: wire === "chat" ? "openai" : "openai-responses",
        baseUrl,
        ...(key.length === 0 ? {} : { apiKey: key }),
        models: (top.model ?? "").length === 0 ? [] : [top.model!],
      },
    ];
  },
};

/** Codex's config: top-level string values and each table's, which is all an import reads. */
export function parseToml(text: string): {
  top: Record<string, string>;
  tables: Record<string, Record<string, string>>;
} {
  const top: Record<string, string> = {};
  const tables: Record<string, Record<string, string>> = {};
  let current = top;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim().replaceAll('"', "");
      current = {};
      tables[name] = current;
      continue;
    }
    const split = line.indexOf("=");
    if (split < 0) {
      continue;
    }
    const key = line.slice(0, split).trim();
    let value = line.slice(split + 1).trim();
    const comment = value.indexOf(" #");
    if (comment > 0 && !value.startsWith('"')) {
      value = value.slice(0, comment).trim();
    }
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      const quote = value[0]!;
      const end = value.lastIndexOf(quote);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    }
    current[key] = value;
  }
  return { top, tables };
}

// ---- CC Switch (the JSON its first versions kept) --------------------------

const ccSwitch: SourceReader = {
  id: "cc-switch",
  name: "CC Switch",
  // Newer CC Switch keeps one SQLite database; its first versions a config.json.
  path: async (home) => {
    const db = path.join(home, ".cc-switch", "cc-switch.db");
    return (await exists(db)) ? db : path.join(home, ".cc-switch", "config.json");
  },
  read: async (file) => {
    if (file.endsWith(".db")) {
      const rows = readSqliteRows(
        file,
        "SELECT id, app_type, name, settings_config FROM providers ORDER BY app_type, COALESCE(sort_index, 0), created_at",
      );
      const out: ImportedProvider[] = [];
      for (const row of rows) {
        const id = typeof row.id === "string" ? row.id : "";
        const app = typeof row.app_type === "string" ? row.app_type : "";
        const name = typeof row.name === "string" ? row.name : id;
        const entry = {
          name,
          settingsConfig: parseJsonObject(row.settings_config),
        };
        const imported = ccSwitchEntry(app, id, entry);
        if (imported !== null) {
          out.push(imported);
        }
      }
      return out;
    }
    const config = asRecord(await readJson(file));
    const out: ImportedProvider[] = [];
    for (const [app, section] of Object.entries(config)) {
      const providers = asRecord(asRecord(section).providers);
      for (const [id, raw] of Object.entries(providers)) {
        const entry = asRecord(raw);
        const imported = ccSwitchEntry(app, id, entry);
        if (imported !== null) {
          out.push(imported);
        }
      }
    }
    return out;
  },
};

function protocolOfFormat(format: string): ImportedProvider["protocol"] {
  if (format.includes("anthropic")) {
    return "anthropic";
  }
  if (format.includes("responses")) {
    return "openai-responses";
  }
  return "openai";
}

function claudeEntry(
  app: string,
  id: string,
  name: string,
  settings: Record<string, unknown>,
): ImportedProvider | null {
  const env = asRecord(settings.env);
  const base = cleanBase(asString(env.ANTHROPIC_BASE_URL));
  const key = asString(env.ANTHROPIC_AUTH_TOKEN) || asString(env.ANTHROPIC_API_KEY);
  if (base.length === 0 && key.length === 0) {
    return null;
  }
  const baseUrl = base.length === 0 ? "https://api.anthropic.com" : base;
  return {
    source: app === "claude" ? "Claude Code" : "Claude Desktop",
    ref: `${app}/${id}`,
    name,
    protocol: "anthropic",
    baseUrl,
    ...(key.length === 0 ? {} : { apiKey: key }),
    models: [],
  };
}

function ccSwitchEntry(
  app: string,
  id: string,
  entry: Record<string, unknown>,
): ImportedProvider | null {
  const name = asString(entry.name) || id;
  const settings = asRecord(entry.settingsConfig);
  if (app === "claude" || app === "claude-desktop") {
    return claudeEntry(app, id, name, settings);
  }
  const base = cleanBase(
    asString(settings.baseUrl) ||
      asString(settings.base_url) ||
      asString(settings.baseURL) ||
      asString(asRecord(settings.options).baseURL),
  );
  const key = asString(settings.apiKey) || asString(settings.api_key);
  if (base.length === 0 || !isHttpUrl(base)) {
    return null;
  }
  const format = (asString(settings.api) || asString(settings.npm) || app).toLowerCase();
  return {
    source: "CC Switch",
    ref: `${app}/${id}`,
    name,
    protocol: protocolOfFormat(format),
    baseUrl: base,
    ...(key.length === 0 ? {} : { apiKey: key }),
    models: asStringArray(settings.models),
  };
}

// ---- Alma ------------------------------------------------------------------

/** Where Alma keeps its databases: the platform's per-user config folder. */
function almaConfigDir(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  if (process.platform === "win32") {
    return process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
}

/** Alma's provider types by the preset at the same address. */
const ALMA_PRESETS: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  openrouter: "openrouter",
  moonshot: "moonshot",
  xai: "xai",
  mistral: "mistral",
  groq: "groq",
  aihubmix: "aihubmix",
  together: "together",
  fireworks: "fireworks",
  siliconflow: "siliconflow",
  ollama: "ollama",
  lmstudio: "lmstudio",
  "opencode-go": "opencode-go",
};

/** Types that are an app's own sign-in, not a key. */
const ALMA_SIGN_INS = new Set([
  "acp",
  "copilot",
  "claude-subscription",
  "codex-subscription",
  "gemini-cli",
  "antigravity",
  "cursor",
]);

const alma: SourceReader = {
  id: "alma",
  name: "Alma",
  path: (home) => path.join(almaConfigDir(home), "alma", "chat_threads.db"),
  read: async (file) => {
    const rows = readSqliteRows(
      file,
      "SELECT id, name, type, api_key, models, COALESCE(base_url, '') AS base_url, COALESCE(enabled, 1) AS enabled, COALESCE(api_format, '') AS api_format, COALESCE(is_response_api, 0) AS is_response_api, COALESCE(custom_headers, '') AS custom_headers FROM providers ORDER BY created_at",
    );
    const out: ImportedProvider[] = [];
    for (const row of rows) {
      const id = asString(row.id);
      const name = asString(row.name) || id;
      const type = asString(row.type);
      if (ALMA_SIGN_INS.has(type)) {
        continue;
      }
      const key = asString(row.api_key);
      const base = cleanBase(asString(row.base_url));
      const format = asString(row.api_format).toLowerCase();
      const responses = Number(row.is_response_api) === 1;
      const preset = ALMA_PRESETS[type];
      const endpoint = preset === undefined ? undefined : PRESET_ENDPOINTS[preset];
      let protocol: ImportedProvider["protocol"] = "openai";
      let baseUrl = base;
      if (base.length === 0) {
        if (endpoint === undefined) {
          continue;
        }
        protocol = endpoint.protocol;
        baseUrl = endpoint.baseUrl;
      } else if (format === "anthropic" || type === "anthropic") {
        protocol = "anthropic";
      } else if (format === "gemini") {
        protocol = "gemini";
      } else if (responses || format === "openai-responses") {
        protocol = "openai-responses";
      }
      if (!isHttpUrl(baseUrl)) {
        continue;
      }
      const headers = headerRecord(row.custom_headers);
      out.push({
        source: "Alma",
        ref: id,
        name,
        protocol,
        baseUrl,
        ...(key.length === 0 ? {} : { apiKey: key }),
        models: parseModelIds(row.models),
        ...(headers === undefined ? {} : { headers }),
        ...(Number(row.enabled) === 0 ? { enabled: false } : {}),
      });
    }
    return out;
  },
};

// ---- OpenCode --------------------------------------------------------------

/** OpenCode's provider ids by the preset at the same address. */
const OPENCODE_PRESETS: Record<string, string> = {
  opencode: "opencode-zen",
  "opencode-go": "opencode-go",
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  xai: "xai",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot-cn",
  mistral: "mistral",
  groq: "groq",
  openrouter: "openrouter",
  togetherai: "together",
  "fireworks-ai": "fireworks",
  "siliconflow-cn": "siliconflow",
  nvidia: "nvidia",
  aihubmix: "aihubmix",
  "302ai": "302ai",
  "ollama-cloud": "ollama-cloud",
  zhipuai: "zhipu",
  zai: "zai",
  alibaba: "qwen",
  "alibaba-cn": "qwen-cn",
  minimax: "minimax",
  modelscope: "modelscope",
  kilo: "kilo",
  "cline-pass": "clinepass",
  "kimi-code-plan-cn": "kimi-code-cn",
  "kimi-code-plan-global": "kimi-code",
  "stepfun-step-plan": "stepfun-cn",
  "stepfun-ai-step-plan": "stepfun",
  longcat: "longcat",
  "volcengine-coding-plan": "volcengine",
  "alibaba-token-plan-cn": "bailian-token-plan",
  "tencent-token-plan": "tencent-cloud",
};

const openCode: SourceReader = {
  id: "opencode",
  name: "OpenCode",
  // `opencode auth login` keeps keys only, never where they go.
  path: (home) =>
    path.join(
      process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share"),
      "opencode",
      "auth.json",
    ),
  read: async (file) => {
    const all = asRecord(await readJson(file));
    const out: ImportedProvider[] = [];
    for (const id of Object.keys(all).sort()) {
      const entry = asRecord(all[id]);
      // OAuth and well-known entries are a sign-in, not a key.
      if (asString(entry.type) !== "api") {
        continue;
      }
      const key = asString(entry.key);
      const preset = OPENCODE_PRESETS[id];
      const endpoint = preset === undefined ? undefined : PRESET_ENDPOINTS[preset];
      if (key.length === 0 || endpoint === undefined) {
        continue;
      }
      out.push({
        source: "OpenCode",
        ref: id,
        name: endpoint.name,
        protocol: endpoint.protocol,
        baseUrl: endpoint.baseUrl,
        apiKey: key,
        models: [],
      });
    }
    return out;
  },
};

// ---- The presets both readers complete a base URL from ---------------------

interface PresetEndpoint {
  name: string;
  protocol: ImportedProvider["protocol"];
  baseUrl: string;
}

/** The presets of `providers-presets.ts`, by id, at the address each serves. */
const PRESET_ENDPOINTS: Record<string, PresetEndpoint> = {
  anthropic: { name: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  openai: { name: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1" },
  google: {
    name: "Google",
    protocol: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  deepseek: { name: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com/v1" },
  xai: { name: "xAI", protocol: "openai", baseUrl: "https://api.x.ai/v1" },
  moonshot: { name: "Moonshot AI", protocol: "openai", baseUrl: "https://api.moonshot.ai/v1" },
  "moonshot-cn": { name: "Moonshot AI", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1" },
  mistral: { name: "Mistral", protocol: "openai", baseUrl: "https://api.mistral.ai/v1" },
  groq: { name: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1" },
  openrouter: {
    name: "OpenRouter",
    protocol: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  together: { name: "Together", protocol: "openai", baseUrl: "https://api.together.xyz/v1" },
  fireworks: {
    name: "Fireworks",
    protocol: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
  siliconflow: {
    name: "SiliconFlow",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  nvidia: { name: "NVIDIA", protocol: "openai", baseUrl: "https://integrate.api.nvidia.com/v1" },
  aihubmix: { name: "AiHubMix", protocol: "openai", baseUrl: "https://aihubmix.com/v1" },
  "302ai": { name: "302.AI", protocol: "openai", baseUrl: "https://api.302.ai/v1" },
  "ollama-cloud": { name: "Ollama Cloud", protocol: "openai", baseUrl: "https://ollama.com/v1" },
  zhipu: {
    name: "Zhipu",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  zai: { name: "Z.ai", protocol: "openai", baseUrl: "https://api.z.ai/api/paas/v4" },
  qwen: {
    name: "Qwen",
    protocol: "openai",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  },
  "qwen-cn": {
    name: "Qwen",
    protocol: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  minimax: { name: "MiniMax", protocol: "openai", baseUrl: "https://api.minimax.io/v1" },
  modelscope: {
    name: "ModelScope",
    protocol: "openai",
    baseUrl: "https://api-inference.modelscope.cn/v1",
  },
  kilo: { name: "Kilo", protocol: "openai", baseUrl: "https://api.kilo.ai/api/openrouter" },
  clinepass: { name: "Cline Pass", protocol: "openai", baseUrl: "https://api.cline.bot/api/v1" },
  "kimi-code-cn": {
    name: "Kimi Code",
    protocol: "openai",
    baseUrl: "https://api.kimi.com/coding/v1",
  },
  "kimi-code": { name: "Kimi Code", protocol: "openai", baseUrl: "https://api.kimi.ai/coding/v1" },
  "stepfun-cn": {
    name: "StepFun",
    protocol: "openai",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
  },
  stepfun: { name: "StepFun", protocol: "openai", baseUrl: "https://api.stepfun.ai/step_plan/v1" },
  longcat: { name: "LongCat", protocol: "openai", baseUrl: "https://api.longcat.chat/openai/v1" },
  volcengine: {
    name: "Volcengine",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
  },
  "bailian-token-plan": {
    name: "Bailian",
    protocol: "openai",
    baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  },
  "tencent-cloud": {
    name: "Tencent Cloud",
    protocol: "openai",
    baseUrl: "https://tokenhub.tencentmaas.com/plan/v3",
  },
  "opencode-zen": {
    name: "OpenCode Zen",
    protocol: "openai",
    baseUrl: "https://opencode.ai/zen/v1",
  },
  "opencode-go": {
    name: "OpenCode Go",
    protocol: "openai",
    baseUrl: "https://opencode.ai/zen/go/v1",
  },
  ollama: { name: "Ollama", protocol: "openai", baseUrl: "http://localhost:11434/v1" },
  lmstudio: { name: "LM Studio", protocol: "openai", baseUrl: "http://localhost:1234/v1" },
};

/** A headers column: a JSON object of header names and values, if any. */
function headerRecord(value: unknown): Record<string, string> | undefined {
  const parsed = typeof value === "string" ? parseJsonObjectOrArray(value) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue === "string" && headerValue.length > 0) {
      out[name] = headerValue;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** A models column: an array of ids, or of objects that carry one. */
function parseModelIds(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseJsonObjectOrArray(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of parsed) {
    const id = typeof entry === "string" ? entry : asString(asRecord(entry).id);
    if (id.length > 0 && !out.includes(id)) {
      out.push(id);
    }
  }
  return out;
}

function parseJsonObjectOrArray(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const READERS: SourceReader[] = [claudeSettings, codex, ccSwitch, alma, openCode];

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
