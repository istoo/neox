// FILE: agentProfiles.ts
// Purpose: Shared shape rules for agent profiles: ids, provider/runtime validation, and
//          sanitizing the per-provider launch options a profile carries.
// Layer: Web settings/chat logic
// Exports: profile wire helpers, provider option sanitizer, and the runtime-mode list.

import {
  ProviderKind,
  RuntimeMode,
  type ProviderKind as ProviderKindType,
} from "@synara/contracts";
import * as Schema from "effect/Schema";

import type { NeolixAgentProfileWire } from "~/lib/neolixHostApi";

/** Access modes this front end can write into a profile's `modeId`. */
export const AGENT_PROFILE_RUNTIME_MODES = [
  "approval-required",
  "accept-edits",
  "auto",
  "full-access",
] as const;

const isProviderKind = Schema.is(ProviderKind);
const isRuntimeModeSchema = Schema.is(RuntimeMode);

export function isAgentProfileProvider(value: unknown): value is ProviderKindType {
  return isProviderKind(value);
}

export function isAgentProfileRuntimeMode(value: unknown): value is RuntimeMode {
  return isRuntimeModeSchema(value);
}

/** Profile ids are opaque to the daemon; a client only has to keep them unique per host. */
export function generateAgentProfileId(): string {
  const cryptoApi = typeof globalThis.crypto === "undefined" ? null : globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Option keys the composer actually sets for each provider. A profile is host config and
 * may have been edited or written by another client, so only these keys are carried back
 * into launch options; anything else would leak into the provider's process config.
 */
const PROVIDER_OPTION_KEYS: Record<ProviderKindType, readonly string[]> = {
  codex: ["reasoningEffort", "fastMode"],
  claudeAgent: ["thinking", "effort", "fastMode", "autoCompactWindow", "contextWindow"],
  cursor: ["reasoningEffort", "fastMode", "thinking", "contextWindow"],
  devin: ["reasoningEffort", "fastMode", "thinking", "contextWindow", "modelVariant"],
  antigravity: ["reasoningEffort"],
  grok: ["reasoningEffort"],
  droid: ["reasoningEffort"],
  opencode: ["variant", "agent"],
  pi: ["thinkingLevel"],
  omp: ["thinkingLevel"],
};

const BOOLEAN_OPTION_KEYS: ReadonlySet<string> = new Set(["thinking", "fastMode"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The launch options a stored profile may restore, restricted to keys the provider's
 * composer controls own. Arrays, nested objects, and unknown values are dropped rather
 * than passed through to the agent process.
 */
export function sanitizeAgentProfileProviderOptions(
  provider: ProviderKindType,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of PROVIDER_OPTION_KEYS[provider]) {
    const option = value[key];
    if (option === undefined) continue;
    if (BOOLEAN_OPTION_KEYS.has(key)) {
      if (typeof option === "boolean") result[key] = option;
      continue;
    }
    if (typeof option === "string" && option.trim().length > 0) result[key] = option;
  }
  return result;
}

/** False when a profile names a provider this build cannot run. */
export function agentProfileProvider(profile: NeolixAgentProfileWire): ProviderKindType | null {
  return isAgentProfileProvider(profile.provider) ? profile.provider : null;
}

/** The trimmed model id, or "" when the profile leaves the model on the provider default. */
export function agentProfileModel(profile: NeolixAgentProfileWire): string {
  return profile.model?.trim() ?? "";
}

/** Message copy for a failed profile write; kept out of try/catch value blocks. */
export function agentProfileErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * A profile capturing the composer's current setup. Blank model and notes are omitted so
 * applying the profile leaves those controls alone, and launch options only survive the
 * provider's own allowlist.
 */
export function buildAgentProfileFromComposer(input: {
  id: string;
  name: string;
  provider: ProviderKindType;
  model?: string | null;
  modeId?: string | null;
  providerOptions?: unknown;
  notes?: string | null;
}): NeolixAgentProfileWire {
  const model = input.model?.trim() ?? "";
  const notes = input.notes?.trim() ?? "";
  const providerOptions = sanitizeAgentProfileProviderOptions(
    input.provider,
    input.providerOptions,
  );
  return {
    id: input.id,
    name: input.name.trim(),
    provider: input.provider,
    ...(model ? { model } : {}),
    ...(isAgentProfileRuntimeMode(input.modeId) ? { modeId: input.modeId } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    ...(notes ? { notes } : {}),
  };
}
