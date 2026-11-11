import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import { MediaMcp, type MediaSend, type MediaSendRequest } from "./media-mcp.js";

const logger = pino({ level: "silent" });

const config: GatewayConfig = {
  ...EMPTY_GATEWAY_CONFIG,
  providers: [
    {
      id: "probe",
      protocol: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      accounts: [],
      countFree: false,
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
      models: [
        { id: "draw", kind: "image" },
        { id: "film", kind: "video" },
      ],
    },
  ],
};

interface Recorded {
  code: number;
  payload: unknown;
  headers: Record<string, string>;
  sent: unknown;
}

function response(): { res: ExpressResponse; recorded: Recorded } {
  const recorded: Recorded = { code: 200, payload: undefined, headers: {}, sent: undefined };
  const res = {
    status(code: number) {
      recorded.code = code;
      return res;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return res;
    },
    json(payload: unknown) {
      recorded.payload = payload;
      return res;
    },
    send(payload: unknown) {
      recorded.sent = payload;
      return res;
    },
    end() {
      return res;
    },
  } as unknown as ExpressResponse;
  return { res, recorded };
}

function request(body: unknown): ExpressRequest {
  return {
    body,
    headers: { authorization: "Bearer key", host: "127.0.0.1:6767" },
    protocol: "http",
    get: (name: string) => (name === "host" ? "127.0.0.1:6767" : undefined),
  } as unknown as ExpressRequest;
}

function rpc(method: string, params?: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) };
}

async function call(
  media: MediaMcp,
  send: MediaSend,
  body: unknown,
): Promise<Record<string, unknown>> {
  const { res, recorded } = response();
  await media.serve({ req: request(body), res, configStore: { get: () => config }, send });
  return (recorded.payload ?? {}) as Record<string, unknown>;
}

function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return rpc("tools/call", { name, arguments: args });
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function imageReply(): string {
  return JSON.stringify({ model: "probe/draw", data: [{ b64_json: png.toString("base64") }] });
}

describe("the image MCP endpoint", () => {
  it("lists the tools with the gateway's image and video models", async () => {
    const media = new MediaMcp({ logger });
    const listed = await call(media, async () => ({ status: 500, text: "" }), rpc("tools/list"));
    const text = JSON.stringify(listed);
    expect(text).toContain("generate_image");
    expect(text).toContain("probe/draw");
    expect(text).toContain("probe/film");
  });

  it("draws an image, puts it in the answer, and serves it at its URL", async () => {
    const media = new MediaMcp({ logger });
    const calls: MediaSendRequest[] = [];
    const send: MediaSend = async (input) => {
      calls.push(input);
      return { status: 200, text: imageReply() };
    };
    const reply = await call(media, send, toolCall("generate_image", { prompt: "a red square" }));
    expect(calls[0]?.path).toBe("/v1/images/generations");
    expect(JSON.parse(String(calls[0]?.body))).toMatchObject({
      prompt: "a red square",
      model: "probe/draw",
    });
    const content = (reply.result as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toEqual({
      type: "image",
      data: png.toString("base64"),
      mimeType: "image/png",
    });
    const files = (reply.result as { _meta: Record<string, Array<{ url: string }>> })._meta[
      "github.com/istoo/myna/files"
    ];
    const url = files?.[0]?.url ?? "";
    const [name = "", query = ""] = url.split("?");
    const token = query.replace(/^t=/, "");

    const { res, recorded } = response();
    media.serveFile(name, token, res);
    expect(recorded.code).toBe(200);
    expect(recorded.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(recorded.sent as Buffer, png)).toBe(0);

    const wrong = response();
    media.serveFile(name, "9999999999.bad", wrong.res);
    expect(wrong.recorded.code).toBe(404);
  });

  it("answers with an id while the drawing goes on, and gives it up on generation_result", async () => {
    const media = new MediaMcp({ logger, answerWithinMs: 10 });
    let finish: (() => void) | null = null;
    const send: MediaSend = () =>
      new Promise((resolve) => {
        finish = () => resolve({ status: 200, text: imageReply() });
      });
    const pending = await call(media, send, toolCall("generate_image", { prompt: "slow" }));
    const id = (pending.result as { _meta: Record<string, string> })._meta[
      "github.com/istoo/myna/pending"
    ];
    expect(id).toMatch(/^img_/);
    expect((pending.result as { isError?: boolean }).isError).toBe(false);

    finish?.();
    const done = await call(media, send, toolCall("generation_result", { id }));
    const content = (done.result as { content: Array<Record<string, unknown>> }).content;
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("makes a video and answers with where to download it", async () => {
    const media = new MediaMcp({ logger });
    const send: MediaSend = async (input) => {
      if (input.path === "/v1/videos") {
        return { status: 200, text: JSON.stringify({ id: "vid_1", status: "queued" }) };
      }
      return {
        status: 200,
        text: JSON.stringify({ id: "vid_1", status: "completed", model: "probe/film" }),
      };
    };
    const reply = await call(media, send, toolCall("generate_video", { prompt: "a wave" }));
    expect(JSON.stringify(reply)).toContain("/v1/videos/vid_1/content");
  });

  it("refuses a model the gateway does not serve for that kind", async () => {
    const media = new MediaMcp({ logger });
    const reply = await call(
      media,
      async () => ({ status: 200, text: imageReply() }),
      toolCall("generate_image", { prompt: "x", model: "probe/film" }),
    );
    expect(JSON.stringify(reply)).toContain("isn't an image model set up here");
    expect(JSON.stringify(reply)).toContain("probe/draw");
  });
});
