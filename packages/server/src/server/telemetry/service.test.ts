import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DaemonConfigStore } from "../daemon-config-store.js";
import { editPersistedConfig, loadPersistedConfig } from "../persisted-config.js";
import {
  TelemetryService,
  normalizeAgentId,
  normalizeProviderId,
  normalizeUsage,
  type TelemetryConfig,
  type TelemetryUsageSnapshot,
} from "./service.js";

interface RecordedRequest {
  url: string;
  body: {
    api_key: string;
    batch: Array<{
      event: string;
      distinct_id: string;
      timestamp: string;
      properties: Record<string, unknown>;
    }>;
  };
}

interface Stub {
  endpoint: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startStub(status = 200): Promise<Stub> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", body: JSON.parse(raw) as RecordedRequest["body"] });
      res.statusCode = status;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Stub did not bind a TCP port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}/batch/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const USAGE: TelemetryUsageSnapshot = {
  agents: ["claude#work@wsl:Ubuntu", "codex", "cursor"],
  providers: [
    { preset: "deepseek", models: ["deepseek-v4"] },
    { baseUrl: "https://example.invalid/v1", models: ["mine"] },
    { baseUrl: "plugin://acme/v1", models: ["acme-model"] },
  ],
  groups: 2,
};

function makeService(params: {
  home: string;
  endpoint: string;
  config: TelemetryConfig;
  usage?: TelemetryUsageSnapshot;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}) {
  return new TelemetryService({
    neolixHome: params.home,
    version: "9.9.9",
    endpoint: params.endpoint,
    env: params.env ?? {},
    now: () => params.now ?? new Date("2026-11-06T10:00:00.000Z"),
    config: () => params.config,
    usage: () => params.usage ?? USAGE,
    platform: "linux",
  });
}

function modeOf(file: string): number {
  return statSync(file).mode & 0o777;
}

