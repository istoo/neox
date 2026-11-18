import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import type { GatewayCandidate } from "./catalog.js";
import { EMPTY_GATEWAY_CONFIG, type GatewayConfig } from "./config.js";
import { CurrentImageError } from "./vision-images.js";
import { IMAGE_OMITTED, VisionService, type VisionAsk, type VisionSend } from "./vision.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];
const services: VisionService[] = [];

const noSend: VisionSend = async () => {
  throw new Error("no describer in this test");
};

afterAll(async () => {
  // The description cache saves in the background; let it finish before its home goes.
  await Promise.all(services.splice(0).map((created) => created.dispose()));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function service(): Promise<VisionService> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-vision-"));
  homes.push(home);
  const created = new VisionService({ neolixHome: home, logger });
  services.push(created);
  return created;
}

function configWith(vision: GatewayConfig["vision"], images?: boolean): GatewayConfig {
  return {
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
        models: [{ id: "text", ...(images === undefined ? {} : { images }) }],
      },
    ],
    vision,
  };
}

const config = configWith({ model: "off" });

function candidate(images: boolean | undefined): GatewayCandidate {
  const provider = config.providers[0];
  if (provider === undefined) {
    throw new Error("no test provider");
  }
  const model = provider.models[0];
  if (model === undefined) {
    throw new Error("no test model");
  }
  return { provider, model: { ...model, ...(images === undefined ? {} : { images }) } };
}

function openaiBody(current: boolean): Record<string, unknown> {
  return {
    messages: current
      ? [
          {
            role: "user",
            content: [
              { type: "text", text: "read" },
              { type: "image_url", image_url: "data:image/png;base64,aGVsbG8=" },
            ],
          },
        ]
      : [
          {
            role: "user",
            content: [{ type: "image_url", image_url: "data:image/png;base64,b2xk" }],
          },
          { role: "assistant", content: "seen" },
          { role: "user", content: "and now?" },
        ],
  };
}

describe("preparing a body for a text-only model", () => {
  it("refuses the latest turn's image when recognition is off", async () => {
    const vision = await service();
    await expect(
      vision.prepareBody({
        config,
        candidate: candidate(false),
        protocol: "openai",
        body: openaiBody(true),
        masker: null,
        send: noSend,
      }),
    ).rejects.toThrow(CurrentImageError);
    await expect(
      vision.prepareBody({
        config,
        candidate: candidate(false),
        protocol: "openai",
        body: openaiBody(true),
        masker: null,
        send: noSend,
      }),
    ).rejects.toThrow("turned off");
  });

  it("omits an older turn's image when recognition is off", async () => {
    const vision = await service();
    const prepared = await vision.prepareBody({
      config,
      candidate: candidate(false),
      protocol: "openai",
      body: openaiBody(false),
      masker: null,
      send: noSend,
    });
    expect(prepared).toEqual({
      messages: [
        { role: "user", content: [{ type: "text", text: IMAGE_OMITTED }] },
        { role: "assistant", content: "seen" },
        { role: "user", content: "and now?" },
      ],
    });
  });

  it("names the missing describer when none is configured", async () => {
    const vision = await service();
    const none = configWith(undefined, false);
    const provider = none.providers[0];
    const model = provider?.models[0];
    if (provider === undefined || model === undefined) {
      throw new Error("no test provider");
    }
    await expect(
      vision.prepareBody({
        config: none,
        candidate: { provider, model },
        protocol: "openai",
        body: openaiBody(true),
        masker: null,
        send: noSend,
      }),
    ).rejects.toThrow("no image recognition model is configured");
  });

  it("leaves a body with no image as it was", async () => {
    const vision = await service();
    const body = { messages: [{ role: "user", content: "hello" }] };
    await expect(
      vision.prepareBody({
        config,
        candidate: candidate(false),
        protocol: "openai",
        body,
        masker: null,
        send: noSend,
      }),
    ).resolves.toBe(body);
  });

  it("remembers a model that turned an image away, and a provider that refused WebP", async () => {
    const vision = await service();
    const model = candidate(true);
    expect(vision.isBlind(model)).toBe(false);
    vision.markBlind(model);
    expect(vision.isBlind(model)).toBe(true);

    expect(vision.webpRefused("probe")).toBe(false);
    vision.markWebpRefused("probe");
    expect(vision.webpRefused("probe")).toBe(true);
  });
});

