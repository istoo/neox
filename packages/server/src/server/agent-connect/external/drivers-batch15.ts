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
import { envOverride, homePath, isDir, isOnPath, writeText } from "./helpers.js";
import {
  findScience,
  readScienceMark,
  scienceConnect,
  scienceDisconnect,
  type ScienceEnvironment,
} from "./claude-science.js";

const SLOT = "neolix";
const AGENT_NAME = "Neolix";

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

// ---------- JetBrains Air, and Air in JetBrains IDEs ----------

interface AirLayout {
  provider: string;
  name: string;
  icon: string;
  dir(environment: ConnectEnvironment): string;
  detect(environment: ConnectEnvironment, acpPath: string, ocPath: string): Promise<boolean>;
}

/** Where OpenCode is for Air, which may not see the shell's PATH (myna's airOpenCode). */
async function airOpenCode(environment: ConnectEnvironment): Promise<string> {
  if (await isOnPath("opencode", environment)) return "opencode";
  const name = environment.platform === "win32" ? "opencode.exe" : "opencode";
  const installed = homePath(environment, ".opencode", "bin", name);
  if (await exists(installed)) return installed;
  return (await acpOpenCode(environment, name)) ?? "opencode";
}

/**
 * OpenCode unpacked by a JetBrains IDE or Zed from the ACP registry, which
 * puts it on no PATH (myna's acpOpenCode); the newest when there are several.
 */
async function acpOpenCode(environment: ConnectEnvironment, name: string): Promise<string | null> {
  const home = environment.homeDir;
  const cache = envOverride(environment.env, "XDG_CACHE_HOME") ?? path.join(home, ".cache");
  const data = envOverride(environment.env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share");
  const local = envOverride(environment.env, "LOCALAPPDATA") ?? path.join(home, "AppData", "Local");
  let patterns: string[][];
  if (environment.platform === "darwin") {
    patterns = [
      [path.join(home, "Library", "Caches", "JetBrains"), "*", "acp-agents", "opencode", "*", name],
      [
        path.join(home, "Library", "Application Support", "Zed"),
        "external_agents",
        "registry",
        "opencode",
        "*",
        name,
      ],
    ];
  } else if (environment.platform === "win32") {
    patterns = [
      [path.join(local, "JetBrains"), "*", "acp-agents", "opencode", "*", name],
      [path.join(local, "Zed"), "external_agents", "registry", "opencode", "*", name],
    ];
  } else {
    patterns = [
      [path.join(cache, "JetBrains"), "*", "acp-agents", "opencode", "*", name],
      [path.join(data, "zed"), "external_agents", "registry", "opencode", "*", name],
    ];
  }
  let best: { file: string; at: number } | null = null;
  for (const pattern of patterns) {
    for (const file of await matchPath(pattern)) {
      const stat = await fs.stat(file).catch(() => null);
      if (stat === null || !stat.isFile()) continue;
      if (best === null || stat.mtimeMs > best.at) best = { file, at: stat.mtimeMs };
    }
  }
  return best?.file ?? null;
}

/** The files a path pattern matches, where "*" stands for one directory name. */
async function matchPath(segments: string[]): Promise<string[]> {
  const [head, ...rest] = segments;
  if (head === undefined) return [];
  if (head === "*") return [];
  if (rest.length === 0) return [head];
  if (rest[0] !== "*") return matchPath([path.join(head, rest[0]), ...rest.slice(1)]);
  const names = await fs.readdir(head).catch(() => [] as string[]);
  const found: string[] = [];
  for (const name of names)
    found.push(...(await matchPath([path.join(head, name), ...rest.slice(1)])));
  return found;
}

function airProvider(environment: ConnectEnvironment): Record<string, unknown> {
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Neox",
    options: { baseURL: `${environment.baseUrl}/v1`, apiKey: environment.apiKey },
    models: Object.fromEntries(
      environment.models.map((entry) => {
        const model: Record<string, unknown> = { name: labelOf(entry) };
        if (entry.contextWindow !== undefined) {
          model.limit = {
            context: entry.contextWindow,
            ...(entry.maxOutputTokens === undefined ? {} : { output: entry.maxOutputTokens }),
          };
        }
        if (entry.images === true) {
          model.modalities = { input: ["text", "image"], output: ["text"] };
        }
        return [entry.id, model];
      }),
    ),
  };
}

