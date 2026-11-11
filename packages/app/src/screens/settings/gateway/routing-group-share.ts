import type { GatewayGroupWire } from "@neolix/protocol/gateway";

/** The routing id myna spells this group's strategy with (provider/routing.go:24-53). */
function sharedRouting(group: GatewayGroupWire): string | null {
  if (group.weighted === true) {
    return "weight";
  }
  const strategy = group.strategy ?? "order";
  // Smart is myna's default routing, which its text leaves out.
  if (strategy === "smart") {
    return null;
  }
  return strategy === "least-used" ? "usage" : strategy;
}

function sharedRule(rule: NonNullable<GatewayGroupWire["rules"]>[number]): Record<string, unknown> {
  return {
    use: rule.use,
    ...(rule.more === undefined ? {} : { more: rule.more }),
    ...(rule.useEffort === undefined ? {} : { useEffort: rule.useEffort }),
    ...(rule.tokens === undefined ? {} : { tokens: rule.tokens }),
    ...(rule.images === true ? { images: true } : {}),
    ...(rule.effort === undefined ? {} : { effort: rule.effort }),
    ...(rule.agents === undefined ? {} : { agents: rule.agents }),
    ...(rule.intent === undefined ? {} : { intent: rule.intent }),
    ...(rule.compact === true ? { compact: true } : {}),
    ...(rule.pause === true ? { pause: true } : {}),
    ...(rule.time === undefined ? {} : { time: rule.time }),
  };
}

/**
 * A group as text for another myna, myna's ShareGroup
 * (magpie/internal/provider/group_share.go:34): a folder rule names a path
 * on this machine, so it stays behind, and so do the accounts and the
 * derived flags.
 */
export function sharedGroupText(group: GatewayGroupWire): string {
  const routing = sharedRouting(group);
  const rules = (group.rules ?? []).filter(
    (rule) => (rule.folders ?? []).length === 0 && (rule.exceptFolders ?? []).length === 0,
  );
  const shared = {
    id: group.id,
    ...(group.label === undefined ? {} : { name: group.label }),
    members: group.members,
    ...(group.match === undefined ? {} : { match: group.match }),
    ...(routing === null ? {} : { routing }),
    ...(group.weights === undefined ? {} : { weights: group.weights }),
    ...(group.off === undefined ? {} : { off: group.off }),
    ...(group.pick === undefined ? {} : { pick: group.pick }),
    ...(rules.length === 0 ? {} : { rules: rules.map(sharedRule) }),
    ...(group.classifier === undefined ? {} : { classifier: group.classifier }),
    ...(group.context === undefined ? {} : { context: group.context }),
    ...(group.levels === undefined ? {} : { levels: group.levels }),
    ...(group.fast === undefined ? {} : { fast: group.fast }),
  };
  return JSON.stringify({ magpie: "routing-group", version: 1, group: shared });
}