describe("picking a describer", () => {
  it("is off when the setting says so", async () => {
    const vision = await service();
    expect(vision.hasModel(configWith({ model: "off" }))).toBe(false);
  });

  it("does not use a model marked text-only", async () => {
    const vision = await service();
    expect(vision.hasModel(configWith({ model: "probe/text" }, false))).toBe(false);
    expect(vision.hasModel(configWith({ model: "probe/text" }, true))).toBe(true);
  });

  it("takes a model marked as seeing without a setting", async () => {
    const vision = await service();
    expect(vision.hasModel(configWith(undefined, true))).toBe(true);
    expect(vision.hasModel(configWith(undefined, undefined))).toBe(false);
  });
});

describe("converting a HEIC before the request goes out", () => {
  it.runIf(process.platform === "darwin")("rewrites an Anthropic inline image", async () => {
    const vision = await service();
    const heic = await readFile(new URL("./testdata/opaque.heic", import.meta.url));
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/heic", data: heic.toString("base64") },
            },
          ],
        },
      ],
    };
    const prepared = await vision.prepareBody({
      config,
      candidate: candidate(true),
      protocol: "anthropic",
      body,
      masker: null,
      send: noSend,
    });
    const messages = prepared.messages as Array<{ content: Array<{ source?: unknown }> }>;
    expect(messages[0]?.content[1]?.source).toMatchObject({ media_type: "image/jpeg" });
  });
});

describe("describing an image to a text-only model", () => {
  const eye: GatewayConfig["providers"][number] = {
    id: "eye",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "key",
    accounts: [],
    countFree: false,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    models: [{ id: "eye", images: true }],
  };
  const text: GatewayConfig["providers"][number] = {
    ...eye,
    id: "texty",
    models: [{ id: "text", images: false }],
  };
  const textModel = text.models[0];
  if (textModel === undefined) {
    throw new Error("no test model");
  }
  const seenConfig: GatewayConfig = {
    ...EMPTY_GATEWAY_CONFIG,
    providers: [eye],
    vision: { model: "eye/eye" },
  };

  it("sends the describer the image, once, and the text model the description", async () => {
    const asks: VisionAsk[] = [];
    const state = { fail: false };
    const send: VisionSend = async (ask) => {
      asks.push(ask);
      if (state.fail) {
        throw new Error("eye is down");
      }
      return "A red square with the word HELLO in it.";
    };
    const vision = await service();
    const image = `data:image/png;base64,${Buffer.from("HELLO").toString("base64")}`;
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            { type: "image_url", image_url: image },
          ],
        },
      ],
    };
    const first = await vision.prepareBody({
      config: seenConfig,
      candidate: { provider: text, model: textModel },
      protocol: "openai",
      body,
      masker: null,
      send,
    });
    const second = await vision.prepareBody({
      config: seenConfig,
      candidate: { provider: text, model: textModel },
      protocol: "openai",
      body,
      masker: null,
      send,
    });
    expect(asks).toHaveLength(1);
    expect(asks[0]?.model).toBe("eye/eye");
    expect(asks[0]?.image).toContain(image.split(",")[1]);
    expect(JSON.stringify(first)).toContain("HELLO");
    expect(JSON.stringify(first)).not.toContain(image.split(",")[1]);
    expect(second).toEqual(first);

    state.fail = true;
    const other = `data:image/png;base64,${Buffer.from("OTHER").toString("base64")}`;
    const changing = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read" },
            { type: "image_url", image_url: other },
          ],
        },
      ],
    };
    await expect(
      vision.prepareBody({
        config: seenConfig,
        candidate: { provider: text, model: textModel },
        protocol: "openai",
        body: changing,
        masker: null,
        send,
      }),
    ).rejects.toThrow(CurrentImageError);

    state.fail = false;
    const recovered = await vision.prepareBody({
      config: seenConfig,
      candidate: { provider: text, model: textModel },
      protocol: "openai",
      body: changing,
      masker: null,
      send,
    });
    expect(JSON.stringify(recovered)).toContain("HELLO");
  });

  it("asks the describer at the effort the setting picks", async () => {
    const asks: VisionAsk[] = [];
    const send: VisionSend = async (ask) => {
      asks.push(ask);
      return "seen";
    };
    const vision = await service();
    await vision.prepareBody({
      config: { ...seenConfig, vision: { model: "eye/eye", effort: "high" } },
      candidate: { provider: text, model: textModel },
      protocol: "openai",
      body: {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: "data:image/png;base64,b2xk" }],
          },
        ],
      },
      masker: null,
      send,
    });
    expect(asks[0]?.model).toBe("eye/eye:high");
  });
});
