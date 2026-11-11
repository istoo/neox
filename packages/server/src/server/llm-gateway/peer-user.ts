import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isLoopbackAddress, parseHostPort, sameAddress, type IpAddress } from "./net-addr.js";

/**
 * Whether the process on the other end of a loopback TCP connection runs as
 * this computer's user (myna's peeruser.go and peeruid). Another user on the
 * same computer can reach 127.0.0.1 too, and the gateway answers loopback
 * without a key; the kernel's TCP table names the socket's owner instead.
 *
 * A verdict is read once per connection, as it is accepted, so a request
 * costs no table read. Unknown — a platform with no reader, a connection not
 * in the table, or a read that failed — is taken as this user, as myna does.
 */

export interface PeerSocket {
  remoteAddress?: string | undefined;
  remotePort?: number | undefined;
  localAddress?: string | undefined;
  localPort?: number | undefined;
}

interface Endpoint {
  address: IpAddress;
  port: number;
}

const peers = new WeakMap<object, boolean>();

function endpointOf(address: string | undefined, port: number | undefined): Endpoint | null {
  if (address === undefined || port === undefined) {
    return null;
  }
  const parsed = parseHostPort(address);
  return parsed === null ? null : { address: parsed.address, port };
}

/**
 * Starts reading a connection's owner in the background, so a later request
 * on it has the verdict. Only loopback connections are read. Call it from the
 * HTTP server's `connection` event.
 */
export function noteConnection(socket: PeerSocket): void {
  const remote = endpointOf(socket.remoteAddress, socket.remotePort);
  const local = endpointOf(socket.localAddress, socket.localPort);
  if (remote === null || local === null || !isLoopbackAddress(remote.address)) {
    return;
  }
  const reader = readerFor(process.platform);
  if (reader === null) {
    return;
  }
  void reader(remote, local, currentUid())
    .then((same) => {
      if (same !== null) {
        peers.set(socket, same);
      }
      return;
    })
    .catch(() => undefined);
}

/** Whether the connection's peer is this user; true when nothing said it isn't. */
export function isSameOSUser(socket: PeerSocket): boolean {
  return peers.get(socket) ?? true;
}

/** Forgets a verdict, for tests. */
export function forgetPeerUser(socket: PeerSocket): void {
  peers.delete(socket);
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

type Reader = (peer: Endpoint, local: Endpoint, uid: number) => Promise<boolean | null>;

function readerFor(platform: NodeJS.Platform): Reader | null {
  if (platform === "darwin") {
    return readDarwin;
  }
  if (platform === "linux" || platform === "android") {
    return readLinux;
  }
  return null;
}

async function readDarwin(peer: Endpoint, local: Endpoint, uid: number): Promise<boolean | null> {
  const table = await new Promise<Buffer | null>((resolve) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-b", "net.inet.tcp.pcblist"],
      { maxBuffer: 16 << 20 },
      (error, stdout) => resolve(error === null && Buffer.isBuffer(stdout) ? stdout : null),
    );
  });
  if (table === null) {
    return null;
  }
  return sameInPcblist(table, peer, local, uid);
}

const XTCPCB_SIZE = 524;
const PC_OFF_FLAGS = 80;
const PC_OFF_FPORT = 20;
const PC_OFF_LPORT = 22;
const PC_OFF_FADDR4 = 96;
const PC_OFF_LADDR4 = 112;
const PC_OFF_FADDR6 = 84;
const PC_OFF_LADDR6 = 100;
const PC_OFF_UID = 512;
const INP_IPV4 = 0x1;
const INP_IPV6 = 0x2;

/**
 * `net.inet.tcp.pcblist`: `xtcpcb` entries. A 64-bit process is given the
 * 32-bit layout (pack(4), 32-bit pointers), which carries the owning socket's
 * uid where the newer `xtcpcb64` doesn't (`xt_len` tells them apart).
 */
