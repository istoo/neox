import { createServer, type Server } from "node:http";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayAccount, type GatewayProvider } from "./config.js";
import { shouldWarm, type WarmWindow } from "./warm-windows.js";
import { WarmupScheduler, warmAccount, warmupRequest } from "./warmup.js";

const logger = pino({ level: "silent" });
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

interface Captured {
  url: string;
  body: string;
  authorization: string | undefined;
  apiKey: string | undefined;
}

async function startUpstream(): Promise<{ url: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        body,
        authorization:
          typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
        apiKey: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
      });
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function provider(baseUrl: string, protocol: GatewayProvider["protocol"]): GatewayProvider {
  return {
    id: "p",
    protocol,
    baseUrl,
    apiKey: "upstream-key",
    accounts: [],
    models: [{ id: "model-a" }],
    maxAccounts: undefined,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
  };
}

const account: GatewayAccount = {
  id: "default",
  priority: 0,
  weight: 1,
  enabled: true,
  models: [],
  warmup: true,
  warmAt: "",
};

describe("warmAccount", () => {
  it("sends one minimum-size turn to an Anthropic upstream", async () => {
    const upstream = await startUpstream();
    const status = await warmAccount({
      provider: provider(`${upstream.url}/v1`, "anthropic"),
      account,
      logger,
    });

    expect(status).toBe(200);
    expect(upstream.requests[0]?.url).toBe("/v1/messages");
    expect(upstream.requests[0]?.apiKey).toBe("upstream-key");
    const body = JSON.parse(upstream.requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ model: "model-a", max_tokens: 1 });
  });

  it("builds an OpenAI chat request", async () => {
    const upstream = await startUpstream();
    await warmAccount({
      provider: provider(`${upstream.url}/v1`, "openai"),
      account,
      logger,
    });
    expect(upstream.requests[0]?.url).toBe("/v1/chat/completions");
    expect(upstream.requests[0]?.authorization).toBe("Bearer upstream-key");
  });

  it("builds a Gemini generateContent call with the version kept once", async () => {
    const request = warmupRequest(
      provider("https://example.test/v1beta", "gemini"),
      "gemini-model",
      account,
    );
    expect(request.url).toBe("https://example.test/v1beta/models/gemini-model:generateContent");
    expect(request.headers.get("x-goog-api-key")).toBe("upstream-key");
  });
});

