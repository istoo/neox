import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "../config.js";
import {
  CheckinService,
  type CheckinConfigStore,
  type CheckinPluginProvider,
  type CheckinPluginSource,
  type CheckinServiceOptions,
} from "./service.js";

/** A service that reads no real myna sign-ins: every test's auth file is under its own home. */
function createService(
  home: string,
  options: Omit<CheckinServiceOptions, "neolixHome" | "mynaAuthPath">,
): CheckinService {
  return new CheckinService({
    neolixHome: home,
    mynaAuthPath: path.join(home, "plugin-auth.json"),
    ...options,
  });
}

function tempHome(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "neolix-plugin-checkin-"));
}

function store(initial: GatewayConfig = {}): CheckinConfigStore {
  let current = GatewayConfigSchema.parse(initial);
  return {
    get: () => current,
    write: async (input) => {
      current = GatewayConfigSchema.parse(input);
      return current;
    },
  };
}

async function writeAccounts(home: string, pluginId: string, accounts: unknown): Promise<void> {
  const dir = path.join(home, "plugin-settings", pluginId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "accounts.json"), `${JSON.stringify({ version: 1, accounts })}\n`);
}

function source(
  providers: CheckinPluginProvider[],
  checkin: CheckinPluginSource["checkin"],
): CheckinPluginSource {
  return { providers: () => providers, checkin };
}

const demo: CheckinPluginProvider = { pluginId: "demo-plugin", id: "demo", label: "Demo" };
const other: CheckinPluginProvider = { pluginId: "other-plugin", id: "other", label: "Other" };

describe("plugin check-ins", () => {
  it("lists a plugin provider's sign-ins under plugin:<id>", async () => {
    const home = await tempHome();
    await writeAccounts(home, demo.pluginId, {
      ann: { accountId: "Ann" },
      bob: {},
    });
    const service = createService(home, {
      config: store(),
      plugins: source([demo], async () => ({ outcome: "claimed" })),
    });

    expect(await service.listAccounts()).toEqual([
      {
        by: "plugin:demo",
        key: "demo-plugin|demo|ann",
        user: "Ann",
        on: true,
        again: false,
      },
      {
        by: "plugin:demo",
        key: "demo-plugin|demo|bob",
        user: "bob",
        on: true,
        again: false,
      },
    ]);
    expect(service.switches()).toEqual({
      workbuddy: false,
      minimax: false,
      trae: false,
      qoder: false,
      demo: false,
    });
  });

  it("keeps a plugin switch by provider id and a plugin row named plugin:<id>", async () => {
    const home = await tempHome();
    const config = store();
    const service = createService(home, {
      config,
      plugins: source([demo], async () => ({ outcome: "claimed" })),
    });

    await service.setSwitch("plugin:demo", true);
    expect(config.get().checkin?.plugins).toEqual({ demo: true });
    expect(service.switches().demo).toBe(true);
  });

  it("runs a plugin's accounts now, normalizes its answer, and keeps the record", async () => {
    const home = await tempHome();
    await writeAccounts(home, demo.pluginId, { ann: { accountId: "Ann" } });
    const calls: string[] = [];
    const asked = new Date("2026-01-02T05:00:00.000Z");
    const service = createService(home, {
      config: store(),
      now: () => asked,
      plugins: source([demo], async (input) => {
        calls.push(input.accountId);
        return {
          outcome: "claimed",
          credit: 12,
          streak: 3.4,
          message: "checked in",
          until: "2026-01-02T08:00:00.000Z",
        };
      }),
    });

    expect(await service.run()).toEqual([
      expect.objectContaining({
        by: "plugin:demo",
        key: "demo-plugin|demo|ann",
        user: "Ann",
        day: "2026-01-02",
        outcome: "claimed",
        credit: 12,
        streak: 3,
        msg: "checked in",
        until: "2026-01-02T08:00:00.000Z",
        asked: true,
      }),
    ]);
    expect(calls).toEqual(["ann"]);
    const kept = JSON.parse(
      await readFile(path.join(home, "gateway", "plugin-checkin.json"), "utf8"),
    ) as Record<string, { outcome: string; claimed: string }>;
    expect(kept["demo-plugin|demo|ann"]).toMatchObject({
      outcome: "claimed",
      claimed: "2026-01-02T05:00:00.000Z",
    });

    // The same Beijing day is settled: a second press asks nothing.
    await service.run();
    expect(calls).toEqual(["ann"]);
  });

  it("turns a bad plugin answer into a failed record, and one plugin never stops another", async () => {
    const home = await tempHome();
    await writeAccounts(home, demo.pluginId, { ann: {} });
    await writeAccounts(home, other.pluginId, { lee: {} });
    const service = createService(home, {
      config: store(),
      now: () => new Date("2026-01-02T05:00:00.000Z"),
      plugins: source([demo, other], async (input) => {
        if (input.providerId === "demo") return { outcome: "surprise" };
        if (input.providerId === "other") return { outcome: "claimed" };
        throw new Error("unreachable");
      }),
    });

    const entries = await service.run();
    expect(entries).toEqual([
      expect.objectContaining({ by: "plugin:demo", outcome: "failed" }),
      expect.objectContaining({ by: "plugin:other", outcome: "claimed" }),
    ]);
    expect(entries[0]?.msg).toContain("the plugin answered");
  });

  it("logs a plugin whose sign-ins can't be read and lists the others", async () => {
    const home = await tempHome();
    await writeAccounts(home, demo.pluginId, { ann: {} });
    const dir = path.join(home, "plugin-settings", other.pluginId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "accounts.json"), "{not json");
    const errors: unknown[] = [];
    const service = createService(home, {
      config: store(),
      plugins: source([demo, other], async () => ({ outcome: "claimed" })),
      onError: (error) => errors.push(error),
    });

    expect(await service.listAccounts()).toEqual([expect.objectContaining({ by: "plugin:demo" })]);
    expect(errors).toHaveLength(1);
  });

  it("runs a switched-on plugin on the scheduler's first look, and stops", async () => {
    const home = await tempHome();
    await writeAccounts(home, demo.pluginId, { ann: {} });
    await writeAccounts(home, other.pluginId, { lee: {} });
    const asked: string[] = [];
    const errors: unknown[] = [];
    const service = createService(home, {
      config: store({ checkin: { plugins: { demo: true, other: true } } }),
      firstCheckMs: 0,
      tickMs: 60_000,
      plugins: source([demo, other], async (input) => {
        asked.push(input.providerId);
        if (input.providerId === "other") throw new Error("other is down");
        return { outcome: "claimed" };
      }),
      onError: (error) => errors.push(error),
    });
    try {
      service.startScheduler();
      await vi.waitFor(() => expect(asked).toContain("demo"));
      expect(asked).toContain("other");
      // The failing plugin's answer is kept as a failure; the other still ran.
      const statuses = await service.listAccounts();
      expect(statuses.find((entry) => entry.by === "plugin:demo")?.record?.outcome).toBe("claimed");
      expect(statuses.find((entry) => entry.by === "plugin:other")?.record?.outcome).toBe("failed");
    } finally {
      service.stop();
    }
    expect(errors).toEqual([]);
  });
});
