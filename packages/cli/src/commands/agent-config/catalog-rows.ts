import type { GatewayConfig, GatewayModel, GatewayProvider } from "@neolix/server/gateway-config";

/**
 * The catalog `neolix models` lists, read from this computer's gateway.json:
 * each enabled provider's served models and the routing groups, and the
 * models that exist but are not served, with the reason. Kept apart from
 * the command so `neolix visible` narrows the same rows.
 */

/** A model row in the catalog, as `neolix models` lists it. */
export interface CatalogRow {
  id: string;
  /** The heading it goes under: the provider's id, or `group/`. */
  groupKey: string;
  /** The heading's text: the provider's name, or "Routing groups". */
  heading: string;
  /** The model's name, when it differs from its id (myna's e.Name). */
  name?: string;
  efforts: string[];
}

/** A model that exists but is not served, and why (myna's notExposed). */
export interface NotServed {
  why: string;
  ids: string[];
}

function providerName(provider: GatewayProvider): string {
  return provider.label ?? provider.id;
}

/** The models a provider serves now, honouring its modelMode (myna's picks). */
function servedModels(provider: GatewayProvider): GatewayModel[] {
  switch (provider.modelMode ?? "list") {
    case "none":
      return [];
    case "picked":
      return provider.models.filter((model) => model.picked === true);
    case "best":
      return provider.models;
    default:
      return provider.models;
  }
}

function effortsOf(config: GatewayConfig, providerId: string, modelId: string): string[] {
  const key = `${providerId}/${modelId}`;
  if (config.modelReasonless?.[key] === true) {
    return [];
  }
  return config.modelEfforts?.[key] ?? [];
}

/** `matches` with a `*` any run of characters, as the gateway reads them. */
function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/** The disabled-model pattern that keeps this model out, or null. */
function disabledBy(config: GatewayConfig, providerId: string, modelId: string): string | null {
  for (const pattern of config.disabledModels ?? []) {
    if (pattern.trim() === "") continue;
    if (globMatch(pattern, `${providerId}/${modelId}`) || globMatch(pattern, modelId)) {
      return pattern;
    }
  }
  return null;
}

/** The models every agent can pick: each enabled provider's served models, then groups. */
export function catalogRows(config: GatewayConfig): CatalogRow[] {
  const rows: CatalogRow[] = [];
  for (const provider of config.providers) {
    if (provider.enabled === false || provider.exposeModels === false) continue;
    for (const model of servedModels(provider)) {
      if (disabledBy(config, provider.id, model.id) !== null) continue;
      rows.push({
        id: `${provider.id}/${model.id}`,
        groupKey: provider.id,
        heading: providerName(provider),
        ...(model.label === undefined || model.label === model.id ? {} : { name: model.label }),
        efforts: effortsOf(config, provider.id, model.id),
      });
    }
  }
  for (const group of config.groups) {
    if (group.disabled === true) continue;
    rows.push({
      id: `group/${group.id}`,
      groupKey: "group/",
      heading: "Routing groups",
      ...(group.label === undefined || group.label === group.id ? {} : { name: group.label }),
      efforts: [],
    });
  }
  return rows;
}

/**
 * The models that exist but are not served, and why: a provider switched
 * off, exposing none, serving only its picks, or a model disabled.
 */
export function notServed(config: GatewayConfig): NotServed[] {
  const out: NotServed[] = [];
  for (const provider of config.providers) {
    const all = provider.models.map((model) => `${provider.id}/${model.id}`);
    if (provider.enabled === false) {
      out.push({ why: `${providerName(provider)} is switched off`, ids: all });
      continue;
    }
    if (provider.exposeModels === false) {
      out.push({ why: `${providerName(provider)} exposes no models`, ids: all });
      continue;
    }
    const mode = provider.modelMode ?? "list";
    if (mode === "none") {
      out.push({ why: `${providerName(provider)} serves none of its models`, ids: all });
      continue;
    }
    if (mode === "picked") {
      const notPicked = provider.models
        .filter((model) => model.picked !== true)
        .map((model) => `${provider.id}/${model.id}`);
      if (notPicked.length > 0) {
        out.push({
          why: `${providerName(provider)} serves only the models picked for it`,
          ids: notPicked,
        });
      }
    }
    const disabled = provider.models
      .filter((model) => disabledBy(config, provider.id, model.id) !== null)
      .map((model) => `${provider.id}/${model.id}`);
    if (disabled.length > 0) {
      out.push({ why: "disabled", ids: disabled });
    }
  }
  return out;
}