function airDriver(layout: AirLayout): AgentConnectDriver {
  const acpPath = (environment: ConnectEnvironment) =>
    path.join(layout.dir(environment), "acp.json");
  const ocPath = (environment: ConnectEnvironment) =>
    path.join(layout.dir(environment), "neolix-opencode.json");
  return {
    provider: layout.provider,
    external: {
      name: layout.name,
      icon: layout.icon,
      detect: (environment) =>
        layout.detect(environment, acpPath(environment), ocPath(environment)),
    },
    configPath: acpPath,
    async read(environment) {
      const acp = await readJsonIfThere(acpPath(environment));
      const config = readJsonString(acp, ["agent_servers", AGENT_NAME, "env", "OPENCODE_CONFIG"]);
      const ours = config === ocPath(environment);
      const openCode = ours ? await readJsonIfThere(ocPath(environment)) : {};
      const model = readJsonString(openCode, ["model"]);
      return {
        connected: ours,
        model: ours && model?.startsWith(`${SLOT}/`) === true ? model.slice(SLOT.length + 1) : null,
        baseUrl: ours
          ? stripNullable(readJsonString(openCode, ["provider", SLOT, "options", "baseURL"]))
          : null,
      };
    },
    async connect(environment, model, undo) {
      const chosen = chosenModel(environment, model);
      const ref = chosen === null ? null : `${SLOT}/${chosen}`;
      const configPath = ocPath(environment);
      await writeText(
        configPath,
        `${JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            ...(ref === null ? {} : { small_model: ref, model: ref }),
            enabled_providers: [SLOT],
            provider: { [SLOT]: airProvider(environment) },
          },
          null,
          2,
        )}\n`,
      );
      const filePath = acpPath(environment);
      const acp = await readJsonIfThere(filePath);
      const captured: Record<string, PriorValue> = {};
      capture(acp, captured, `agent_servers.${AGENT_NAME}`);
      setAtValue(acp, `agent_servers.${AGENT_NAME}`, {
        command: await airOpenCode(environment),
        args: ["acp"],
        env: { OPENCODE_CONFIG: configPath },
      });
      const entry = await writeJsonWithUndo(filePath, acp, captured, undo);
      return { kind: "json", files: [entry] };
    },
    async disconnect(environment, undo) {
      await fs.rm(ocPath(environment), { force: true });
      const filePath = acpPath(environment);
      if (!(await exists(filePath))) return;
      const acp = await readJsonIfThere(filePath);
      const prior =
        undo?.kind === "json" ? undo.files.find((file) => file.path === filePath) : null;
      if (prior) restore(acp, prior.values);
      // Nothing of the reader's was there: Air creates the file on its own
      // first save, so leaving an empty one would hide that it is unused.
      if (Object.keys(acp).length === 0) {
        await fs.rm(filePath, { force: true });
        return;
      }
      await writeJsonWithUndo(filePath, acp, {}, undo);
    },
  };
}

function stripNullable(value: string | null): string | null {
  return value === null ? null : stripV1(value);
}

function airDir(environment: ConnectEnvironment): string {
  const home = environment.homeDir;
  if (environment.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "JetBrains", "Air");
  }
  if (environment.platform === "win32") {
    return path.join(
      envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming"),
      "JetBrains",
      "Air",
    );
  }
  const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
  return path.join(
    xdg !== null && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"),
    "JetBrains",
    "Air",
  );
}

