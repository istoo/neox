// FILE: gatewayHelpers.ts
// Purpose: Pure helpers the gateway settings panes share: cloning the config,
//          listing catalog entries, masking secrets, and formatting numbers.
// Layer: Settings UI support

import type {
  GatewayAccount,
  GatewayConfig,
  GatewayKey,
  GatewayKeyObject,
  GatewayModel,
  GatewayProbeTarget,
  GatewayProtocol,
  GatewayProvider,
  GatewayProviderPreset,
} from "~/lib/gatewayTypes";

export function cloneConfig(config: GatewayConfig): GatewayConfig {
  return structuredClone(config);
}

export function asKeyObject(entry: GatewayKey): GatewayKeyObject {
  return typeof entry === "string" ? { key: entry, models: [] } : entry;
}

export function stringList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function listText(values: readonly string[] | undefined): string {
  return (values ?? []).join(", ");
}

export function maskSecret(value: string | undefined): string {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function isLocalAddress(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

/** The accounts a provider actually has: an explicit list, or the implicit key. */
export function providerAccountsOf(provider: GatewayProvider): GatewayAccount[] {
  if ((provider.accounts?.length ?? 0) > 0) return provider.accounts ?? [];
  if (provider.apiKey !== undefined && provider.apiKey.length > 0) {
    return [{ id: "default", apiKey: provider.apiKey, enabled: true }];
  }
  return [];
}

export interface ProviderKeySummary {
  /** The first enabled account's credential, already masked. */
  text: string;
  /** `key` when there is one; otherwise why the row has none. */
  kind: "key" | "needsKey" | "noKeyNeeded" | "noActiveAccount";
}

/** A key is always shown masked; the row's dot says whether one is there. */
export function providerKeySummary(provider: GatewayProvider): ProviderKeySummary {
  const accounts = providerAccountsOf(provider);
  const active = accounts.filter((account) => account.enabled !== false);
  const key = active.find((account) => (account.apiKey ?? "").length > 0)?.apiKey ?? "";
  if (key.length > 0) return { text: maskSecret(key), kind: "key" };
  if (accounts.length > 0) return { text: "", kind: "noActiveAccount" };
  if (isLocalAddress(provider.baseUrl)) return { text: "", kind: "noKeyNeeded" };
  return { text: "", kind: "needsKey" };
}

/** The name of the first enabled account, hidden when accounts are masked. */
export function providerAccountName(provider: GatewayProvider): string | null {
  const active = providerAccountsOf(provider).filter((account) => account.enabled !== false);
  const named = active.find((account) => (account.label ?? "").trim().length > 0);
  if (named !== undefined) return (named.label ?? "").trim();
  const explicit = active.find(
    (account) => account.id !== "default" || (provider.accounts?.length ?? 0) > 0,
  );
  return explicit === undefined ? null : explicit.id;
}

export interface CatalogEntry {
  id: string;
  provider: GatewayProvider;
  model: GatewayModel;
  disabled: boolean;
}

export function modelDisabled(pattern: string, id: string): boolean {
  if (pattern === id) return true;
  if (!pattern.includes("*")) return false;
  const patternParts = pattern.split("*");
  const rest = patternParts.slice(1);
  let index = 0;
  for (const part of patternParts) {
    if (part.length === 0) continue;
    const found = id.indexOf(part, index);
    if (found < 0) return false;
    index = found + part.length;
  }
  return rest.length === 0 || index <= id.length;
}

export function catalogEntries(config: GatewayConfig): CatalogEntry[] {
  const disabled = config.disabledModels ?? [];
  const entries: CatalogEntry[] = [];
  for (const provider of config.providers ?? []) {
    for (const model of provider.models ?? []) {
      const id = `${provider.id}/${model.id}`;
      entries.push({
        id,
        provider,
        model,
        disabled: disabled.some(
          (pattern) => modelDisabled(pattern, id) || modelDisabled(pattern, model.id),
        ),
      });
    }
  }
  return entries;
}

export function providerProbeTarget(provider: GatewayProvider): GatewayProbeTarget {
  return {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
    ...(provider.headers === undefined ? {} : { headers: provider.headers }),
    ...(provider.insecureTls === undefined ? {} : { insecureTls: provider.insecureTls }),
    ...(provider.modelsUrl === undefined ? {} : { modelsUrl: provider.modelsUrl }),
    ...(provider.id ? { providerId: provider.id } : {}),
  };
}

/** The protocol a preset opens on: the first endpoint it serves, OpenAI first. */
export function presetProtocol(preset: GatewayProviderPreset): GatewayProtocol {
  if (preset.endpoints.openai !== undefined) return "openai";
  if (preset.endpoints.anthropic !== undefined) return "anthropic";
  if (preset.endpoints["openai-responses"] !== undefined) return "openai-responses";
  if (preset.endpoints.gemini !== undefined) return "gemini";
  return "openai";
}

export function presetProtocols(preset: GatewayProviderPreset): GatewayProtocol[] {
  const protocols = Object.keys(preset.endpoints) as GatewayProtocol[];
  return protocols.length > 0 ? protocols : ["openai"];
}

/** An id no other provider uses, so a preset saves without a collision. */
export function uniqueProviderId(preferred: string, providers: readonly GatewayProvider[]): string {
  const base = preferred.toLowerCase().replace(/[^a-z0-9-]/gu, "-");
  const first = /^[a-z]/u.test(base) ? base : `p-${base}`;
  let candidate = first;
  let suffix = 2;
  while (providers.some((provider) => provider.id === candidate)) {
    candidate = `${first}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function presetMatches(preset: GatewayProviderPreset, words: readonly string[]): boolean {
  if (words.length === 0) return true;
  const haystack = [
    preset.id,
    preset.name,
    preset.fullName ?? "",
    preset.note ?? "",
    ...Object.values(preset.endpoints),
    ...(preset.regions ?? []).flatMap((region) =>
      [region.name].concat(Object.values(region.endpoints)),
    ),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function presetHost(preset: GatewayProviderPreset): string {
  const first = Object.values(preset.endpoints)[0];
  if (!first) return preset.decide ?? "";
  try {
    return new URL(first).host;
  } catch {
    return first;
  }
}

/** Where the daemon's HTTP server listens, as the gateway page shows it. */
export interface GatewayListen {
  listen: string | null;
  origin: string | null;
  networkOrigin: string | null;
  socket: boolean;
  /** Other computers can reach the listener (it binds every interface or a network address). */
  lanReachable: boolean;
}

export function parseListen(raw: string | null | undefined): GatewayListen {
  const listen = raw?.trim() ?? "";
  if (!listen) {
    return { listen: null, origin: null, networkOrigin: null, socket: false, lanReachable: false };
  }
  if (
    listen.startsWith("/") ||
    listen.startsWith("~") ||
    listen.startsWith("unix://") ||
    listen.includes("\\\\.\\pipe")
  ) {
    return { listen, origin: null, networkOrigin: null, socket: true, lanReachable: false };
  }
  const separator = listen.lastIndexOf(":");
  const host = separator > 0 ? listen.slice(0, separator) : "";
  const port = Number(listen.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { listen, origin: null, networkOrigin: null, socket: false, lanReachable: false };
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare === "" || bare === "*" || bare === "0.0.0.0" || bare === "::") {
    return {
      listen,
      origin: `http://127.0.0.1:${port}`,
      networkOrigin: null,
      socket: false,
      lanReachable: true,
    };
  }
  const urlHost = bare.includes(":") ? `[${bare}]` : bare;
  const network = bare === "localhost" || bare === "::1" || bare.startsWith("127.");
  return {
    listen,
    origin: network ? `http://${urlHost}:${port}` : null,
    networkOrigin: network ? null : `http://${urlHost}:${port}`,
    socket: false,
    lanReachable: !network,
  };
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)}%`;
}

export function formatWhen(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function formatCountdown(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The origin this computer can use, falling back to the page's own. */
export function gatewayOrigin(listen: GatewayListen): string | null {
  return listen.origin ?? listen.networkOrigin;
}

export const GATEWAY_TABS = [
  "overview",
  "providers",
  "routing",
  "keys",
  "usage",
  "allowances",
  "advanced",
  "masking",
] as const;

export type GatewayTab = (typeof GATEWAY_TABS)[number];