export function sameInPcblist(
  table: Uint8Array,
  peer: Endpoint,
  local: Endpoint,
  uid: number,
): boolean | null {
  if (table.length < 8) {
    return null;
  }
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  let offset = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  for (let index = 0; index < count && offset + 4 <= table.length; index += 1) {
    const length = view.getUint32(offset, true);
    if (length <= 0 || offset + length > table.length) {
      return null;
    }
    if (
      length === XTCPCB_SIZE &&
      ownsPcblistEntry(table.subarray(offset, offset + length), peer, local)
    ) {
      return view.getUint32(offset + PC_OFF_UID, true) === uid;
    }
    offset += length;
  }
  return null;
}

function ownsPcblistEntry(entry: Uint8Array, peer: Endpoint, local: Endpoint): boolean {
  const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
  if (view.getUint16(PC_OFF_LPORT, false) !== peer.port) {
    return false;
  }
  if (view.getUint16(PC_OFF_FPORT, false) !== local.port) {
    return false;
  }
  const flags = entry[PC_OFF_FLAGS] ?? 0;
  if ((flags & INP_IPV4) !== 0) {
    return (
      sameBytes(entry, PC_OFF_LADDR4, peer.address, 4) &&
      sameBytes(entry, PC_OFF_FADDR4, local.address, 4)
    );
  }
  if ((flags & INP_IPV6) !== 0) {
    return (
      sameBytes(entry, PC_OFF_LADDR6, peer.address, 16) &&
      sameBytes(entry, PC_OFF_FADDR6, local.address, 16)
    );
  }
  return false;
}

function sameBytes(entry: Uint8Array, offset: number, address: IpAddress, size: number): boolean {
  if (address.family !== (size === 4 ? 4 : 6)) {
    return false;
  }
  for (let index = 0; index < size; index += 1) {
    if ((entry[offset + index] ?? 0) !== (address.bytes[index] ?? 0)) {
      return false;
    }
  }
  return true;
}

async function readLinux(peer: Endpoint, local: Endpoint, uid: number): Promise<boolean | null> {
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table: string;
    try {
      table = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const same = sameInProcNet(table, peer, local, uid);
    if (same !== null) {
      return same;
    }
  }
  return null;
}

/**
 * `/proc/net/tcp` and `tcp6`: local and remote address and port in hex, and
 * the uid that owns the socket. The row whose local end is the peer's is the
 * one to ask about.
 */
export function sameInProcNet(
  table: string,
  peer: Endpoint,
  local: Endpoint,
  uid: number,
): boolean | null {
  const lines = table.split("\n");
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8) {
      continue;
    }
    const listening = parseProcNet(fields[1] ?? "");
    const remote = parseProcNet(fields[2] ?? "");
    if (listening === null || remote === null) {
      continue;
    }
    if (listening.port !== peer.port || remote.port !== local.port) {
      continue;
    }
    if (
      !sameAddress(listening.address, peer.address) ||
      !sameAddress(remote.address, local.address)
    ) {
      continue;
    }
    const owner = Number(fields[7]);
    return owner === uid;
  }
  return null;
}

function parseProcNet(field: string): Endpoint | null {
  const colon = field.indexOf(":");
  if (colon < 0) {
    return null;
  }
  const port = Number.parseInt(field.slice(colon + 1), 16);
  if (!Number.isInteger(port)) {
    return null;
  }
  const hex = field.slice(0, colon);
  if (!/^(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{32})$/.test(hex)) {
    return null;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  // Each 32-bit word is written in host order, so its bytes come reversed.
  for (let index = 0; index < bytes.length; index += 4) {
    const first = bytes[index]!;
    bytes[index] = bytes[index + 3]!;
    bytes[index + 3] = first;
    const second = bytes[index + 1]!;
    bytes[index + 1] = bytes[index + 2]!;
    bytes[index + 2] = second;
  }
  if (bytes.length === 4) {
    return { address: { family: 4, bytes }, port };
  }
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return { address: { family: 4, bytes: bytes.slice(12) }, port };
  }
  return { address: { family: 6, bytes }, port };
}
