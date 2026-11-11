import type { GatewayConfig } from "./config.js";

/**
 * The per-model preferences myna keeps in settings.json, as this gateway's
 * gateway.json carries them. Each is the myna field it mirrors:
 *
 * - `modelWires` — settings.ModelWires (settings.go:915-923); the name a
 *   vendor is asked for a model by, `*` in it the model, up to the whole
 *   provider with `<provider>/*` (provider/modelprefs.go:1014-1023).
 * - `modelIDs` — settings.ModelIDs (settings.go:924-934); the id a model is
 *   listed and routed by, where the provider serves it under another.
 * - `disabledModels` — settings.DisabledModels (settings.go:826-830); exact
 *   ids or globs, matched case-insensitively against "<provider>/<model>"
 *   and the bare id (provider/disabled.go:83-99).
 * - `modelEfforts` / `modelReasonless` — settings.go:876-889; the levels a
 *   model offers, or no reasoning ask at all.
 * - `usageAliases` — settings.UsageAliases (settings.go:949-957); the id a
 *   model's usage is counted under, a bare model id on both sides.
 *
 * The request-path pieces (wire, disabled refusal, listed-id reverse
 * lookup) are pure here so the routing side can call them.
 */

/** myna's globMatch (provider/disabled.go:101): * any run (slashes too), ? one. */
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

/** The names a disabled pattern is matched against: the ref and the bare id. */
function namesOf(providerId: string, modelId: string): string[] {
  return [`${providerId}/${modelId}`, modelId];
}

/** The pattern that disables this model, or null, myna's ModelDisabled. */
export function disabledPattern(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
): string | null {
  const list = config.disabledModels ?? [];
  if (list.length === 0) {
    return null;
  }
  return matchDisabled(list, namesOf(providerId, modelId));
}

export function matchDisabled(list: readonly string[], names: readonly string[]): string | null {
  for (const pattern of list) {
    const trimmed = pattern.trim();
    if (trimmed === "") {
      continue;
    }
    for (const name of names) {
      if (name !== "" && globMatch(trimmed, name)) {
        return pattern;
      }
    }
  }
  return null;
}

/**
 * What a request for a disabled model is told, myna's disabledError
 * (gateway/disabled.go:23-25): a 403 before anything goes upstream.
 */
export function disabledRefusal(id: string, pattern: string): { status: 403; message: string } {
  return {
    status: 403,
    message: `model ${id} is disabled in Neox (it matches ${JSON.stringify(pattern)} in Settings › Models › Disabled models); enable it there or with \`neox model enable ${pattern}\`. Only requests through Neox are refused`,
  };
}

/**
 * The refusal one planned candidate earns, or null: myna's ModelDisabled is
 * checked on every route a request could take — a member of a group, a
 * fallback, a sub-agent's model — not only on the id the client asked for.
 */
export function disabledCandidateRefusal(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
): { status: 403; message: string } | null {
  const pattern = disabledPattern(config, providerId, modelId);
  return pattern === null ? null : disabledRefusal(`${providerId}/${modelId}`, pattern);
}

/**
 * What a request that names a disabled model is told before anything goes
 * upstream: `provider/model`, or a bare id the first provider serves. A
 * group or an `auto/` id names no one model here; each candidate is
 * checked with disabledCandidateRefusal instead.
 */
export function disabledRequestRefusal(
  config: GatewayConfig,
  requestedModel: string,
): { status: 403; message: string } | null {
  const model = requestedModel.trim();
  if (model === "" || model.startsWith("group/") || model.startsWith("auto/")) {
    return null;
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    return disabledCandidateRefusal(config, model.slice(0, slash), model.slice(slash + 1));
  }
  for (const provider of config.providers) {
    if (provider.enabled === false) {
      continue;
    }
    const served = provider.models.find((entry) => entry.id === model);
    if (served !== undefined) {
      return disabledCandidateRefusal(config, provider.id, served.id);
    }
  }
  return null;
}

/** The name the vendor is asked for, myna's UpstreamNameIn (modelprefs.go:1014). */
export function upstreamModelName(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
): string {
  const wires = config.modelWires ?? {};
  let name = (wires[`${providerId}/${modelId}`] ?? "").trim();
  if (name === "") {
    name = (wires[`${providerId}/*`] ?? "").trim();
  }
  return name === "" ? modelId : name.split("*").join(modelId);
}

/**
 * The id a model is listed and routed by, myna's ModelIDs: the provider's
 * own id when the user said nothing, and the user's id when they did.
 * modelIDs is keyed by the listed id, so the mapping is inverted here once.
 */
export function listedModelId(config: GatewayConfig, providerId: string, modelId: string): string {
  const ids = config.modelIDs ?? {};
  for (const [listed, served] of Object.entries(ids)) {
    const slash = listed.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    if (listed.slice(0, slash) === providerId && served === modelId) {
      return listed.slice(slash + 1);
    }
  }
  return modelId;
}

/**
 * The provider's own model id for an id a request names, myna's reverse of
 * ModelIDs: a listed id maps back to what the provider serves, and the same
 * id of the provider's own is not resolved while another model goes by it.
 */
export function servedModelId(
  config: GatewayConfig,
  providerId: string,
  requestedId: string,
): string {
  const key = `${providerId}/${requestedId}`;
  const served = (config.modelIDs ?? {})[key];
  return served === undefined || served === "" ? requestedId : served;
}

/** The levels a model offers, myna's ModelEfforts; null when the user said nothing. */
export function modelEfforts(
  config: GatewayConfig,
  providerId: string,
  modelId: string,
): string[] | null {
  const key = `${providerId}/${modelId}`;
  if (config.modelReasonless?.[key] === true) {
    return [];
  }
  return config.modelEfforts?.[key] ?? null;
}

/**
 * The id a model's usage is counted under, myna's UsageAliases: keyed by a
 * bare model id, so two ids of one model become one row. Only usage
 * grouping reads it; requests, lists and prices keep the id asked.
 */
export function usageModelId(config: GatewayConfig, modelId: string): string {
  const alias = (config.usageAliases ?? {})[modelId];
  return alias === undefined || alias.trim() === "" ? modelId : alias;
}
