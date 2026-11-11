import { describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import { isConnectionFailure, OfflineDetector, otherHosts } from "./offline.js";

function provider(
  id: string,
  baseUrl = "https://up.example/v1",
  accounts: unknown[] = [],
): GatewayProvider {
  return {
    id,
    protocol: "openai-responses",
    baseUrl,
    accounts,
    countFree: false,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    models: [],
    replyHeaders: [],
    passHeaders: [],
  } as GatewayProvider;
}

function connectionError(code = "ENOTFOUND"): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("getaddrinfo"), { code }),
  });
}

describe("isConnectionFailure", () => {
  it("tells a connection never made apart from a reply", () => {
    expect(isConnectionFailure(connectionError("ENOTFOUND"))).toBe(true);
    expect(isConnectionFailure(connectionError("ECONNREFUSED"))).toBe(true);
    expect(isConnectionFailure(new TypeError("fetch failed"))).toBe(false);
    expect(isConnectionFailure(new Error("socket hang up"))).toBe(false);
    expect(isConnectionFailure("ENOTFOUND")).toBe(true);
  });
});

describe("otherHosts", () => {
  it("skips the failed provider, its own host, near hosts and proxied ones", () => {
    const failed = provider("a", "https://a.example/v1");
    const providers = [
      failed,
      provider("b", "https://b.example/v1"),
      provider("c", "https://localhost/v1"),
      provider("d", "https://d.example/v1", [{ proxy: "http://127.0.0.1:8080" }]),
      provider("e", "https://e.example/v1"),
    ];
    expect(otherHosts(providers, failed)).toEqual(["b.example:443", "e.example:443"]);
  });
});

describe("OfflineDetector", () => {
  function detector(overrides: {
    hasNetwork?: boolean;
    dial?: boolean;
    now?: () => number;
  }): OfflineDetector {
    return new OfflineDetector({
      hasNetwork: () => overrides.hasNetwork ?? true,
      dialHost: async () => overrides.dial ?? true,
      now: overrides.now ?? (() => 10_000_000),
    });
  }

  it("does not call a reply's failure an outage", async () => {
    const offline = detector({});
    expect(
      await offline.isOffline(new TypeError("fetch failed"), [provider("a")], provider("a")),
    ).toBe(false);
  });

  it("treats no interface as offline once nothing has answered lately", async () => {
    const offline = detector({ hasNetwork: false, now: () => 10_000_000 });
    const providers = [provider("a")];
    expect(await offline.isOffline(connectionError(), providers, providers[0]!)).toBe(true);
  });

  it("treats a network that reaches no other provider as offline", async () => {
    const providers = [provider("a"), provider("b", "https://b.example/v1")];
    const offline = detector({ hasNetwork: true, dial: false });
    expect(await offline.isOffline(connectionError(), providers, providers[0]!)).toBe(true);
    const reachable = detector({ hasNetwork: true, dial: true });
    expect(await reachable.isOffline(connectionError(), providers, providers[0]!)).toBe(false);
  });

  it("believes a reply heard a moment ago", async () => {
    let now = 10_000_000;
    const offline = detector({ hasNetwork: false, now: () => now });
    const providers = [provider("a")];
    offline.noteHeard();
    now += 1_000;
    expect(await offline.isOffline(connectionError(), providers, providers[0]!)).toBe(false);
    now += 20_000;
    expect(await offline.isOffline(connectionError(), providers, providers[0]!)).toBe(true);
  });

  it("keeps a verdict for a moment", async () => {
    let now = 10_000_000;
    let asks = 0;
    const offline = new OfflineDetector({
      hasNetwork: () => {
        asks += 1;
        return false;
      },
      dialHost: async () => true,
      now: () => now,
    });
    const providers = [provider("a")];
    await offline.isOffline(connectionError(), providers, providers[0]!);
    await offline.isOffline(connectionError(), providers, providers[0]!);
    expect(asks).toBe(1);
    now += 6_000;
    await offline.isOffline(connectionError(), providers, providers[0]!);
    expect(asks).toBe(2);
  });
});
