import { promises as fs } from "node:fs";
import path from "node:path";
import { contentHash, readJsonObject, readTextOrNull } from "../config-files.js";
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
import { envOverride, getTomlTableKey, homePath, isDir, writeText } from "./helpers.js";

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

function textPart(undo: AgentConnectUndo | undefined, filePath: string) {
  let parts: AgentConnectUndo[] = [];
  if (undo !== undefined) parts = undo.kind === "multi" ? undo.parts : [undo];
  return parts.find(
    (part): part is Extract<AgentConnectUndo, { kind: "text" }> =>
      part.kind === "text" && part.path === filePath,
  );
}

// ---------- PenguinHarness ----------

function penguinRoot(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "PENGUIN_HOME");
  if (override !== null && path.isAbsolute(override)) return override;
  return homePath(environment, ".penguin", "data");
}

function penguinProject(environment: ConnectEnvironment): string {
  const id = envOverride(environment.env, "PENGUIN_PROJECT_ID");
  const clean = id !== null && id !== "." && id !== ".." && !/[/\\]/.test(id);
  return clean && id !== null ? id : "default_project";
}

function penguinPath(environment: ConnectEnvironment): string {
  return path.join(penguinRoot(environment), penguinProject(environment), ".project_config.toml");
}

interface TomlSection {
  header: string | null;
  lines: string[];
}

/** The file as top-level lines and [table]/[[array]] sections, in order. */
function tomlSections(text: string): TomlSection[] {
  const sections: TomlSection[] = [{ header: null, lines: [] }];
  for (const line of text.split("\n")) {
    if (/^\s*\[\[?.+?\]\]?\s*$/.test(line)) {
      sections.push({ header: line.trim(), lines: [line] });
      continue;
    }
    sections[sections.length - 1]?.lines.push(line);
  }
  return sections;
}

