import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import { MediaMcp, type MediaSend } from "./media-mcp.js";

const logger = pino({ level: "silent" });

function configOf(extra: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    ...EMPTY_GATEWAY_CONFIG,
    providers: [
      {
        id: "probe",
        protocol: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        models: [
          { id: "draw", kind: "image" },
          { id: "draw-two", kind: "image" },
          { id: "film", kind: "video" },
        ],
      },
    ],
    ...extra,
  };
}

interface Recorded {
  payload: unknown;
}

function request(body: unknown): ExpressRequest {
  return {
    body,
    headers: { authorization: "Bearer key", host: "127.0.0.1:6767" },
    protocol: "http",
    get: (name: string) => (name === "host" ? "127.0.0.1:6767" : undefined),
  } as unknown as ExpressRequest;
}

function response(): { res: ExpressResponse; recorded: Recorded } {
  const recorded: Recorded = { payload: undefined };
  const res = {
    status() {
      return res;
    },
    setHeader() {
      return res;
    },
    json(payload: unknown) {
      recorded.payload = payload;
      return res;
    },
    send(payload: unknown) {
      recorded.payload = payload;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as ExpressResponse;
  return { res, recorded };
}

async function call(
  config: GatewayConfig,
  send: MediaSend,
  body: unknown,
): Promise<Record<string, unknown>> {
  const media = new MediaMcp({ logger });
  const { res, recorded } = response();
  await media.serve({ req: request(body), res, configStore: { get: () => config }, send });
  return (recorded.payload ?? {}) as Record<string, unknown>;
}

function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const noSend: MediaSend = async () => ({ status: 500, text: "" });

describe("Image generation", () => {
  it("draws with the model picked, not the first image model", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const send: MediaSend = async (input) => {
      calls.push(JSON.parse(String(input.body)) as Record<string, unknown>);
      return {
        status: 200,
        text: JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }),
      };
    };
    await call(
      configOf({ imageGen: "probe/draw-two" }),
      send,
      toolCall("generate_image", { prompt: "x" }),
    );
    expect(calls[0]?.model).toBe("probe/draw-two");
  });

  it("says it is off when the row is Off", async () => {
    const reply = await call(
      configOf({ imageGen: "off" }),
      noSend,
      toolCall("generate_image", { prompt: "x" }),
    );
    const content = (reply.result as { content: Array<{ text?: string }> }).content;
    expect(content[0]?.text).toContain("off");
  });

  it("says why a picked model that is gone draws nothing", async () => {
    const reply = await call(
      configOf({ imageGen: "probe/gone" }),
      noSend,
      toolCall("generate_image", { prompt: "x" }),
    );
    const content = (reply.result as { content: Array<{ text?: string }> }).content;
    expect(content[0]?.text).toContain("probe/gone");
  });

  it("names the picked model as the default in the tool's list", async () => {
    const listed = await call(configOf({ imageGen: "probe/draw-two" }), noSend, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(JSON.stringify(listed)).toContain("Leave it out to use probe/draw-two");
  });
});
