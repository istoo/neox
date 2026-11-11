import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import { isProviderEnabled, type GatewayConfig } from "./config.js";
import { loadImageSource } from "./vision-fetch.js";

/**
 * myna's image generation MCP server: generate_image, generate_video and
 * generation_result, for an agent that reaches the gateway from another
 * computer or a container. What draws is the gateway's own images and videos
 * API, called through this daemon (so the caller's key, models and limits
 * hold it), and what it made comes back in the answer and at a URL kept for
 * an hour.
 */

const IMAGE_PATH = "/v1/images/generations";
const EDITS_PATH = "/v1/images/edits";
const VIDEOS_PATH = "/v1/videos";

const ANSWER_WITHIN_MS = 20_000;
const POLL_MS = 3_000;
const KEEP_MS = 60 * 60_000;
const FILES_MOST = 256 << 20;
const INLINE_MOST = 5 << 20;
const JOB_MOST_MS = 15 * 60_000;
const SELF_TIMEOUT_MS = JOB_MOST_MS;

const GENERATE_IMAGE_TOOL = "generate_image";
const GENERATE_VIDEO_TOOL = "generate_video";
const GENERATION_RESULT_TOOL = "generation_result";

const PENDING_META = "github.com/istoo/myna/pending";
const FILES_META = "github.com/istoo/myna/files";

export interface MediaSendRequest {
  method: "GET" | "POST";
  path: string;
  body?: Buffer;
  contentType?: string;
  timeoutMs: number;
}

/** Calls this daemon's own API as the MCP caller. */
export type MediaSend = (request: MediaSendRequest) => Promise<{ status: number; text: string }>;

interface MediaMcpInput {
  req: ExpressRequest;
  res: ExpressResponse;
  configStore: { get(): GatewayConfig };
  send: MediaSend;
}

type ToolResult = Record<string, unknown>;

interface MadeFile {
  url: string;
  inline?: boolean;
}

interface ImageFile {
  data: Buffer;
  mime: string;
  key: string;
  made: number;
}

interface Job {
  id: string;
  key: string;
  started: number;
  result: Promise<ToolResult>;
}

export class MediaMcp {
  private readonly logger: Logger;
  private readonly answerWithinMs: number;
  private readonly pollMs: number;
  private readonly jobs = new Map<string, Job>();
  private readonly files = new Map<string, ImageFile>();
  private readonly order: string[] = [];
  private bytes = 0;
  private secret: Buffer | null = null;

