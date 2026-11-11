import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { parseDataUrl } from "./vision-images.js";

/**
 * Downloads an image a request names. Only public addresses are reachable:
 * loopback, the user's own network, link-local (cloud metadata), CGNAT and
 * the other special ranges are refused before a connection is made, and each
 * redirect is checked the same way. The host is resolved once and the
 * connection is pinned to the address that was checked, so a name that
 * resolves differently a second time (DNS rebinding) cannot reach elsewhere.
 */
export class ImageFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ImageFetchError";
  }
}

/** The largest image accepted, whether inline or downloaded. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** myna's cap on a base64 data URL's payload. */
const MAX_DATA_URL_BASE64 = 48 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/**
 * The private hosts and ranges the user's `fetchPrivate` lets a download
 * reach. Empty means public addresses only, whatever sent the request: a
 * request that reaches the gateway on loopback may be a reverse proxy's,
 * passing on someone else's.
 */
let allowHosts = new Set<string>();
let allowNets = new BlockList();

export function setFetchPrivate(entries: readonly string[]): void {
  const hosts = new Set<string>();
  const nets = new BlockList();
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") {
      continue;
    }
    const slash = entry.lastIndexOf("/");
    const address = slash < 0 ? entry.replace(/^\[|\]$/g, "") : entry.slice(0, slash);
    const family = isIP(address);
    if (family !== 0) {
      const bits = family === 4 ? 32 : 128;
      const prefix = slash < 0 ? bits : Number.parseInt(entry.slice(slash + 1), 10);
      if (Number.isInteger(prefix) && prefix >= 0 && prefix <= bits) {
        nets.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
        continue;
      }
    }
    hosts.add(entry);
  }
  allowHosts = hosts;
  allowNets = nets;
}

function allowedAddress(address: string): boolean {
  if (!isPrivateAddress(address)) {
    return true;
  }
  const family = isIP(address);
  if (family === 4) {
    return allowNets.check(address, "ipv4");
  }
  return family === 6 && allowNets.check(address, "ipv6");
}

function namedByUser(hostname: string, port: string): boolean {
  const name = hostname.toLowerCase();
  return allowHosts.has(name) || allowHosts.has(`${name}:${port}`);
}

/** Whether an address is outside the public internet (or not an address). */
export function isPrivateAddress(address: string): boolean {
  const trimmed = address.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
  if (mapped !== null) {
    return isPrivateAddress(mapped[1] ?? "");
  }
  const family = isIP(trimmed);
  if (family === 4) {
    return BLOCKED.check(trimmed, "ipv4");
  }
  if (family === 6) {
    return blockedIPv6(trimmed);
  }
  return true;
}

/**
 * IPv6 forms that carry an IPv4 address are judged by it, as myna's netguard
 * does: an IPv4-mapped, NAT64 or 6to4 form of a private address reaches it.
 * Teredo and the deprecated IPv4-compatible block are refused whole.
 */
function blockedIPv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (groups === null || BLOCKED.check(address, "ipv6")) {
    return true;
  }
  const zero = (from: number, to: number): boolean => {
    for (let index = from; index <= to; index += 1) {
      if (groups[index] !== 0) {
        return false;
      }
    }
    return true;
  };
  const embedded = (high: number | undefined, low: number | undefined): string =>
    `${(high ?? 0) >> 8}.${(high ?? 0) & 0xff}.${(low ?? 0) >> 8}.${(low ?? 0) & 0xff}`;
  // ::ffff:7f00:1 is the numeric spelling of ::ffff:127.0.0.1.
  if (zero(0, 4) && groups[5] === 0xffff) {
    return isPrivateAddress(embedded(groups[6], groups[7]));
  }
  // 64:ff9b::/96 is NAT64 for the IPv4 internet; 64:ff9b:1::/48 is its
  // local-use form, whose mapping this host doesn't know.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 5)) {
    return isPrivateAddress(embedded(groups[6], groups[7]));
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) {
    return true;
  }
  // 2002::/16 carries an IPv4 address in its next 32 bits.
  if (groups[0] === 0x2002) {
    return isPrivateAddress(embedded(groups[1], groups[2]));
  }
  // Teredo (2001::/32) and deprecated IPv4-compatible (::/96).
  if (groups[0] === 0x2001 && groups[1] === 0) {
    return true;
  }
  if (zero(0, 5)) {
    return true;
  }
  if (groups[0] === 0x100 && zero(1, 3)) {
    return true;
  }
  if (((groups[0] ?? 0) & 0xffc0) === 0xfec0) {
    return true;
  }
  return false;
}

