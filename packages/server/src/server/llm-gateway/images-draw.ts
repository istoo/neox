import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import type { GatewayAccount, GatewayProvider } from "./config.js";
import { buildUpstreamHeaders } from "./upstream.js";
import { privateAddress } from "./video.js";

/**
 * /v1/images/generations for the vendors that don't take OpenAI's images
 * request, ported from myna's draw*.go: DashScope's multimodal generation,
 * ModelScope's asynchronous task, Volcengine Ark's images API and
 * WorkBuddy's wrapped one. Every answer is OpenAI's shape, whichever vendor
 * drew; one no adapter serves goes upstream untouched.
 */

export type ImageMechanism =
  | "dashscope"
  | "modelscope"
  | "ark"
  | "workbuddy"
  | "openrouter"
  | "grok"
  | "copilot"
  | "gemini"
  | "chat";

/** The models asked on an images API, as myna's catalog tells them. */
const IMAGES_API_WORDS = [
  "gpt-image",
  "chatgpt-image",
  "dall-e",
  "imagen",
  "imagine",
  "qwen-image",
  "wanx",
  "wan2",
  "seedream",
  "cogview",
  "flux",
  "stable-diffusion",
  "sdxl",
  "kolors",
  "hidream",
  "sensenova-u1",
  "hy-image",
];

const GROK_ASPECTS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
];

const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

/** The vendors whose image models are asked on their own API, as myna tells them. */
const DASHSCOPE_PRESETS = new Set([
  "qwen",
  "qwen-cn",
  "qwen-token-plan",
  "bailian-token-plan",
  "qwencloud",
  "qwencloud-token-plan",
]);

/** How long a vendor is given to draw, and one polling task to finish. */
export const IMAGE_WAIT_MS = 5 * 60_000;
/** The most minutes the Image generation timeout may be set to (myna's ImageTimeoutMost). */
export const IMAGE_TIMEOUT_MOST = 60;

/**
 * How long a drawing is given, from the user's Image generation timeout in
 * minutes (myna's ImageWait): 5 when unset, and no more than the most.
 */
export function imageWaitMs(config: { imageTimeout?: number }): number {
  const minutes = config.imageTimeout ?? 0;
  const held = minutes > 0 ? Math.min(minutes, IMAGE_TIMEOUT_MOST) : 5;
  return held * 60_000;
}
const MAX_DRAWINGS = 4;
const MAX_IMAGE_BYTES = 64 << 20;

export interface ImageDrawTiming {
  waitMs: number;
  pollMs: number;
  /** The waits before asking ModelScope again while its queue is full. */
  busyMs: readonly number[];
}

const DEFAULT_TIMING: ImageDrawTiming = {
  waitMs: IMAGE_WAIT_MS,
  pollMs: 2_000,
  busyMs: [3_000, 8_000, 15_000],
};

const DRAWING_FIELDS = new Set([
  "model",
  "prompt",
  "size",
  "quality",
  "background",
  "output_format",
  "response_format",
  "n",
  "image",
  "images",
  "mask",
  "user",
]);

const ARK_RATIO_SIZES: Record<string, string> = {
  "1:1": "2048x2048",
  "4:3": "2304x1728",
  "3:4": "1728x2304",
  "16:9": "2848x1600",
  "9:16": "1600x2848",
  "3:2": "2496x1664",
  "2:3": "1664x2496",
  "21:9": "3136x1344",
};

interface Drawing {
  model: string;
  prompt: string;
  size: string;
  quality: string;
  background: string;
  format: string;
  want: string;
  n: number;
  images: string[];
  mask?: string;
  extra: Record<string, unknown>;
}

interface DrawnImage {
  url?: string;
  data?: Buffer;
  mime?: string;
}

interface Drawn {
  images: DrawnImage[];
  revised?: string;
  /** What a chat model said besides its image. */
  text?: string;
}

class DrawInputError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "DrawInputError";
    this.status = status;
  }
}

interface DrawContext {
  provider: GatewayProvider;
  account: GatewayAccount | undefined;
  model: string;
  base: string;
  drawing: Drawing;
  timing: ImageDrawTiming;
  fetchImpl: typeof fetch;
}

/* ---------------------------------------------------------------- vendors */

