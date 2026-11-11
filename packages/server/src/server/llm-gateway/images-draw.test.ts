import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayAccount, GatewayConfig, GatewayProvider } from "./config.js";
import { GatewayConfigStore } from "./config.js";
import { drawImageFor, imageMechanismOf, type ImageDrawTiming } from "./images-draw.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { createGatewayRuntime } from "./runtime.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });
const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

interface VendorRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

interface VendorReply {
  status?: number;
  body: unknown;
  contentType?: string;
  raw?: Buffer;
}

function startVendor(
  handler: (request: VendorRequest) => VendorReply,
): Promise<{ url: string; requests: VendorRequest[] }> {
  const requests: VendorRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        body = { raw: text };
      }
      const request: VendorRequest = {
        method: incoming.method ?? "GET",
        url: incoming.url ?? "/",
        headers: incoming.headers,
        body,
      };
      requests.push(request);
      const reply = handler(request);
      response.statusCode = reply.status ?? 200;
      response.setHeader("content-type", reply.contentType ?? "application/json");
      response.end(reply.raw ?? JSON.stringify(reply.body));
    });
  });
  openServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    accounts: [],
    models: [],
    maxAccounts: undefined,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    rateWindows: undefined,
    ...overrides,
  };
}

function account(baseUrl: string): GatewayAccount {
  return { id: "a1", apiKey: "account-key", baseUrl };
}

const fast: Partial<ImageDrawTiming> = { pollMs: 1, waitMs: 2_000, busyMs: [1, 1, 1] };

async function draw(input: {
  provider: GatewayProvider;
  account?: GatewayAccount;
  model?: string;
  body: Record<string, unknown>;
}): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await drawImageFor({
    provider: input.provider,
    ...(input.account === undefined ? {} : { account: input.account }),
    model: input.model ?? String(input.body.model),
    body: input.body,
    timing: fast,
  });
  if (response === null) {
    throw new Error("no adapter took the provider");
  }
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

