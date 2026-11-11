import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import type { GatewayConfig } from "./config.js";
import { maskingWanted, type Masker } from "./masking.js";
import { MAX_IMAGE_BYTES, sniffImageType } from "./vision-fetch.js";
import { dataUrl } from "./vision-images.js";
import type { VisionSend, VisionService } from "./vision.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const VISION_MCP_SCHEMA = {
  type: "object",
  properties: {
    image: {
      type: "string",
      description:
        "The image: an absolute path to an image file on this computer (PNG, JPEG, GIF or WebP), an http(s) URL, or a data URL (data:image/png;base64,...).",
    },
    prompt: {
      type: "string",
      description:
        "What to find out about the image. Without it the image is described in full: its text transcribed, its layout, charts and diagrams.",
    },
  },
  required: ["image"],
};

interface VisionMcpInput {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: { get(): GatewayConfig };
  vision: VisionService;
  send: VisionSend;
  masker: Masker;
  logger: Logger;
}

type JsonReply = (result: unknown) => void;

/**
 * myna's image recognition as an MCP server: `analyze_image` looks at an
 * image with the gateway's vision model and answers in text, for a model or
 * agent that cannot see images.
 */
export async function serveVisionMcp(input: VisionMcpInput): Promise<void> {
  const body = isRecord(input.req.body) ? input.req.body : {};
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const reply: JsonReply = (result) => {
    input.res.json({ jsonrpc: "2.0", id, result });
  };
  if (await serveMethod(input, method, id, reply)) {
    return;
  }
  await callVisionTool(input, body, reply);
}

/** Answers every method but tools/call; true when it did. */
async function serveMethod(
  input: VisionMcpInput,
  method: string,
  id: unknown,
  reply: JsonReply,
): Promise<boolean> {
  if (method === "initialize") {
    reply({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "neox-vision", title: "Neox Image Recognition", version: "1" },
      instructions:
        "analyze_image looks at an image with the gateway's image recognition model and answers in text: for a model or agent that can't see images, or to read a screenshot, chart or diagram.",
    });
    return true;
  }
  if (method === "ping") {
    reply({});
    return true;
  }
  if (method === "tools/list") {
    reply({ tools: [VISION_TOOL] });
    return true;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    input.res.status(202).end();
    return true;
  }
  if (method !== "tools/call") {
    input.res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    return true;
  }
  return false;
}

async function callVisionTool(
  input: VisionMcpInput,
  body: Record<string, unknown>,
  reply: JsonReply,
): Promise<void> {
  const params = isRecord(body.params) ? body.params : {};
  if (params.name !== "analyze_image") {
    reply(toolReply(`Unknown tool ${String(params.name)}`));
    return;
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const image = textArgument(args, "image");
  const prompt = textArgument(args, "prompt");
  if (image.length === 0) {
    reply(toolReply("analyze_image needs an image"));
    return;
  }
  const config = input.configStore.get();
  if (!input.vision.hasModel(config)) {
    reply(
      toolReply(
        "No image recognition model is configured: set gateway.json vision.model, or mark a model images: true",
      ),
    );
    return;
  }
  try {
    const src = await mcpImageSource(input.req, image);
    const masker = maskingWanted(config.masking) ? input.masker : null;
    const said = await input.vision.analyze(config, src, prompt, masker, input.send);
    reply({ content: [{ type: "text", text: said }], isError: false });
  } catch (error) {
    input.logger.info({ err: error }, "Image recognition MCP call failed");
    reply(toolReply(error instanceof Error ? error.message : String(error)));
  }
}

function toolReply(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}

function textArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

const VISION_TOOL = {
  name: "analyze_image",
  title: "Analyze image",
  description:
    "Looks at an image and answers in text: what the prompt asks of it, or, with no prompt, a full description with all its text transcribed. Use it to read screenshots, error dialogs, charts, diagrams and photos when you can't see images yourself.",
  inputSchema: VISION_MCP_SCHEMA,
  annotations: { readOnlyHint: true, openWorldHint: false },
};

async function mcpImageSource(req: ExpressRequest, image: string): Promise<string> {
  const lower = image.toLowerCase();
  if (lower.startsWith("data:")) {
    if (!lower.startsWith("data:image/") || !lower.slice(0, 64).includes(";base64,")) {
      throw new Error(
        "analyze_image takes a base64 data URL of an image (data:image/png;base64,...)",
      );
    }
    return image;
  }
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    return image;
  }
  let filePath = image;
  if (lower.startsWith("file://")) {
    filePath = image.slice("file://".length);
  }
  if (filePath.startsWith("~/")) {
    filePath = path.join(homedir(), filePath.slice(2));
  }
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `analyze_image takes an absolute file path, an http(s) URL or a data URL: ${image} is none of them`,
    );
  }
  const remote = req.socket.remoteAddress;
  if (remote !== undefined && !LOOPBACK.has(remote)) {
    throw new Error(
      "analyze_image reads a file only for an agent on this computer: send the image as a data URL or an http(s) URL",
    );
  }
  const info = await stat(filePath);
  if (info.isDirectory()) {
    throw new Error(`${filePath} is a folder, not an image`);
  }
  if (info.size > MAX_IMAGE_BYTES) {
    throw new Error(`${filePath} is over ${MAX_IMAGE_BYTES >> 20} MB`);
  }
  const bytes = await readFile(filePath);
  const mediaType = sniffImageType(bytes);
  if (mediaType === null) {
    throw new Error(`${filePath} isn't an image analyze_image can read`);
  }
  return dataUrl(mediaType, bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