/** The vendor whose images API a provider's model is asked on, or null. */
export function imageMechanismOf(
  provider: GatewayProvider,
  modelId: string,
): ImageMechanism | null {
  const base = (provider.baseUrl ?? "").trim();
  const host = hostOf(base);
  if (base !== "" && (provider.id === "workbuddy" || provider.id === "workbuddy-ai")) {
    return "workbuddy";
  }
  if (host === "api-inference.modelscope.cn") {
    return "modelscope";
  }
  if (host.includes("grok.com") || provider.id.toLowerCase().startsWith("grok")) {
    return "grok";
  }
  if (provider.id.toLowerCase().includes("copilot")) {
    return "copilot";
  }
  const model = modelId.toLowerCase();
  if (host === "generativelanguage.googleapis.com" && model.includes("gemini")) {
    return "gemini";
  }
  if (host === "openrouter.ai") {
    return imagesApiModel(modelId) ? "openrouter" : "chat";
  }
  if (isArkHost(host)) {
    return "ark";
  }
  if (dashScopeDraws(provider, modelId, host)) {
    return "dashscope";
  }
  return null;
}

function imagesApiModel(modelId: string): boolean {
  const model = modelId.toLowerCase();
  return IMAGES_API_WORDS.some((word) => model.includes(word));
}

