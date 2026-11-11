import { networkInterfaces } from "node:os";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { GatewayConfig } from "./config.js";
import {
  isLoopbackAddress,
  parseHostPort,
  parseIp,
  parsePrefix,
  prefixContains,
  sameAddress,
  type IpAddress,
} from "./net-addr.js";
import { isSameOSUser, type PeerSocket } from "./peer-user.js";

/**
 * The allow list (myna's allow.go): the addresses other computers may reach
 * the gateway from at all, as IPs and CIDR ranges. A request from any other
 * address is refused 403 before its key is looked at, so a leaked key is of
 * no use from elsewhere. With no list every address is let in. This
 * computer — loopback and its own addresses — is always let in.
 *
 * The address judged is the connection's own (`req.socket.remoteAddress`). A
 * forwarding header is never taken for it: anyone can write one, and the
 * gateway keeps no list of proxies to believe.
 */

/** Names the environment variable that sets the list, in place of gateway.json's. */
export const ALLOW_IPS_ENV = "NEOLIX_ALLOW_IPS";

/** An environment list split as myna's MYNA_ALLOW_IPS is: commas, semicolons, spaces. */
export function splitAllowIps(value: string): string[] {
  return value.split(/[,;\s]+/).filter((entry) => entry.length > 0);
}

/**
 * The allow list in force: the environment's when it is set, gateway.json's
 * otherwise (myna's rule). Empty means no list.
 */
export function allowListOf(config: GatewayConfig): string[] {
  const fromEnv = process.env[ALLOW_IPS_ENV]?.trim() ?? "";
  if (fromEnv.length > 0) {
    return splitAllowIps(fromEnv);
  }
  return config.allowIPs ?? [];
}

/** The addresses this computer holds, as a connection from it would name them. */
export function ownAddresses(): IpAddress[] {
  const out: IpAddress[] = [];
  const interfaces = networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const address = parseIp(entry.address);
      if (address !== null) {
        out.push(address);
      }
    }
  }
  return out;
}

/** The connection address of a request, never a forwarded one. */
export function peerAddress(req: { socket: PeerSocket }): IpAddress | null {
  const raw = req.socket.remoteAddress;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const parsed = parseHostPort(raw);
  return parsed === null ? null : parsed.address;
}

/**
 * `address` reaches the gateway under `list`: there is no list, it is this
 * computer's, or it is in the list. An entry that doesn't parse lets nothing
 * in, so a typo never opens the gateway to every address.
 */
export function allowedIn(list: string[], address: IpAddress, own: IpAddress[]): boolean {
  if (list.length === 0 || isLoopbackAddress(address)) {
    return true;
  }
  for (const entry of list) {
    const prefix = parsePrefix(entry);
    if (prefix !== null && prefixContains(prefix, address)) {
      return true;
    }
  }
  return own.some((candidate) => sameAddress(candidate, address));
}

export interface AllowVerdict {
  allowed: boolean;
  address: string;
  message: string;
}

/** The allow list's verdict on a request's own address. */
export function allowVerdict(config: GatewayConfig, req: { socket: PeerSocket }): AllowVerdict {
  const list = allowListOf(config);
  if (list.length === 0) {
    return { allowed: true, address: "", message: "" };
  }
  const parsed = peerAddress(req);
  const address = parsed === null ? (req.socket.remoteAddress ?? "") : formatAddress(parsed);
  if (parsed !== null && allowedIn(list, parsed, ownAddresses())) {
    return { allowed: true, address, message: "" };
  }
  return {
    allowed: false,
    address,
    message:
      `Neox answers only the addresses on its allow list (gateway.json's allowIPs, or ${ALLOW_IPS_ENV}), and this request came from ` +
      `${address}: add it there to let it in`,
  };
}

/** True when the request came from this computer, as myna's `local` judges it. */
export function isLocalRequest(req: { socket: PeerSocket }): boolean {
  const address = peerAddress(req);
  if (address === null || !isLoopbackAddress(address)) {
    return false;
  }
  return isSameOSUser(req.socket);
}

/**
 * Refuses a request the allow list leaves out, in the gateway's error shape;
 * true when it did. Call it before anything looks at the key.
 */
export function refuseNotAllowed(
  req: ExpressRequest,
  res: ExpressResponse,
  config: GatewayConfig,
): boolean {
  const verdict = allowVerdict(config, req);
  if (verdict.allowed) {
    return false;
  }
  res.status(403).json({
    error: {
      type: "forbidden",
      message: verdict.message,
    },
  });
  return true;
}

function formatAddress(address: IpAddress): string {
  if (address.family === 4) {
    return Array.from(address.bytes).join(".");
  }
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push(
      (((address.bytes[index] ?? 0) << 8) | (address.bytes[index + 1] ?? 0)).toString(16),
    );
  }
  return groups.join(":");
}
