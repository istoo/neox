/**
 * The address arithmetic the gateway's network guards need (the allow list
 * and the loopback user check), ported from myna's netip use. Node has no
 * netip: addresses are parsed to bytes here so IPv4 and IPv6 are compared
 * without a library.
 */

export interface IpAddress {
  family: 4 | 6;
  bytes: Uint8Array;
}

export interface IpPrefix {
  address: IpAddress;
  bits: number;
}

const V4_MAPPED = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);

function strip(raw: string): string {
  let out = raw.trim();
  if (out.startsWith("[") && out.endsWith("]")) {
    out = out.slice(1, -1);
  }
  const zone = out.indexOf("%");
  return zone < 0 ? out : out.slice(0, zone);
}

function parseV4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] ?? "";
    if (part.length === 0 || part.length > 3 || !/^\d+$/.test(part)) {
      return null;
    }
    const value = Number(part);
    if (value > 255) {
      return null;
    }
    out[i] = value;
  }
  return out;
}

function parseV6(text: string): Uint8Array | null {
  const halves = text.split("::");
  if (halves.length > 2) {
    return null;
  }
  const split = (half: string): string[] => (half.length === 0 ? [] : half.split(":"));
  const head = split(halves[0] ?? "");
  const tail = halves.length === 2 ? split(halves[1] ?? "") : [];
  const groups: number[] = [];
  const push = (group: string, last: boolean): boolean => {
    if (last && group.includes(".")) {
      const v4 = parseV4(group);
      if (v4 === null) {
        return false;
      }
      groups.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      return true;
    }
    if (group.length === 0 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) {
      return false;
    }
    groups.push(Number.parseInt(group, 16));
    return true;
  };
  for (let i = 0; i < head.length; i += 1) {
    if (!push(head[i]!, i === head.length - 1 && tail.length === 0)) {
      return null;
    }
  }
  const tailStart = groups.length;
  for (let i = 0; i < tail.length; i += 1) {
    if (!push(tail[i]!, i === tail.length - 1)) {
      return null;
    }
  }
  const tailGroups = groups.length - tailStart;
  if (halves.length === 2) {
    const zeros = 8 - tailStart - tailGroups;
    if (zeros < 1) {
      return null;
    }
    groups.splice(tailStart, 0, ...Array<number>(zeros).fill(0));
  }
  if (groups.length !== 8) {
    return null;
  }
  const out = new Uint8Array(16);
  groups.forEach((group, index) => {
    out[index * 2] = group >> 8;
    out[index * 2 + 1] = group & 0xff;
  });
  return out;
}

function isMapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) {
    return false;
  }
  for (let i = 0; i < V4_MAPPED.length; i += 1) {
    if (bytes[i] !== V4_MAPPED[i]) {
      return false;
    }
  }
  return true;
}

/** Parses an address, with an IPv4 address written as IPv6 read as IPv4. */
export function parseIp(raw: string): IpAddress | null {
  const text = strip(raw);
  if (text.length === 0) {
    return null;
  }
  if (!text.includes(":")) {
    const bytes = parseV4(text);
    return bytes === null ? null : { family: 4, bytes };
  }
  const bytes = parseV6(text);
  if (bytes === null) {
    return null;
  }
  if (isMapped(bytes)) {
    return { family: 4, bytes: bytes.slice(12) };
  }
  return { family: 6, bytes };
}

export function sameAddress(left: IpAddress, right: IpAddress): boolean {
  if (left.family !== right.family) {
    return false;
  }
  return left.bytes.every((byte, index) => byte === right.bytes[index]);
}

export function isLoopbackAddress(address: IpAddress): boolean {
  if (address.family === 4) {
    return address.bytes[0] === 127;
  }
  const bytes = address.bytes;
  const leading = bytes.slice(0, 15).every((byte) => byte === 0);
  return leading && bytes[15] === 1;
}

/** An allow-list entry: an address, or a range in CIDR form. */
export function parsePrefix(raw: string): IpPrefix | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }
  const slash = text.indexOf("/");
  if (slash < 0) {
    const address = parseIp(text);
    return address === null ? null : { address, bits: address.family === 4 ? 32 : 128 };
  }
  const rawAddress = text.slice(0, slash);
  const rawV6 = rawAddress.includes(":") ? parseV6(strip(rawAddress)) : null;
  const mapped = rawV6 !== null && isMapped(rawV6);
  let address = parseIp(rawAddress);
  let bits = Number(text.slice(slash + 1));
  if (address === null || !Number.isInteger(bits) || bits < 0) {
    return null;
  }
  // An IPv4 range written in IPv6 form (`::ffff:198.51.100.0/120`) is the
  // IPv4 range: its last 32 bits are the address.
  if (mapped && rawV6 !== null && bits >= 96) {
    address = { family: 4, bytes: rawV6.slice(12) };
    bits -= 96;
  }
  if (address.family === 4 && bits > 32) {
    return null;
  }
  if (address.family === 6 && bits > 128) {
    return null;
  }
  const masked = address.bytes.map((byte, index) => {
    const left = bits - index * 8;
    if (left >= 8) {
      return byte;
    }
    return left <= 0 ? 0 : byte & ((0xff << (8 - left)) & 0xff);
  });
  return {
    address: { family: address.family, bytes: Uint8Array.from(masked) },
    bits,
  };
}

export function prefixContains(prefix: IpPrefix, address: IpAddress): boolean {
  if (prefix.address.family !== address.family) {
    return false;
  }
  const fullBytes = Math.floor(prefix.bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if ((prefix.address.bytes[index] ?? 0) !== (address.bytes[index] ?? 0)) {
      return false;
    }
  }
  const remainder = prefix.bits % 8;
  if (remainder === 0) {
    return true;
  }
  const shift = 8 - remainder;
  return (
    (prefix.address.bytes[fullBytes] ?? 0) >> shift === (address.bytes[fullBytes] ?? 0) >> shift
  );
}

/** "127.0.0.1:5000", "[::1]:5000" and a bare address, as the address. */
export function parseHostPort(raw: string): { address: IpAddress; port: number | null } | null {
  const text = strip(raw).trim();
  if (text.length === 0) {
    return null;
  }
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracketed !== null) {
    const address = parseIp(bracketed[1] ?? "");
    if (address === null) {
      return null;
    }
    return { address, port: bracketed[2] === undefined ? null : Number(bracketed[2]) };
  }
  const lastColon = text.lastIndexOf(":");
  if (lastColon >= 0 && !text.slice(lastColon + 1).includes(":")) {
    const maybePort = text.slice(lastColon + 1);
    if (/^\d+$/.test(maybePort)) {
      const address = parseIp(text.slice(0, lastColon));
      if (address !== null) {
        return { address, port: Number(maybePort) };
      }
    }
  }
  const address = parseIp(text);
  return address === null ? null : { address, port: null };
}