function hostOf(base: string): string {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isArkHost(host: string): boolean {
  return (host.startsWith("ark.") && host.endsWith(".volces.com")) || host.includes("volcengine");
}

function dashScopeDraws(provider: GatewayProvider, modelId: string, host: string): boolean {
  const model = modelId.toLowerCase();
  if (!model.startsWith("qwen-image") && !model.startsWith("wan2.7-image")) {
    return false;
  }
  return (
    DASHSCOPE_PRESETS.has(provider.id) ||
    (host.startsWith("dashscope") && host.endsWith(".aliyuncs.com")) ||
    host.endsWith(".maas.aliyuncs.com") ||
    host === "maas.qianwenaiapi.com" ||
    host.endsWith(".maas.qianwenaiapi.com") ||
    host === "maas.qwencloudapi.com" ||
    host.endsWith(".maas.qwencloudapi.com")
  );
}

/* ------------------------------------------------------------- the request */

/**
 * A vendor's answer to an images generation, as an OpenAI-shaped Response,
 * so it goes through the gateway's usual relay. Null when no adapter serves
 * the provider and model, which go upstream as they came.
 */
export async function drawImageFor(input: {
  provider: GatewayProvider;
  account?: GatewayAccount;
  model: string;
  body: Record<string, unknown>;
  timing?: Partial<ImageDrawTiming>;
  fetchImpl?: typeof fetch;
}): Promise<Response | null> {
  const mechanism = imageMechanismOf(input.provider, input.model);
  if (mechanism === null) {
    return null;
  }
  try {
    const context: DrawContext = {
      provider: input.provider,
      account: input.account,
      model: input.model,
      base: (input.account?.baseUrl ?? input.provider.baseUrl).replace(/\/+$/, ""),
      drawing: parseDrawing(input.body, input.model),
      timing: { ...DEFAULT_TIMING, ...input.timing },
      fetchImpl: input.fetchImpl ?? fetch,
    };
    const drawn = await drawBy(mechanism, context);
    return await openAiAnswer(context, drawn);
  } catch (error) {
    if (error instanceof DrawInputError) {
      return errorResponse(error.status, error.message, "invalid_request");
    }
    if (error instanceof VendorError) {
      return errorResponse(error.status, error.message, "gateway_error");
    }
    return errorResponse(502, errorMessage(error), "gateway_error");
  }
}

async function drawBy(mechanism: ImageMechanism, context: DrawContext): Promise<Drawn> {
  switch (mechanism) {
    case "dashscope":
      return drawDashScope(context);
    case "modelscope":
      return drawModelScope(context);
    case "ark":
      return drawArk(context);
    case "workbuddy":
      return drawWorkBuddy(context);
    case "openrouter":
      return drawOpenRouter(context);
    case "grok":
      return drawGrok(context);
    case "copilot":
      return drawCopilot(context);
    case "gemini":
      return drawGemini(context);
    case "chat":
      return drawChat(context);
    default:
      throw new Error(`unknown image mechanism ${String(mechanism)}`);
  }
}

function parseDrawing(body: Record<string, unknown>, model: string): Drawing {
  const n = typeof body.n === "number" && Number.isFinite(body.n) ? Math.floor(body.n) : 0;
  if (n > MAX_DRAWINGS) {
    throw new DrawInputError(400, `n is at most ${MAX_DRAWINGS}`);
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!DRAWING_FIELDS.has(key)) {
      extra[key] = value;
    }
  }
  const mask = typeof body.mask === "string" ? body.mask.trim() : "";
  return {
    model,
    prompt: stringOf(body.prompt),
    size: stringOf(body.size).trim(),
    quality: stringOf(body.quality),
    background: stringOf(body.background),
    format: stringOf(body.output_format),
    want: stringOf(body.response_format).trim(),
    n: Math.max(1, n),
    images: imageRefs(body),
    ...(mask === "" ? {} : { mask }),
    extra,
  };
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** An images request's reference images, from `image`, `images` or both. */
function imageRefs(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["image", "images"]) {
    const value = body[key];
    if (typeof value === "string" && value !== "") {
      out.push(value);
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      if (typeof entry === "string" && entry !== "") {
        out.push(entry);
      } else if (isRecord(entry) && typeof entry.url === "string" && entry.url !== "") {
        out.push(entry.url);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ DashScope */

async function drawDashScope(context: DrawContext): Promise<Drawn> {
  const { drawing } = context;
  if (drawing.mask !== undefined) {
    throw new DrawInputError(
      400,
      "DashScope's image models take no mask: say in the prompt which part of the image to change",
    );
  }
  const size = dashScopeSize(drawing.size);
  const content: Array<Record<string, string>> = drawing.images.map((url) => ({ image: url }));
  content.push({ text: drawing.prompt });
  const parameters: Record<string, unknown> = { watermark: false };
  if (drawing.n > 1) {
    parameters.n = drawing.n;
  }
  if (size !== "") {
    parameters.size = size;
  }
  const url = `${dashScopeRoot(context.base)}/api/v1/services/aigc/multimodal-generation/generation`;
  const answer = await sendJson(context, url, {
    model: context.model,
    input: { messages: [{ role: "user", content }] },
    parameters,
  });
  if (answer.status < 200 || answer.status >= 300) {
    throw new VendorError(answer.status, `${hostOf(url)}: ${answer.status} ${answer.message}`);
  }
  return readDashScopeAnswer(answer.json, answer.text);
}

function dashScopeRoot(base: string): string {
  for (const cut of ["/compatible-mode/", "/apps/", "/api/v1"]) {
    const at = base.indexOf(cut);
    if (at >= 0) {
      return base.slice(0, at);
    }
  }
  return base;
}

function dashScopeSize(size: string): string {
  if (size === "" || size.toLowerCase() === "auto") {
    return "";
  }
  if (size.includes(":")) {
    throw new DrawInputError(
      400,
      "DashScope's image models take no aspect ratio as size: give WIDTHxHEIGHT (e.g. 1328x1328, at most 2048x2048 in pixels), or leave size out for the model to pick one from the prompt",
    );
  }
  return size.toLowerCase().replace("x", "*");
}

function readDashScopeAnswer(value: unknown, text: string): Drawn {
  if (!isRecord(value) || !isRecord(value.output)) {
    throw new VendorError(502, `DashScope's answer isn't its own: ${text.slice(0, 300)}`);
  }
  const out: Drawn = { images: [] };
  const texts: string[] = [];
  const endings: string[] = [];
  const choices = Array.isArray(value.output.choices) ? value.output.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) {
      continue;
    }
    const message = isRecord(choice.message) ? choice.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      if (typeof part.image === "string" && part.image !== "") {
        out.images.push({ url: part.image });
      } else if (typeof part.text === "string" && part.text.trim() !== "") {
        texts.push(part.text);
      }
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "stop") {
      endings.push(choice.finish_reason);
    }
  }
  if (out.images.length === 0) {
    const said = dashScopeSaid(value) || texts.join("\n");
    throw new VendorError(
      502,
      `DashScope answered with no image${saidOf(said || endings.join(", "))}`,
    );
  }
  return out;
}

function dashScopeSaid(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const code = stringOf(value.code);
  const message = stringOf(value.message);
  if (code === "" && message === "") {
    return "";
  }
  return code === "" ? message : `${message} (${code})`;
}

/* ------------------------------------------------------------ ModelScope */

interface ModelScopeAnswer {
  taskId: string;
  images: DrawnImage[];
}

const modelScopeQueues = new Map<string, Promise<unknown>>();

async function drawModelScope(context: DrawContext): Promise<Drawn> {
  const out: Drawn = { images: [] };
  const key = `${context.provider.id}\u0000${context.account?.id ?? context.provider.apiKey ?? ""}`;
  await queued(key, async () => {
    for (let i = 0; i < context.drawing.n; i += 1) {
      const images = await modelScopeTask(context);
      out.images.push(...images);
    }
  });
  return out;
}

/** One vendor task at a time per key, as myna asks ModelScope. */
function queued<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = modelScopeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  modelScopeQueues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function modelScopeTask(context: DrawContext): Promise<DrawnImage[]> {
  const { drawing } = context;
  const body: Record<string, unknown> = { model: context.model, prompt: drawing.prompt };
  if (drawing.size !== "" && drawing.size.toLowerCase() !== "auto") {
    body.size = drawing.size;
  }
  if (drawing.images.length > 0) {
    body.image_url = drawing.images;
  }
  const deadline = Date.now() + context.timing.waitMs;
  const started = await modelScopeStart(context, body, deadline);
  if (started.images.length > 0 || started.taskId === "") {
    if (started.images.length === 0) {
      throw new VendorError(502, "ModelScope started no image task");
    }
    return started.images;
  }
  return modelScopePoll(context, started.taskId, deadline);
}

async function modelScopeStart(
  context: DrawContext,
  body: Record<string, unknown>,
  deadline: number,
): Promise<ModelScopeAnswer> {
  const url = `${context.base}/images/generations`;
  for (let attempt = 0; ; attempt += 1) {
    const answer = await sendJson(context, url, body, { "X-ModelScope-Async-Mode": "true" });
    const busy = answer.status === 429 || answer.message.includes("queue is full");
    if (!busy || attempt >= context.timing.busyMs.length) {
      if (answer.status < 200 || answer.status >= 300) {
        throw new VendorError(answer.status, `ModelScope: ${answer.status} ${answer.message}`);
      }
      return readModelScopeAnswer(answer.json, answer.text);
    }
    await sleep(Math.min(context.timing.busyMs[attempt] ?? 0, Math.max(0, deadline - Date.now())));
  }
}

async function modelScopePoll(
  context: DrawContext,
  taskId: string,
  deadline: number,
): Promise<DrawnImage[]> {
  for (;;) {
    if (Date.now() >= deadline) {
      throw new VendorError(
        504,
        `ModelScope didn't finish drawing in ${context.timing.waitMs / 1000}s`,
      );
    }
    await sleep(context.timing.pollMs);
    const answer = await sendJson(
      context,
      `${context.base}/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      { "X-ModelScope-Task-Type": "image_generation" },
      "GET",
    );
    if (answer.status < 200 || answer.status >= 300) {
      throw new VendorError(answer.status, `ModelScope: ${answer.status} ${answer.message}`);
    }
    const status = isRecord(answer.json) ? stringOf(answer.json.task_status).toUpperCase() : "";
    if (status === "SUCCEED" || status === "SUCCEEDED" || status === "SUCCESS") {
      const images = modelScopeImages(answer.json);
      if (images.length === 0) {
        throw new VendorError(502, "ModelScope finished the task with no image");
      }
      return images;
    }
    if (
      status === "FAILED" ||
      status === "FAILURE" ||
      status === "CANCELED" ||
      status === "CANCELLED"
    ) {
      throw new VendorError(502, `ModelScope's image task failed${saidOf(answer.message)}`);
    }
  }
}

function readModelScopeAnswer(value: unknown, text: string): ModelScopeAnswer {
  if (!isRecord(value)) {
    throw new VendorError(502, `ModelScope's answer isn't its own: ${text.slice(0, 300)}`);
  }
  return { taskId: stringOf(value.task_id), images: modelScopeImages(value) };
}

function modelScopeImages(value: unknown): DrawnImage[] {
  if (!isRecord(value)) {
    return [];
  }
  const out: DrawnImage[] = [];
  if (Array.isArray(value.output_images)) {
    for (const url of value.output_images) {
      if (typeof url === "string" && url !== "") {
        out.push({ url });
      }
    }
  }
  if (Array.isArray(value.images)) {
    for (const image of value.images) {
      if (isRecord(image) && typeof image.url === "string" && image.url !== "") {
        out.push({ url: image.url });
      }
    }
  }
  return out;
}

/* ----------------------------------------------------------- Volcengine */

async function drawArk(context: DrawContext): Promise<Drawn> {
  const body = arkBody(context);
  const url = `${context.base}/images/generations`;
  const results = await Promise.all(
    Array.from({ length: context.drawing.n }, () => arkOnce(context, url, body)),
  );
  const out: Drawn = { images: [] };
  for (const result of results) {
    out.images.push(...result.images);
    out.revised ??= result.revised;
  }
  return out;
}

async function arkOnce(
  context: DrawContext,
  url: string,
  body: Record<string, unknown>,
): Promise<Drawn> {
  const answer = await sendJson(context, url, body);
  if (answer.status < 200 || answer.status >= 300) {
    throw new VendorError(answer.status, `Volcengine: ${answer.status} ${answer.message}`);
  }
  return readImagesAnswer(answer.json, answer.text, "Volcengine");
}

function arkBody(context: DrawContext): Record<string, unknown> {
  const { drawing } = context;
  if (drawing.mask !== undefined) {
    throw new DrawInputError(
      400,
      "Volcengine's images API takes no mask: say in the prompt which part of the image to change",
    );
  }
  const body: Record<string, unknown> = { watermark: false };
  for (const [key, value] of Object.entries(drawing.extra)) {
    body[key] = value;
  }
  if (body.stream === true) {
    throw new DrawInputError(
      400,
      "Volcengine's images API streams its images in events of its own, which /v1/images/generations doesn't give: leave stream out",
    );
  }
  delete body.stream;
  body.model = context.model;
  if (drawing.prompt !== "") {
    body.prompt = drawing.prompt;
  }
  body.response_format = drawing.want.toLowerCase() === "url" ? "url" : "b64_json";
  const size = arkSize(drawing.size);
  if (size !== "") {
    body.size = size;
  }
  const format = drawing.format.toLowerCase();
  if (format === "png" || format === "jpeg") {
    body.output_format = format;
  } else if (format === "jpg") {
    body.output_format = "jpeg";
  }
  if (drawing.background.toLowerCase() === "transparent") {
    body.background = "transparent";
  }
  if (drawing.images.length === 1) {
    body.image = drawing.images[0];
  } else if (drawing.images.length > 1) {
    body.image = drawing.images;
  }
  return body;
}

function arkSize(size: string): string {
  if (size === "" || size.toLowerCase() === "auto") {
    return "";
  }
  if (!size.includes(":")) {
    return size;
  }
  const mapped = ARK_RATIO_SIZES[size.replaceAll(" ", "")];
  if (mapped !== undefined) {
    return mapped;
  }
  throw new DrawInputError(
    400,
    `Volcengine's images API takes no aspect ratio as size, and ${JSON.stringify(size)} isn't one it maps to a size (it can: 1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9): describe the ratio in the prompt and leave size out, or give WIDTHxHEIGHT (e.g. 2048x2048)`,
  );
}

/* ------------------------------------------------------------- WorkBuddy */

async function drawWorkBuddy(context: DrawContext): Promise<Drawn> {
  const { drawing } = context;
  const gpt = context.model.toLowerCase().includes("gpt-image");
  const body: Record<string, unknown> = {
    model: context.model,
    prompt: drawing.prompt,
    n: drawing.n,
  };
  if (drawing.size !== "" && (gpt || drawing.size.toLowerCase() !== "auto")) {
    body.size = drawing.size;
  }
  if (gpt) {
    for (const [key, value] of [
      ["quality", drawing.quality],
      ["background", drawing.background],
      ["output_format", drawing.format],
    ] as const) {
      if (value !== "") {
        body[key] = value;
      }
    }
    body.response_format = "b64_json";
  }
  let url = `${context.base}/images/generations`;
  if (drawing.images.length > 0) {
    body.image = drawing.images;
    if (gpt && drawing.mask !== undefined) {
      body.mask = drawing.mask;
    }
    url = `${context.base}/images/edits`;
  }
  const answer = await sendJson(context, url, body);
  if (answer.status < 200 || answer.status >= 300) {
    throw new VendorError(answer.status, `WorkBuddy: ${answer.status} ${answer.message}`);
  }
  const unwrapped = workBuddyAnswer(answer.json);
  return readImagesAnswer(unwrapped, answer.text, "WorkBuddy");
}

/** WorkBuddy wraps OpenAI's answer in {code, msg, data}. */
function workBuddyAnswer(value: unknown): unknown {
  if (!isRecord(value) || value.code === undefined) {
    return value;
  }
  const code =
    typeof value.code === "string" || typeof value.code === "number" ? String(value.code) : "";
  if (code !== "" && code !== "0" && code !== "null") {
    throw new VendorError(502, `WorkBuddy: ${stringOf(value.msg) || "error"} (${code})`);
  }
  return value.data ?? value;
}

/* ---------------------------------------------------------- OpenRouter */

async function drawOpenRouter(context: DrawContext): Promise<Drawn> {
  const { drawing } = context;
  if (drawing.mask !== undefined) {
    throw new DrawInputError(400, "OpenRouter's images API does not support mask edits");
  }
  const body: Record<string, unknown> = {
    model: context.model,
    prompt: drawing.prompt,
    n: drawing.n,
  };
  addImageFields(body, drawing);
  if (drawing.images.length > 0) {
    body.input_references = drawing.images.map((url) => ({
      type: "image_url",
      image_url: { url },
    }));
  }
  return answerOf(await sendJson(context, `${context.base}/images`, body), "OpenRouter");
}

function addImageFields(body: Record<string, unknown>, drawing: Drawing): void {
  const fields: Array<[string, string]> = [
    ["size", drawing.size],
    ["quality", drawing.quality],
    ["background", drawing.background],
    ["output_format", drawing.format],
  ];
  for (const [key, value] of fields) {
    if (value !== "") {
      body[key] = value;
    }
  }
}

/* ---------------------------------------------------------------- Grok */

async function drawGrok(context: DrawContext): Promise<Drawn> {
  const { drawing } = context;
  const body: Record<string, unknown> = {
    model: context.model,
    prompt: drawing.prompt,
    n: drawing.n,
    response_format: "b64_json",
  };
  const aspect = aspectAmong(drawing.size, GROK_ASPECTS);
  if (aspect !== "") {
    body.aspect_ratio = aspect;
  }
  let url = `${context.base}/images/generations`;
  if (drawing.images.length > 0) {
    body.images = drawing.images.map((reference) => ({ url: reference, type: "image_url" }));
    url = `${context.base}/images/edits`;
  }
  return answerOf(await sendJson(context, url, body), "Grok");
}

/* ------------------------------------------------------------- Copilot */

async function drawCopilot(context: DrawContext): Promise<Drawn> {
  const { drawing } = context;
  const body: Record<string, unknown> = {
    model: context.model,
    prompt: drawing.prompt,
    n: drawing.n,
  };
  if (drawing.size !== "") {
    body.size = drawing.size;
  }
  if (drawing.quality !== "") {
    body.quality = drawing.quality;
  }
  const url = `${context.base}/images/generations`;
  return answerOf(await sendJson(context, url, body), "Copilot");
}

/* -------------------------------------------------------------- Gemini */

async function drawGemini(context: DrawContext): Promise<Drawn> {
  const parts: Array<Record<string, unknown>> = [{ text: drawPrompt(context.drawing) }];
  for (const reference of context.drawing.images) {
    const image = await inlineImage(reference, context);
    if (image === null) {
      throw new DrawInputError(
        400,
        `Gemini can't draw from ${reference}: it takes its images from a public address or this gateway's own`,
      );
    }
    parts.push({ inlineData: { mimeType: image.mime, data: image.data.toString("base64") } });
  }
  const config: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  const aspect = aspectAmong(context.drawing.size, ASPECTS);
  if (aspect !== "") {
    config.imageConfig = { aspectRatio: aspect };
  }
  const base = context.base.replace(/\/openai$/, "");
  const url = `${base}/models/${encodeURIComponent(context.model)}:generateContent`;
  const answers = await Promise.all(
    Array.from({ length: context.drawing.n }, () =>
      sendJson(context, url, { contents: [{ role: "user", parts }], generationConfig: config }),
    ),
  );
  const out: Drawn = { images: [] };
  for (const answer of answers) {
    if (answer.status < 200 || answer.status >= 300) {
      throw new VendorError(answer.status, `Gemini: ${answer.status} ${answer.message}`);
    }
    collectGemini(answer.json, out);
  }
  if (out.images.length === 0) {
    throw new VendorError(502, "Gemini drew nothing");
  }
  return out;
}

function collectGemini(value: unknown, out: Drawn): void {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    return;
  }
  for (const candidate of value.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content)) {
      continue;
    }
    const parts = candidate.content.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (!isRecord(part) || part.thought === true) {
        continue;
      }
      if (isRecord(part.inlineData) && typeof part.inlineData.data === "string") {
        out.images.push({
          data: Buffer.from(part.inlineData.data, "base64"),
          mime: stringOf(part.inlineData.mimeType) || "image/png",
        });
      } else if (typeof part.text === "string" && part.text !== "") {
        out.text = `${out.text ?? ""}${part.text}`;
      }
    }
  }
}