describe("TelemetryService", () => {
  const tempDirs: string[] = [];
  const stubs: Stub[] = [];

  afterEach(async () => {
    for (const running of stubs.splice(0)) await running.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "neolix-telemetry-"));
    tempDirs.push(dir);
    return dir;
  }

  async function stub(status = 200): Promise<Stub> {
    const created = await startStub(status);
    stubs.push(created);
    return created;
  }

  test("off by default: no id, no file, no request", async () => {
    const dir = home();
    const http = await stub();
    const service = makeService({ home: dir, endpoint: http.endpoint, config: {} });

    service.start();
    await service.stopAndDrain();

    expect(http.requests).toHaveLength(0);
    expect(() => readFileSync(path.join(dir, "telemetry-id"))).toThrow();
    expect(() => readFileSync(path.join(dir, "telemetry-sent"))).toThrow();
  });

  test("aborts an in-flight send, returns quickly, and writes nothing after", async () => {
    const dir = home();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new TelemetryService({
      neolixHome: dir,
      version: "9.9.9",
      endpoint: "https://telemetry.test/batch/",
      env: {},
      now: () => new Date("2026-11-06T10:00:00.000Z"),
      config: () => ({ enabled: true }),
      usage: () => USAGE,
      fetchImpl: ((_input: RequestInfo | URL, init?: RequestInit) => {
        started();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }) as typeof fetch,
    });

    service.start();
    await requestStarted;
    const before = readdirSync(dir).sort();
    const startedAt = Date.now();
    await service.stopAndDrain();
    // Aborting ends the request at once instead of waiting out its timeout.
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(readdirSync(dir).sort()).toEqual(before);
    expect(() => readFileSync(path.join(dir, "telemetry-sent"))).toThrow();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  test("enabled sends a random id once a day and records the day", async () => {
    const dir = home();
    const http = await stub();
    const service = makeService({
      home: dir,
      endpoint: http.endpoint,
      config: { enabled: true, shareUsage: false },
    });

    service.start();
    await vi.waitFor(() =>
      expect(readFileSync(path.join(dir, "telemetry-sent"), "utf8").trim()).toBe("2026-11-06"),
    );
    await service.stopAndDrain();

    expect(http.requests).toHaveLength(1);
    const request = http.requests[0]!;
    expect(request.url).toBe("/batch/");
    expect(request.body.api_key).toBe("phc_nyDyYyrUTRGvNq5U7FBesCyM2j4GdKeqGp8ko7DBerTC");
    expect(request.body.batch).toHaveLength(1);

    const active = request.body.batch[0]!;
    expect(active.event).toBe("neolix active");
    expect(active.distinct_id).toMatch(/^[0-9a-f]{32}$/);
    expect(active.properties).toMatchObject({
      version: "9.9.9",
      kind: "daemon",
      $os: "Linux",
      arch: process.arch,
      $process_person_profile: false,
      distinct_id: active.distinct_id,
    });
    expect(active.properties).not.toHaveProperty("agents");
    expect(active.properties).not.toHaveProperty("providers");
    expect(active.properties).not.toHaveProperty("models");
    expect(active.properties).not.toHaveProperty("groups");

    const idPath = path.join(dir, "telemetry-id");
    expect(readFileSync(idPath, "utf8").trim()).toBe(active.distinct_id);
    // Windows cannot express POSIX permissions; the file is private by location there.
    if (process.platform !== "win32") {
      expect(modeOf(idPath)).toBe(0o600);
    }
    expect(readFileSync(path.join(dir, "telemetry-sent"), "utf8").trim()).toBe("2026-11-06");

    service.start();
    await service.stopAndDrain();
    expect(http.requests).toHaveLength(1);
  });

  test("shareUsage sends counts plus normalized uses events", async () => {
    const dir = home();
    const http = await stub();
    const service = makeService({
      home: dir,
      endpoint: http.endpoint,
      config: { enabled: true, shareUsage: true },
      usage: USAGE,
    });

    service.start();
    await vi.waitFor(() =>
      expect(readFileSync(path.join(dir, "telemetry-sent"), "utf8").trim()).toBe("2026-11-06"),
    );
    await service.stopAndDrain();

    const batch = http.requests[0]!.body.batch;
    const active = batch[0]!;
    expect(active.properties).toMatchObject({
      agents: 3,
      providers: 3,
      models: 3,
      groups: 2,
    });

    const uses = batch.slice(1).map((event) => ({
      event: event.event,
      kind: event.properties.kind,
      id: event.properties.id,
    }));
    expect(uses).toEqual([
      { event: "neolix uses", kind: "agent", id: "claude" },
      { event: "neolix uses", kind: "agent", id: "codex" },
      { event: "neolix uses", kind: "agent", id: "plugin" },
      { event: "neolix uses", kind: "provider", id: "deepseek" },
      { event: "neolix uses", kind: "provider", id: "custom" },
      { event: "neolix uses", kind: "provider", id: "plugin" },
      { event: "neolix uses", kind: "model", id: "deepseek/deepseek-v4" },
      { event: "neolix uses", kind: "model", id: "custom" },
      { event: "neolix uses", kind: "model", id: "plugin" },
    ]);
  });

  test("DO_NOT_TRACK forces sharing off", async () => {
    const dir = home();
    const http = await stub();
    const service = makeService({
      home: dir,
      endpoint: http.endpoint,
      config: { enabled: true, shareUsage: true },
      env: { DO_NOT_TRACK: "1" },
    });

    service.start();
    await service.stopAndDrain();

    expect(http.requests).toHaveLength(0);
    expect(() => readFileSync(path.join(dir, "telemetry-id"))).toThrow();
  });

  test("NEOLIX_NO_TELEMETRY forces sharing off", async () => {
    const dir = home();
    const http = await stub();
    const service = makeService({
      home: dir,
      endpoint: http.endpoint,
      config: { enabled: true },
      env: { NEOLIX_NO_TELEMETRY: "1" },
    });

    service.start();
    await service.stopAndDrain();

    expect(http.requests).toHaveLength(0);
  });

  test("a failing endpoint sends nothing to the day file and retries next hour", async () => {
    const dir = home();
    const http = await stub(500);
    const service = makeService({
      home: dir,
      endpoint: http.endpoint,
      config: { enabled: true },
    });

    service.start();
    await vi.waitFor(() => expect(http.requests).toHaveLength(1));
    await service.stopAndDrain();

    expect(http.requests).toHaveLength(1);
    expect(() => readFileSync(path.join(dir, "telemetry-sent"))).toThrow();
  });
});

describe("telemetry id normalization", () => {
  test("agent ids drop profile and WSL suffixes, unknown providers become plugin", () => {
    expect(normalizeAgentId("claude#work@wsl:Ubuntu")).toBe("claude");
    expect(normalizeAgentId("codex@wsl:Debian")).toBe("codex");
    expect(normalizeAgentId("cursor")).toBe("plugin");
  });

  test("known presets keep their id, everything else is custom or plugin", () => {
    expect(normalizeProviderId({ preset: "deepseek" })).toBe("deepseek");
    expect(normalizeProviderId({ preset: "not-a-preset" })).toBe("custom");
    expect(normalizeProviderId({ baseUrl: "https://example.invalid/v1" })).toBe("custom");
    expect(normalizeProviderId({ baseUrl: "plugin://acme/v1" })).toBe("plugin");
  });

  test("each kind is deduplicated and capped at 50", () => {
    const models = Array.from({ length: 60 }, (_, index) => `model-${index}`);
    const usage = normalizeUsage({
      agents: ["claude", "claude#work", "cursor"],
      providers: [{ preset: "deepseek", models }],
      groups: 0,
    });
    expect(usage.agents).toEqual(["claude", "plugin"]);
    expect(usage.models).toHaveLength(50);
    expect(new Set(usage.models).size).toBe(50);
  });
});

describe("daemon.telemetry config", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function home(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "neolix-telemetry-config-"));
    tempDirs.push(dir);
    return dir;
  }

  const initial = {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  } as const;

  test("a config file without telemetry still loads", () => {
    const dir = home();
    writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ version: 1, daemon: { listen: "127.0.0.1:6767" } }),
    );

    const persisted = loadPersistedConfig(dir);
    expect(persisted.daemon?.telemetry).toBeUndefined();
  });

  test("patch round-trips through persisted config and preserves sibling fields", async () => {
    const dir = home();
    const store = new DaemonConfigStore(dir, { ...initial });

    await store.patch({
      telemetry: {
        enabled: true,
        shareUsage: true,
        decidedAt: "2026-11-06T00:00:00.000Z",
      },
    });

    expect(store.get().telemetry).toEqual({
      enabled: true,
      shareUsage: true,
      decidedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(loadPersistedConfig(dir).daemon?.telemetry).toEqual({
      enabled: true,
      shareUsage: true,
      decidedAt: "2026-11-06T00:00:00.000Z",
    });

    await store.patch({ telemetry: { shareUsage: false } });

    expect(store.get().telemetry).toEqual({
      enabled: true,
      shareUsage: false,
      decidedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(loadPersistedConfig(dir).daemon?.telemetry).toEqual({
      enabled: true,
      shareUsage: false,
      decidedAt: "2026-11-06T00:00:00.000Z",
    });
  });

  test("reload reports and applies telemetry changes", async () => {
    const dir = home();
    const store = new DaemonConfigStore(dir, { ...initial }, undefined, {
      reloadSource: {
        resolve: (persisted) => ({
          mutable: {
            ...initial,
            telemetry: persisted.daemon?.telemetry,
          },
          overrideControlledPaths: [],
        }),
      },
    });
    await store.patch({ telemetry: { enabled: true } });
    editPersistedConfig(dir, "daemon.telemetry.enabled", { value: false });

    const result = await store.reload();

    expect(result.appliedPaths).toContain("daemon.telemetry.enabled");
    expect(store.get().telemetry?.enabled).toBe(false);
  });
});