  public constructor(options: { logger: Logger; answerWithinMs?: number; pollMs?: number }) {
    this.logger = options.logger;
    this.answerWithinMs = options.answerWithinMs ?? ANSWER_WITHIN_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  public async serve(input: MediaMcpInput): Promise<void> {
    const body = isRecord(input.req.body) ? input.req.body : {};
    const id = body.id ?? null;
    const method = typeof body.method === "string" ? body.method : "";
    const reply = (result: unknown): void => {
      input.res.json({ jsonrpc: "2.0", id, result });
    };
    if (method === "initialize") {
      reply({
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "neox-image", title: "Neox Image", version: "1" },
        instructions: `${GENERATE_IMAGE_TOOL} draws with an image model set up in the gateway and ${GENERATE_VIDEO_TOOL} makes a short video; images come back in the answer and at a URL, videos at a URL, nothing is saved in your project.`,
      });
      return;
    }
    if (method === "ping") {
      reply({});
      return;
    }
    if (method === "tools/list") {
      reply({ tools: toolsFor(input.configStore.get()) });
      return;
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      input.res.status(202).end();
      return;
    }
    if (method !== "tools/call") {
      input.res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const params = isRecord(body.params) ? body.params : {};
    const args = isRecord(params.arguments) ? params.arguments : {};
    const name = typeof params.name === "string" ? params.name : "";
    const config = input.configStore.get();
    try {
      if (name === GENERATE_IMAGE_TOOL) {
        reply(await this.draw(input, config, args));
        return;
      }
      if (name === GENERATE_VIDEO_TOOL) {
        reply(await this.film(input, config, args));
        return;
      }
      if (name === GENERATION_RESULT_TOOL) {
        reply(await this.result(input, args));
        return;
      }
      reply(
        toolReply(
          `Unknown tool ${name}: this server has ${GENERATE_IMAGE_TOOL}, ${GENERATE_VIDEO_TOOL} and ${GENERATION_RESULT_TOOL}`,
        ),
      );
    } catch (error) {
      this.logger.info({ err: error, tool: name }, "Image MCP call failed");
      reply(toolReply(error instanceof Error ? error.message : String(error)));
    }
  }

  private async draw(
    input: MediaMcpInput,
    config: GatewayConfig,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const prompt = textArgument(args, "prompt");
    if (prompt.length === 0) {
      return toolReply(`${GENERATE_IMAGE_TOOL} needs a prompt`);
    }
    const model = mediaModelFor(config, "image", args);
    const references = arrayArgument(args, "reference_images");
    const fields: Record<string, string> = {
      prompt,
      n: String(clampNumber(args.n, 1, 4, 1)),
      response_format: "b64_json",
    };
    if (model !== null) {
      fields.model = model;
    }
    for (const name of ["size", "quality", "background"]) {
      const value = textArgument(args, name);
      if (value.length > 0) {
        fields[name] = value;
      }
    }
    const pictures: { data: Buffer; mime: string }[] = [];
    for (const reference of references) {
      const image = await loadImageSource(reference);
      pictures.push({ data: image.bytes, mime: image.mediaType });
    }
    const job = this.start(input, () => this.drawn(input, fields, pictures));
    return this.awaitJob(job, "image");
  }

  private async drawn(
    input: MediaMcpInput,
    fields: Record<string, string>,
    pictures: readonly { data: Buffer; mime: string }[],
  ): Promise<ToolResult> {
    let response: { status: number; text: string };
    if (pictures.length === 0) {
      response = await input.send({
        method: "POST",
        path: IMAGE_PATH,
        body: Buffer.from(JSON.stringify(fields)),
        contentType: "application/json",
        timeoutMs: SELF_TIMEOUT_MS,
      });
    } else {
      const form = multipart(fields, pictures);
      response = await input.send({
        method: "POST",
        path: EDITS_PATH,
        body: form.body,
        contentType: form.contentType,
        timeoutMs: SELF_TIMEOUT_MS,
      });
    }
    if (response.status !== 200) {
      return toolReply(`no image: ${said(response.text)}`);
    }
    const payload = parseJson(response.text);
    const taken = await this.collect(payload, keyOf(input));
    if (taken.urls.length === 0) {
      return toolReply(taken.lost.join("\n") || "no image came back");
    }
    const { content, urls, files, lost } = taken;
    const model =
      isRecord(payload) && typeof payload.model === "string" ? payload.model : "the image model";
    const lines = [
      `Generated with ${model}. ${
        urls.length === 1 ? "The image is" : "The images are"
      } in this answer and can be downloaded for an hour from (the link opens without a header, in a browser too, until it expires):`,
      ...urls.map((url) => `- ${url}`),
    ];
    if (content.length < urls.length) {
      lines.push(`Images over ${INLINE_MOST >> 20} MB are only at their URL.`);
    }
    for (const note of lost) {
      lines.push(`Not saved: ${note}`);
    }
    return meta(
      { content: [{ type: "text", text: `${lines.join("\n")}\n` }, ...content], isError: false },
      FILES_META,
      files,
    );
  }

  /** The images in the images API's answer, kept and put in the tool result. */
  private async collect(
    payload: unknown,
    key: string,
  ): Promise<{
    content: Record<string, unknown>[];
    urls: string[];
    files: MadeFile[];
    lost: string[];
  }> {
    const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const content: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const files: MadeFile[] = [];
    const lost: string[] = [];
    for (const [index, entry] of data.entries()) {
      const image = await this.drawnOne(entry, index, key);
      if ("note" in image) {
        lost.push(image.note);
        continue;
      }
      urls.push(image.url);
      files.push(image.file);
      if (image.inline) {
        content.push({ type: "image", data: image.data, mimeType: image.mime });
      }
    }
    return { content, urls, files, lost };
  }

  private async drawnOne(
    entry: unknown,
    index: number,
    key: string,
  ): Promise<
    { note: string } | { url: string; file: MadeFile; inline: boolean; data: string; mime: string }
  > {
    if (!isRecord(entry)) {
      return { note: `image ${index + 1} came back unreadable` };
    }
    const inline = typeof entry.b64_json === "string" ? entry.b64_json : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    let bytes: Buffer | null = null;
    let mime = typeof entry.mime_type === "string" ? entry.mime_type : "image/png";
    if (inline.length > 0) {
      bytes = Buffer.from(inline, "base64");
    } else if (url.length > 0) {
      try {
        const downloaded = await loadImageSource(url);
        bytes = downloaded.bytes;
        mime = downloaded.mediaType;
      } catch (error) {
        return {
          note: `image ${index + 1} was drawn but couldn't be downloaded (${errorMessage(error)}); the vendor keeps it at ${url} for a while`,
        };
      }
    }
    if (bytes === null) {
      return { note: `image ${index + 1} came back without bytes or a URL` };
    }
    if (!mime.startsWith("image/")) {
      mime = "image/png";
    }
    const kept = this.keepFile(bytes, mime, key);
    if (kept === null) {
      return { note: `image ${index + 1} was drawn but couldn't be kept` };
    }
    const fits = bytes.length <= INLINE_MOST;
    return {
      url: kept,
      file: { url: kept, ...(fits ? { inline: true } : {}) },
      inline: fits,
      data: fits ? bytes.toString("base64") : "",
      mime,
    };
  }

  private async film(
    input: MediaMcpInput,
    config: GatewayConfig,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const prompt = textArgument(args, "prompt");
    if (prompt.length === 0) {
      return toolReply(`${GENERATE_VIDEO_TOOL} needs a prompt`);
    }
    const body: Record<string, unknown> = { prompt };
    const model = mediaModelFor(config, "video", args);
    if (model !== null) {
      body.model = model;
    }
    const seconds = numberArgument(args, "seconds");
    if (seconds !== null) {
      if (seconds < 1 || seconds > 15 || !Number.isInteger(seconds)) {
        return toolReply("seconds is a whole number from 1 to 15");
      }
      body.seconds = seconds;
    }
    const size = textArgument(args, "size");
    if (size.length > 0) {
      body.size = size;
    }
    const image = textArgument(args, "image");
    if (image.length > 0) {
      const source = await loadImageSource(image);
      body.input_reference = `data:${source.mediaType};base64,${source.bytes.toString("base64")}`;
    }
    const references = arrayArgument(args, "reference_images");
    if (references.length > 0) {
      body.reference_images = await Promise.all(
        references.map(async (reference) => {
          const source = await loadImageSource(reference);
          return `data:${source.mediaType};base64,${source.bytes.toString("base64")}`;
        }),
      );
    }
    const response = await input.send({
      method: "POST",
      path: VIDEOS_PATH,
      body: Buffer.from(JSON.stringify(body)),
      contentType: "application/json",
      timeoutMs: SELF_TIMEOUT_MS,
    });
    if (response.status !== 200) {
      return toolReply(`no video: ${said(response.text)}`);
    }
    const id = isRecord(parseJson(response.text)) ? readId(parseJson(response.text)) : null;
    if (id === null) {
      return toolReply(`no video: the answer has no id: ${said(response.text)}`);
    }
    return this.watchVideo(input, id);
  }

  private async watchVideo(input: MediaMcpInput, id: string): Promise<ToolResult> {
    const deadline = Date.now() + this.answerWithinMs;
    const started = Date.now();
    for (;;) {
      const response = await input.send({
        method: "GET",
        path: `${VIDEOS_PATH}/${encodeURIComponent(id)}`,
        timeoutMs: 60_000,
      });
      if (response.status !== 200) {
        return toolReply(`asking after the video (${id}): ${said(response.text)}`);
      }
      const payload = parseJson(response.text);
      const status = isRecord(payload) && typeof payload.status === "string" ? payload.status : "";
      if (status === "completed") {
        const at = `${baseOf(input.req)}/v1/videos/${encodeURIComponent(id)}/content`;
        return meta(
          toolReply(
            `Generated a video with ${
              isRecord(payload) && typeof payload.model === "string"
                ? payload.model
                : "the video model"
            }. Download the mp4 from (with the same Authorization header as this server, from another computer):\n- ${at}\n`,
            false,
          ),
          FILES_META,
          [{ url: at }],
        );
      }
      if (status === "failed") {
        const message =
          isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
            ? payload.error.message
            : "it gave no reason";
        return toolReply(`the video failed: ${message}`);
      }
      if (Date.now() + this.pollMs > deadline) {
        const waited = Math.round((Date.now() - started) / 1000);
        return meta(
          toolReply(
            `The video is still being made (${id}, ${waited} s so far; it can take a few minutes). It goes on without this call. Don't ask for it again: call ${GENERATION_RESULT_TOOL} with id ${JSON.stringify(id)} to wait for it.\n`,
            false,
          ),
          PENDING_META,
          id,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async result(input: MediaMcpInput, args: Record<string, unknown>): Promise<ToolResult> {
    const id = textArgument(args, "id");
    if (id.length === 0) {
      return toolReply(
        `${GENERATION_RESULT_TOOL} needs the id ${GENERATE_IMAGE_TOOL} or ${GENERATE_VIDEO_TOOL} answered with`,
      );
    }
    const job = this.jobs.get(id);
    if (job !== undefined) {
      if (job.key !== keyOf(input)) {
        return toolReply(`no image is being made as ${JSON.stringify(id)}`);
      }
      return this.awaitJob(job, "image");
    }
    return this.watchVideo(input, id);
  }

  private start(input: MediaMcpInput, run: () => Promise<ToolResult>): Job {
    this.sweep();
    const job: Job = {
      id: `img_${randomBytes(9).toString("hex")}`,
      key: keyOf(input),
      started: Date.now(),
      result: run(),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  private async awaitJob(job: Job, kind: string): Promise<ToolResult> {
    const limit = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), this.answerWithinMs),
    );
    const done = await Promise.race([job.result, limit]);
    if (done !== null) {
      return done;
    }
    const waited = Math.round((Date.now() - job.started) / 1000);
    return meta(
      toolReply(
        `The ${kind} is still being made (${waited} s so far; it can take a few minutes). It goes on without this call. Don't ask for it again: call ${GENERATION_RESULT_TOOL} with id ${JSON.stringify(job.id)} to wait for it and get it.\n`,
        false,
      ),
      PENDING_META,
      job.id,
    );
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      void this.reap(id, job, now);
    }
  }

  private async reap(id: string, job: Job, now: number): Promise<void> {
    try {
      await job.result;
    } catch {
      this.jobs.delete(id);
      return;
    }
    if (now - job.started > KEEP_MS) {
      this.jobs.delete(id);
    }
  }

  private keepFile(data: Buffer, mime: string, key: string): string | null {
    if (data.length > FILES_MOST) {
      return null;
    }
    const name = `${randomBytes(16).toString("hex")}${extensionOf(mime)}`;
    this.secret ??= randomBytes(32);
    const made = Date.now();
    this.files.set(name, { data, mime, key, made });
    this.order.push(name);
    this.bytes += data.length;
    while (this.order.length > 1) {
      const oldest = this.order[0];
      if (oldest === undefined) {
        break;
      }
      const file = this.files.get(oldest);
      if (this.bytes <= FILES_MOST && file !== undefined && made - file.made <= KEEP_MS) {
        break;
      }
      this.order.shift();
      this.files.delete(oldest);
      this.bytes -= file?.data.length ?? 0;
    }
    const exp = made + KEEP_MS;
    const token = this.token(name, exp);
    return `${name}?t=${token}`;
  }

  private token(name: string, exp: number): string {
    const secret = this.secret ?? randomBytes(32);
    this.secret = secret;
    const mac = createHmac("sha256", secret)
      .update(`neolix image file\0${name}\0${exp}`)
      .digest("base64url");
    return `${exp}.${mac}`;
  }

  /** Serves an image the server made, to whoever has its token within the hour. */
  public serveFile(name: string, token: string, res: ExpressResponse): void {
    const file = this.files.get(name);
    if (file === undefined || Date.now() - file.made > KEEP_MS || !this.tokenOpens(name, token)) {
      res.status(404).json({
        error: {
          message:
            "no such image: images are kept for an hour, and only at the link they were handed out at",
          type: "not_found",
        },
      });
      return;
    }
    res.setHeader("content-type", file.mime);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "private, max-age=3600");
    res.send(file.data);
  }

  private tokenOpens(name: string, token: string): boolean {
    const dot = token.indexOf(".");
    if (dot <= 0) {
      return false;
    }
    const exp = Number(token.slice(0, dot));
    if (!Number.isInteger(exp) || Date.now() > exp * 1000) {
      return false;
    }
    const expected = Buffer.from(this.token(name, exp));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}

function keyOf(input: MediaMcpInput): string {
  for (const name of ["authorization", "x-api-key", "x-goog-api-key"]) {
    const value = input.req.headers[name];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function toolsFor(config: GatewayConfig): Record<string, unknown>[] {
  const imageModels = mediaModels(config, "image");
  const videoModels = mediaModels(config, "video");
  const imageDraws = imageDefault(config, imageModels);
  const imageDescription =
    config.imageGen === "off"
      ? "Image generation is off in Settings › Models › Images, so this draws nothing until a model is picked there. The tool takes a prompt, and optional size, n, quality and reference_images."
      : `Generate an image from a text prompt, or edit/combine images given as reference_images, with an image model set up in the gateway or the one model names.${imageDraws === null ? "" : ` Leave model out to use ${imageDraws}.`} The image comes back in the answer and at a URL kept for an hour; nothing is saved in your project. When it is not ready within about 20 seconds, the answer is an id to wait on with generation_result. Write a detailed prompt: subject, style, composition, colours, any text to render exactly.`;
  return [
    {
      name: GENERATE_IMAGE_TOOL,
      title: "Generate image",
      description: imageDescription,
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What to draw, or how to change the reference images.",
          },
          model: modelProperty("image", imageModels, imageDraws),
          size: {
            type: "string",
            description:
              "WIDTHxHEIGHT (1024x1024, 1536x1024, 1024x1536) or an aspect ratio (16:9). Default: the model's.",
          },
          n: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            description: "How many images (default 1).",
          },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description:
              "Images to edit or draw from: an http(s) URL, a data URL, or an absolute file path for an agent on this computer.",
          },
          quality: {
            type: "string",
            description: "low, medium, high or auto, for models that take it.",
          },
          background: {
            type: "string",
            description: "transparent, opaque or auto, for models that take it.",
          },
        },
        required: ["prompt"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: GENERATE_VIDEO_TOOL,
      title: "Generate video",
      description:
        "Generate a short video from a text prompt, optionally starting from an image to animate, with a video model set up in the gateway or the one model names. It takes from ten seconds to a few minutes; the answer is the URL to download the mp4 from (with the same Authorization header this server is called with), or, when it is not ready within about 20 seconds, an id to wait on with generation_result. Nothing is saved in your project. Describe the subject, the motion and the camera.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "What happens in the video: the subject, its motion, the camera.",
          },
          model: modelProperty("video", videoModels, videoModels[0] ?? null),
          seconds: {
            type: "integer",
            minimum: 1,
            maximum: 15,
            description: "Length in whole seconds (1-15). Default: the model's.",
          },
          size: {
            type: "string",
            description: "An aspect ratio (16:9, 9:16, 1:1) or WIDTHxHEIGHT. Default: the model's.",
          },
          image: {
            type: "string",
            description:
              "An image to animate, the video's first frame: an http(s) URL, a data URL, or an absolute file path for an agent on this computer.",
          },
          reference_images: {
            type: "array",
            items: { type: "string" },
            description: "Images the video's subjects are drawn from.",
          },
        },
        required: ["prompt"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
      name: GENERATION_RESULT_TOOL,
      title: "Generation result",
      description:
        "Wait for an image or video that generate_image or generate_video said is still being made, by the id it gave, and get it. It answers within about 20 seconds: if it is still not ready, call this again with the same id (don't generate it again).",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The id generate_image or generate_video answered with.",
          },
        },
        required: ["id"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ];
}

function modelProperty(
  kind: "image" | "video",
  models: readonly string[],
  draws: string | null,
): Record<string, unknown> {
  let description: string;
  if (models.length === 0) {
    description = `The ${kind} model to use, as provider/model. Leave it out: none is set up in the gateway.`;
  } else if (models.length > 40) {
    description = `The ${kind} model to use, as provider/model, one of the ${models.length} set up in the gateway (such as ${models.slice(0, 3).join(", ")}); an unknown one is refused with the full list.`;
  } else {
    description = `The ${kind} model to use, as provider/model. Leave it out to use ${draws ?? models[0]}.`;
  }
  return {
    type: "string",
    description,
    ...(models.length > 0 && models.length <= 40 ? { enum: models } : {}),
  };
}

function mediaModels(config: GatewayConfig, kind: "image" | "video"): string[] {
  const models: string[] = [];
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    for (const model of provider.models) {
      if (model.kind === kind) {
        models.push(`${provider.id}/${model.id}`);
      }
    }
  }
  return models;
}