/* ---------------------------------------------------------------- chat */

async function drawChat(context: DrawContext): Promise<Drawn> {
  const { drawing } = context;
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: drawPrompt(drawing) },
    ...drawing.images.map((reference) => ({
      type: "image_url",
      image_url: { url: reference },
    })),
  ];
  const body: Record<string, unknown> = {
    model: context.model,
    stream: false,
    modalities: ["image", "text"],
    messages: [{ role: "user", content }],
  };
  const aspect = aspectAmong(drawing.size, ASPECTS);
  if (aspect !== "") {
    body.image_config = { aspect_ratio: aspect };
  }
  const url = `${context.base}/chat/completions`;
  const answers = await Promise.all(
    Array.from({ length: drawing.n }, () => sendJson(context, url, body)),
  );
  const out: Drawn = { images: [] };
  for (const answer of answers) {
    if (answer.status < 200 || answer.status >= 300) {
      throw new VendorError(answer.status, `the chat API: ${answer.status} ${answer.message}`);
    }
    collectChat(answer.json, out);
  }
  if (out.images.length === 0) {
    throw new VendorError(502, `the chat model drew nothing${saidOf(out.text ?? "")}`);
  }
  return out;
}

function collectChat(value: unknown, out: Drawn): void {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    return;
  }
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) {
      continue;
    }
    const message = choice.message;
    if (Array.isArray(message.images)) {
      for (const image of message.images) {
        if (
          isRecord(image) &&
          isRecord(image.image_url) &&
          typeof image.image_url.url === "string"
        ) {
          pushSource(image.image_url.url, out);
        }
      }
    }
    if (Array.isArray(message.multi_mod_content)) {
      for (const part of message.multi_mod_content) {
        if (
          isRecord(part) &&
          isRecord(part.inline_data) &&
          typeof part.inline_data.data === "string"
        ) {
          out.images.push({
            data: Buffer.from(part.inline_data.data, "base64"),
            mime: stringOf(part.inline_data.mime_type) || "image/png",
          });
        }
      }
    }
    collectChatContent(message.content, out);
  }
}

