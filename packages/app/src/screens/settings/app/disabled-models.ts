import type { GatewayConfigWire, GatewayProviderWire } from "@neolix/protocol/gateway";

/**
 * myna's DisabledModels as the Models › Disabled models page shows it: a
 * pattern, `*` any run and `?` one, matched case-insensitively against a
 * model's `provider/model` and its bare id (the daemon's
 * model-prefs.ts globMatch does the refusing; this only counts the hits).
 */

export interface DisabledModelChoice {
  /** `provider/model`, what a pick adds to the list. */
  id: string;
  /** The model's own id, the other name a pattern matches. */
  bare: string;
  label: string;
}

export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .toLowerCase()
    .split("")
    .map((char) => {
      if (char === "*") return ".*";
      if (char === "?") return ".";
      return char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "s").test(value.toLowerCase());
}

function enabledProvider(provider: GatewayProviderWire): boolean {
  return provider.enabled !== false;
}

/** The models a pattern can disable, in the providers' order. */
export function disabledModelChoices(config: GatewayConfigWire | null): DisabledModelChoice[] {
  const out: DisabledModelChoice[] = [];
  for (const provider of config?.providers ?? []) {
    if (!enabledProvider(provider)) {
      continue;
    }
    for (const model of provider.models) {
      out.push({
        id: `${provider.id}/${model.id}`,
        bare: model.id,
        label: model.label ?? model.id,
      });
    }
  }
  return out;
}

/** Whether the config turns this model off, so a picker leaves it out (as myna's lists do). */
export function modelDisabled(
  config: GatewayConfigWire | null,
  providerId: string,
  modelId: string,
): boolean {
  return (config?.disabledModels ?? []).some(
    (pattern) =>
      pattern.trim().length > 0 &&
      (globMatch(pattern, `${providerId}/${modelId}`) || globMatch(pattern, modelId)),
  );
}

/** The models a pattern disables now: its ref and its bare id are both matched. */
export function disabledHits(
  pattern: string,
  choices: readonly DisabledModelChoice[],
): DisabledModelChoice[] {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return choices.filter(
    (choice) => globMatch(trimmed, choice.id) || globMatch(trimmed, choice.bare),
  );
}
