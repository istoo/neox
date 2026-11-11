import type {
  ExternalSession,
  ExternalSessionHit,
  ExternalSubagent,
  ExternalTranscriptPart,
} from "@neolix/protocol/messages";

export const GATEWAY_GROUP = "\u0000gateway";

export interface SessionGroup {
  key: string;
  name: string;
  where: string;
  sessions: ExternalSession[];
  latest: ExternalSession;
  scratch: boolean;
}

export interface SessionGroups {
  projects: SessionGroup[];
  others: SessionGroup[];
}

export function groupSessions(sessions: readonly ExternalSession[], home: string): SessionGroups {
  const groups = new Map<string, ExternalSession[]>();
  for (const session of sessions) {
    const key = groupKeyOf(session);
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }
  const projects: SessionGroup[] = [];
  const others: SessionGroup[] = [];
  for (const [key, list] of groups) {
    const group = {
      key,
      name: groupName(key, isGatewayGroup(key)),
      where: key === "" || key === GATEWAY_GROUP ? "" : parentPath(key, home),
      sessions: list,
      latest: latestOf(list),
      scratch: isScratchGroup(key),
    };
    if (group.scratch) {
      others.push(group);
    } else {
      projects.push(group);
    }
  }
  return { projects, others };
}

export function groupKeyOf(session: ExternalSession): string {
  if (session.cwd.length > 0) {
    return session.cwd;
  }
  return session.gateway === true ? GATEWAY_GROUP : "";
}

function isGatewayGroup(key: string): boolean {
  return key === GATEWAY_GROUP;
}

function groupName(key: string, gateway: boolean): string {
  if (gateway) {
    return "";
  }
  if (key.length === 0) {
    return "";
  }
  return baseName(key);
}

function latestOf(sessions: readonly ExternalSession[]): ExternalSession {
  return sessions.reduce((latest, session) => (session.last > latest.last ? session : latest));
}

/** Folders apps and the system made, not projects the reader chose. */
export function isScratchGroup(key: string): boolean {
  if (key.length === 0 || key === GATEWAY_GROUP) {
    return false;
  }
  const normalized = key.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  const withoutDrive = normalized[1] === ":" ? normalized.slice(2) : normalized;
  const driveOnly = normalized.length === 2 && normalized.endsWith(":");
  const temp =
    withoutDrive === "/tmp" ||
    withoutDrive.startsWith("/tmp/") ||
    withoutDrive.startsWith("/private/tmp") ||
    withoutDrive.startsWith("/var/tmp") ||
    withoutDrive.startsWith("/var/folders") ||
    withoutDrive.includes("/appdata/local/temp");
  const hiddenHome =
    withoutDrive.startsWith("/users/") || withoutDrive.startsWith("/home/")
      ? withoutDrive.split("/")[2]?.startsWith(".") === true
      : withoutDrive.startsWith("/root/.");
  return driveOnly || temp || hiddenHome;
}

export function baseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/** The folder a project is in, with the home folder as `~`. */
export function parentPath(value: string, home: string): string {
  const trimmed = value.replace(/[\\/]+$/u, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  let parent = "";
  if (at === 0) {
    parent = "/";
  } else if (at > 0) {
    parent = trimmed.slice(0, at);
  }
  if (home.length === 0 || parent.length === 0) {
    return parent;
  }
  if (parent === home) {
    return "~";
  }
  if (parent.startsWith(`${home}/`) || parent.startsWith(`${home}\\`)) {
    return `~${parent.slice(home.length)}`;
  }
  return parent;
}

/** The row's filter: what the page already shows, plus what the search found. */
export function filterSessions(
  sessions: readonly ExternalSession[],
  query: string,
  hits: ReadonlyMap<string, ExternalSessionHit>,
): ExternalSession[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...sessions];
  }
  return sessions.filter((session) => {
    if (hits.has(session.id)) {
      return true;
    }
    const fields = [
      session.title,
      session.cwd,
      session.id,
      ...session.models.map((model) => model.model),
    ];
    return fields.some((field) => field.toLowerCase().includes(needle));
  });
}