describe("WarmupScheduler", () => {
  it("warms each account once per five-hour window", async () => {
    const upstream = await startUpstream();
    let now = 20_000_000;
    const scheduler = new WarmupScheduler({
      providers: () => [{ ...provider(`${upstream.url}/v1`, "openai"), accounts: [account] }],
      logger,
      now: () => now,
    });

    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);

    now += 60_000;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);

    now += 5 * 60 * 60_000;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(2);
    scheduler.dispose();
  });

  it("skips an account that did not opt in", async () => {
    const upstream = await startUpstream();
    const scheduler = new WarmupScheduler({
      providers: () => [
        {
          ...provider(`${upstream.url}/v1`, "openai"),
          accounts: [{ ...account, warmup: false }],
        },
      ],
      logger,
      now: () => 0,
    });

    await scheduler.tick();
    expect(upstream.requests).toHaveLength(0);
    scheduler.dispose();
  });

  it("warms a subscription on its family's setting", async () => {
    const upstream = await startUpstream();
    let now = 20_000_000;
    let plan: "off" | "week" | "all" = "all";
    const scheduler = new WarmupScheduler({
      providers: () => [
        {
          ...provider(`${upstream.url}/v1`, "openai-responses"),
          id: "codex",
          accounts: [account],
        },
      ],
      config: () => ({ ...EMPTY_GATEWAY_CONFIG, codexWarmup: plan, claudeWarmup: "off" }),
      logger,
      now: () => now,
    });

    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);
    now += 60 * 60_000;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);
    now += 4 * 60 * 60_000;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(2);

    plan = "off";
    now += 30 * 24 * 60 * 60_000;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(2);
    scheduler.dispose();
  });

  it("warms when the weekly window has reset with nothing used", async () => {
    const upstream = await startUpstream();
    let windows: WarmWindow[] = [{ id: "7d", usedPct: 0, resetsAt: 2_000_000 }];
    let now = 1_000_000;
    const scheduler = new WarmupScheduler({
      providers: () => [
        { ...provider(`${upstream.url}/v1`, "openai-responses"), id: "codex", accounts: [account] },
      ],
      config: () => ({ ...EMPTY_GATEWAY_CONFIG, codexWarmup: "week", claudeWarmup: "off" }),
      windows: () => windows,
      logger,
      now: () => now,
    });

    await scheduler.tick();
    expect(upstream.requests).toHaveLength(0);

    now = 2_000_100;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);

    now += 60_000;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);

    windows = [{ id: "7d", usedPct: 30, resetsAt: 3_000_000 }];
    now = 3_000_100;
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);
    scheduler.dispose();
  });

  it("starts the 5-hour window at a chosen time of day", async () => {
    const upstream = await startUpstream();
    const at = (hour: number, minute: number, day = 5) =>
      new Date(2026, 0, day, hour, minute).getTime();
    let now = at(5, 55);
    let windows: WarmWindow[] = [{ id: "5h", usedPct: 0, resetsAt: at(2, 0) }];
    const scheduler = new WarmupScheduler({
      providers: () => [
        { ...provider(`${upstream.url}/v1`, "openai-responses"), id: "codex", accounts: [account] },
      ],
      config: () => ({
        ...EMPTY_GATEWAY_CONFIG,
        codexWarmup: "off",
        claudeWarmup: "off",
        codexWarmAts: ["06:00"],
      }),
      windows: () => windows,
      logger,
      now: () => now,
    });

    await scheduler.tick();
    expect(upstream.requests).toHaveLength(0);

    now = at(6, 3);
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);

    now = at(6, 30);
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);

    windows = [{ id: "5h", usedPct: 1, resetsAt: at(9, 0, 6) }];
    now = at(6, 0, 6);
    await scheduler.tick();
    expect(upstream.requests).toHaveLength(1);
    scheduler.dispose();
  });

  it("decides a warm from the real windows, not a guessed cadence", () => {
    const weekly: WarmWindow = { id: "7d", usedPct: 0, resetsAt: 1_000 };
    const fiveHour: WarmWindow = { id: "5h", usedPct: 0, resetsAt: 2_000 };
    // "week" waits for the weekly window to have reset with nothing used.
    expect(shouldWarm({ windows: [weekly], plan: "week", now: 500, lastWarm: 0 }).warm).toBe(false);
    expect(shouldWarm({ windows: [weekly], plan: "week", now: 1_001, lastWarm: 0 })).toEqual({
      warm: true,
      window: "7d",
    });
    // Once warmed after the reset, it isn't warmed again.
    expect(shouldWarm({ windows: [weekly], plan: "week", now: 1_500, lastWarm: 1_200 }).warm).toBe(
      false,
    );
    // "all" takes the 5-hour window too, and never a used one.
    expect(shouldWarm({ windows: [fiveHour], plan: "week", now: 3_000, lastWarm: 0 }).warm).toBe(
      false,
    );
    expect(shouldWarm({ windows: [fiveHour], plan: "all", now: 3_000, lastWarm: 0 })).toEqual({
      warm: true,
      window: "5h",
    });
    expect(
      shouldWarm({ windows: [{ ...weekly, usedPct: 12 }], plan: "week", now: 3_000, lastWarm: 0 })
        .warm,
    ).toBe(false);
    // A vendor that doesn't say when its window resets asks for no warm.
    expect(
      shouldWarm({ windows: [{ ...weekly, resetsAt: null }], plan: "all", now: 3_000, lastWarm: 0 })
        .warm,
    ).toBe(false);
  });
});