function collectChatContent(content: unknown, out: Drawn): void {
  if (typeof content === "string") {
    out.text = `${out.text ?? ""}${content}`;
    for (const match of content.matchAll(/\(data:image\/([a-z0-9+.-]+);base64,([^)]+)\)/gi)) {
      out.images.push({
        data: Buffer.from(match[2] ?? "", "base64"),
        mime: `image/${match[1] ?? "png"}`,
      });
    }
    return;
  }
  if (!Array.isArray(content)) {
    return;
  }
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    if (typeof part.text === "string") {
      out.text = `${out.text ?? ""}${part.text}`;
    }
    if (typeof part.image_url === "string") {
      pushSource(part.image_url, out);
    } else if (isRecord(part.image_url) && typeof part.image_url.url === "string") {
      pushSource(part.image_url.url, out);
    }
  }
}

/** A chat answer's image: its URL, or the bytes behind a data URL. */
function pushSource(source: string, out: Drawn): void {
  const data = parseDataUrl(source);
  if (data === null) {
    out.images.push({ url: source });
    return;
  }
  out.images.push(data);
}

function parseDataUrl(source: string): { data: Buffer; mime: string } | null {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(source);
  if (match === null) {
    return null;
  }
  return { mime: match[1] ?? "image/png", data: Buffer.from(match[2] ?? "", "base64") };
}