/**
 * The model a call that names none draws with: myna's Image generation row,
 * `provider/model`, "off", or absent for the first image model set up.
 */
function imageDefault(config: GatewayConfig, models: readonly string[]): string | null {
  const chosen = (config.imageGen ?? "").trim();
  if (chosen.length === 0) {
    return models[0] ?? null;
  }
  return chosen === "off" ? null : chosen;
}

function mediaModelFor(
  config: GatewayConfig,
  kind: "image" | "video",
  args: Record<string, unknown>,
): string | null {
  const asked = textArgument(args, "model");
  const models = mediaModels(config, kind);
  if (asked.length === 0) {
    if (kind !== "image") {
      return models[0] ?? null;
    }
    const chosen = (config.imageGen ?? "").trim();
    if (chosen === "off") {
      throw new Error(
        "image generation is off in Settings › Models › Images; pick a model or Automatic there to draw",
      );
    }
    if (chosen.length === 0) {
      return models[0] ?? null;
    }
    if (!models.includes(chosen)) {
      throw new Error(
        `${chosen}, picked in Settings › Models › Images, isn't an image model set up in the gateway any more; pick another model there, or pass model`,
      );
    }
    return chosen;
  }
  const whole = models.includes(asked)
    ? asked
    : models.find((model) => model.slice(model.indexOf("/") + 1) === asked);
  if (whole !== undefined) {
    return whole;
  }
  throw new Error(
    models.length === 0
      ? `no ${kind} model is set up in the gateway`
      : `${JSON.stringify(asked)} isn't ${kind === "image" ? "an" : "a"} ${kind} model set up here. Pick one of: ${models.join(", ")}; or leave model out.`,
  );
}