/** A JetBrains IDE from 2026.2, which carries Air (myna's jetBrainsIDESince). */
async function jetBrainsIdeWithAir(environment: ConnectEnvironment): Promise<boolean> {
  const home = environment.homeDir;
  let base: string;
  if (environment.platform === "darwin") {
    base = path.join(home, "Library", "Application Support", "JetBrains");
  } else if (environment.platform === "win32") {
    base = envOverride(environment.env, "APPDATA") ?? path.join(home, "AppData", "Roaming");
    base = path.join(base, "JetBrains");
  } else {
    const xdg = envOverride(environment.env, "XDG_CONFIG_HOME");
    base = path.join(
      xdg !== null && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"),
      "JetBrains",
    );
  }
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return false;
  }
  return names.some((name) => {
    const match = /(\d{4})\.(\d)/.exec(name);
    if (match === null) return false;
    const year = Number(match[1]);
    const minor = Number(match[2]);
    return year > 2026 || (year === 2026 && minor >= 2);
  });
}

const airApp = airDriver({
  provider: "air",
  name: "JetBrains Air",
  icon: "air",
  dir: airDir,
  detect: async (environment, _acpPath, ocPath) => {
    if (await isDir(airDir(environment))) return true;
    return exists(ocPath);
  },
});

const airIde = airDriver({
  provider: "air-ide",
  name: "Air (JetBrains IDEs)",
  icon: "air",
  dir: (environment) => homePath(environment, ".jetbrains"),
  detect: async (environment, acpPath, ocPath) => {
    if (await exists(ocPath)) return true;
    if (await jetBrainsIdeWithAir(environment)) return true;
    const acp = await readJsonIfThere(acpPath);
    return readJsonString(acp, ["agent_servers", AGENT_NAME, "env", "OPENCODE_CONFIG"]) === ocPath;
  },
});

// ---------- Claude Science ----------

function scienceEnvironment(environment: ConnectEnvironment): ScienceEnvironment {
  return {
    homeDir: environment.homeDir,
    platform: environment.platform,
    env: environment.env,
    ...(environment.runWithEnv === undefined ? {} : { runWithEnv: environment.runWithEnv }),
  };
}

function claudeScienceBin(environment: ConnectEnvironment): Promise<boolean> {
  return findScience(scienceEnvironment(environment)).then((bin) => bin !== null);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** myna's ScienceLaunch: restart its daemon with the gateway's address. */
function scienceLaunch(environment: ConnectEnvironment): string {
  if (environment.platform === "win32") {
    return `& 'science' stop; $env:CLAUDE_SCIENCE_GATEWAY_URL="${environment.baseUrl}"; & 'science' serve --detached`;
  }
  return `${quoteShell("science")} stop; CLAUDE_SCIENCE_GATEWAY_URL=${environment.baseUrl} ${quoteShell("science")} serve --detached`;
}

const claudeScienceDriver: AgentConnectDriver = {
  provider: "claude-science",
  external: {
    name: "Claude Science",
    icon: "claude-color",
    // It keeps no provider in a file Neolix can write: its daemon is started
    // with the gateway's address, so the row offers that line (myna's
    // ScienceLaunch). myna also restarts the daemon it started every minute;
    // that keep-alive is not ported.
    launch: (environment) => scienceLaunch(environment),
    detect: claudeScienceBin,
  },
  configPath: (environment) => homePath(environment, ".claude-science"),
  async read(environment) {
    const mark = await readScienceMark(scienceEnvironment(environment));
    if (mark === null || mark.url !== environment.baseUrl) {
      return { connected: false, model: null, baseUrl: null };
    }
    return { connected: true, model: null, baseUrl: mark.url };
  },
  async connect(environment) {
    await scienceConnect(scienceEnvironment(environment), environment.baseUrl);
    return { kind: "json", files: [] };
  },
  async disconnect(environment) {
    await scienceDisconnect(scienceEnvironment(environment));
  },
};

export const BATCH15_AGENT_DRIVERS: AgentConnectDriver[] = [airApp, airIde, claudeScienceDriver];
