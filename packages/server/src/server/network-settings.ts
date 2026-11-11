import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { GatewayConfigStore, GatewayKey } from "./llm-gateway/config.js";
import { loadPersistedConfigAsync, savePersistedConfigAsync } from "./persisted-config.js";
import { networkHosts } from "./web-page.js";

/**
 * The daemon's listening settings, as myna's Settings › Network page has them
 * (settings.go's Port and LAN): the port, whether the gateway is shared on the
 * local network, and the key remote callers use. A change is written to
 * `config.json` and takes effect at the next start — the daemon never rebinds
 * itself here.
 *
 * `lan` follows myna: sharing on means the daemon listens on every interface,
 * and remote callers must send an enabled gateway key. Sharing off leaves the
 * default sharing key in gateway.json (myna keeps it too), so turning sharing
 * back on hands out the same one; only loopback is answered.
 */

export const DEFAULT_DAEMON_PORT = 6868;
export const LAN_KEY_LABEL = "LAN sharing";

export interface NetworkSettings {
  /** Where the daemon listens, as `host:port`, or a socket path. */
  listen: string | null;
  /** The TCP port, or null for a socket. */
  port: number | null;
  lan: boolean;
  /** The key remote callers use; null while sharing is off. */
  lanKey: string | null;
  /** Where other computers reach the daemon while sharing is on. */
  lanUrls: string[];
}

export interface SaveNetworkSettingsInput {
  neolixHome: string;
  /** The listen address in force now, to read the current port. */
  listen: string | null;
  port?: number;
  lan?: boolean;
  gatewayStore?: GatewayConfigStore;
  logger?: pino.Logger;
}

/** What is wrong with a port, or null when it may be used. 0 means the default. */
export function checkPort(port: number): string | null {
  // myna's rule, internal/settings/settings.go:1750-1755: 0 is the default,
  // anything else is 1024 up (below that a system wants an administrator)
  // and at most 65535.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return `the daemon's port is a number from 1024 to 65535, not ${port}`;
  }
  if (port !== 0 && port < 1024) {
    return `the daemon's port is a number from 1024 to 65535, not ${port}`;
  }
  return null;
}

/** A TCP listen address's host and port, or null for a socket or a bad one. */
export function parseTcpListen(listen: string | null): { host: string; port: number } | null {
  if (listen === null || listen.trim().length === 0) {
    return null;
  }
  const text = listen.trim();
  if (text.startsWith("unix://") || text.startsWith("pipe://") || text.startsWith("/")) {
    return null;
  }
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(text);
  if (bracketed !== null) {
    return { host: bracketed[1] ?? "", port: Number(bracketed[2]) };
  }
  const colon = text.lastIndexOf(":");
  if (colon < 0) {
    return null;
  }
  const port = Number(text.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0) {
    return null;
  }
  return { host: text.slice(0, colon), port };
}

function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower.startsWith("127.") ||
    lower === "::ffff:127.0.0.1"
  );
}

/** The settings a listen address and a remembered key describe. */
export function networkSettingsOf(
  listen: string | null,
  lanKey: string | null = null,
): NetworkSettings {
  const tcp = parseTcpListen(listen);
  const lan = tcp !== null && !isLoopbackHost(tcp.host);
  return {
    listen,
    port: tcp?.port ?? null,
    lan,
    lanKey: lan ? lanKey : null,
    lanUrls: lan && tcp !== null ? networkHosts().map((host) => `http://${host}:${tcp.port}`) : [],
  };
}

/** The key myna's sharing creates, found among the gateway's keys or made. */
async function ensureLanKey(store: GatewayConfigStore, remembered: string | null): Promise<string> {
  const config = store.get();
  const present = (key: string): boolean =>
    config.keys.some((entry) => (typeof entry === "string" ? entry : entry.key) === key);
  if (remembered !== null && present(remembered)) {
    return remembered;
  }
  for (const entry of config.keys) {
    if (typeof entry !== "string" && entry.label === LAN_KEY_LABEL) {
      return entry.key;
    }
  }
  const key = `pk_${randomUUID().replace(/-/g, "")}`;
  const entry: GatewayKey = {
    key,
    label: LAN_KEY_LABEL,
    models: [],
    readOnly: false,
    issues: false,
  };
  await store.write({ ...config, keys: [...config.keys, entry] });
  return key;
}

function wantedPortOf(
  input: SaveNetworkSettingsInput,
  persisted: Awaited<ReturnType<typeof loadPersistedConfigAsync>>,
  current: { host: string; port: number } | null,
): number {
  const wanted = input.port ?? persisted.daemon?.port ?? current?.port ?? DEFAULT_DAEMON_PORT;
  const problem = checkPort(wanted);
  if (problem !== null) {
    throw new Error(problem);
  }
  return wanted === 0 ? DEFAULT_DAEMON_PORT : wanted;
}

function wantedLanOf(
  input: SaveNetworkSettingsInput,
  persisted: Awaited<ReturnType<typeof loadPersistedConfigAsync>>,
  current: { host: string; port: number } | null,
): boolean {
  if (input.lan !== undefined) {
    return input.lan;
  }
  if (persisted.daemon?.lan !== undefined) {
    return persisted.daemon.lan;
  }
  return current === null ? false : !isLoopbackHost(current.host);
}

function listenFor(lan: boolean, port: number): string {
  return `${lan ? "0.0.0.0" : "127.0.0.1"}:${port}`;
}

/**
 * Writes the network settings and says what they are. The daemon answers
 * `restartRequired` for them: a port or a sharing change is bound at start.
 */
export async function saveNetworkSettings(
  input: SaveNetworkSettingsInput,
): Promise<NetworkSettings & { restartRequired: true }> {
  if ((process.env.NEOLIX_LISTEN ?? "").trim().length > 0) {
    throw new Error(
      "The listen address is controlled by NEOLIX_LISTEN. Remove it before changing the port or LAN sharing here.",
    );
  }
  const persisted = await loadPersistedConfigAsync(input.neolixHome, input.logger);
  const current = parseTcpListen(input.listen ?? persisted.daemon?.listen ?? null);
  const port = wantedPortOf(input, persisted, current);
  const lan = wantedLanOf(input, persisted, current);
  const listen = listenFor(lan, port);
  let lanKey = persisted.daemon?.lanKey ?? null;
  if (lan && input.gatewayStore !== undefined) {
    lanKey = await ensureLanKey(input.gatewayStore, lanKey);
  }
  const daemon = {
    ...persisted.daemon,
    listen,
    port,
    lan,
    ...(lanKey === null ? {} : { lanKey }),
  };
  await savePersistedConfigAsync(input.neolixHome, { ...persisted, daemon }, input.logger);
  return {
    listen,
    port,
    lan,
    lanKey: lan ? lanKey : null,
    lanUrls: lan ? networkHosts().map((host) => `http://${host}:${port}`) : [],
    restartRequired: true,
  };
}
