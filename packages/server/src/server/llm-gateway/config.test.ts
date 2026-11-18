import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { accountDiscoveryOn, GatewayConfigStore } from "./config.js";

const logger = pino({ level: "silent" });

function createHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-gateway-config-"));
}

describe("accountDiscoveryOn", () => {
  it("reads the general key, then the Codex-only key it replaced", () => {
    expect(accountDiscoveryOn(undefined)).toBe(true);
    expect(accountDiscoveryOn({ codexAccountDiscovery: false } as never)).toBe(false);
    expect(
      accountDiscoveryOn({ accountDiscovery: false, codexAccountDiscovery: true } as never),
    ).toBe(false);
    expect(
      accountDiscoveryOn({ accountDiscovery: true, codexAccountDiscovery: false } as never),
    ).toBe(true);
  });
});

describe("GatewayConfigStore", () => {
  it("starts disabled when no config file exists", async () => {
    const store = new GatewayConfigStore({ neolixHome: createHome(), logger });
    await store.start();

    expect(store.get()).toMatchObject({ enabled: true, providers: [], groups: [], keys: [] });
    store.dispose();
  });

  it("logs no error for a fresh home that has no config file yet", async () => {
    const lines: string[] = [];
    const capturing = pino({ level: "error" }, { write: (line: string) => lines.push(line) });
    const store = new GatewayConfigStore({ neolixHome: createHome(), logger: capturing });
    await store.start();

    expect(lines).toEqual([]);
    store.dispose();
  });

  it("still logs a file that is there but not a gateway config", async () => {
    const neolixHome = createHome();
    writeFileSync(path.join(neolixHome, "gateway.json"), "null");
    const lines: string[] = [];
    const capturing = pino({ level: "error" }, { write: (line: string) => lines.push(line) });
    const store = new GatewayConfigStore({ neolixHome, logger: capturing });
    await store.start();

    expect(lines.join("")).toContain("Invalid LLM gateway config");
    store.dispose();
  });

  it("parses providers and groups", async () => {
    const neolixHome = createHome();
    writeFileSync(
      path.join(neolixHome, "gateway.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "deepseek",
            protocol: "openai",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: "sk-test",
            models: [{ id: "deepseek-v4-pro" }],
          },
        ],
        groups: [{ id: "daily", members: ["deepseek/deepseek-v4-pro"] }],
      }),
    );
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();

    expect(store.get().providers[0]?.id).toBe("deepseek");
    expect(store.get().groups[0]?.id).toBe("daily");
    store.dispose();
  });

  it("keeps masking categories and custom rules", async () => {
    const store = new GatewayConfigStore({ neolixHome: createHome(), logger });
    await store.start();

    await store.write({
      version: 1,
      enabled: true,
      keys: [],
      providers: [],
      groups: [],
      masking: {
        enabled: true,
        allow: [],
        categories: ["API_KEY", "CARD"],
        rules: [{ kind: "TICKET", pattern: "TICKET-[0-9]+", flags: "g" }],
      },
    });

    expect(store.get().masking).toMatchObject({
      categories: ["API_KEY", "CARD"],
      rules: [{ kind: "TICKET", pattern: "TICKET-[0-9]+", flags: "g" }],
      // The masking alert is off until it is turned on. Personal data is on:
      // a config that turns masking on and names no switch kept it on
      // before the switch existed (COMPAT(maskingPersonalDefault)).
      alert: false,
      personal: true,
    });
    store.dispose();
  });

  it("keeps masking personal data on for a config written before the switch", async () => {
    const neolixHome = createHome();
    writeFileSync(
      path.join(neolixHome, "gateway.json"),
      JSON.stringify({ version: 1, masking: { enabled: true } }),
    );
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();

    expect(store.get().masking?.personal).toBe(true);

    // The first write persists the value, so the next read needs no compat.
    await store.write(store.get());
    const saved = JSON.parse(readFileSync(path.join(neolixHome, "gateway.json"), "utf8")) as {
      masking?: { personal?: boolean };
    };
    expect(saved.masking?.personal).toBe(true);
    store.dispose();
  });

  it("honors an explicit personal switch on an old config", async () => {
    const neolixHome = createHome();
    writeFileSync(
      path.join(neolixHome, "gateway.json"),
      JSON.stringify({ version: 1, masking: { enabled: true, personal: false } }),
    );
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();

    expect(store.get().masking?.personal).toBe(false);
    store.dispose();
  });

  it("disables the gateway when the file is malformed", async () => {
    const neolixHome = createHome();
    const filePath = path.join(neolixHome, "gateway.json");
    writeFileSync(filePath, JSON.stringify({ providers: [{ id: "Bad Id" }] }));
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();

    expect(store.get().providers).toEqual([]);

    writeFileSync(
      filePath,
      JSON.stringify({
        providers: [
          {
            id: "ok",
            protocol: "anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            models: [],
          },
        ],
      }),
    );
    store.dispose();
    await store.start();

    expect(store.get().providers.map((provider) => provider.id)).toEqual(["ok"]);
    store.dispose();
  });
});

describe("rate windows", () => {
  it("reads an old peak window as a rate window on load", async () => {
    const neolixHome = createHome();
    writeFileSync(
      path.join(neolixHome, "gateway.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "relay",
            protocol: "openai",
            baseUrl: "https://relay.example.test/v1",
            peak: { startHour: 9, endHour: 18, rate: 2 },
            models: [{ id: "m" }],
          },
        ],
      }),
    );
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();

    expect(store.get().providers[0]?.rateWindows).toEqual([
      { start: "09:00", end: "18:00", rate: 2 },
    ]);
    store.dispose();
  });

  it("keeps the windows a config names", async () => {
    const store = new GatewayConfigStore({ neolixHome: createHome(), logger });
    await store.start();
    const config = await store.write({
      providers: [
        {
          id: "relay",
          protocol: "openai",
          baseUrl: "https://relay.example.test/v1",
          rateWindows: [
            { start: "22:00", end: "06:00", rate: 3, days: [1, 2] },
            { start: "12:00", end: "13:00", rate: 0.5 },
          ],
          models: [],
        },
      ],
    });

    expect(config.providers[0]?.rateWindows).toHaveLength(2);
    store.dispose();
  });
});
