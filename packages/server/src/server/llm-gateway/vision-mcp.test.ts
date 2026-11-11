import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import type { Masker } from "./masking.js";
import { serveVisionMcp } from "./vision-mcp.js";
import { VisionService } from "./vision.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const seeing: GatewayConfig = {
  ...EMPTY_GATEWAY_CONFIG,
  providers: [
    {
      id: "eye",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      accounts: [],
      countFree: false,
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
      models: [{ id: "eye", images: true }],
    },
  ],
};

function request(body: unknown, remote = "127.0.0.1"): ExpressRequest {
  return { body, socket: { remoteAddress: remote } } as unknown as ExpressRequest;
}

interface Recorded {
  code: number;
  payload: unknown;
  ended: boolean;
}

function response(): { res: ExpressResponse; recorded: Recorded } {
  const recorded: Recorded = { code: 200, payload: undefined, ended: false };
  const res = {
    status(code: number) {
      recorded.code = code;
      return res;
    },
    json(payload: unknown) {
      recorded.payload = payload;
      return res;
    },
    end() {
      recorded.ended = true;
      return res;
    },
  } as unknown as ExpressResponse;
  return { res, recorded };
}

async function call(
  body: unknown,
  config: GatewayConfig = seeing,
  remote = "127.0.0.1",
): Promise<Recorded> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-vision-mcp-"));
  homes.push(home);
  const vision = new VisionService({ neolixHome: home, logger });
  const { res, recorded } = response();
  await serveVisionMcp({
    req: request(body, remote),
    res,
    configStore: { get: () => config },
    vision,
    send: async () => "seen",
    masker: {} as Masker,
    logger,
  });
  return recorded;
}

function rpc(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

describe("the vision MCP endpoint", () => {
  it("answers initialize", async () => {
    const recorded = await call(rpc("initialize"));
    expect(recorded.payload).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "neox-vision" } },
    });
  });

  it("lists analyze_image and accepts notifications without a reply", async () => {
    const listed = await call(rpc("tools/list"));
    expect(JSON.stringify(listed.payload)).toContain("analyze_image");

    const notified = await call(rpc("notifications/initialized"));
    expect(notified.code).toBe(202);
    expect(notified.ended).toBe(true);
  });

  it("refuses a method it does not serve", async () => {
    const recorded = await call(rpc("resources/list"));
    expect(recorded.payload).toMatchObject({ error: { code: -32601 } });
  });

  it("refuses a tool it does not have", async () => {
    const recorded = await call(rpc("tools/call", { name: "draw_image", arguments: {} }));
    expect(JSON.stringify(recorded.payload)).toContain("Unknown tool draw_image");
  });

  it("says which setting turns recognition on when no model is configured", async () => {
    const recorded = await call(
      rpc("tools/call", {
        name: "analyze_image",
        arguments: { image: `data:image/png;base64,${Buffer.from("hello").toString("base64")}` },
      }),
      EMPTY_GATEWAY_CONFIG,
    );
    expect(JSON.stringify(recorded.payload)).toContain("vision.model");
  });

  it("reads a file only for an agent on this computer", async () => {
    const recorded = await call(
      rpc("tools/call", { name: "analyze_image", arguments: { image: "/tmp/a.png" } }),
      seeing,
      "8.8.8.8",
    );
    expect(JSON.stringify(recorded.payload)).toContain("this computer");
  });

  it("needs an image", async () => {
    const recorded = await call(rpc("tools/call", { name: "analyze_image", arguments: {} }));
    expect(JSON.stringify(recorded.payload)).toContain("needs an image");
  });
});