/** An IPv6 address as its eight 16-bit groups, or null when it doesn't parse. */
function ipv6Groups(address: string): number[] | null {
  const text = address.split("%")[0] ?? address;
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string): number[] | null => {
    if (part.length === 0) {
      return [];
    }
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const octets = piece.split(".").map((value) => Number(value));
        if (
          octets.length !== 4 ||
          octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
        ) {
          return null;
        }
        out.push(
          ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
          ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
        );
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) {
        return null;
      }
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  if (head === null) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = parse(halves[1] ?? "");
  if (tail === null) {
    return null;
  }
  const zeros = 8 - head.length - tail.length;
  if (zeros < 1) {
    return null;
  }
  return [...head, ...Array.from({ length: zeros }, () => 0), ...tail];
}

interface PublicAddress {
  address: string;
  family: 4 | 6;
}

async function resolvePublic(hostname: string, port: string): Promise<PublicAddress> {
  const named = namedByUser(hostname, port);
  if (hostname.toLowerCase() === "localhost" && !named) {
    throw new ImageFetchError("localhost is not a public address");
  }
  if (isIP(hostname) !== 0) {
    if (isPrivateAddress(hostname) && !named && !allowedAddress(hostname)) {
      throw new ImageFetchError(`${hostname} is a private address`);
    }
    return { address: hostname, family: isIP(hostname) === 6 ? 6 : 4 };
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new ImageFetchError(`${hostname} resolves to no address`);
  }
  if (!named) {
    for (const record of records) {
      if (!allowedAddress(record.address)) {
        throw new ImageFetchError(`${hostname} resolves to a private address`);
      }
    }
  }
  const first = records[0];
  if (first === undefined) {
    throw new ImageFetchError(`${hostname} resolves to no address`);
  }
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function pinnedAgent(pinned: PublicAddress): Agent {
  return new Agent({
    connect: {
      lookup: (_hostname, _options, callback) => {
        callback(null, pinned.address, pinned.family);
      },
    },
  });
}

function redirectTarget(status: number, location: string | null, base: URL): URL | null {
  if (status < 300 || status >= 400 || location === null || location.length === 0) {
    return null;
  }
  return new URL(location, base);
}

async function readCapped(response: Awaited<ReturnType<typeof undiciFetch>>): Promise<Buffer> {
  const body = response.body;
  if (body === null) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_IMAGE_BYTES) {
      throw new ImageFetchError(`the image is over ${MAX_IMAGE_BYTES >> 20} MB`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The image's type from its first bytes, or null when it is not an image. */
export function sniffImageType(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (
      ["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"].includes(
        brand,
      )
    ) {
      return "image/heic";
    }
  }
  return null;
}

async function fetchHttpImage(src: string): Promise<{ bytes: Buffer; mediaType: string }> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = new URL(src);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new ImageFetchError(`${current.protocol} is not an http(s) URL`);
    }
    const defaultPort = current.protocol === "https:" ? "443" : "80";
    const port = current.port === "" ? defaultPort : current.port;
    const pinned = await resolvePublic(current.hostname, port);
    const agent = pinnedAgent(pinned);
    try {
      const response = await undiciFetch(current, {
        method: "GET",
        redirect: "manual",
        signal,
        dispatcher: agent,
      });
      const next = redirectTarget(response.status, response.headers.get("location"), current);
      if (next !== null) {
        await response.body?.cancel();
        current = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ImageFetchError(`HTTP ${response.status}`);
      }
      const bytes = await readCapped(response);
      const mediaType = sniffImageType(bytes);
      if (mediaType === null) {
        throw new ImageFetchError("the URL did not answer with an image");
      }
      return { bytes, mediaType };
    } finally {
      await agent.close();
    }
  }
  throw new ImageFetchError(`it redirects more than ${MAX_REDIRECTS} times`);
}

/** The bytes and type of an image named by a data URL or an http(s) URL. */
export async function loadImageSource(src: string): Promise<{ bytes: Buffer; mediaType: string }> {
  if (src.length === 0) {
    throw new ImageFetchError("the image has no portable source");
  }
  const inline = parseDataUrl(src);
  if (inline !== null) {
    if (inline.base64.length > MAX_DATA_URL_BASE64) {
      throw new ImageFetchError(`the inline image is over ${MAX_DATA_URL_BASE64 >> 20} MB`);
    }
    if (inline.bytes.length > MAX_IMAGE_BYTES) {
      throw new ImageFetchError(`the image is over ${MAX_IMAGE_BYTES >> 20} MB`);
    }
    const mediaType = sniffImageType(inline.bytes) ?? inline.mediaType;
    return { bytes: inline.bytes, mediaType };
  }
  if (!src.startsWith("http://") && !src.startsWith("https://")) {
    throw new ImageFetchError("the image is not a data URL or an http(s) URL");
  }
  return fetchHttpImage(src);
}