/** An image a vendor is sent inline: a data URL, or a fetchable address. */
async function inlineImage(
  reference: string,
  context: DrawContext,
): Promise<{ data: Buffer; mime: string } | null> {
  const data = parseDataUrl(reference);
  if (data !== null) {
    return data;
  }
  return fetchDrawnImage(reference, context);
}

function drawPrompt(drawing: Drawing): string {
  let prompt = drawing.prompt;
  const aspect = aspectAmong(drawing.size, ASPECTS);
  if (aspect !== "") {
    prompt += `\n\nAspect ratio: ${aspect}.`;
  }
  if (drawing.background.toLowerCase() === "transparent") {
    prompt += " Transparent background.";
  }
  return prompt;
}

/** A size as the nearest of the ratios a model takes; a ratio passes through. */
function aspectAmong(size: string, ratios: readonly string[]): string {
  const trimmed = size.trim().toLowerCase();
  if (trimmed === "" || trimmed === "auto") {
    return "";
  }
  const cut = trimmed.indexOf("x");
  if (cut < 0) {
    return trimmed.includes(":") ? trimmed : "";
  }
  const width = Number(trimmed.slice(0, cut));
  const height = Number(trimmed.slice(cut + 1));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "";
  }
  let best = "";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of ratios) {
    const [left, right] = ratio.split(":");
    const distance = Math.abs(Math.log(width / height) - Math.log(Number(left) / Number(right)));
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

/** A vendor's answer when it went well, as images; its refusal otherwise. */
function answerOf(answer: VendorAnswer, vendor: string): Drawn {
  if (answer.status < 200 || answer.status >= 300) {
    throw new VendorError(answer.status, `${vendor}: ${answer.status} ${answer.message}`);
  }
  return readImagesAnswer(answer.json, answer.text, vendor);
}

/* ------------------------------------------------------------- the answer */

/** OpenAI's answer, from what a vendor gave: its URL, or its bytes. */
function readImagesAnswer(value: unknown, text: string, vendor: string): Drawn {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new VendorError(502, `${vendor}'s answer isn't an images API's: ${text.slice(0, 300)}`);
  }
  const out: Drawn = { images: [] };
  for (const entry of value.data) {
    if (!isRecord(entry)) {
      continue;
    }
    const revised = stringOf(entry.revised_prompt);
    if (revised !== "") {
      out.revised = revised;
    }
    const b64 = stringOf(entry.b64_json);
    if (b64 !== "") {
      const data = Buffer.from(b64, "base64");
      out.images.push({ data, mime: stringOf(entry.media_type) || "image/png" });
      continue;
    }
    const url = stringOf(entry.url);
    if (url !== "") {
      out.images.push({ url });
    }
  }
  if (out.images.length === 0) {
    throw new VendorError(502, `${vendor} drew nothing${saidOf(text.slice(0, 300))}`);
  }
  return out;
}

