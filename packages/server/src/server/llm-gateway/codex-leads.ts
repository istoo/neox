/**
 * The model each Codex conversation's own turns last went on (myna's
 * codexLeads, `internal/gateway/codex_follow.go:36`). A subagent request
 * names its lead by the parent thread in its turn metadata; with no turn
 * seen for that thread yet, the key's last own turn stands in.
 */

interface Lead {
  model: string;
  at: number;
}

/** How many conversations are kept, as myna's codexLeadsCap. */
const LEADS_CAP = 512;

const byThread = new Map<string, Lead>();
const byKey = new Map<string, Lead>();

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A turn's identity fields, from the metadata Codex sends (title-link's shape). */
function identityOf(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>,
): { thread: string; parent: string; forked: string } {
  const client = isRecord(body.client_metadata) ? body.client_metadata : {};
  const raw = client["x-codex-turn-metadata"] ?? headerValue(headers, "x-codex-turn-metadata");
  let turn: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      turn = isRecord(parsed) ? parsed : {};
    } catch {
      turn = {};
    }
  }
  return {
    thread: stringOf(turn.thread_id) ?? stringOf(client.thread_id) ?? "",
    parent:
      stringOf(turn.parent_thread_id) ??
      stringOf(client.parent_thread_id) ??
      stringOf(client["x-codex-parent-thread-id"]) ??
      headerValue(headers, "x-codex-parent-thread-id"),
    forked: stringOf(turn.forked_from_thread_id) ?? stringOf(client.forked_from_thread_id) ?? "",
  };
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Notes a Codex conversation's own turn on `model` (myna's codexLeads.saw). */
export function noteCodexLead(input: {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  key: string;
  model: string;
  now?: number;
}): void {
  if (input.model.length === 0) {
    return;
  }
  const at = input.now ?? Date.now();
  byKey.set(input.key, { model: input.model, at });
  const { thread } = identityOf(input.headers, input.body);
  if (thread.length === 0) {
    return;
  }
  if (!byThread.has(thread) && byThread.size >= LEADS_CAP) {
    let oldest = "";
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, lead] of byThread) {
      if (lead.at < oldestAt) {
        oldest = id;
        oldestAt = lead.at;
      }
    }
    byThread.delete(oldest);
  }
  byThread.set(thread, { model: input.model, at });
}

/**
 * The model the conversation a subagent request belongs to ran on: the
 * parent thread's, the thread it forked from, else its own, else the
 * key's last own turn (myna's codexLeads.lookup).
 */
export function codexLeadModel(input: {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  key: string;
}): string | null {
  const { thread, parent, forked } = identityOf(input.headers, input.body);
  for (const id of [parent, forked, thread]) {
    if (id.length === 0) {
      continue;
    }
    const lead = byThread.get(id);
    if (lead !== undefined) {
      return lead.model;
    }
  }
  return byKey.get(input.key)?.model ?? null;
}

/** Forgets every lead, for a test. */
export function clearCodexLeads(): void {
  byThread.clear();
  byKey.clear();
}
