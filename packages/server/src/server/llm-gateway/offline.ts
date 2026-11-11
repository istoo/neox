import { networkInterfaces } from "node:os";
import { connect } from "node:net";
import type { GatewayProvider } from "./config.js";

/**
 * A connection that fails because this computer has no network says nothing
 * of the provider (myna's offline.go): offline, a routing group's providers
 * failed one after another, each rested, and the first stayed behind the
 * others once the network was back. When a request never got a reply and
 * nothing has answered lately, the network is asked — no interface with an
 * address, or none of the other providers' hosts takes a connection — and
 * then no provider rests.
 */

const HEARD_FRESH_MS = 15_000;
const OFFLINE_KEEP_MS = 5_000;
const DIAL_TIMEOUT_MS = 2_000;

const CONNECTION_FAILURE =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|getaddrinfo|network is unreachable|no route to host|TLS handshake timeout/i;

export interface OfflineProbe {
  hasNetwork(): boolean;
  /** True when the host took a connection. */
  dialHost(host: string): Promise<boolean>;
  now(): number;
}

function defaultProbe(): OfflineProbe {
  return {
    hasNetwork: () =>
      Object.values(networkInterfaces()).some((entries) =>
        (entries ?? []).some((entry) => {
          if (entry.internal) {
            return false;
          }
          return entry.family === "IPv4" || !entry.address.toLowerCase().startsWith("fe80");
        }),
      ),
    dialHost: (host) =>
      new Promise((resolve) => {
        const socket = connect({ host, port: portOf(host) });
        const done = (ok: boolean): void => {
          socket.destroy();
          resolve(ok);
        };
        socket.setTimeout(DIAL_TIMEOUT_MS, () => done(false));
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
      }),
    now: () => Date.now(),
  };
}

function portOf(hostPort: string): number {
  const colon = hostPort.lastIndexOf(":");
  if (colon < 0) {
    return 443;
  }
  const port = Number(hostPort.slice(colon + 1));
  return Number.isInteger(port) ? port : 443;
}

/** The failure names a connection that was never made, not a vendor's reply. */
export function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return CONNECTION_FAILURE.test(String(error));
  }
  const cause = (error as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error
      ? `${String((cause as { code?: unknown }).code ?? "")} ${cause.message}`
      : String(cause ?? "");
  return CONNECTION_FAILURE.test(`${error.name} ${error.message} ${causeText}`);
}

function urlHost(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    if (url.hostname.length === 0) {
      return null;
    }
    let port = "80";
    if (url.port.length > 0) {
      port = url.port;
    } else if (url.protocol === "https:") {
      port = "443";
    }
    return `${url.hostname}:${port}`;
  } catch {
    return null;
  }
}

function nearHost(hostPort: string): boolean {
  const host = hostPort.slice(0, hostPort.lastIndexOf(":")).toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (!host.includes(".") && !host.includes(":")) ||
    host.startsWith("127.") ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

/** Up to three hosts of providers other than the failed one, reached directly. */
export function otherHosts(
  providers: readonly GatewayProvider[],
  failed: GatewayProvider,
): string[] {
  const own = new Set([urlHost(failed.baseUrl)].filter((host): host is string => host !== null));
  const out: string[] = [];
  for (const provider of providers) {
    if (provider.id === failed.id) {
      continue;
    }
    if (provider.accounts.some((account) => account.proxy !== undefined)) {
      continue;
    }
    const host = urlHost(provider.baseUrl);
    if (host === null || own.has(host) || nearHost(host) || out.includes(host)) {
      continue;
    }
    out.push(host);
    if (out.length === 3) {
      break;
    }
  }
  return out;
}

export class OfflineDetector {
  private lastHeard = 0;
  private verdictAt = 0;
  private verdict = false;
  private asking: Promise<boolean> | null = null;

  constructor(private readonly probe: OfflineProbe = defaultProbe()) {}

  /** Any upstream answered: the network reached it, whatever it said. */
  public noteHeard(): void {
    this.lastHeard = this.probe.now();
  }

  /**
   * The failure is this computer having no network: no connection was made,
   * nothing answered lately, and the network is down or reaches none of the
   * other providers. With no other provider to ask, it is the failed one's.
   */
  public async isOffline(
    error: unknown,
    providers: readonly GatewayProvider[],
    failed: GatewayProvider,
  ): Promise<boolean> {
    if (!isConnectionFailure(error)) {
      return false;
    }
    const now = this.probe.now();
    if (now - this.lastHeard < HEARD_FRESH_MS) {
      return false;
    }
    if (now - this.verdictAt < OFFLINE_KEEP_MS) {
      return this.verdict;
    }
    if (this.asking !== null) {
      return this.asking;
    }
    this.asking = this.ask(providers, failed);
    try {
      this.verdict = await this.asking;
    } finally {
      this.asking = null;
    }
    this.verdictAt = this.probe.now();
    return this.verdict;
  }

  private async ask(
    providers: readonly GatewayProvider[],
    failed: GatewayProvider,
  ): Promise<boolean> {
    if (!this.probe.hasNetwork()) {
      return true;
    }
    const hosts = otherHosts(providers, failed);
    if (hosts.length === 0) {
      return false;
    }
    const reached = await Promise.all(hosts.map((host) => this.probe.dialHost(host)));
    return reached.every((ok) => !ok);
  }
}

/** The gateway's detector, as myna keeps one for the process. */
export const offlineDetector = new OfflineDetector();
