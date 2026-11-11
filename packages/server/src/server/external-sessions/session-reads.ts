import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { GATEWAY_CONFIG_FILENAME } from "../llm-gateway/config.js";
import {
  EXTERNAL_SESSION_AGENTS,
  agentLabel,
  resolveSessionRoots,
  type ExternalSessionAgentId,
} from "./sources.js";

/**
 * Which agents' own session files Neolix may read, myna's SessionReads
 * (internal/settings/settings.go:1793). Asked false reads none; then a named
 * agent is read as it says and the rest as `all`. The setting lives in
 * gateway.json because that is where Neolix already keeps it
 * (llm-gateway/config.ts codexSessionReads), and the daemon watches that file,
 * so a change made by `neolix sessions read` takes effect without a restart.
 *
 * An install with no value reads every agent. myna settles a new setting the
 * same way for an install that read sessions before the consent existed
 * (sessions/access.go readBefore); Neolix has always read these sessions, so
 * every install is that case. A fresh install therefore is not asked, it is
 * answered; `sessions read` can still turn an agent off.
 */
export interface SessionReads {
  asked: boolean;
  all: boolean;
  agents: Record<string, boolean>;
}

export const DEFAULT_SESSION_READS: SessionReads = { asked: true, all: true, agents: {} };

interface SessionReadsConfig {
  codexSessionReads?: {
    asked?: boolean | undefined;
    all?: boolean | undefined;
    agents?: Record<string, boolean> | undefined;
  };
}

/** The setting a parse gateway.json holds, or the settled default when it holds none. */
export function sessionReadsOf(config: SessionReadsConfig | undefined): SessionReads {
  const value = config?.codexSessionReads;
  if (value === undefined) {
    return DEFAULT_SESSION_READS;
  }
  return {
    asked: value.asked === true,
    all: value.all === true,
    agents: { ...value.agents },
  };
}

/** Whether Neolix may read agent's sessions. */
export function readsSessions(reads: SessionReads, agent: string): boolean {
  if (!reads.asked) {
    return false;
  }
  const named = reads.agents[agent];
  return named ?? reads.all;
}

/**
 * The setting `neolix sessions read on|off` leaves behind: myna's SetReads
 * (sessions/access.go:117). `all` is whether an agent nobody named is read;
 * each named agent is as given and the others stay as they were.
 */
export function setSessionReads(
  current: SessionReads,
  all: boolean | undefined,
  agents: Record<string, boolean>,
): SessionReads {
  return {
    asked: true,
    all: all ?? current.all,
    agents: { ...current.agents, ...agents },
  };
}

/** Reads gateway.json without starting a daemon; an unreadable file reads every agent. */
export async function readSessionReads(neolixHome: string): Promise<SessionReads> {
  let raw: string;
  try {
    raw = await readFile(path.join(neolixHome, GATEWAY_CONFIG_FILENAME), "utf8");
  } catch {
    return DEFAULT_SESSION_READS;
  }
  try {
    return sessionReadsOf(JSON.parse(raw) as SessionReadsConfig);
  } catch {
    // The daemon keeps the last good gateway.json when a file is malformed;
    // the default is what it falls back to when it has none.
    return DEFAULT_SESSION_READS;
  }
}

/** The folders each agent keeps its sessions in, for `sessions read` to name. */
export function sessionRoots(
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Record<ExternalSessionAgentId, string> {
  const roots = resolveSessionRoots(homeDir, env);
  return {
    claude: path.join(roots.claude, "projects"),
    codex: path.join(roots.codex, "sessions"),
    pi: roots.pi,
    opencode: roots.opencode,
    agy: path.join(roots.agy, "brain"),
  };
}

/**
 * The agents with a session store on this computer, by a look at their
 * folders only (myna's sessions.Found): what `sessions read` lists. WSL
 * distros are not looked into; allowing all covers them.
 */
export async function foundSessionAgents(
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const roots = sessionRoots(homeDir, env);
  const out: string[] = [];
  for (const agent of EXTERNAL_SESSION_AGENTS) {
    if (await exists(roots[agent])) {
      out.push(agent);
    }
  }
  return out;
}

/** What `sessions.reads.get` and `.set` answer, as myna's /api/sessions/reads does. */
export interface SessionReadsSnapshot {
  asked: boolean;
  all: boolean;
  found: { agent: string; name: string; on: boolean }[];
}

/**
 * The setting with the agents it covers: those found on this computer and
 * any the setting names but the folders no longer show (myna's Found plus
 * the setting's own agents, so a row never disappears with its agent).
 */
export function sessionReadsSnapshot(
  reads: SessionReads,
  found: readonly string[],
): SessionReadsSnapshot {
  const agents = [...new Set([...found, ...Object.keys(reads.agents)])].sort();
  return {
    asked: reads.asked,
    all: reads.all,
    found: agents.map((agent) => ({
      agent,
      name: sessionAgentName(agent),
      on: readsSessions(reads, agent),
    })),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** The name the consent lines print for an agent. */
export function sessionAgentName(agent: string): string {
  return agentLabel(agent);
}

/** The agents a consent line may name besides those found on this computer. */
export function knownSessionAgents(): readonly string[] {
  return EXTERNAL_SESSION_AGENTS;
}

/**
 * The sessions command's refusal when an agent is not allowed, worded as
 * myna's ErrNotRead. The reader throws it; the CLI prints its message.
 */
export class SessionNotReadError extends Error {
  constructor() {
    super("Neox is not allowed to read this agent's sessions (Settings, Sessions)");
    this.name = "SessionNotReadError";
  }
}