/**
 * What a session ran on, the first two and how many more, then what the
 * gateway served it with: `claude-opus-5-5 → deepseek-v4.1-flash · high`.
 */
export function modelsText(session: ExternalSession): string {
  const names = session.models.slice(0, 2).map((model) => model.model);
  const more = session.models.length > 2 ? ` +${session.models.length - 2}` : "";
  const models = names.join(", ") + more;
  const via = session.via?.[0];
  if (via === undefined) {
    return models;
  }
  const served = [via.model, via.effort].filter(Boolean).join(" · ");
  const extra =
    session.via !== undefined && session.via.length > 1 ? ` +${session.via.length - 1}` : "";
  return `${models} → ${served}${extra}`;
}

export function costText(cost: number, locale: string): string {
  const digits = cost < 0.01 ? 4 : 2;
  return cost.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** The gateway-only sessions have no folder; their row says so. */

/** The page's translation function: keys under its own namespace. */
export interface SessionsT {
  (key: string, options?: Record<string, unknown>): string;
}

export interface SubagentNode {
  sub: ExternalSubagent;
  depth: number;
}

// debt: deeper nests than this show flat; raise it with the fold's indentation.
const SUBAGENT_DEPTH = 8;

/** A session's subagents as they started one another, each with its depth. */
export function subagentTree(subagents: readonly ExternalSubagent[]): SubagentNode[] {
  const ids = new Set(subagents.map((sub) => sub.id));
  const under = new Map<string, ExternalSubagent[]>();
  for (const sub of subagents) {
    const parent =
      sub.parent !== undefined && sub.parent !== sub.id && ids.has(sub.parent) ? sub.parent : "";
    const list = under.get(parent) ?? [];
    list.push(sub);
    under.set(parent, list);
  }
  const out: SubagentNode[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number): void => {
    for (const sub of under.get(parent) ?? []) {
      if (seen.has(sub.id)) {
        continue;
      }
      seen.add(sub.id);
      out.push({ sub, depth: Math.min(depth, SUBAGENT_DEPTH) });
      walk(sub.id, depth + 1);
    }
  };
  walk("", 0);
  // One in a loop of parents is still shown, at the top.
  for (const sub of subagents) {
    if (seen.has(sub.id)) {
      continue;
    }
    seen.add(sub.id);
    out.push({ sub, depth: 0 });
    walk(sub.id, 1);
  }
  return out;
}

/** Codex sessions its history doesn't list: made with another provider. */
export function hiddenProviderSessions(sessions: readonly ExternalSession[]): ExternalSession[] {
  return sessions.filter(
    (session) =>
      session.agent === "codex" &&
      session.deletable &&
      session.provider !== undefined &&
      session.provider.length > 0 &&
      session.usesProvider !== undefined &&
      session.usesProvider.length > 0 &&
      session.provider !== session.usesProvider,
  );
}

export interface TalkLine {
  key: string;
  part: ExternalTranscriptPart;
  /** Said only where the speaker changes, as the conversation reads. */
  heading: "user" | "assistant" | null;
  /** The reply's model, at its first part and where it changes. */
  model: string;
}

/** What was said, with the speaker headings and models the page shows. */
export function talkLines(parts: readonly ExternalTranscriptPart[]): TalkLine[] {
  const out: TalkLine[] = [];
  let who = "";
  let said = "";
  let fresh = true;
  for (const [index, part] of parts.entries()) {
    let model = "";
    if (part.role === "assistant") {
      if (part.model !== undefined && part.model.length > 0 && (fresh || part.model !== said)) {
        model = part.model;
      }
      said = part.model ?? "";
      fresh = false;
    } else if (part.role === "user") {
      fresh = true;
    }
    let heading: TalkLine["heading"] = null;
    if (part.role !== "tool" && part.role !== who) {
      heading = part.role === "assistant" ? "assistant" : "user";
      who = part.role;
    }
    out.push({ key: `${index}:${part.role}:${part.kind}`, part, heading, model });
  }
  return out;
}