function imageUrls(json: Record<string, unknown>): string[] {
  const data = Array.isArray(json.data) ? json.data : [];
  return data.map((entry) => (isRecord(entry) && typeof entry.url === "string" ? entry.url : ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("imageMechanismOf", () => {
  const cases: Array<[string, GatewayProvider, string, string | null]> = [
    [
      "qwen preset",
      provider({ id: "qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }),
      "qwen-image-3.0-pro",
      "dashscope",
    ],
    [
      "qwen host",
      provider({ id: "x", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
      "qwen-image-edit-plus",
      "dashscope",
    ],
    [
      "qwen wan",
      provider({ id: "qwen", baseUrl: "https://dashscope.aliyuncs.com/api/v1" }),
      "wan2.7-image",
      "dashscope",
    ],
    [
      "qwen at a gpt model",
      provider({ id: "qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" }),
      "gpt-image-2",
      null,
    ],
    [
      "another provider's qwen",
      provider({ id: "relay", baseUrl: "https://relay.example/v1" }),
      "qwen-image-3.0-pro",
      null,
    ],
    [
      "modelscope",
      provider({ id: "ms", baseUrl: "https://api-inference.modelscope.cn/v1" }),
      "Qwen/Qwen-Image",
      "modelscope",
    ],
    [
      "ark",
      provider({ id: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" }),
      "doubao-seedream-4-0",
      "ark",
    ],
    [
      "ark lookalike",
      provider({ id: "x", baseUrl: "https://ark.example.com/v3" }),
      "doubao-seedream-4-0",
      null,
    ],
    [
      "workbuddy",
      provider({ id: "workbuddy", baseUrl: "https://www.codebuddy.cn/v1" }),
      "hunyuan-image-alpha",
      "workbuddy",
    ],
    [
      "openai",
      provider({ id: "openai", baseUrl: "https://api.openai.com/v1" }),
      "gpt-image-2",
      null,
    ],
  ];
  for (const [name, who, model, want] of cases) {
    it(`tells ${name}`, () => {
      expect(imageMechanismOf(who, model)).toBe(want);
    });
  }
  it("leaves a provider no adapter serves alone", async () => {
    const response = await drawImageFor({
      provider: provider({ id: "openai", baseUrl: "https://api.openai.com/v1" }),
      model: "gpt-image-2",
      body: { model: "gpt-image-2", prompt: "x" },
      timing: fast,
    });
    expect(response).toBeNull();
  });
});

describe("DashScope", () => {
  it("asks its multimodal-generation API and answers in OpenAI's shape", async () => {
    const vendor = await startVendor(() => ({
      body: {
        output: {
          choices: [
            { message: { content: [{ image: "https://img/1.png" }, { text: "here" }] } },
            { message: { content: [{ image: "https://img/2.png" }] } },
          ],
        },
      },
    }));
    const who = provider({
      id: "qwen",
      baseUrl: `${vendor.url}/compatible-mode/v1`,
      apiKey: "dash-key",
    });
    const answer = await draw({
      provider: who,
      body: { model: "qwen-image-3.0-pro", prompt: "a cat", size: "1024x768", n: 2 },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests[0]?.url).toBe("/api/v1/services/aigc/multimodal-generation/generation");
    expect(vendor.requests[0]?.headers.authorization).toBe("Bearer dash-key");
    expect(vendor.requests[0]?.body).toMatchObject({
      model: "qwen-image-3.0-pro",
      input: { messages: [{ role: "user", content: [{ text: "a cat" }] }] },
      parameters: { watermark: false, n: 2, size: "1024*768" },
    });
    expect(imageUrls(answer.json)).toEqual(["https://img/1.png", "https://img/2.png"]);
    expect(answer.json.model).toBe("qwen/qwen-image-3.0-pro");
  });

  it("sends the images to change as content images", async () => {
    const vendor = await startVendor(() => ({
      body: { output: { choices: [{ message: { content: [{ image: "u" }] } }] } },
    }));
    const who = provider({ id: "qwen", baseUrl: `${vendor.url}/compatible-mode/v1` });
    await draw({
      provider: who,
      body: {
        model: "qwen-image-edit-plus",
        prompt: "make it blue",
        image: ["https://in/1.png", "https://in/2.png"],
      },
    });
    expect(vendor.requests[0]?.body.input).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { image: "https://in/1.png" },
            { image: "https://in/2.png" },
            { text: "make it blue" },
          ],
        },
      ],
    });
  });

  it("turns away a ratio and a mask with what to send instead", async () => {
    const who = provider({
      id: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    const ratio = await draw({
      provider: who,
      body: { model: "qwen-image-3.0-pro", prompt: "x", size: "16:9" },
    });
    expect(ratio.status).toBe(400);
    expect(JSON.stringify(ratio.json)).toContain("WIDTHxHEIGHT");
    const mask = await draw({
      provider: who,
      body: { model: "qwen-image-3.0-pro", prompt: "x", mask: "https://m.png" },
    });
    expect(mask.status).toBe(400);
    expect(JSON.stringify(mask.json)).toContain("no mask");
  });

  it("says what DashScope said when it drew nothing", async () => {
    const vendor = await startVendor(() => ({
      body: { code: "InvalidParameter", message: "size too small" },
    }));
    const who = provider({ id: "qwen", baseUrl: `${vendor.url}/compatible-mode/v1` });
    const answer = await draw({
      provider: who,
      body: { model: "qwen-image-3.0-pro", prompt: "x" },
    });
    expect(answer.status).toBe(502);
    expect(JSON.stringify(answer.json)).toContain("size too small");
  });

  it("keeps a URL answered by its own host when bytes were asked for", async () => {
    const png = Buffer.from("PNGDATA");
    let origin = "";
    const vendor = await startVendor((request) => {
      if (request.url === "/i.png") {
        return { raw: png, contentType: "image/png" };
      }
      return {
        body: { output: { choices: [{ message: { content: [{ image: `${origin}/i.png` }] } }] } },
      };
    });
    origin = vendor.url;
    const who = provider({ id: "qwen", baseUrl: `${vendor.url}/compatible-mode/v1` });
    const answer = await draw({
      provider: who,
      body: {
        model: "qwen-image-3.0-pro",
        prompt: "x",
        response_format: "b64_json",
      },
    });
    const data = answer.json.data;
    expect(Array.isArray(data)).toBe(true);
    const first = Array.isArray(data) ? data[0] : undefined;
    expect(isRecord(first) ? first.b64_json : "").toBe(png.toString("base64"));
  });
});

describe("ModelScope", () => {
  const who = (): GatewayProvider =>
    provider({
      id: "modelscope",
      baseUrl: "https://api-inference.modelscope.cn/v1",
      apiKey: "ms-key",
    });

  it("starts a task, polls it, and answers its images", async () => {
    let polls = 0;
    const vendor = await startVendor((request) => {
      if (request.method === "POST") {
        return { body: { task_id: "t1" } };
      }
      polls += 1;
      if (polls === 1) {
        return { body: { task_status: "RUNNING" } };
      }
      return { body: { task_status: "SUCCEED", output_images: ["https://img/1.png"] } };
    });
    const answer = await draw({
      provider: who(),
      account: account(vendor.url),
      body: { model: "Qwen/Qwen-Image", prompt: "a cat", size: "1024x1024" },
    });
    expect(answer.status).toBe(200);
    expect(imageUrls(answer.json)).toEqual(["https://img/1.png"]);
    expect(vendor.requests[0]?.url).toBe("/images/generations");
    expect(vendor.requests[0]?.headers["x-modelscope-async-mode"]).toBe("true");
    expect(vendor.requests[1]?.url).toBe("/tasks/t1");
    expect(vendor.requests[1]?.headers["x-modelscope-task-type"]).toBe("image_generation");
    expect(polls).toBe(2);
  });

  it("asks again when its queue is full", async () => {
    let posts = 0;
    const vendor = await startVendor((request) => {
      if (request.method === "POST") {
        posts += 1;
        if (posts === 1) {
          return { status: 429, body: { errors: { message: "user queue is full" } } };
        }
        return { body: { task_id: "t1" } };
      }
      return { body: { task_status: "SUCCEED", output_images: ["https://img/1.png"] } };
    });
    const answer = await draw({
      provider: who(),
      account: account(vendor.url),
      body: { model: "Qwen/Qwen-Image", prompt: "x" },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests.filter((request) => request.method === "POST")).toHaveLength(2);
  });

  it("says a failed task failed", async () => {
    const vendor = await startVendor((request) =>
      request.method === "POST"
        ? { body: { task_id: "t1" } }
        : { body: { task_status: "FAILED", errors: { message: "no credit" } } },
    );
    const answer = await draw({
      provider: who(),
      account: account(vendor.url),
      body: { model: "Qwen/Qwen-Image", prompt: "x" },
    });
    expect(answer.status).toBe(502);
    expect(JSON.stringify(answer.json)).toContain("failed");
  });
});

describe("Volcengine Ark", () => {
  const who = (): GatewayProvider =>
    provider({ id: "ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" });

  it("draws with its own fields, a ratio as its 2K size", async () => {
    const vendor = await startVendor(() => ({
      body: {
        data: [
          {
            b64_json: Buffer.from("png").toString("base64"),
            media_type: "image/png",
            revised_prompt: "a red cat",
          },
        ],
      },
    }));
    const answer = await draw({
      provider: who(),
      account: account(`${vendor.url}/api/v3`),
      body: {
        model: "doubao-seedream-4-0",
        prompt: "a cat",
        size: "16:9",
        n: 2,
        image: ["https://in/1.png"],
        output_format: "jpg",
      },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests).toHaveLength(2);
    expect(vendor.requests[0]?.url).toBe("/api/v3/images/generations");
    expect(vendor.requests[0]?.body).toMatchObject({
      model: "doubao-seedream-4-0",
      prompt: "a cat",
      size: "2848x1600",
      watermark: false,
      response_format: "b64_json",
      output_format: "jpeg",
      image: "https://in/1.png",
    });
    const first = Array.isArray(answer.json.data) ? answer.json.data[0] : undefined;
    expect(isRecord(first) ? first.revised_prompt : "").toBe("a red cat");
  });

  it("asks for a URL when the caller did", async () => {
    const vendor = await startVendor(() => ({ body: { data: [{ url: "https://img/1.png" }] } }));
    const answer = await draw({
      provider: who(),
      account: account(`${vendor.url}/api/v3`),
      body: { model: "doubao-seedream-4-0", prompt: "x", response_format: "url" },
    });
    expect(vendor.requests[0]?.body.response_format).toBe("url");
    expect(imageUrls(answer.json)).toEqual(["https://img/1.png"]);
  });

  it("turns away a stream and a ratio it can't map", async () => {
    const vendor = await startVendor(() => ({ body: {} }));
    const stream = await draw({
      provider: who(),
      account: account(`${vendor.url}/api/v3`),
      body: { model: "doubao-seedream-4-0", prompt: "x", stream: true },
    });
    expect(stream.status).toBe(400);
    const ratio = await draw({
      provider: who(),
      account: account(`${vendor.url}/api/v3`),
      body: { model: "doubao-seedream-4-0", prompt: "x", size: "5:4" },
    });
    expect(ratio.status).toBe(400);
    expect(JSON.stringify(ratio.json)).toContain("2048x2048");
  });
});

describe("WorkBuddy", () => {
  const who = (baseUrl: string): GatewayProvider =>
    provider({ id: "workbuddy", baseUrl: `${baseUrl}/v2` });

  it("unwraps its {code, data} answer", async () => {
    const vendor = await startVendor(() => ({
      body: { code: 0, data: { data: [{ url: "https://img/1.png" }] } },
    }));
    const answer = await draw({
      provider: who(vendor.url),
      body: { model: "hunyuan-image-alpha", prompt: "a cat" },
    });
    expect(answer.status).toBe(200);
    expect(imageUrls(answer.json)).toEqual(["https://img/1.png"]);
    expect(vendor.requests[0]?.url).toBe("/v2/images/generations");
  });

  it("sends an edit's images to its edits endpoint", async () => {
    const vendor = await startVendor(() => ({
      body: { code: 0, data: { data: [{ url: "u" }] } },
    }));
    await draw({
      provider: who(vendor.url),
      body: { model: "hunyuan-image-alpha", prompt: "x", image: ["https://in/1.png"] },
    });
    expect(vendor.requests[0]?.url).toBe("/v2/images/edits");
    expect(vendor.requests[0]?.body.image).toEqual(["https://in/1.png"]);
  });

  it("says a refused code", async () => {
    const vendor = await startVendor(() => ({ body: { code: 14018, msg: "credits used up" } }));
    const answer = await draw({
      provider: who(vendor.url),
      body: { model: "hunyuan-image-alpha", prompt: "x" },
    });
    expect(answer.status).toBe(502);
    expect(JSON.stringify(answer.json)).toContain("credits used up");
  });
});

describe("OpenRouter, Grok, Copilot, Gemini and chat", () => {
  it("asks OpenRouter's /images API with input references", async () => {
    const vendor = await startVendor(() => ({ body: { data: [{ url: "https://img/1.png" }] } }));
    const who = provider({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    const answer = await draw({
      provider: who,
      account: account(`${vendor.url}/api/v1`),
      body: {
        model: "black-forest-labs/flux-1.1-pro",
        prompt: "a cat",
        size: "1024x1024",
        image: ["https://in/1.png"],
      },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests[0]?.url).toBe("/api/v1/images");
    expect(vendor.requests[0]?.body.input_references).toEqual([
      { type: "image_url", image_url: { url: "https://in/1.png" } },
    ]);
    expect(imageUrls(answer.json)).toEqual(["https://img/1.png"]);
    const mask = await draw({
      provider: who,
      account: account(`${vendor.url}/api/v1`),
      body: { model: "black-forest-labs/flux-1.1-pro", prompt: "x", mask: "https://m.png" },
    });
    expect(mask.status).toBe(400);
  });

  it("asks Grok's Imagine API with a ratio and its images", async () => {
    const vendor = await startVendor(() => ({
      body: { data: [{ b64_json: Buffer.from("png").toString("base64") }] },
    }));
    const who = provider({ id: "grok", baseUrl: "https://api.x.ai/v1" });
    const answer = await draw({
      provider: who,
      account: account(`${vendor.url}/v1`),
      body: {
        model: "grok-imagine-image",
        prompt: "a cat",
        size: "1536x1024",
        image: ["https://in/1.png"],
      },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests[0]?.url).toBe("/v1/images/edits");
    expect(vendor.requests[0]?.body).toMatchObject({
      response_format: "b64_json",
      aspect_ratio: "3:2",
      images: [{ url: "https://in/1.png", type: "image_url" }],
    });
  });

  it("asks a Copilot account's images API with its own fields", async () => {
    const vendor = await startVendor(() => ({ body: { data: [{ url: "https://img/1.png" }] } }));
    const who = provider({ id: "copilot", baseUrl: `${vendor.url}/api` });
    await draw({
      provider: who,
      body: { model: "gpt-image-2", prompt: "x", size: "1024x1024", quality: "high" },
    });
    expect(vendor.requests[0]?.url).toBe("/api/images/generations");
    expect(vendor.requests[0]?.body).toMatchObject({
      model: "gpt-image-2",
      prompt: "x",
      size: "1024x1024",
      quality: "high",
    });
    expect(vendor.requests[0]?.body.response_format).toBeUndefined();
  });

  it("asks Gemini on generateContent and reads its inline images", async () => {
    const vendor = await startVendor(() => ({
      body: {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                  },
                },
                { thought: true, text: "thinking" },
                { text: "here" },
              ],
            },
          },
        ],
      },
    }));
    const who = provider({
      id: "google",
      protocol: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "google-key",
    });
    const answer = await draw({
      provider: who,
      account: account(vendor.url),
      model: "gemini-3-pro-image",
      body: { model: "gemini-3-pro-image", prompt: "a cat", size: "1024x1024" },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests[0]?.url).toBe("/models/gemini-3-pro-image:generateContent");
    expect(vendor.requests[0]?.headers["x-goog-api-key"]).toBe("account-key");
    expect(vendor.requests[0]?.body.generationConfig).toMatchObject({
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "1:1" },
    });
    const first = Array.isArray(answer.json.data) ? answer.json.data[0] : undefined;
    expect(isRecord(first) ? first.b64_json : "").toBe(Buffer.from("png").toString("base64"));
    expect(answer.json.text).toBe("here");
  });

  it("asks a chat model with modalities and reads both kinds of image", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("chat").toString("base64")}`;
    const vendor = await startVendor(() => ({
      body: {
        choices: [
          {
            message: {
              content: `I drew it: ![img](${dataUrl})`,
              images: [{ image_url: { url: "https://img/1.png" } }],
            },
          },
        ],
      },
    }));
    const who = provider({ id: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
    const answer = await draw({
      provider: who,
      account: account(`${vendor.url}/api/v1`),
      model: "google/gemini-3-pro-image",
      body: { model: "google/gemini-3-pro-image", prompt: "a cat", size: "1536x1024" },
    });
    expect(answer.status).toBe(200);
    expect(vendor.requests[0]?.url).toBe("/api/v1/chat/completions");
    expect(vendor.requests[0]?.body).toMatchObject({
      stream: false,
      modalities: ["image", "text"],
      image_config: { aspect_ratio: "3:2" },
    });
    const urls = imageUrls(answer.json);
    expect(urls).toEqual(["https://img/1.png", ""]);
    const data = answer.json.data;
    const second = Array.isArray(data) ? data[1] : undefined;
    expect(isRecord(second) ? second.b64_json : "").toBe(Buffer.from("chat").toString("base64"));
  });
});

describe("/v1/images/generations", () => {
  it("draws through a vendor's adapter", async () => {
    const vendor = await startVendor(() => ({
      body: { output: { choices: [{ message: { content: [{ image: "https://img/1.png" }] } }] } },
    }));
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-images-"));
    const config: GatewayConfig = {
      version: 1,
      enabled: true,
      keys: [],
      pricing: {},
      modelSameAs: {},
      groups: [],
      providers: [
        {
          id: "qwen",
          protocol: "openai",
          baseUrl: `${vendor.url}/compatible-mode/v1`,
          apiKey: "dash-key",
          accounts: [],
          models: [{ id: "qwen-image-3.0-pro" }],
          maxAccounts: undefined,
          queueWaitMs: 0,
          sink: false,
          priceRate: 1,
          rateWindows: undefined,
        },
      ],
    };
    writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();
    const ledger = new UsageLedger({ neolixHome, logger });
    const app = express();
    app.use(
      createGatewayRouter({
        configStore: store,
        masker: new Masker({ neolixHome, logger, allow: () => [] }),
        ledger,
        logger,
        runtime: createGatewayRuntime(ledger),
      }),
    );
    const server = createServer(app);
    openServers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/images/generations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-image-3.0-pro", prompt: "a cat" }),
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as Record<string, unknown>;
    expect(imageUrls(answer)).toEqual(["https://img/1.png"]);
    expect(vendor.requests[0]?.url).toBe("/api/v1/services/aigc/multimodal-generation/generation");
  });
});
