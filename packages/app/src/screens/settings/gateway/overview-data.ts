import type { GatewayConfigWire } from "@neolix/protocol/gateway";

/** Where the daemon's HTTP server listens, in the terms the gateway page shows. */
export type GatewayListenKind = "loopback" | "network" | "wildcard" | "socket" | "unknown";

export interface GatewayListen {
  kind: GatewayListenKind;
  listen: string | null;
  port: number | null;
  /** The origin this computer reaches the daemon at, when it listens on loopback or a concrete host. */
  thisComputerUrl: string | null;
  /** The origin other computers reach, when the daemon binds one network address. */
  networkUrl: string | null;
}

const UNKNOWN_LISTEN: GatewayListen = {
  kind: "unknown",
  listen: null,
  port: null,
  thisComputerUrl: null,
  networkUrl: null,
};

function bareHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function hostForUrl(host: string): string {
  const bare = bareHost(host);
  return bare.includes(":") ? `[${bare}]` : bare;
}

function isLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  return (
    bare === "localhost" || bare === "::1" || bare === "0:0:0:0:0:0:0:1" || bare.startsWith("127.")
  );
}

function isWildcardHost(host: string): boolean {
  const bare = bareHost(host);
  return bare === "" || bare === "*" || bare === "0.0.0.0" || bare === "::";
}

function isSocketListen(listen: string): boolean {
  return (
    listen.startsWith("/") ||
    listen.startsWith("~") ||
    listen.startsWith("unix://") ||
    listen.startsWith("pipe://") ||
    listen.startsWith("\\\\.\\pipe\\")
  );
}

/**
 * Reads the `listen` value the daemon reports. The gateway is mounted on that
 * same server, so it is the gateway's address too.
 */
export function parseGatewayListen(listen: string | null | undefined): GatewayListen {
  if (listen === null || listen === undefined) {
    return UNKNOWN_LISTEN;
  }
  const value = listen.trim();
  if (value.length === 0) {
    return { ...UNKNOWN_LISTEN, listen: value };
  }
  if (isSocketListen(value)) {
    return { kind: "socket", listen: value, port: null, thisComputerUrl: null, networkUrl: null };
  }

  const separator = value.lastIndexOf(":");
  if (separator <= 0) {
    return { ...UNKNOWN_LISTEN, listen: value };
  }
  const host = value.slice(0, separator);
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return { ...UNKNOWN_LISTEN, listen: value };
  }

  if (isWildcardHost(host)) {
    return {
      kind: "wildcard",
      listen: value,
      port,
      thisComputerUrl: `http://127.0.0.1:${port}`,
      networkUrl: null,
    };
  }
  if (isLoopbackHost(host)) {
    return {
      kind: "loopback",
      listen: value,
      port,
      thisComputerUrl: `http://${hostForUrl(host)}:${port}`,
      networkUrl: null,
    };
  }
  return {
    kind: "network",
    listen: value,
    port,
    thisComputerUrl: null,
    networkUrl: `http://${hostForUrl(host)}:${port}`,
  };
}

/** One row of the gateway's model list: a routing group, or a provider's model. */
export interface GatewayModelEntry {
  id: string;
  label: string;
  /** The provider's display name; empty for a routing group. */
  providerLabel: string;
  group: boolean;
  members: string[];
  contextWindow: number | null;
}

/**
 * The catalog as `/v1/models` lists it: routing groups first, then each
 * provider's models in the order `gateway.json` writes them.
 */
export function listGatewayModels(config: GatewayConfigWire): GatewayModelEntry[] {
  const groups = config.groups ?? [];
  const providers = config.providers ?? [];
  const entries: GatewayModelEntry[] = [];

  for (const group of groups) {
    entries.push({
      id: `group/${group.id}`,
      label: group.label ?? group.id,
      providerLabel: "",
      group: true,
      members: group.members,
      contextWindow: null,
    });
  }
  for (const provider of providers) {
    for (const model of provider.models) {
      entries.push({
        id: `${provider.id}/${model.id}`,
        label: model.label ?? model.id,
        providerLabel: provider.label ?? provider.id,
        group: false,
        members: [],
        contextWindow: model.contextWindow ?? null,
      });
    }
  }
  return entries;
}

/** The same words match an id, a name, a provider or a group's members. */
export function filterGatewayModels(
  models: readonly GatewayModelEntry[],
  query: string,
): GatewayModelEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [...models];
  }
  return models.filter((model) => {
    const haystack =
      `${model.id} ${model.label} ${model.providerLabel} ${model.members.join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** `1M`, `922K`: the badge on a model row. */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

/** A key entry's secret, whichever shape `gateway.json` uses. */
export function gatewayKeySecret(entry: NonNullable<GatewayConfigWire["keys"]>[number]): string {
  return typeof entry === "string" ? entry : entry.key;
}

/** What the page shows for a key: its label, else a masked secret. */
export function gatewayKeyLabel(entry: NonNullable<GatewayConfigWire["keys"]>[number]): string {
  if (typeof entry === "string") {
    return maskGatewayKey(entry);
  }
  return entry.label ?? maskGatewayKey(entry.key);
}

export function maskGatewayKey(key: string): string {
  return key.length <= 6 ? key : `${key.slice(0, 4)}…${key.slice(-2)}`;
}
