/**
 * The agent ids `clientOfUserAgent` writes into the ledger and the trace, as
 * a reader names them. An unknown id is shown as it arrived.
 */
const AGENT_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
  pi: "Pi",
  antigravity: "Antigravity",
  "muse-code": "Muse Code",
  neolix: "Neox",
  "neolix-router": "Router",
  other: "Other",
};

export function agentDisplayName(id: string): string {
  return AGENT_NAMES[id] ?? id;
}
