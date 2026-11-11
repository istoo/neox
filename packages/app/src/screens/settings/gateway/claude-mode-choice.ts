import type { GatewayConfigWire } from "@neolix/protocol/gateway";

/**
 * Whether the "Claude Code runs as" choice is read-only: myna's
 * claudemode.js:75 disables it only where the page serves as the gateway
 * (myna web); an app window switches it.
 */
export function claudeModeChoicesDisabled(gatewayModeEnabled: boolean): boolean {
  return gatewayModeEnabled;
}

/** The config a picked mode writes: `claude -p` is `claudePrintMode` (myna's ClaudePrintMode). */
export function withClaudeMode(config: GatewayConfigWire, choice: "tui" | "p"): GatewayConfigWire {
  return { ...config, claudePrintMode: choice === "p" };
}
