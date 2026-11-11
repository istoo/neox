import { promises as fs } from "node:fs";
import path from "node:path";
import { contentHash, readJsonObject, readTextOrNull, tomlString } from "../config-files.js";
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
  envOverride,
  isDir,
  isOnPath,
  readEnvFile,
  removeEnvValues,
  setEnvValues,
  setTomlTopLevel,
  writeText,
} from "./helpers.js";

const SLOT = "neolix";

function chosenModel(environment: ConnectEnvironment, model: string | null): string | null {
  return model ?? environment.models[0]?.id ?? null;
}

function jsonUndo(entries: Awaited<ReturnType<typeof writeJsonWithUndo>>[]): AgentConnectUndo {
  return { kind: "json", files: entries };
}

function undoParts(undo: AgentConnectUndo | undefined): AgentConnectUndo[] {
  if (undo === undefined) return [];
  return undo.kind === "multi" ? undo.parts : [undo];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---------- Kiro Crew ----------

/** The harnesses Neolix can point Kiro Crew at, in myna's picking order. */
const KIRO_CREW_HARNESSES = [
  { id: "codex", agent: "codex", dispatch: true },
  { id: "claude", agent: "claude", dispatch: true },
  { id: "opencode", agent: "opencode", dispatch: true },
  { id: "pi", agent: "pi", dispatch: false },
  { id: "goose", agent: "goose", dispatch: true },
] as const;

const KIRO_CREW_REFUSED_ROOTS = new Set(["/", "/usr", "/System", "/etc"]);

function kiroCrewDir(environment: ConnectEnvironment): string {
  const override = envOverride(environment.env, "KIROCREW_HOME");
  if (override !== null && path.isAbsolute(override) && !KIRO_CREW_REFUSED_ROOTS.has(override)) {
    return override;
  }
  return path.join(environment.homeDir, ".kiro", "crew");
}

function kiroCrewPath(environment: ConnectEnvironment): string {
  return path.join(kiroCrewDir(environment), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** config.local.json is merged over config.json key by key. */
function mergeRecords(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? mergeRecords(current, value) : value;
  }
  return out;
}

async function kiroCrewMerged(environment: ConnectEnvironment): Promise<Record<string, unknown>> {
  const dir = kiroCrewDir(environment);
  const base = await readJsonObject(path.join(dir, "config.json"));
  const local = await readJsonObject(path.join(dir, "config.local.json"));
  return mergeRecords(base, local);
}

function kiroCrewBackend(config: Record<string, unknown>): string | null {
  const agent = config.agent;
  if (!isRecord(agent)) return null;
  const value = agent.acp_backend;
  return typeof value === "string" && value.length > 0 ? value : null;
}

const kiroCrewDriver: AgentConnectDriver = {
  provider: "kirocrew",
  external: {
    name: "Kiro Crew",
    icon: "generic",
    detect: async (environment) =>
      (await exists(kiroCrewPath(environment))) || (await isDir(kiroCrewDir(environment))),
    // myna: internal/agent/kirocrew.go pick()/kiroCrewJoin/kiroCrewLeave.
    harness: {
      backends: KIRO_CREW_HARNESSES.map((harness) => ({
        backend: harness.id,
        agent: harness.agent,
      })),
      current: async (environment) => kiroCrewBackend(await kiroCrewMerged(environment)),
    },
  },
  configPath: kiroCrewPath,
  async read(environment) {
    const config = await kiroCrewMerged(environment);
    const backend = kiroCrewBackend(config);
    const harness = KIRO_CREW_HARNESSES.find((entry) => entry.id === backend);
    // myna's kiroCrewWired: the harness must itself be on the gateway.
    const connected =
      harness !== undefined &&
      (environment.connectedAgents === undefined ||
        environment.connectedAgents.includes(harness.agent));
    return { connected, model: null, baseUrl: null };
  },
  async connect(environment, _model, undo, hint) {
    const dir = kiroCrewDir(environment);
    const local = await readJsonObject(path.join(dir, "config.local.json"));
    if (kiroCrewBackend(local) !== null) {
      throw new Error(
        "Kiro Crew's config.local.json sets its harness, which wins over config.json; set it there to an agent connected to Neox.",
      );
    }
    const config = await readJsonObject(kiroCrewPath(environment));
    const current = hint ?? kiroCrewBackend(config);
    const connected = new Set(environment.connectedAgents ?? []);
    const picked =
      KIRO_CREW_HARNESSES.find((harness) => harness.id === current) ??
      KIRO_CREW_HARNESSES.find((harness) => connected.has(harness.agent));
    if (picked === undefined) {
      throw new Error(
        "Connect Codex, Claude Code, OpenCode, Pi or Goose to the gateway first: Kiro Crew runs one of them as its harness.",
      );
    }
    const captured: Record<string, PriorValue> = {};
    for (const key of ["agent.acp_backend", "agent.member_acp_backend"]) {
      capture(config, captured, key);
    }
    setAtValue(config, "agent.acp_backend", picked.id);
    if (picked.dispatch) setAtValue(config, "agent.member_acp_backend", picked.id);
    const entry = await writeJsonWithUndo(kiroCrewPath(environment), config, captured, undo);
    return jsonUndo([entry]);
  },
  async disconnect(environment, undo) {
    const filePath = kiroCrewPath(environment);
    if (!(await exists(filePath))) return;
    const root = await readJsonObject(filePath);
    const prior = priorJsonFiles(undo).find((file) => file.path === filePath);
    if (prior) restore(root, prior.values);
    await writeJsonWithUndo(filePath, root, {}, undo);
  },
};

// ---------- Reasonix Studio ----------

const REASONIX_KEY = "NEOLIX_REASONIX_API_KEY";
const REASONIX_OPEN = "# >>> neolix reasonix >>>";
const REASONIX_CLOSE = "# <<< neolix reasonix <<<";

function reasonixDir(environment: ConnectEnvironment): string {
  if ((environment.platform ?? process.platform) === "win32") {
    const override = envOverride(environment.env, "REASONIX_HOME");
    if (override !== null && path.isAbsolute(override)) return override;
    const appData = environment.env.APPDATA?.trim();
    return path.join(appData && appData.length > 0 ? appData : environment.homeDir, "reasonix");
  }
  return absoluteDir(environment, envOverride(environment.env, "REASONIX_HOME"), [".reasonix"]);
}

function reasonixPath(environment: ConnectEnvironment): string {
  return path.join(reasonixDir(environment), "config.toml");
}

function reasonixEnvPath(environment: ConnectEnvironment): string {
  return path.join(reasonixDir(environment), ".env");
}

/** Takes out the one [[providers]] entry Neolix wrote, between its markers. */
function stripReasonixBlock(text: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === REASONIX_OPEN);
  if (start < 0) return text;
  let end = lines.findIndex((line, index) => index > start && line.trim() === REASONIX_CLOSE);
  if (end < 0) end = lines.length - 1;
  const from = start > 0 && lines[start - 1] === "" ? start - 1 : start;
  return lines.filter((_, index) => index < from || index > end).join("\n");
}

function reasonixBlockText(environment: ConnectEnvironment, model: string | null): string {
  const lines = [
    REASONIX_OPEN,
    "[[providers]]",
    `name = ${tomlString(SLOT)}`,
    `kind = "openai"`,
    `base_url = ${tomlString(`${environment.baseUrl}/v1`)}`,
    `api_key_env = ${tomlString(REASONIX_KEY)}`,
  ];
  if (model !== null) {
    lines.push(`default = ${tomlString(model)}`, `model = ${tomlString(model)}`);
  }
  lines.push(
    `models = [${environment.models.map((entry) => tomlString(entry.id)).join(", ")}]`,
    REASONIX_CLOSE,
  );
  return lines.join("\n");
}

function reasonixDefaultModel(text: string): string | null {
  for (const line of text.split("\n")) {
    if (/^\s*\[/.test(line)) break;
    const match = /^\s*default_model\s*=\s*"([^"]*)"/.exec(line);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

const reasonixDriver: AgentConnectDriver = {
  provider: "reasonix",
  external: {
    name: "Reasonix Studio",
    icon: "reasonix-color",
    detect: async (environment) =>
      (await isOnPath("reasonix", environment)) || (await isDir(reasonixDir(environment))),
  },
  configPath: reasonixPath,
  async read(environment) {
    const text = (await readTextOrNull(reasonixPath(environment))) ?? "";
    const current = reasonixDefaultModel(text);
    const prefixed =
      current?.startsWith(`${SLOT}/`) === true ? current.slice(SLOT.length + 1) : null;
    const base = /^\s*base_url\s*=\s*"([^"]*)"/m.exec(text)?.[1] ?? null;
    return {
      connected: prefixed !== null && text.includes(REASONIX_OPEN),
      model: prefixed,
      baseUrl: base === null ? null : stripV1(base),
    };
  },
  async connect(environment, model, undo) {
    const filePath = reasonixPath(environment);
    const envPath = reasonixEnvPath(environment);
    const before = await readTextOrNull(filePath);
    const text = before ?? "";
    const previousParts = undoParts(undo);
    const previousConfig = previousParts.find(
      (part): part is Extract<AgentConnectUndo, { kind: "toml-tables" }> =>
        part.kind === "toml-tables",
    );
    const previousEnv = previousParts.find(
      (part): part is Extract<AgentConnectUndo, { kind: "env" }> => part.kind === "env",
    );
    const priorDefault = reasonixDefaultModel(text);
    const chosen = chosenModel(environment, model);
    const body = stripReasonixBlock(text).replace(/\s+$/, "");
    const block = reasonixBlockText(environment, chosen);
    let next = body.length === 0 ? block : `${body}\n\n${block}`;
    if (chosen !== null) {
      next = setTomlTopLevel(next, "default_model", `${SLOT}/${chosen}`);
    }
    const wrote = next.endsWith("\n") ? next : `${next}\n`;
    await writeText(filePath, wrote);
    const priorEnv =
      previousEnv?.values[REASONIX_KEY] ?? (await readEnvFile(envPath))[REASONIX_KEY] ?? null;
    await setEnvValues(envPath, { [REASONIX_KEY]: environment.apiKey });
    const configUndo: AgentConnectUndo = {
      kind: "toml-tables",
      path: filePath,
      before: previousConfig?.before ?? before,
      wrote: contentHash(wrote),
      sections: [],
      restore: previousConfig?.restore ?? [
        { header: "", key: "default_model", value: priorDefault },
      ],
    };
    return {
      kind: "multi",
      parts: [configUndo, { kind: "env", path: envPath, values: { [REASONIX_KEY]: priorEnv } }],
    };
  },
  async disconnect(environment, undo) {
    const filePath = reasonixPath(environment);
    const parts = undoParts(undo);
    const configUndo = parts.find(
      (part): part is Extract<AgentConnectUndo, { kind: "toml-tables" }> =>
        part.kind === "toml-tables",
    );
    const text = await readTextOrNull(filePath);
    if (text !== null && configUndo?.kind === "toml-tables") {
      if (contentHash(text) === configUndo.wrote) {
        if (configUndo.before === null) await fs.rm(filePath, { force: true });
        else await writeText(filePath, configUndo.before);
      } else {
        let next = stripReasonixBlock(text);
        const priorDefault = configUndo.restore.find((entry) => entry.key === "default_model");
        const current = reasonixDefaultModel(next);
        if (current?.startsWith(`${SLOT}/`) === true) {
          next =
            priorDefault?.value == null
              ? next
                  .split("\n")
                  .filter((line) => !/^\s*default_model\s*=/.test(line))
                  .join("\n")
              : setTomlTopLevel(next, "default_model", priorDefault.value);
        }
        await writeText(filePath, next);
      }
    }
    const envUndo = parts.find(
      (part): part is Extract<AgentConnectUndo, { kind: "env" }> => part.kind === "env",
    );
    if (envUndo?.kind !== "env") return;
    const envPath = reasonixEnvPath(environment);
    const prior = envUndo.values[REASONIX_KEY];
    if (prior === null || prior === undefined) {
      await removeEnvValues(envPath, [REASONIX_KEY]);
    } else {
      await setEnvValues(envPath, { [REASONIX_KEY]: prior });
    }
  },
};

export const BATCH3_AGENT_DRIVERS: AgentConnectDriver[] = [kiroCrewDriver, reasonixDriver];