async function openAiAnswer(context: DrawContext, drawn: Drawn): Promise<Response> {
  const inline = context.drawing.want.toLowerCase() === "b64_json";
  const data: Array<Record<string, unknown>> = [];
  for (const image of drawn.images) {
    let url = image.url ?? "";
    let bytes = image.data;
    let mime = image.mime ?? "";
    if (url !== "" && inline) {
      const fetched = await fetchDrawnImage(url, context);
      if (fetched !== null) {
        bytes = fetched.data;
        mime = fetched.mime;
        url = "";
      }
    }
    const entry: Record<string, unknown> = {};
    if (url !== "") {
      entry.url = url;
    } else {
      entry.b64_json = (bytes ?? Buffer.alloc(0)).toString("base64");
      entry.mime_type = mime === "" ? "image/png" : mime;
    }
    if (drawn.revised !== undefined) {
      entry.revised_prompt = drawn.revised;
    }
    data.push(entry);
  }
  const payload: Record<string, unknown> = {
    created: Math.floor(Date.now() / 1000),
    model: `${context.provider.id}/${context.model}`,
    data,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  const said = (drawn.text ?? "").trim();
  if (said !== "") {
    payload.text = said;
  }
  return jsonResponse(200, payload);
}

/**
 * A vendor's image URL, fetched only when it is public, or on the vendor's
 * own host: the URL comes from an upstream answer.
 */
async function fetchDrawnImage(
  url: string,
  context: DrawContext,
): Promise<{ data: Buffer; mime: string } | null> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return null;
  }
  if (target.hostname !== hostOf(context.base)) {
    try {
      const addresses = await lookup(target.hostname, { all: true });
      if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) {
        return null;
      }
    } catch {
      return null;
    }
  }
  try {
    const response = await context.fetchImpl(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(context.timing.waitMs),
    });
    if (!response.ok) {
      return null;
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
      return null;
    }
    return { data, mime: response.headers.get("content-type") ?? "image/png" };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- transport */