function joinSections(sections: TomlSection[]): string {
  const lines = sections.flatMap((section) => section.lines);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

function isPenguinModels(section: TomlSection): boolean {
  return (
    section.header === "[[models]]" &&
    section.lines.some((line) => /^\s*provider\s*=\s*"neolix"\s*$/.test(line))
  );
}

function penguinBlocks(environment: ConnectEnvironment): string[] {
  const blocks = [
    [
      `[providers.${SLOT}]`,
      `base_url = ${tomlString(`${environment.baseUrl}/v1`)}`,
      'client_type = "openai-responses"',
      `api_key = ${tomlString(environment.apiKey)}`,
      "",
    ].join("\n"),
  ];
  for (const model of environment.models) {
    blocks.push(
      [
        "[[models]]",
        `provider = ${tomlString(SLOT)}`,
        `model_id = ${tomlString(model.id)}`,
        `display_name = ${tomlString(labelOf(model))}`,
        ...(model.contextWindow === undefined
          ? []
          : [`context_window = ${String(model.contextWindow)}`]),
        `vision = ${model.images === true ? "true" : "false"}`,
        ...(model.maxOutputTokens === undefined
          ? []
          : [`max_tokens = ${String(model.maxOutputTokens)}`]),
        "",
      ].join("\n"),
    );
  }
  return blocks;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function penguinDefaultLine(model: string): string {
  return `default_model = { provider = ${tomlString(SLOT)}, model_id = ${tomlString(model)} }`;
}

function penguinDefaultModel(text: string): string | null {
  const head = tomlSections(text)[0]?.lines.join("\n") ?? "";
  const match =
    /^\s*default_model\s*=\s*\{\s*provider\s*=\s*"([^"]*)"\s*,\s*model_id\s*=\s*"([^"]*)"\s*\}\s*$/m.exec(
      head,
    );
  return match?.[1] === SLOT ? (match[2] ?? null) : null;
}

function penguinRemoveDefault(text: string): string {
  const sections = tomlSections(text);
  const head = sections[0];
  if (head !== undefined) {
    head.lines = head.lines.filter((line) => !/^\s*default_model\s*=/.test(line));
  }
  return joinSections(sections);
}

function penguinSetDefaultLine(text: string, line: string): string {
  const sections = tomlSections(text);
  const head = sections[0] ?? { header: null, lines: [] };
  const at = head.lines.findIndex((entry) => /^\s*default_model\s*=/.test(entry));
  if (at >= 0) head.lines[at] = line;
  else head.lines.push(line);
  sections[0] = head;
  return joinSections(sections);
}

function penguinSetDefault(text: string, model: string): string {
  return penguinSetDefaultLine(text, penguinDefaultLine(model));
}

/** Everything Neolix writes: our provider table and model entries. */
function penguinStripOurs(text: string): string {
  const sections = tomlSections(text).filter(
    (section) => section.header !== `[providers.${SLOT}]` && !isPenguinModels(section),
  );
  return joinSections(sections);
}

const penguinDriver: AgentConnectDriver = {
  provider: "penguin",
  external: {
    name: "PenguinHarness",
    icon: "penguin-color",
    detect: async (environment) =>
      (await exists(penguinPath(environment))) || isDir(penguinRoot(environment)),
  },
  configPath: penguinPath,
  async read(environment) {
    const filePath = penguinPath(environment);
    if (!(await exists(filePath))) return { connected: false, model: null, baseUrl: null };
    const text = (await readTextOrNull(filePath)) ?? "";
    const model = penguinDefaultModel(text);
    const base = getTomlTableKey(text, `[providers.${SLOT}]`, "base_url");
    return {
      connected: model !== null,
      model,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, _undo) {
    const filePath = penguinPath(environment);
    const existed = await exists(filePath);
    const before = existed ? await readTextOrNull(filePath) : null;
    const chosen = chosenModel(environment, model) ?? environment.models[0]?.id ?? "";
    // A file Neolix starts is made private: it holds a key (myna's writeMyna).
    if (!(await exists(filePath))) {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await fs.writeFile(filePath, "", { mode: 0o600 });
    }
    const kept = penguinStripOurs(before ?? "");
    const body = penguinSetDefault(kept, chosen).trimEnd();
    const blocks = penguinBlocks(environment).map((block) => block.trimEnd());
    const after =
      body.length === 0 ? `${blocks.join("\n\n")}\n` : `${body}\n\n${blocks.join("\n\n")}\n`;
    await writeText(filePath, after);
    return { kind: "text", path: filePath, before, wrote: contentHash(after) };
  },
  async disconnect(environment, undo) {
    const filePath = penguinPath(environment);
    if (!(await exists(filePath))) return;
    const text = (await readTextOrNull(filePath)) ?? "";
    const stripped = penguinStripOurs(text);
    const part = textPart(undo, filePath);
    // The default model comes back when it is still Neolix's; a pick the
    // reader made in Penguin since is theirs (myna's unwire).
    const restored = part?.before ?? null;
    const priorDefault =
      restored === null ? null : (/^\s*default_model\s*=.*$/m.exec(restored)?.[0] ?? null);
    let next = penguinRemoveDefault(stripped);
    if (penguinDefaultModel(text) !== null && priorDefault !== null) {
      next = penguinSetDefaultLine(next, priorDefault);
    }
    const empty = next.trim() === "";
    if (empty && restored === null) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await writeText(filePath, next);
  },
};

// ---------- Pencil ----------

function pencilPath(environment: ConnectEnvironment): string {
  return homePath(environment, ".pencil", "models.json");
}

function pencilProvider(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    name: "Neox",
    baseUrl: `${environment.baseUrl}/v1`,
    api: "openai-completions",
    models: environment.models.map((model) => ({
      id: model.id,
      name: labelOf(model),
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxOutputTokens ?? 8192,
      compat: {},
    })),
  };
}

const pencilDriver: AgentConnectDriver = {
  provider: "pencil",
  external: {
    name: "Pencil",
    icon: "generic",
    detect: async (environment) => isDir(homePath(environment, ".pencil")),
  },
  configPath: pencilPath,
  async read(environment) {
    const config = await readJsonIfThere(pencilPath(environment));
    const providers = isRecord(config.providers) ? config.providers : {};
    const entry = isRecord(providers[SLOT]) ? providers[SLOT] : null;
    const base = entry !== null && typeof entry.baseUrl === "string" ? entry.baseUrl : null;
    return {
      connected: entry !== null,
      model: null,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, _model, undo) {
    const filePath = pencilPath(environment);
    const config = await readJsonIfThere(filePath);
    const captured: Record<string, PriorValue> = {};
    capture(config, captured, `providers.${SLOT}`);
    setAtValue(config, `providers.${SLOT}`, pencilProvider(environment));
    const entry = await writeJsonWithUndo(filePath, config, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = pencilPath(environment);
    if (!(await exists(filePath))) return;
    const config = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
    if (prior) restore(config, prior.values);
    await writeJsonWithUndo(filePath, config, {}, undo);
  },
};

// ---------- OpenBot ----------

function openBotDir(environment: ConnectEnvironment): string {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "OpenBot");
  }
  if (environment.platform === "win32") {
    return path.join(
      envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming"),
      "OpenBot",
    );
  }
  const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
  return path.join(
    xdg !== null && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"),
    "OpenBot",
  );
}

function openBotPath(environment: ConnectEnvironment): string {
  return path.join(openBotDir(environment), "openbot-custom-providers-v1.json");
}

interface OpenBotEntry {
  id?: string;
  [key: string]: unknown;
}

/**
 * The model ids OpenBot takes as myna's: ASCII letters, digits and
 * `._:/[],=-`, at most 160 (myna's isAgentModel, an entry it wouldn't
 * accept empties the whole list).
 */
const OPENBOT_MODEL_ID = new RegExp("^[A-Za-z0-9._:/\\[\\],=-]{1,160}$");

function openBotEntry(environment: ConnectEnvironment, secret: unknown): OpenBotEntry {
  return {
    id: SLOT,
    name: "Neox",
    baseUrl: `${environment.baseUrl}/v1`,
    models: environment.models
      .filter((model) => OPENBOT_MODEL_ID.test(model.id))
      .slice(0, 64)
      .map((model) => ({
        id: model.id,
        name: labelOf(model),
        contextWindow: model.contextWindow ?? 128000,
      })),
    // The user's own sealed key stays; Neolix's entry has none (OpenBot
    // hands it to OpenCode keyless), as myna's does.
    secret: secret ?? null,
  };
}

const openBotDriver: AgentConnectDriver = {
  provider: "openbot",
  external: {
    name: "OpenBot",
    icon: "openbot",
    detect: async (environment) => isDir(openBotDir(environment)),
  },
  configPath: openBotPath,
  async read(environment) {
    const filePath = openBotPath(environment);
    if (!(await exists(filePath))) return { connected: false, model: null, baseUrl: null };
    const file = await readJsonIfThere(filePath);
    const providers = Array.isArray(file.providers) ? (file.providers as OpenBotEntry[]) : [];
    const ours = providers.find((entry) => entry.id === SLOT);
    return {
      connected: ours !== undefined,
      model: null,
      baseUrl:
        ours !== undefined && typeof ours.baseUrl === "string" ? stripV1(ours.baseUrl) : null,
    };
  },
  async connect(environment, _model, undo) {
    const filePath = openBotPath(environment);
    const file = await readJsonIfThere(filePath);
    if (file.version !== undefined && file.version !== 1) {
      throw new Error("OpenBot's custom providers file isn't version 1; it was left as it is.");
    }
    const captured: Record<string, PriorValue> = {};
    capture(file, captured, "providers");
    const providers = Array.isArray(file.providers) ? (file.providers as OpenBotEntry[]) : [];
    const prior = providers.find((entry) => entry.id === SLOT);
    const next = providers.filter((entry) => entry.id !== SLOT);
    next.push(openBotEntry(environment, prior?.secret));
    setAtValue(file, "providers", next);
    file.version = 1;
    const entry = await writeJsonWithUndo(filePath, file, captured, undo);
    return { kind: "json", files: [entry] };
  },
  async disconnect(environment, undo) {
    const filePath = openBotPath(environment);
    if (!(await exists(filePath))) return;
    const file = await readJsonIfThere(filePath);
    const prior = undo?.kind === "json" ? undo.files.find((part) => part.path === filePath) : null;
    if (prior) restore(file, prior.values);
    await writeJsonWithUndo(filePath, file, {}, undo);
  },
};

export const BATCH10_AGENT_DRIVERS: AgentConnectDriver[] = [
  penguinDriver,
  pencilDriver,
  openBotDriver,
];
