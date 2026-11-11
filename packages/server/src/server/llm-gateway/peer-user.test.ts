import { describe, expect, it } from "vitest";
import { parseIp } from "./net-addr.js";
import { sameInPcblist, sameInProcNet } from "./peer-user.js";

interface Endpoint {
  address: NonNullable<ReturnType<typeof parseIp>>;
  port: number;
}

function endpoint(address: string, port: number): Endpoint {
  const parsed = parseIp(address);
  if (parsed === null) {
    throw new Error(`bad address ${address}`);
  }
  return { address: parsed, port };
}

function put4(view: DataView, offset: number, address: Endpoint["address"]): void {
  address.bytes.forEach((byte, index) => view.setUint8(offset + index, byte));
}

function put16(view: DataView, offset: number, address: Endpoint["address"]): void {
  address.bytes.forEach((byte, index) => view.setUint8(offset + index, byte));
}

/** One xtcpcb entry in a pcblist read: the sizes and offsets the reader uses. */
function pcblist(entries: Array<(view: DataView, offset: number) => number>): Uint8Array {
  const buffer = new Uint8Array(8 + 524 * entries.length);
  const view = new DataView(buffer.buffer);
  view.setUint32(0, 8, true);
  view.setUint32(4, entries.length, true);
  entries.forEach((fill, index) => {
    const offset = 8 + index * 524;
    view.setUint32(offset, fill(view, offset), true);
  });
  return buffer;
}

function ipv4Entry(
  peer: Endpoint,
  local: Endpoint,
  uid: number,
): (view: DataView, offset: number) => number {
  return (view, offset) => {
    view.setUint16(offset + 20, local.port, false);
    view.setUint16(offset + 22, peer.port, false);
    view.setUint8(offset + 80, 0x1);
    put4(view, offset + 96, local.address);
    put4(view, offset + 112, peer.address);
    view.setUint32(offset + 512, uid, true);
    return 524;
  };
}

function ipv6Entry(
  peer: Endpoint,
  local: Endpoint,
  uid: number,
): (view: DataView, offset: number) => number {
  return (view, offset) => {
    view.setUint16(offset + 20, local.port, false);
    view.setUint16(offset + 22, peer.port, false);
    view.setUint8(offset + 80, 0x2);
    put16(view, offset + 84, local.address);
    put16(view, offset + 100, peer.address);
    view.setUint32(offset + 512, uid, true);
    return 524;
  };
}

const peer4 = endpoint("10.1.2.3", 5000);
const local4 = endpoint("10.1.2.3", 6767);
const peer6 = endpoint("2001:db8::2", 5001);
const local6 = endpoint("2001:db8::2", 6767);

describe("sameInPcblist", () => {
  it("reads the owner of an IPv4 connection", () => {
    const table = pcblist([ipv4Entry(peer4, local4, 1000)]);
    expect(sameInPcblist(table, peer4, local4, 1000)).toBe(true);
    expect(sameInPcblist(table, peer4, local4, 1001)).toBe(false);
  });

  it("reads the owner of an IPv6 connection", () => {
    const table = pcblist([ipv6Entry(peer6, local6, 1000)]);
    expect(sameInPcblist(table, peer6, local6, 1000)).toBe(true);
    expect(sameInPcblist(table, peer6, local6, 0)).toBe(false);
  });

  it("finds the row among others, and says unknown when none is the connection", () => {
    const other = endpoint("10.9.9.9", 6000);
    const table = pcblist([ipv4Entry(peer4, local4, 1000), ipv4Entry(other, local4, 1000)]);
    expect(sameInPcblist(table, other, local4, 1000)).toBe(true);
    const missing = endpoint("10.7.7.7", 5000);
    expect(sameInPcblist(table, missing, local4, 1000)).toBeNull();
  });

  it("says unknown for a short or malformed table", () => {
    expect(sameInPcblist(new Uint8Array(4), peer4, local4, 0)).toBeNull();
    const table = new Uint8Array(16);
    const view = new DataView(table.buffer);
    view.setUint32(0, 8, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, 4096, true);
    expect(sameInPcblist(table, peer4, local4, 0)).toBeNull();
  });

  it("skips an entry that isn't the 32-bit xtcpcb layout", () => {
    const table = pcblist([
      (view, offset) => {
        view.setUint16(offset + 20, local4.port, false);
        view.setUint16(offset + 22, peer4.port, false);
        view.setUint8(offset + 80, 0x1);
        put4(view, offset + 96, local4.address);
        put4(view, offset + 112, peer4.address);
        view.setUint32(offset + 512, 7, true);
        return 500;
      },
    ]);
    // The length says 500, so the next entry starts inside this one; the
    // reader can't trust the table.
    expect(sameInPcblist(table, peer4, local4, 7)).toBeNull();
  });
});

const HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

function procRow(local: string, remote: string, uid: number): string {
  return `   0: ${local} ${remote} 01 00000000:00000000 00:00000000 00000000 ${uid} 0 1`;
}

describe("sameInProcNet", () => {
  it("reads the owner of the row whose local end is the peer's", () => {
    const table = [HEADER, procRow("0100007F:1388", "0100007F:1A6F", 1000)].join("\n");
    expect(
      sameInProcNet(table, endpoint("127.0.0.1", 5000), endpoint("127.0.0.1", 6767), 1000),
    ).toBe(true);
    expect(sameInProcNet(table, endpoint("127.0.0.1", 5000), endpoint("127.0.0.1", 6767), 0)).toBe(
      false,
    );
    expect(
      sameInProcNet(table, endpoint("127.0.0.1", 5001), endpoint("127.0.0.1", 6767), 1000),
    ).toBeNull();
  });

  it("reads the 32-hex IPv6 form", () => {
    const table = [
      HEADER,
      procRow(
        "00000000000000000000000001000000:1389",
        "00000000000000000000000001000000:1A6F",
        501,
      ),
    ].join("\n");
    expect(sameInProcNet(table, endpoint("::1", 5001), endpoint("::1", 6767), 501)).toBe(true);
    expect(sameInProcNet(table, endpoint("::1", 5001), endpoint("::1", 6767), 500)).toBe(false);
  });

  it("reads an IPv4-mapped IPv6 row as IPv4", () => {
    const mapped = "0000000000000000FFFF00000302010A";
    const table = [HEADER, procRow(`${mapped}:1388`, `${mapped}:1A6F`, 7)].join("\n");
    expect(sameInProcNet(table, endpoint("10.1.2.3", 5000), endpoint("10.1.2.3", 6767), 7)).toBe(
      true,
    );
  });

  it("says unknown when no row is the connection", () => {
    const table = [HEADER, procRow("0100007F:1388", "0100007F:1A6F", 0)].join("\n");
    expect(
      sameInProcNet(table, endpoint("127.0.0.1", 6000), endpoint("127.0.0.1", 6767), 0),
    ).toBeNull();
  });
});
