import type { GatewayProvider } from "./config.js";
import type { RoutingStrategy } from "./routing.js";

/**
 * How a provider's settings shape a request, as myna's do. These are pure
 * decisions, so the request path can call them without state; the gateway
 * that sends the request (routes.ts) is page-routing-2's.
 */

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

/** Whether one of its accounts signs in as its own client (myna's Account != nil). */
function hasSignedInAccount(provider: GatewayProvider): boolean {
  return provider.accounts.some(
    (account) =>
      account.enabled && (account.agent !== undefined || account.codexAccountId !== undefined),
  );
}

function headerValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  for (const [held, value] of Object.entries(headers ?? {})) {
    if (held.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }
  return undefined;
}

const OPEN_CODE_PRESETS = new Set(["opencode-zen", "opencode-go"]);
const CLINE_PRESETS = new Set(["clinepass"]);
const KILO_PRESETS = new Set(["kilo"]);
/** Another Neolix's gateway, myna's remote-myna preset (`remote_myna.go:72`). */
const REMOTE_NEOLIX_PRESET = "remote-myna";

/**
 * myna's `Provider.OwnClient` (`internal/provider/user_agent.go:17`): the
 * gateways sent the client they serve, whatever agent sent the request —
 * OpenCode's, Cline's, Kilo's, and another Neolix's. Each is known by its
 * preset or by its host (myna's IsOpenCode/IsCline/IsKilo).
 */
export function ownClientProvider(provider: GatewayProvider): boolean {
  const preset = (provider.preset ?? "").toLowerCase();
  if (
    OPEN_CODE_PRESETS.has(preset) ||
    CLINE_PRESETS.has(preset) ||
    KILO_PRESETS.has(preset) ||
    preset === REMOTE_NEOLIX_PRESET
  ) {
    return true;
  }
  const host = hostOf(provider.baseUrl).toLowerCase().replace(/\.$/, "");
  return (
    host === "opencode.ai" ||
    host.endsWith(".opencode.ai") ||
    host === "cline.bot" ||
    host.endsWith(".cline.bot") ||
    host === "api.kilo.ai" ||
    host === "api.kilocode.ai"
  );
}

/**
 * myna's `Provider.PassesUserAgent` (`internal/provider/user_agent.go:10`):
 * a key+URL provider the user set `user-agent=agent` on. A signed-in account
 * signs as its own client, and an OwnClient gateway is sent its own client's
 * User-Agent instead, so neither takes the agent's.
 */
export function passesUserAgent(provider: GatewayProvider): boolean {
  return (
    provider.passUserAgent === true && !hasSignedInAccount(provider) && !ownClientProvider(provider)
  );
}

/**
 * The User-Agent a request to this provider goes with. A `header.User-Agent`
 * the user set stands over both, as myna's `headers` do
 * (`internal/cli/providers_cli.go:1155-1162`).
 */
export function userAgentFor(
  provider: GatewayProvider,
  agentUserAgent: string | undefined,
  gatewayUserAgent: string,
): string {
  const own = headerValue(provider.headers, "user-agent");
  if (own !== undefined && own.length > 0) {
    return own;
  }
  if (passesUserAgent(provider) && agentUserAgent !== undefined && agentUserAgent.length > 0) {
    return agentUserAgent;
  }
  return gatewayUserAgent;
}

/** The zero-width space myna puts inside a line Antigravity turns away. */
const ZERO_WIDTH = "​";

/**
 * The lines, lower-cased, Antigravity turns a system instruction away for
 * (myna's `agTurnedAway`, `internal/gateway/codeassist.go:99-105`).
 */
export const ANTIGRAVITY_TURNED_AWAY: readonly string[] = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
];

function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/**
 * myna's `antigravityCloak` (`internal/gateway/codeassist.go:128`): every
 * occurrence of a turned-away line gets a zero-width space after its first
 * letter, so Google's check reads past it and the model does too.
 */
