import { readFile } from "node:fs/promises";
import path from "node:path";

import type { PartFileInput } from "./archive.js";
import { writeConfig } from "./parts.js";

/**
 * "Kept on this computer": the agent fields a sync wrote over a value the
 * user picked here, and that the user then put back (myna `own.go`,
 * hayden4608 on Discord). From then on a sync neither brings that field in
 * nor takes this computer's value up, while everything else still syncs.
 *
 * Neolix's agent fields are one level under `config.json`'s
 * `agents.providers.<agent>`; each of them is one key, `"<agent>.<field>"`.
 */
export const OWN_FIELDS = ["command", "env", "disallowedTools"] as const;

/** `"claude.env"` to the JSON of its value. */
export type AgentFields = Record<string, string>;

export interface OwnField {
  agent: string;
  field: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldsFromConfig(config: unknown): AgentFields {
  const out: AgentFields = {};
  const agents = isRecord(config) ? config.agents : undefined;
  const providers = isRecord(agents) ? agents.providers : undefined;
  if (!isRecord(providers)) {
    return out;
  }
  for (const [agent, settings] of Object.entries(providers)) {
    if (!isRecord(settings)) {
      continue;
    }
    for (const field of OWN_FIELDS) {
      if (settings[field] !== undefined) {
        out[`${agent}.${field}`] = JSON.stringify(settings[field]);
      }
    }
  }
  return out;
}

/** This computer's agent fields, as the last sync left them here. */
export async function readAgentFields(neolixHome: string): Promise<AgentFields> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(neolixHome, "config.json"), "utf8"),
    );
    return fieldsFromConfig(parsed);
  } catch {
    return {};
  }
}

/**
 * The models files without this computer's own fields: what is hashed and
 * pushed, so an own field is no change to send and the server's value of
 * one is no change to bring (myna `withoutOwn`).
 */
export function stripOwnFields(
  files: readonly PartFileInput[],
  own: Readonly<Record<string, boolean>> | undefined,
): PartFileInput[] {
  if (!own || Object.keys(own).length === 0) {
    return [...files];
  }
  return files.map((file) => {
    if (file.path !== "models.json") {
      return file;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(file.content).toString("utf8"));
    } catch {
      return file;
    }
    const agents = isRecord(parsed) ? parsed.agents : undefined;
    const providers = isRecord(agents) ? agents.providers : undefined;
    if (!isRecord(providers)) {
      return file;
    }
    for (const key of Object.keys(own)) {
      const dot = key.indexOf(".");
      const agent = key.slice(0, dot);
      const field = key.slice(dot + 1);
      const settings = providers[agent];
      if (dot > 0 && isRecord(settings)) {
        delete settings[field];
      }
    }
    return { ...file, content: `${JSON.stringify(parsed, null, 2)}\n` };
  });
}

/** Puts this computer's own field values back after a pull wrote over them. */
export async function restoreOwnFields(
  neolixHome: string,
  own: Readonly<Record<string, boolean>> | undefined,
  values: AgentFields,
): Promise<void> {
  if (!own || Object.keys(own).length === 0) {
    return;
  }
  const file = path.join(neolixHome, "config.json");
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(parsed)) {
      return;
    }
    config = parsed;
  } catch {
    return;
  }
  const agents = isRecord(config.agents) ? config.agents : {};
  const providers = isRecord(agents.providers) ? agents.providers : {};
  let changed = false;
  for (const key of Object.keys(own)) {
    const value = values[key];
    if (value === undefined) {
      continue;
    }
    const dot = key.indexOf(".");
    const agent = key.slice(0, dot);
    const field = key.slice(dot + 1);
    if (dot <= 0) {
      continue;
    }
    const settings = isRecord(providers[agent]) ? providers[agent] : {};
    settings[field] = JSON.parse(value);
    providers[agent] = settings;
    changed = true;
  }
  if (!changed) {
    return;
  }
  agents.providers = providers;
  config.agents = agents;
  await writeConfig(file, config);
}

/** The own fields as the settings page's rows. */
export function ownList(own: Readonly<Record<string, boolean>> | undefined): OwnField[] {
  return Object.keys(own ?? {})
    .sort()
    .map((key) => {
      const dot = key.indexOf(".");
      return { agent: key.slice(0, dot), field: key.slice(dot + 1) };
    });
}

/** What one sync wrote here, for a field the user later puts back. */
export interface OwnState {
  /** Each field's value as the last sync that changed it here wrote it. */
  brought?: Record<string, string>;
  /** The value picked here that sync wrote over, when it was one. */
  replaced?: Record<string, string>;
  /** Fields put back here since. */
  own?: Record<string, boolean>;
  /** The next sync brings the server's values of the own fields back in. */
  follow?: boolean;
}

/**
 * Marks own each field sync wrote over a pick, put back to that pick here
 * since; another value picked since is a pick like any other (myna
 * `noticeOwn`).
 */
export function noticeOwn(state: OwnState, here: AgentFields): void {
  for (const [key, brought] of Object.entries(state.brought ?? {})) {
    const now = here[key];
    if (now === undefined || now === brought) {
      continue;
    }
    if (state.replaced?.[key] === now) {
      state.own = { ...state.own, [key]: true };
    }
    if (state.brought) {
      delete state.brought[key];
    }
    if (state.replaced) {
      delete state.replaced[key];
    }
  }
}

/** Records what a pull changed, before it is applied and after. */
export function noteBrought(state: OwnState, before: AgentFields, after: AgentFields): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (before[key] === after[key]) {
      continue;
    }
    const was = before[key];
    if (was !== undefined && state.brought?.[key] !== was) {
      state.replaced = { ...state.replaced, [key]: was };
    }
    if (after[key] === undefined) {
      delete state.brought?.[key];
    } else {
      state.brought = { ...state.brought, [key]: after[key] };
    }
  }
}