interface VendorAnswer {
  status: number;
  text: string;
  message: string;
  json: unknown;
}

async function sendJson(
  context: DrawContext,
  url: string,
  body: Record<string, unknown> | undefined,
  extraHeaders: Record<string, string> = {},
  method: "POST" | "GET" = "POST",
): Promise<VendorAnswer> {
  const headers = buildUpstreamHeaders(context.provider, context.account, {});
  headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(extraHeaders)) {
    headers.set(name, value);
  }
  let response: globalThis.Response;
  try {
    response = await context.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(context.timing.waitMs),
    });
  } catch (error) {
    throw new VendorError(502, `${hostOf(url)} couldn't be reached: ${errorMessage(error)}`);
  }
  const text = await response.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text === "" ? null : JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    text,
    message: messageOf(json, text),
    json,
  };
}

function messageOf(value: unknown, text: string): string {
  if (isRecord(value)) {
    const error = value.error;
    if (isRecord(error) && typeof error.message === "string") {
      return error.message;
    }
    if (typeof error === "string" && error !== "") {
      return error;
    }
    if (typeof value.message === "string" && value.message !== "") {
      return value.message;
    }
    if (typeof value.msg === "string" && value.msg !== "") {
      return value.msg;
    }
  }
  return text.slice(0, 300);
}

class VendorError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VendorError";
    this.status = status;
  }
}

function errorResponse(status: number, message: string, type: string): Response {
  return jsonResponse(status, { error: { message, type } });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function saidOf(text: string): string {
  const said = text.trim();
  return said === "" ? "" : `: ${said.length > 300 ? `${said.slice(0, 300)}…` : said}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
