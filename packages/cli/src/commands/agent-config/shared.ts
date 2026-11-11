import type { AgentConnectEntry, AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import { AGENT_PROVIDER_DEFINITIONS } from "@neolix/protocol/provider-manifest";
import { connectToDaemon } from "../../utils/client.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";

/**
 * What myna's own agent commands read and write: `myna agents`, `myna ls`'s
 * detected rows, `myna <agent> [model|field]`, `myna visible` and the
 * profiles (internal/cli/main.go:57-70, 92-94, 159, 495). The daemon owns the
 * wiring and these settings, so each command asks it; the argument forms and
 * the wording are myna's.
 */

/** myna's agents, the ones `myna <agent>` takes (internal/cli/main.go:174). */
export const AGENT_COMMAND_IDS = [
  "claude",
  "codex",
  "gemini",
  "opencode",
  "mimocode",
  "deveco",
  "pi",
  "goose",
  "cursor",
  "zed",
  "copilot",
  "crush",
  "aside",
  // Neolix's own provider, beside myna's list.
  "omp",
] as const;

/** A field an agent's own config holds, as myna's `<agent> <field>` takes it. */
export interface AgentFieldDefinition {
  key: string;
  label: string;
}

/**
 * myna's fields per agent, for help and for naming an unknown one without
 * asking the daemon (internal/agent/claude.go, codex.go, agents.go, pi.go).
 */
export const AGENT_FIELDS: Record<string, AgentFieldDefinition[]> = {
  claude: [
    { key: "model", label: "model" },
    { key: "effort", label: "effort" },
    { key: "ultracode", label: "ultracode" },
    { key: "subagent", label: "subagents" },
    { key: "subagent_effort", label: "subagent effort" },
    { key: "auto_mode", label: "auto mode" },
    { key: "login", label: "sign-in" },
    { key: "statusline", label: "status line" },
  ],
  codex: [
    { key: "model", label: "model" },
    { key: "effort", label: "effort" },
    { key: "subagent", label: "subagents" },
    { key: "subagent_model", label: "subagent model" },
    { key: "subagent_effort", label: "subagent effort" },
    { key: "memories", label: "memories" },
    { key: "login", label: "sign-in" },
  ],
  opencode: [
    { key: "model", label: "model" },
    { key: "small", label: "small" },
  ],
  pi: [{ key: "model", label: "model" }],
};

/** The fields an agent takes; every agent takes its model. */
export function fieldsOf(id: string): AgentFieldDefinition[] {
  return AGENT_FIELDS[canonicalAgentId(id)] ?? [{ key: "model", label: "model" }];
}

/** The fields an agent's row carries now, else the ones it is known for. */
export function fieldDefinitions(
  id: string,
  settings: { key: string; label: string }[] | undefined,
): AgentFieldDefinition[] {
  return settings !== undefined && settings.length > 0
    ? settings.map((entry) => ({ key: entry.key, label: entry.label }))
    : fieldsOf(id);
}

/** myna's short names for an agent (internal/agent's aliases): `myna cc`. */
export const AGENT_ALIASES: Record<string, string> = {
  cc: "claude",
  oc: "opencode",
};

const PROVIDER_LABELS = new Map(AGENT_PROVIDER_DEFINITIONS.map((item) => [item.id, item.label]));

export interface AgentCliOptions {
  home?: string;
  host?: string;
}

export function canonicalAgentId(id: string): string {
  const lower = id.toLowerCase();
  return AGENT_ALIASES[lower] ?? lower;
}

/** myna's agent name: the one it lists, its provider's label, or its id. */
export function agentLabel(entry: Pick<AgentConnectEntry, "provider" | "name">): string {
  return entry.name ?? PROVIDER_LABELS.get(entry.provider) ?? entry.provider;
}

/** The name without a daemon to ask: the provider's label, or the id capitalized. */
export function staticAgentLabel(id: string): string {
  const canonical = canonicalAgentId(id);
  const known = PROVIDER_LABELS.get(canonical);
  if (known !== undefined) return known;
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
}

/** The row for an agent, by its id, its alias or the name it goes by. */
export function findAgentEntry(
  snapshot: AgentConnectSnapshot,
  id: string,
): AgentConnectEntry | undefined {
  const wanted = canonicalAgentId(id);
  return (
    snapshot.entries.find((entry) => entry.provider.toLowerCase() === wanted) ??
    snapshot.entries.find((entry) => (entry.name ?? "").toLowerCase() === wanted)
  );
}

export function requireAgentEntry(snapshot: AgentConnectSnapshot, id: string): AgentConnectEntry {
  const entry = findAgentEntry(snapshot, id);
  if (entry === undefined) {
    throw new Error(`no agent "${id}" on this host (neox agents lists them)`);
  }
  return entry;
}

/** A write's error, said as the command's failure rather than a stale row. */
export function checkedSnapshot(snapshot: AgentConnectSnapshot): AgentConnectSnapshot {
  if (snapshot.error !== null) {
    throw new Error(snapshot.error);
  }
  return snapshot;
}

export type AgentConnectClient = Awaited<ReturnType<typeof connectToDaemon>>;

export async function withAgentConnect<T>(
  options: AgentCliOptions,
  work: (client: AgentConnectClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({
    target: selectDaemonTarget({ home: options.home, host: options.host }),
  });
  try {
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** myna's tilde: a path under the home directory as `~/…`. */
export function tilde(value: string | null): string {
  if (value === null) return "";
  const home = process.env.HOME;
  if (home !== undefined && value.startsWith(home)) {
    return `~${value.slice(home.length)}`;
  }
  return value;
}

/** The help myna prints for `myna <agent> --help` (internal/cli/help_cli.go:123). */
export function agentHelpText(id: string, label: string): string {
  const fields = fieldsOf(id);
  return `${label}

  neox ${id}                  show it
  neox ${id} <model>          set its model   (neox models lists them)
  neox ${id} <field>          show a field
  neox ${id} <field> <value>  set it
  neox ${id} default          take Neox out: back on what it had before
  neox ${id} <field> default  the field back to the agent's own

fields: ${fields.map((field) => field.key).join(", ")}`;
}

/** An argument to an agent command that is a flag: no form takes one. */
export function flagArgument(args: readonly string[]): string | null {
  for (const value of args) {
    if (!value.startsWith("-")) continue;
    if (Number.isFinite(Number(value))) continue;
    return value;
  }
  return null;
}
