import type { AgentConnectSnapshot } from "@neolix/protocol/agent-connect";
import type { GatewayGroup } from "@neolix/server/gateway-config";
import { connectToDaemon } from "../../utils/client.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";

/**
 * Which agents are set to a routing group, and which have to be moved off one
 * that stops being served (myna's groupUses and agent.Reseat), read from the
 * agent-connect snapshot's `model` per agent. The daemon writes those config
 * files, so this needs it; without one the answers are empty and nothing moves.
 */

/** A token the gateway answers, `group/<id>`, with a Claude [1m] mark allowed. */
export function agentGroupId(model: string | null | undefined): string | null {
  if (typeof model !== "string") {
    return null;
  }
  const clean = model.trim().replace(/\[1m\]$/, "");
  if (!clean.startsWith("group/")) {
    return null;
  }
  const id = clean.slice("group/".length).split(":")[0] ?? "";
  return id === "" ? null : id;
}

function modelsOf(entry: AgentConnectSnapshot["entries"][number]): string[] {
  const models: string[] = [];
  if (entry.model !== null) {
    models.push(entry.model);
  }
  for (const field of entry.fields ?? []) {
    if (field.model !== null) {
      models.push(field.model);
    }
  }
  return models;
}

/** myna's groupUses: group id → the agents set to it, connected ones only. */
export function agentUses(snapshot: AgentConnectSnapshot): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of snapshot.entries) {
    if (!entry.connected) {
      continue;
    }
    const name = entry.name ?? entry.provider;
    for (const model of modelsOf(entry)) {
      const id = agentGroupId(model);
      if (id === null) {
        continue;
      }
      const agents = out.get(id) ?? [];
      if (!agents.includes(name)) {
        agents.push(name);
      }
      out.set(id, agents);
    }
  }
  return out;
}

export interface AgentMove {
  provider: string;
  name: string;
  from: string;
  to: string;
}

/**
 * myna's agent.Reseat after a change: an agent set to a found group that is
 * no longer served moves to the first of that group's models.
 */
export function reseatPlan(
  before: readonly GatewayGroup[],
  after: readonly GatewayGroup[],
  snapshot: AgentConnectSnapshot,
): AgentMove[] {
  const still = new Set(after.map((group) => group.id));
  const was = new Map(before.map((group) => [group.id, group]));
  const moves: AgentMove[] = [];
  for (const entry of snapshot.entries) {
    if (!entry.connected) {
      continue;
    }
    const name = entry.name ?? entry.provider;
    for (const model of modelsOf(entry)) {
      const id = agentGroupId(model);
      if (id === null || still.has(id)) {
        continue;
      }
      const group = was.get(id);
      const to = group?.members[0];
      if (to === undefined) {
        continue;
      }
      if (moves.some((move) => move.provider === entry.provider && move.to === to)) {
        continue;
      }
      moves.push({ provider: entry.provider, name, from: `group/${id}`, to });
    }
  }
  return moves;
}

export type AgentConnectSource = () => Promise<AgentConnectSnapshot | null>;

async function liveSnapshot(): Promise<AgentConnectSnapshot | null> {
  try {
    const client = await connectToDaemon({ target: selectDaemonTarget({}), timeout: 1500 });
    try {
      const payload = await client.getAgentConnect();
      return payload.snapshot;
    } finally {
      await client.close();
    }
  } catch {
    return null;
  }
}

let source: AgentConnectSource = liveSnapshot;

/** A test's snapshot, in place of the daemon's. */
export function setAgentConnectSource(next: AgentConnectSource): void {
  source = next;
}

export async function connectedAgents(): Promise<AgentConnectSnapshot | null> {
  return source();
}

export type AgentMoveApplier = (moves: readonly AgentMove[]) => Promise<string[]>;

async function liveReseat(moves: readonly AgentMove[]): Promise<string[]> {
  if (moves.length === 0) {
    return [];
  }
  const moved: string[] = [];
  try {
    const client = await connectToDaemon({ target: selectDaemonTarget({}), timeout: 1500 });
    try {
      for (const move of moves) {
        await client.setAgentConnect({
          provider: move.provider,
          connected: true,
          model: move.to,
        });
        moved.push(`${move.name} is on ${move.to} now`);
      }
    } finally {
      await client.close();
    }
  } catch {
    // no daemon: the group change stands, the agents keep their model
  }
  return moved;
}

let applier: AgentMoveApplier = liveReseat;

/** A test's mover, in place of the daemon's. */
export function setAgentMoveApplier(next: AgentMoveApplier): void {
  applier = next;
}

/** Moves the agents a change re-seated; says which moved, by name and model. */
export async function applyReseat(moves: readonly AgentMove[]): Promise<string[]> {
  return applier(moves);
}
