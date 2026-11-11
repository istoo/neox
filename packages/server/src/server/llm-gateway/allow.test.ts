import { networkInterfaces } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  ALLOW_IPS_ENV,
  allowListOf,
  allowVerdict,
  allowedIn,
  isLocalRequest,
  ownAddresses,
  splitAllowIps,
} from "./allow.js";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import { isLoopbackAddress, parseIp, parsePrefix } from "./net-addr.js";

function config(allowIPs: string[]): GatewayConfig {
  return { ...EMPTY_GATEWAY_CONFIG, allowIPs };
}

function socketFrom(remote: string): {
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
} {
  const colon = remote.lastIndexOf(":");
  const address = remote.slice(0, colon).replace(/^\[/, "").replace(/\]$/, "");
  return {
    remoteAddress: address,
    remotePort: Number(remote.slice(colon + 1)),
    localAddress: "127.0.0.1",
    localPort: 6767,
  };
}

describe("parsePrefix", () => {
  it("reads addresses and ranges, IPv4 written as IPv6 as IPv4", () => {
    expect(parsePrefix("203.0.113.7")?.bits).toBe(32);
    expect(parsePrefix("10.0.0.0/8")?.bits).toBe(8);
    expect(parsePrefix("2001:db8::/32")?.bits).toBe(32);
    expect(parsePrefix("::ffff:198.51.100.0/120")?.address.family).toBe(4);
    expect(parsePrefix("203.0.113.0/33")).toBeNull();
    expect(parsePrefix("not-an-address")).toBeNull();
  });

  it("unmaps an IPv4 address written as IPv6", () => {
    const address = parseIp("::ffff:10.1.2.3");
    expect(address?.family).toBe(4);
    expect(Array.from(address?.bytes ?? [])).toEqual([10, 1, 2, 3]);
  });
});

describe("allowedIn", () => {
  const own = ownAddresses();

  it("lets every address in with no list", () => {
    expect(allowedIn([], parseIp("203.0.113.9")!, own)).toBe(true);
  });

  it("judges an address by the list", () => {
    const list = ["198.51.100.7", "10.0.0.0/8", "2001:db8:1::/48"];
    expect(allowedIn(list, parseIp("198.51.100.7")!, own)).toBe(true);
    expect(allowedIn(list, parseIp("198.51.100.8")!, own)).toBe(false);
    expect(allowedIn(list, parseIp("10.20.30.40")!, own)).toBe(true);
    expect(allowedIn(list, parseIp("::ffff:10.1.2.3")!, own)).toBe(true);
    expect(allowedIn(list, parseIp("2001:db8:1:ff::2")!, own)).toBe(true);
    expect(allowedIn(list, parseIp("2001:db8:2::2")!, own)).toBe(false);
  });

  it("always lets this computer in", () => {
    const list = ["203.0.113.7"];
    for (const loopback of ["127.0.0.1", "127.8.9.10", "::1"]) {
      const address = parseIp(loopback)!;
      expect(isLoopbackAddress(address)).toBe(true);
      expect(allowedIn(list, address, own)).toBe(true);
    }
  });

  it("lets a typo in the list open nothing", () => {
    const list = ["203.0.113.0/33"];
    expect(allowedIn(list, parseIp("203.0.113.9")!, own)).toBe(false);
    expect(allowedIn(list, parseIp("198.51.100.7")!, own)).toBe(false);
  });

  it("lets this computer's own non-loopback address in", () => {
    const address = own.find((entry) => !isLoopbackAddress(entry));
    if (address === undefined) {
      return;
    }
    expect(allowedIn(["203.0.113.7"], address, own)).toBe(true);
  });
});

describe("allowVerdict", () => {
  it("refuses an address left out, naming it", () => {
    const verdict = allowVerdict(config(["10.0.0.0/8"]), {
      socket: socketFrom("198.51.100.7:5000"),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.address).toBe("198.51.100.7");
    expect(verdict.message).toContain("allow list");
    expect(verdict.message).toContain("198.51.100.7");
  });

  it("lets an address on the list through, and loopback always", () => {
    expect(
      allowVerdict(config(["10.0.0.0/8"]), { socket: socketFrom("10.20.30.40:5000") }).allowed,
    ).toBe(true);
    expect(
      allowVerdict(config(["10.0.0.0/8"]), { socket: socketFrom("127.0.0.1:5000") }).allowed,
    ).toBe(true);
  });

  it("lets everything in with no list", () => {
    expect(allowVerdict(config([]), { socket: socketFrom("203.0.113.9:5000") }).allowed).toBe(true);
  });
});

describe("isLocalRequest", () => {
  it("is true for loopback and false elsewhere", () => {
    expect(isLocalRequest({ socket: socketFrom("127.0.0.1:5000") })).toBe(true);
    expect(isLocalRequest({ socket: socketFrom("203.0.113.9:5000") })).toBe(false);
  });
});

describe("ownAddresses", () => {
  it("reads the interfaces without throwing", () => {
    const interfaces = networkInterfaces();
    expect(Object.keys(interfaces).length).toBeGreaterThan(0);
    expect(Array.isArray(ownAddresses())).toBe(true);
  });
});

describe("NEOLIX_ALLOW_IPS", () => {
  it("splits commas, semicolons and spaces", () => {
    expect(splitAllowIps("10.0.0.0/8, 2001:db8::/32 ;198.51.100.7\n")).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
      "198.51.100.7",
    ]);
  });

  it("stands in place of gateway.json's list", () => {
    const saved = config(["198.51.100.7"]);
    vi.stubEnv(ALLOW_IPS_ENV, "203.0.113.0/24 2001:db8::5");
    try {
      expect(allowListOf(saved)).toEqual(["203.0.113.0/24", "2001:db8::5"]);
      expect(allowVerdict(saved, { socket: socketFrom("198.51.100.7:5000") }).allowed).toBe(false);
      expect(allowVerdict(saved, { socket: socketFrom("203.0.113.200:5000") }).allowed).toBe(true);
      expect(allowVerdict(saved, { socket: socketFrom("127.0.0.1:5000") }).allowed).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(allowListOf(saved)).toEqual(["198.51.100.7"]);
  });

  it("is gateway.json's when unset or blank", () => {
    vi.stubEnv(ALLOW_IPS_ENV, "   ");
    try {
      expect(allowListOf(config(["10.0.0.0/8"]))).toEqual(["10.0.0.0/8"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
