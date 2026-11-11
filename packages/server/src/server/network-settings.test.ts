import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { GatewayConfigStore } from "./llm-gateway/config.js";
import {
  checkPort,
  LAN_KEY_LABEL,
  networkSettingsOf,
  parseTcpListen,
  saveNetworkSettings,
} from "./network-settings.js";
import { loadPersistedConfig } from "./persisted-config.js";

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-network-"));
}

function gatewayStore(neolixHome: string): GatewayConfigStore {
  writeFileSync(
    path.join(neolixHome, "gateway.json"),
    JSON.stringify({ version: 1, enabled: true, keys: [], providers: [], groups: [] }),
  );
  const store = new GatewayConfigStore({ neolixHome, logger: pino({ level: "silent" }) });
  return store;
}

describe("parseTcpListen", () => {
  it("reads a TCP address and refuses a socket", () => {
    expect(parseTcpListen("127.0.0.1:6767")).toEqual({ host: "127.0.0.1", port: 6767 });
    expect(parseTcpListen("0.0.0.0:7000")).toEqual({ host: "0.0.0.0", port: 7000 });
    expect(parseTcpListen("[::]:6767")).toEqual({ host: "::", port: 6767 });
    expect(parseTcpListen("unix:///tmp/neolix.sock")).toBeNull();
    expect(parseTcpListen("/tmp/neolix.sock")).toBeNull();
    expect(parseTcpListen(null)).toBeNull();
  });
});

describe("networkSettingsOf", () => {
  it("says whether the address shares on the LAN", () => {
    expect(networkSettingsOf("127.0.0.1:6767", "k").lan).toBe(false);
    expect(networkSettingsOf("127.0.0.1:6767", "k").lanKey).toBeNull();
    const shared = networkSettingsOf("0.0.0.0:6767", "k");
    expect(shared).toMatchObject({
      listen: "0.0.0.0:6767",
      port: 6767,
      lan: true,
      lanKey: "k",
    });
    // The addresses are this machine's own; each one is a URL at the port.
    for (const url of shared.lanUrls) {
      expect(url).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:6767$/);
    }
    expect(networkSettingsOf("unix:///tmp/neolix.sock", "k")).toEqual({
      listen: "unix:///tmp/neolix.sock",
      port: null,
      lan: false,
      lanKey: null,
      lanUrls: [],
    });
  });
});

describe("checkPort", () => {
  it("takes 1024 to 65535, and 0 for the default", () => {
    expect(checkPort(0)).toBeNull();
    expect(checkPort(1024)).toBeNull();
    expect(checkPort(65535)).toBeNull();
    expect(checkPort(80)).toContain("1024 to 65535");
    expect(checkPort(70000)).toContain("1024 to 65535");
  });
});

describe("saveNetworkSettings", () => {
  it("persists the port and the sharing flag, bound at the next start", async () => {
    const neolixHome = home();
    const saved = await saveNetworkSettings({
      neolixHome,
      listen: "127.0.0.1:6767",
      port: 7000,
      lan: false,
    });
    expect(saved).toEqual({
      listen: "127.0.0.1:7000",
      port: 7000,
      lan: false,
      lanKey: null,
      lanUrls: [],
      restartRequired: true,
    });
    const persisted = loadPersistedConfig(neolixHome);
    expect(persisted.daemon?.listen).toBe("127.0.0.1:7000");
    expect(persisted.daemon?.port).toBe(7000);
    expect(persisted.daemon?.lan).toBe(false);
  });

  it("makes one sharing key, reuses it, and keeps it while sharing is off", async () => {
    const neolixHome = home();
    const store = gatewayStore(neolixHome);
    const shared = await saveNetworkSettings({
      neolixHome,
      listen: "127.0.0.1:6767",
      lan: true,
      gatewayStore: store,
    });
    expect(shared.listen).toBe("0.0.0.0:6767");
    expect(shared.lan).toBe(true);
    expect(shared.lanKey).not.toBeNull();
    const keys = store.get().keys;
    expect(keys).toHaveLength(1);
    expect(typeof keys[0] === "string" ? null : keys[0]?.label).toBe(LAN_KEY_LABEL);
    expect(loadPersistedConfig(neolixHome).daemon?.lanKey).toBe(shared.lanKey);

    const again = await saveNetworkSettings({
      neolixHome,
      listen: "0.0.0.0:6767",
      lan: true,
      gatewayStore: store,
    });
    expect(again.lanKey).toBe(shared.lanKey);
    expect(store.get().keys).toHaveLength(1);

    const off = await saveNetworkSettings({
      neolixHome,
      listen: "0.0.0.0:6767",
      lan: false,
      gatewayStore: store,
    });
    expect(off.lan).toBe(false);
    expect(off.lanKey).toBeNull();
    // The key stays in gateway.json and in the daemon's config, as myna keeps it.
    expect(store.get().keys).toHaveLength(1);
    expect(loadPersistedConfig(neolixHome).daemon?.lanKey).toBe(shared.lanKey);

    const on = await saveNetworkSettings({
      neolixHome,
      listen: "127.0.0.1:6767",
      lan: true,
      gatewayStore: store,
    });
    expect(on.lanKey).toBe(shared.lanKey);
  });

  it("takes 0 as the default port", async () => {
    const neolixHome = home();
    const saved = await saveNetworkSettings({ neolixHome, listen: null, port: 0, lan: false });
    expect(saved.port).toBe(6868);
  });

  it("refuses a port below 1024", async () => {
    await expect(
      saveNetworkSettings({ neolixHome: home(), listen: null, port: 80, lan: false }),
    ).rejects.toThrow("1024 to 65535");
  });

  it("refuses when NEOLIX_LISTEN controls the address", async () => {
    vi.stubEnv("NEOLIX_LISTEN", "127.0.0.1:7000");
    try {
      await expect(
        saveNetworkSettings({ neolixHome: home(), listen: null, port: 7001, lan: false }),
      ).rejects.toThrow("NEOLIX_LISTEN");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
