import type { GatewayConfig, GatewayProvider } from "@neolix/server/gateway-config";

/**
 * myna's `myna accounts switch-only <codex|claude> [on|off]`
 * (internal/cli/accounts_cli.go:914, internal/provider/routing.go:149): neolix
 * only moves the agent's own sign-in between its accounts. On, the gateway
 * serves no request on those sign-ins (`routableAccounts`).
 */

export const SWITCH_ONLY_AGENTS = ["codex", "claude"] as const;
export type SwitchOnlyAgent = (typeof SWITCH_ONLY_AGENTS)[number];

export function parseSwitchOnlyAgent(value: string | undefined): SwitchOnlyAgent {
  const id = (value ?? "").trim().toLowerCase();
  const found = SWITCH_ONLY_AGENTS.find((agent) => agent === id);
  if (found === undefined) {
    throw new Error("usage: neox accounts switch-only <codex|claude> [on|off]");
  }
  return found;
}

/** "on" or "off", as myna's switch-only reads it. */
export function parseOnOff(value: string): boolean {
  const word = value.trim().toLowerCase();
  if (word === "on") {
    return true;
  }
  if (word === "off") {
    return false;
  }
  throw new Error("usage: neox accounts switch-only <codex|claude> [on|off]");
}

function providerOf(config: GatewayConfig, id: SwitchOnlyAgent): GatewayProvider {
  const provider = config.providers.find((entry) => entry.id === id);
  if (provider === undefined) {
    throw new Error(`no ${id} provider — neox providers lists them`);
  }
  return provider;
}

/** The provider's accounts that are the agent's own sign-ins. */
function signInsOf(provider: GatewayProvider, id: SwitchOnlyAgent): number {
  return provider.accounts.filter((account) =>
    id === "claude" ? account.agent === "claude-code" : account.codexAccountId !== undefined,
  ).length;
}

export function switchOnlyOf(config: GatewayConfig, id: SwitchOnlyAgent): boolean {
  return providerOf(config, id).switchOnly === true;
}

/** Writes `switchOnly` on the agent's provider, as myna's SetSwitchOnly. */
export function setSwitchOnly(
  config: GatewayConfig,
  id: SwitchOnlyAgent,
  on: boolean,
): GatewayConfig {
  const provider = providerOf(config, id);
  if (signInsOf(provider, id) === 0) {
    throw new Error(
      `Neox doesn't route ${provider.label ?? provider.id}'s own requests for account failover`,
    );
  }
  return {
    ...config,
    providers: config.providers.map((entry) => {
      if (entry.id !== id) {
        return entry;
      }
      if (on) {
        return { ...entry, switchOnly: true };
      }
      const { switchOnly: _off, ...rest } = entry;
      return rest;
    }),
  };
}

/** What `switch-only <agent>` prints, myna's wording with neolix as the name. */
export function switchOnlySaid(id: SwitchOnlyAgent, on: boolean): string {
  if (id === "codex") {
    return on
      ? "on · Neox only switches Codex's sign-in; its requests go straight to OpenAI"
      : "off · with more of its accounts on, Codex's requests go through Neox to fail over between them";
  }
  return on
    ? "on · Neox only switches Claude Code's sign-in; it serves no requests on the Claude accounts"
    : "off · Neox serves requests on the Claude accounts that are on";
}

/** What `switch-only <agent> on|off` prints after writing. */
export function switchOnlyWritten(id: SwitchOnlyAgent, on: boolean): string {
  if (id === "codex") {
    return on
      ? "Neox only switches Codex's sign-in to an account with room; its requests go straight to OpenAI. A Codex app or session already open stays on its account until it is opened again."
      : "with more of its accounts on, Codex's requests go through Neox to fail over between them again";
  }
  return on
    ? "Neox only switches Claude Code's sign-in to an account with room; it serves no requests on the Claude accounts. A Claude Code session already open stays on its account until it is started again."
    : "Neox serves requests on the Claude accounts that are on again";
}
