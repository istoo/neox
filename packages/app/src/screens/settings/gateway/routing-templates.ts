import type {
  GatewayConfigWire,
  GatewayGroupRuleWire,
  GatewayGroupWire,
} from "@neolix/protocol/gateway";

export type RoutingTemplateKind = "steady" | "thrifty" | "smart";

/**
 * A group myna's routing templates inspire, made from the models this host
 * serves. Its members are picked from the provider and model order the config
 * already has: the admin lists a provider's strongest model first.
 */
export interface RoutingTemplate {
  kind: RoutingTemplateKind;
  /** The configured members, `provider/model`, in the order they are tried. */
  members: string[];
  /** The model asked which intent a turn is (the smart template). */
  classifier?: string;
  rules?: GatewayGroupRuleWire[];
}

/** myna's two intents its smart template's classifier chooses between. */
export const TEMPLATE_INTENT_HARD =
  "a hard task: designing, debugging, a change across several files, or planning";
export const TEMPLATE_INTENT_EASY =
  "an easy task: a quick question, a small edit, a lookup, or running a command";

const CHEAP_WORDS = new Set([
  "mini",
  "nano",
  "flash",
  "haiku",
  "lite",
  "small",
  "air",
  "turbo",
  "instant",
  "tiny",
]);

const CHAT_KINDS = new Set(["chat", undefined]);

export function buildRoutingTemplates(config: GatewayConfigWire): RoutingTemplate[] {
  const served: { provider: string; models: string[] }[] = [];
  for (const provider of config.providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    const models = provider.models
      .filter((model) => CHAT_KINDS.has(model.kind))
      .map((model) => model.id);
    if (models.length > 0) {
      served.push({ provider: provider.id, models });
    }
  }
  const templates: RoutingTemplate[] = [];
  const steady = steadyMembers(served);
  if (steady !== null) {
    templates.push({ kind: "steady", members: steady });
  }
  const thrifty = thriftyMembers(served);
  if (thrifty !== null) {
    templates.push({ kind: "thrifty", members: thrifty });
  }
  const strong = strongestMember(served);
  const cheap = cheapestMember(served);
  if (strong !== null && cheap !== null && strong !== cheap) {
    templates.push({
      kind: "smart",
      members: [strong, cheap],
      classifier: cheap,
      rules: [
        { use: strong, intent: TEMPLATE_INTENT_HARD },
        { use: cheap, intent: TEMPLATE_INTENT_EASY },
      ],
    });
  }
  return templates;
}

function strongestMember(served: { provider: string; models: string[] }[]): string | null {
  const first = served[0];
  return first === undefined ? null : `${first.provider}/${first.models[0]}`;
}

function cheapestMember(served: { provider: string; models: string[] }[]): string | null {
  for (const entry of served) {
    for (const model of entry.models) {
      if (isCheapModel(model)) {
        return `${entry.provider}/${model}`;
      }
    }
  }
  return null;
}

/** The first model of each of up to three providers, strong first. */
function steadyMembers(served: { provider: string; models: string[] }[]): string[] | null {
  if (served.length < 2) {
    return null;
  }
  return served.slice(0, 3).map((entry) => `${entry.provider}/${entry.models[0]}`);
}

/**
 * A small model first, the first strong model behind it. A model's id says it
 * is small (mini, flash, haiku, a size up to 72b), as myna reads it when no
 * prices are known.
 */
function thriftyMembers(served: { provider: string; models: string[] }[]): string[] | null {
  const all = served.flatMap((entry) => entry.models.map((model) => `${entry.provider}/${model}`));
  const cheap = all.find((member) => isCheapModel(member.slice(member.indexOf("/") + 1)));
  const strong =
    served[0] === undefined ? undefined : `${served[0].provider}/${served[0].models[0]}`;
  if (cheap === undefined || strong === undefined || cheap === strong) {
    return null;
  }
  return [cheap, strong];
}

function isCheapModel(modelId: string): boolean {
  const words = modelId
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((word) => word.length > 0);
  for (const word of words) {
    if (CHEAP_WORDS.has(word)) {
      return true;
    }
    const size = /^(\d+(?:\.\d+)?)b$/.exec(word);
    if (size !== null && Number(size[1]) <= 72) {
      return true;
    }
  }
  return false;
}

export function groupFromTemplate(
  config: GatewayConfigWire,
  template: RoutingTemplate,
  label: string,
): GatewayGroupWire {
  const base = templateGroupId(template.kind);
  return {
    id: uniqueGroupId(config, base),
    label,
    members: template.members,
    strategy: "order",
    ...(template.classifier === undefined ? {} : { classifier: template.classifier }),
    ...(template.rules === undefined ? {} : { rules: template.rules }),
  };
}

function templateGroupId(kind: RoutingTemplateKind): string {
  if (kind === "steady") {
    return "never-stuck";
  }
  return kind === "thrifty" ? "cheap-first" : "smart-split";
}

export function uniqueGroupId(config: GatewayConfigWire, base: string): string {
  const taken = new Set((config.groups ?? []).map((group) => group.id));
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  while (taken.has(`${base}-${index}`)) {
    index += 1;
  }
  return `${base}-${index}`;
}