export function antigravityCloak(system: string): string {
  const lower = system.toLowerCase();
  // Lower-casing only keeps byte offsets while it keeps the length; a
  // non-ASCII character can change it (myna's asciiLower fallback).
  const scanned = lower.length === system.length ? lower : asciiLower(system);
  const at: number[] = [];
  for (const line of ANTIGRAVITY_TURNED_AWAY) {
    for (let index = 0; ; ) {
      const found = scanned.indexOf(line, index);
      if (found < 0) {
        break;
      }
      at.push(found + 1);
      index = found + line.length;
    }
  }
  if (at.length === 0) {
    return system;
  }
  at.sort((left, right) => left - right);
  let out = "";
  let previous = 0;
  for (const index of new Set(at)) {
    out += system.slice(previous, index) + ZERO_WIDTH;
    previous = index;
  }
  return out + system.slice(previous);
}

/**
 * The system prompt an Antigravity account is sent: broken up unless the
 * user asked for it as written (myna's `PromptAsWritten`,
 * `internal/gateway/codeassist.go:294`).
 */
export function antigravitySystemPrompt(provider: GatewayProvider, system: string): string {
  if (provider.promptAsWritten === true) {
    return system;
  }
  if (!provider.accounts.some((account) => account.enabled && account.agent === "antigravity")) {
    return system;
  }
  return antigravityCloak(system);
}

/**
 * Whether Codex's own Responses request goes on as Codex sent it: the user
 * set `codex=as-sent`, it is a key+URL provider, and Codex was the caller
 * (myna's `CodexAsSent`, `internal/gateway/gateway.go:5606`).
 */
export function codexRequestAsSent(provider: GatewayProvider, fromCodex: boolean): boolean {
  return provider.codexAsSent === true && !hasSignedInAccount(provider) && fromCodex;
}

/**
 * Whether a tool loaded by an Anthropic client's tool search goes in an
 * `additional_tools` item where it was loaded: OpenAI's own API and a
 * ChatGPT account do so by default, `additional-tools=on|off` overrides,
 * anything else moves it in with the tools (myna's `loadsInPlace`,
 * `internal/gateway/gateway.go:7464`).
 */
export function loadsAdditionalToolsInPlace(provider: GatewayProvider): boolean {
  if (provider.additionalTools === "off") {
    return false;
  }
  if (provider.additionalTools === "on") {
    return true;
  }
  if (provider.accounts.some((account) => account.enabled && account.agent === "chatgpt-api")) {
    // Neolix's ChatGPT (Codex) sign-in is the account agent chatgpt-api.
    return true;
  }
  const host = hostOf(provider.baseUrl);
  return host === "api.openai.com" || host.endsWith(".api.openai.com");
}

/**
 * The names a provider answers to in a visibility, myna's `Entry.Names`
 * (`internal/provider/visible.go:20-34`): its family tag, and its own id.
 * Settings' per-agent visibility (myna's `VisibleTo`) has no Neolix store
 * yet; these are the names it would compare.
 */
export function providerVisibilityNames(provider: GatewayProvider): string[] {
  const names: string[] = [];
  if (provider.family !== undefined && provider.family.length > 0) {
    names.push(provider.family);
  }
  names.push(provider.id);
  return names;
}

/** Whether a visibility shows this provider; no visibility narrows nothing. */
export function providerShownTo(
  provider: GatewayProvider,
  visible: readonly string[] | undefined,
): boolean {
  if (visible === undefined) {
    return true;
  }
  return providerVisibilityNames(provider).some((name) =>
    visible.some((wanted) => wanted.toLowerCase() === name.toLowerCase()),
  );
}

/**
 * A provider's `routing=` as the group strategy it is served by. Weight is a
 * group's flag in Neolix, not a strategy; `undefined` leaves the gateway's
 * own order (myna's `Provider.Routing`, `internal/provider/provider.go:123-135`).
 */
export function providerRoutingStrategy(
  provider: GatewayProvider,
): { strategy: RoutingStrategy; weighted: boolean } | undefined {
  switch (provider.routing) {
    case "smart":
      return { strategy: "smart", weighted: false };
    case "order":
      return { strategy: "order", weighted: false };
    case "rotate":
      return { strategy: "rotate", weighted: false };
    case "usage":
      return { strategy: "least-used", weighted: false };
    case "pace":
      return { strategy: "pace", weighted: false };
    case "weight":
      return { strategy: "order", weighted: true };
    case "free":
      return { strategy: "free", weighted: false };
    case "fast":
      return { strategy: "fast", weighted: false };
    case "drain":
      return { strategy: "drain", weighted: false };
    default:
      return provider.routing?.includes("/")
        ? { strategy: provider.routing, weighted: false }
        : undefined;
  }
}