function multipart(
  fields: Record<string, string>,
  pictures: readonly { data: Buffer; mime: string }[],
): { body: Buffer; contentType: string } {
  const boundary = `----neolix${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  const text = (value: string): void => {
    chunks.push(Buffer.from(value, "utf8"));
  };
  for (const [name, value] of Object.entries(fields)) {
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  pictures.forEach((picture, index) => {
    text(
      `--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="image-${index + 1}${extensionOf(picture.mime)}"\r\nContent-Type: ${picture.mime}\r\n\r\n`,
    );
    chunks.push(picture.data);
    text("\r\n");
  });
  text(`--${boundary}--\r\n`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function extensionOf(mime: string): string {
  if (mime === "image/jpeg") {
    return ".jpg";
  }
  if (mime === "image/webp") {
    return ".webp";
  }
  if (mime === "image/gif") {
    return ".gif";
  }
  return ".png";
}

function baseOf(req: ExpressRequest): string {
  const forwarded = req.headers["x-forwarded-proto"];
  const scheme = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : req.protocol;
  return `${scheme === "https" ? "https" : "http"}://${req.get("host") ?? "127.0.0.1"}`;
}

function toolReply(text: string, isError = true): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

function meta(result: ToolResult, key: string, value: unknown): ToolResult {
  return { ...result, _meta: { [key]: value } };
}

function textArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value.trim() : "";
}

function arrayArgument(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function numberArgument(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function clampNumber(value: unknown, low: number, high: number, fallback: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(high, Math.max(low, number));
}

function readId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = payload.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function said(text: string): string {
  const payload = parseJson(text);
  if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  const trimmed = text.trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
