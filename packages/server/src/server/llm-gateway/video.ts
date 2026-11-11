import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import { planAccounts, type AccountRoutingState } from "./accounts.js";
import {
  allowsAccount,
  checkAccess,
  resolvePrincipal,
  type AccessDenial,
  type GatewayPrincipal,
  type RateLimiter,
} from "./access.js";
import { reserveBudget, type Reservation } from "./budget.js";
import { listGatewayModels, resolveGatewayCandidates } from "./catalog.js";
import {
  providerAccounts,
  type GatewayAccount,
  type GatewayConfig,
  type GatewayConfigStore,
  type GatewayModel,
  type GatewayProvider,
  isProviderEnabled,
} from "./config.js";
import { buildUpstreamHeaders } from "./upstream.js";
import type { UsageLedger } from "./usage.js";

/**
 * OpenAI's Videos API, as myna serves it: POST /v1/videos starts a video and
 * answers with its id; GET /v1/videos/{id} says how it is going;
 * GET /v1/videos/{id}/content sends its bytes. The id names the provider and
 * the vendor's id, so the gateway keeps no state between calls:
 * `video_<provider>.<vendor id>.<started>.<account mark>`.
 */

const MAX_VIDEO_BYTES = 512 << 20;
const VIDEO_TIMEOUT_MS = 5 * 60_000;

export const GROK_VIDEO_MODELS: GatewayModel[] = [
  { id: "grok-imagine-video", label: "Grok Imagine Video" },
  { id: "grok-imagine-video-1.5", label: "Grok Imagine Video 1.5" },
];
const GROK_VIDEO_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const GROK_VIDEO_FAMILY = "grok-imagine-video";

export const MINIMAX_VIDEO_MODELS: GatewayModel[] = [
  { id: "MiniMax-H3", label: "MiniMax H3" },
  { id: "MiniMax-H3-Highspeed", label: "MiniMax H3 Highspeed" },
  { id: "MiniMax-H3-Lite", label: "MiniMax H3 Lite" },
  { id: "MiniMax-H3-Max", label: "MiniMax H3 Max" },
];

const MINIMAX_VIDEO_LIMITS: Record<string, { resolutions: string[]; minSeconds: number }> = {
  "MiniMax-H3": { resolutions: ["768P", "2K"], minSeconds: 4 },
  "MiniMax-H3-Highspeed": { resolutions: ["768P"], minSeconds: 4 },
  "MiniMax-H3-Lite": { resolutions: ["768P", "480P"], minSeconds: 4 },
  "MiniMax-H3-Max": { resolutions: ["768P", "480P"], minSeconds: 5 },
};
const MINIMAX_VIDEO_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

const MINIMAX_HOSTS = new Set(["api.minimax.io", "api.minimaxi.com", "api.minimax.cn"]);

const ARK_VIDEO_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9"];
const ARK_VIDEO_TIERS: ReadonlyArray<{ name: string; pixels: number }> = [
  { name: "480p", pixels: 864 * 480 },
  { name: "720p", pixels: 1280 * 720 },
  { name: "1080p", pixels: 1920 * 1080 },
  { name: "4k", pixels: 3840 * 2160 },
];
const ARK_TEXT_FIELDS = new Set([
  "model",
  "ratio",
  "resolution",
  "safety_identifier",
  "callback_url",
  "service_tier",
  "output_format",
  "omni_reference_task_type",
]);
const ARK_OWN_FIELDS = new Set([
  "id",
  "object",
  "model",
  "status",
  "progress",
  "created_at",
  "updated_at",
  "error",
  "prompt",
  "size",
  "seconds",
]);

type VideoMechanism = "grok" | "ark" | "minimax" | "custom";

interface ResolvedVideoModel {
  provider: GatewayProvider;
  model: GatewayModel;
  mechanism: VideoMechanism;
}

interface Filming {
  model: string;
  prompt: string;
  seconds: string;
  size: string;
  start?: string;
  end?: string;
  references: string[];
  extra: Record<string, unknown>;
  form: boolean;
}

class VideoInputError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VideoInputError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ models */

function isArkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host.includes("volces.com") || host.includes("volcengine") || host.includes("ark.cn-");
}

export function providerBase(provider: GatewayProvider, account?: GatewayAccount): string {
  return (account?.baseUrl ?? provider.baseUrl).replace(/\/+$/, "");
}

function providerHost(provider: GatewayProvider, account?: GatewayAccount): string {
  try {
    return new URL(providerBase(provider, account)).hostname;
  } catch {
    return "";
  }
}

type VideoApi = "openai" | "ark" | "minimax" | "grok";

/** The video API a provider speaks: named, or read from its host. */
function videoApiFor(provider: GatewayProvider, account?: GatewayAccount): VideoApi {
  if (provider.videoApi !== undefined) {
    return provider.videoApi;
  }
  const host = providerHost(provider, account).toLowerCase();
  if (MINIMAX_HOSTS.has(host)) {
    return "minimax";
  }
  if (host.includes("grok.com") || provider.id.startsWith("grok")) {
    return "grok";
  }
  if (isArkHost(host)) {
    return "ark";
  }
  return "openai";
}

function isMiniMaxProvider(provider: GatewayProvider, account?: GatewayAccount): boolean {
  return videoApiFor(provider, account) === "minimax";
}

function isGrokProvider(provider: GatewayProvider, account?: GatewayAccount): boolean {
  return videoApiFor(provider, account) === "grok";
}

function isArkProvider(provider: GatewayProvider, account?: GatewayAccount): boolean {
  return videoApiFor(provider, account) === "ark";
}

function isMiniMaxModel(model: GatewayModel): boolean {
  return MINIMAX_VIDEO_MODELS.some((entry) => entry.id === model.id);
}

function isGrokVideoModel(model: GatewayModel): boolean {
  return model.id.startsWith(GROK_VIDEO_FAMILY);
}

function isArkVideoModel(model: GatewayModel): boolean {
  return model.kind === "video" || /seedance/i.test(model.id);
}

/** The models a provider makes videos with, whichever vendor API it speaks. */
export function videoModelsOf(provider: GatewayProvider): GatewayModel[] {
  if (isMiniMaxProvider(provider)) {
    return MINIMAX_VIDEO_MODELS;
  }
  if (isGrokProvider(provider)) {
    const listed = provider.models.filter(isGrokVideoModel);
    return listed.length > 0 ? listed : GROK_VIDEO_MODELS;
  }
  if (isArkProvider(provider)) {
    return provider.models.filter(isArkVideoModel);
  }
  return provider.models.filter((model) => model.kind === "video");
}

function mechanismOf(provider: GatewayProvider, model: GatewayModel): VideoMechanism | null {
  if (isMiniMaxProvider(provider)) {
    return isMiniMaxModel(model) || model.kind === "video" ? "minimax" : null;
  }
  if (isGrokProvider(provider)) {
    return isGrokVideoModel(model) || model.kind === "video" ? "grok" : null;
  }
  if (isArkProvider(provider)) {
    return isArkVideoModel(model) ? "ark" : null;
  }
  return model.kind === "video" ? "custom" : null;
}

function autoVideoModel(config: GatewayConfig): ResolvedVideoModel | null {
  let paid: ResolvedVideoModel | null = null;
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    const models = videoModelsOf(provider);
    if (models.length === 0) {
      continue;
    }
    const candidate: ResolvedVideoModel = { provider, model: models[0]!, mechanism: "custom" };
    const mechanism = mechanismOf(provider, models[0]!);
    if (mechanism === null) {
      continue;
    }
    candidate.mechanism = mechanism;
    if (mechanism === "minimax") {
      paid ??= candidate;
      continue;
    }
    return candidate;
  }
  return paid;
}

function findProviderModel(config: GatewayConfig, requested: string): ResolvedVideoModel | null {
  for (const provider of config.providers) {
    if (!isProviderEnabled(provider)) {
      continue;
    }
    const models = videoModelsOf(provider);
    for (const model of models) {
      const mechanism = mechanismOf(provider, model);
      if (mechanism === null) {
        continue;
      }
      if (requested === model.id || requested === `${provider.id}/${model.id}`) {
        return { provider, model, mechanism };
      }
    }
    if (
      isGrokProvider(provider) &&
      requested.startsWith(GROK_VIDEO_FAMILY) &&
      !requested.includes("/")
    ) {
      return {
        provider,
        model: { id: requested },
        mechanism: "grok",
      };
    }
  }
  return null;
}

function resolveVideoModel(
  config: GatewayConfig,
  requested: string,
): { resolved: ResolvedVideoModel } | { known: true } | { known: false } {
  const direct = findProviderModel(config, requested);
  if (direct !== null) {
    return { resolved: direct };
  }
  try {
    const candidates = resolveGatewayCandidates(config, requested);
    if (candidates.length > 0) {
      return { known: true };
    }
  } catch {
    // The model is not in the catalog either.
  }
  const known = listGatewayModels(config).some((entry) => entry.id === requested);
  return { known };
}

/* --------------------------------------------------------------- reading */

const FILMING_READ = new Set([
  "model",
  "prompt",
  "seconds",
  "size",
  "input_reference",
  "last_frame",
  "reference_images",
  "reference_images[]",
]);

function readFilming(body: Buffer, contentType: string): Filming {
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (media === "multipart/form-data") {
    return readFormFilming(body, contentType);
  }
  return readJsonFilming(body);
}

function secondsText(raw: unknown): string {
  if (typeof raw === "number") {
    return String(raw);
  }
  return typeof raw === "string" ? raw.trim() : "";
}

function readJsonFilming(body: Buffer): Filming {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new VideoInputError(400, "the request isn't JSON");
  }
  if (!isRecord(parsed)) {
    throw new VideoInputError(400, "the request isn't a video's");
  }
  const prompt = typeof parsed.prompt === "string" ? parsed.prompt : "";
  const size = typeof parsed.size === "string" ? parsed.size : "";
  const seconds = secondsText(parsed.seconds);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!FILMING_READ.has(key)) {
      extra[key] = value;
    }
  }
  const starts = imageSources(parsed.input_reference);
  const ends = imageSources(parsed.last_frame);
  const refs = imageSources(parsed.reference_images);
  const filming: Filming = {
    model: typeof parsed.model === "string" ? parsed.model.trim() : "",
    prompt,
    seconds,
    size,
    references: refs.map(filmPictureOf),
    extra,
    form: false,
  };
  if (starts.length > 0) {
    filming.start = filmPictureOf(starts[0]!);
  }
  if (ends.length > 0) {
    filming.end = filmPictureOf(ends[0]!);
  }
  return validateFilming(filming);
}

interface FormPart {
  name: string;
  filename: string | null;
  contentType: string;
  data: Buffer;
}

function readFormFilming(body: Buffer, contentType: string): Filming {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (boundary === undefined) {
    throw new VideoInputError(400, "the multipart request has no boundary");
  }
  const parts = parseMultipart(body, boundary);
  const values = new Map<string, string>();
  const files = new Map<string, FormPart[]>();
  for (const part of parts) {
    if (part.filename !== null) {
      const list = files.get(part.name) ?? [];
      list.push(part);
      files.set(part.name, list);
    } else {
      values.set(part.name, part.data.toString("utf8").trim());
    }
  }
  const value = (name: string): string => values.get(name) ?? "";
  const extra: Record<string, unknown> = {};
  for (const [key, text] of values) {
    if (!FILMING_READ.has(key)) {
      extra[key] = text;
    }
  }
  const asPicture = (part: FormPart | undefined): string | undefined => {
    if (part === undefined) {
      return undefined;
    }
    const type =
      part.contentType === "" || part.contentType === "application/octet-stream"
        ? sniffMediaType(part.data)
        : part.contentType;
    return `data:${type};base64,${part.data.toString("base64")}`;
  };
  const refs: string[] = [];
  for (const name of ["reference_images", "reference_images[]"]) {
    for (const part of files.get(name) ?? []) {
      refs.push(asPicture(part) as string);
    }
  }
  const filming: Filming = {
    model: value("model").trim(),
    prompt: value("prompt"),
    seconds: value("seconds"),
    size: value("size"),
    form: true,
    extra,
    references: refs,
  };
  const start = asPicture(files.get("input_reference")?.[0]);
  if (start !== undefined) {
    filming.start = start;
  }
  const end = asPicture(files.get("last_frame")?.[0]);
  if (end !== undefined) {
    filming.end = end;
  }
  return validateFilming(filming);
}

function parseMultipart(body: Buffer, boundary: string): FormPart[] {
  const delimiter = `--${boundary}`;
  const parts: FormPart[] = [];
  let at = body.indexOf(delimiter);
  while (at >= 0) {
    let start = at + delimiter.length;
    if (body[start] === 45 && body[start + 1] === 45) {
      break;
    }
    if (body[start] === 13 && body[start + 1] === 10) {
      start += 2;
    }
    const headerEnd = body.indexOf("\r\n\r\n", start);
    if (headerEnd < 0) {
      break;
    }
    const next = body.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (next < 0) {
      break;
    }
    const headers = parsePartHeaders(body.subarray(start, headerEnd).toString("latin1"));
    const disposition = headers["content-disposition"] ?? "";
    const name = /name="([^"]*)"/.exec(disposition)?.[1];
    if (name !== undefined) {
      parts.push({
        name,
        filename: /filename="([^"]*)"/.exec(disposition)?.[1] ?? null,
        contentType: (headers["content-type"] ?? "").trim(),
        data: body.subarray(headerEnd + 4, next),
      });
    }
    at = next + 2;
  }
  return parts;
}

function parsePartHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return headers;
}

function sniffMediaType(data: Buffer): string {
  if (
    data.length >= 4 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("latin1") === "GIF8") {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("latin1") === "RIFF" &&
    data.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (data.length >= 12 && data.subarray(4, 8).toString("latin1") === "ftyp") {
    return data.subarray(8, 12).toString("latin1") === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return "application/octet-stream";
}

function imageSources(raw: unknown): string[] {
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.flatMap(imageSources);
  }
  if (isRecord(raw)) {
    if (typeof raw.url === "string") {
      return [raw.url];
    }
    if (raw.image_url !== undefined) {
      return imageSources(raw.image_url);
    }
    if (typeof raw.data === "string") {
      const media = typeof raw.media_type === "string" ? raw.media_type : "image/png";
      return [raw.data.startsWith("data:") ? raw.data : `data:${media};base64,${raw.data}`];
    }
  }
  return [];
}

function filmPictureOf(source: string): string {
  const trimmed = source.trim();
  if (trimmed.startsWith("asset://")) {
    return trimmed;
  }
  return pictureOf(trimmed);
}

function pictureOf(source: string): string {
  if (source.startsWith("data:")) {
    const comma = source.indexOf(",");
    const meta = comma < 0 ? "" : source.slice(5, comma);
    if (comma < 0 || !meta.endsWith(";base64")) {
      throw new VideoInputError(400, "an image's data: URL must be base64");
    }
    const data = source.slice(comma + 1);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new VideoInputError(400, "an image's data: URL isn't base64");
    }
    return source;
  }
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return source;
  }
  throw new VideoInputError(400, "an image is a data: or http(s) URL");
}

function validateFilming(filming: Filming): Filming {
  if (
    filming.prompt.trim().length === 0 &&
    filming.start === undefined &&
    filming.end === undefined &&
    filming.references.length === 0 &&
    !hasArkContent(filming)
  ) {
    throw new VideoInputError(400, "say what to film in prompt");
  }
  if (filming.seconds === "-1") {
    return filming;
  }
  if (filming.seconds !== "") {
    filming.seconds = String(parseSeconds(filming.seconds));
  }
  return filming;
}

function hasArkContent(filming: Filming): boolean {
  let content = filming.extra.content;
  if (filming.form && typeof content === "string") {
    content = formValue("content", content, new Set());
  }
  return Array.isArray(content) && content.length > 0;
}

/* -------------------------------------------------------------- validation */

const DECIMAL_NUMBER = /^[0-9]+(\.[0-9]*)?([eE][+-]?[0-9]+)?$/;

function parseSeconds(value: string): number {
  if (DECIMAL_NUMBER.test(value)) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 2_147_483_647) {
      return parsed;
    }
  }
  throw new VideoInputError(
    400,
    `seconds is a whole number of at least 1, not ${JSON.stringify(value)}`,
  );
}

function arkOnlyReason(filming: Filming, mechanism: VideoMechanism): string | null {
  if (filming.seconds === "-1" && mechanism !== "ark") {
    return "seconds -1 (the model picks the length) is Volcengine Ark's alone";
  }
  if (filming.prompt.trim().length === 0 && mechanism !== "ark") {
    return "say what to film in prompt (only Volcengine Ark's Seedance films an image with no prompt)";
  }
  const pictures = [filming.start, filming.end, ...filming.references];
  if (
    mechanism !== "ark" &&
    pictures.some((picture) => picture !== undefined && picture.startsWith("asset://"))
  ) {
    return "an asset:// image is in Volcengine Ark's asset library, which only Ark's Seedance reads";
  }
  return null;
}

function aspectAmong(size: string, aspects: readonly string[]): string {
  const value = size.toLowerCase().trim();
  if (aspects.includes(value)) {
    return value;
  }
  const [widthText, heightText] = value.split("x");
  if (widthText === undefined || heightText === undefined) {
    return "";
  }
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "";
  }
  const wanted = width / height;
  let best = "";
  let distance = Number.POSITIVE_INFINITY;
  for (const aspect of aspects) {
    const [aspectWidth, aspectHeight] = aspect.split(":").map(Number);
    if (aspectWidth === undefined || aspectHeight === undefined) {
      continue;
    }
    const delta = Math.abs(Math.log(wanted / (aspectWidth / aspectHeight)));
    if (delta < distance) {
      distance = delta;
      best = aspect;
    }
  }
  return best;
}

function pixelResolution(size: string): string {
  const [widthText, heightText] = size.toLowerCase().trim().split("x");
  if (widthText === undefined || heightText === undefined) {
    return "";
  }
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "";
  }
  const short = Math.min(width, height);
  if (short >= 1080) {
    return "1080p";
  }
  if (short >= 720) {
    return "720p";
  }
  return "480p";
}

function videoResolution(model: string, size: string): string {
  const resolution = pixelResolution(size);
  if (resolution === "1080p" && model === "grok-imagine-video") {
    return "720p";
  }
  return resolution;
}

function arkVideoSize(size: string): { resolution: string; ratio: string } {
  const value = size.toLowerCase().trim();
  for (const tier of ARK_VIDEO_TIERS) {
    if (value === tier.name || (tier.name === "4k" && value === "2160p")) {
      return { resolution: tier.name, ratio: "" };
    }
  }
  if (value.includes(":")) {
    const [width, height] = value.split(":");
    return { resolution: "", ratio: aspectAmong(`${width}x${height}`, ARK_VIDEO_RATIOS) };
  }
  const [widthText, heightText] = value.split("x");
  if (widthText === undefined || heightText === undefined) {
    return { resolution: "", ratio: "" };
  }
  const width = Number(widthText);
  const height = Number(heightText);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { resolution: "", ratio: "" };
  }
  let resolution = "";
  let best = Number.POSITIVE_INFINITY;
  for (const tier of ARK_VIDEO_TIERS) {
    const delta = Math.abs(Math.log((width * height) / tier.pixels));
    if (delta < best) {
      best = delta;
      resolution = tier.name;
    }
  }
  return { resolution, ratio: aspectAmong(value, ARK_VIDEO_RATIOS) };
}

/* -------------------------------------------------------------- request bodies */

function formValue(key: string, value: unknown, textFields: ReadonlySet<string>): unknown {
  if (typeof value !== "string" || textFields.has(key)) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "boolean" ||
      typeof parsed === "number" ||
      Array.isArray(parsed) ||
      (typeof parsed === "object" && parsed !== null)
    ) {
      return parsed;
    }
  } catch {
    // A plain word stays text.
  }
  return value;
}

function customVideoBody(model: string, filming: Filming): string {
  const body: Record<string, unknown> = { ...filming.extra };
  body.model = model;
  body.prompt = filming.prompt;
  if (filming.seconds !== "") {
    body.seconds = filming.seconds;
  }
  if (filming.size !== "") {
    body.size = filming.size;
  }
  if (filming.start !== undefined) {
    body.input_reference = filming.start;
  }
  if (filming.end !== undefined) {
    body.last_frame = filming.end;
  }
  if (filming.references.length > 0) {
    body.reference_images = filming.references;
  }
  return JSON.stringify(body);
}

function arkVideoBody(model: string, filming: Filming): string {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filming.extra)) {
    body[key] = filming.form ? formValue(key, value, ARK_TEXT_FIELDS) : value;
  }
  const content = Array.isArray(body.content) ? [...body.content] : [];
  const said = content.some((entry) => isRecord(entry) && entry.type === "text");
  if (filming.prompt !== "" && !said) {
    content.unshift({ type: "text", text: filming.prompt });
  }
  const frame = (picture: string | undefined, role: string): void => {
    if (picture !== undefined) {
      content.push({ type: "image_url", image_url: { url: picture }, role });
    }
  };
  frame(filming.start, "first_frame");
  frame(filming.end, "last_frame");
  for (const reference of filming.references) {
    frame(reference, "reference_image");
  }
  body.model = model;
  body.content = content;
  const set = (key: string, value: unknown): void => {
    if (!(key in body)) {
      body[key] = value;
    }
  };
  if (filming.seconds !== "") {
    set("duration", Number(filming.seconds));
  }
  const { resolution, ratio } = arkVideoSize(filming.size);
  if (ratio !== "") {
    set("ratio", ratio);
  }
  if (resolution !== "") {
    set("resolution", resolution);
  }
  return JSON.stringify(body);
}

function grokVideoBody(model: string, filming: Filming): string {
  const body: Record<string, unknown> = { model, prompt: filming.prompt };
  if (filming.seconds !== "") {
    body.duration = parseSeconds(filming.seconds);
  }
  const ratio = aspectAmong(filming.size, GROK_VIDEO_ASPECTS);
  if (ratio !== "") {
    body.aspect_ratio = ratio;
  }
  const resolution = videoResolution(model, filming.size);
  if (resolution !== "") {
    body.resolution = resolution;
  }
  if (filming.start !== undefined) {
    body.image = { url: filming.start };
  }
  if (filming.references.length > 0) {
    body.reference_images = filming.references.map((url) => ({ url }));
  }
  return JSON.stringify(body);
}

function minimaxVideoBody(model: string, filming: Filming): string {
  const limits = MINIMAX_VIDEO_LIMITS[model] ?? MINIMAX_VIDEO_LIMITS["MiniMax-H3"]!;
  const frames = filming.start !== undefined || filming.end !== undefined;
  if (frames && filming.references.length > 0) {
    throw new VideoInputError(
      400,
      "MiniMax makes a video from a first or last frame, or from reference images, not both: send one or the other",
    );
  }
  if (filming.references.length > 9) {
    throw new VideoInputError(
      400,
      `MiniMax takes at most 9 reference images, not ${filming.references.length}`,
    );
  }
  const content: Record<string, unknown>[] = [{ type: "text", text: filming.prompt }];
  const add = (picture: string, role: string): void => {
    content.push({ type: "image_url", image_url: { url: picture }, role });
  };
  if (filming.start !== undefined) {
    add(filming.start, "first_frame");
  }
  if (filming.end !== undefined) {
    add(filming.end, "last_frame");
  }
  for (const reference of filming.references) {
    add(reference, "reference_image");
  }
  let seconds = 5;
  if (filming.seconds !== "") {
    seconds = Number(filming.seconds);
  }
  seconds = Math.min(Math.max(seconds, limits.minSeconds), 15);
  const body: Record<string, unknown> = {
    model,
    content,
    duration: seconds,
    resolution: minimaxResolution(limits.resolutions, filming),
  };
  if (!frames) {
    let ratio = minimaxRatio(filming);
    if (ratio === "" && (filming.references.length === 0 || model === "MiniMax-H3-Lite")) {
      ratio = "16:9";
    }
    if (ratio !== "") {
      body.ratio = ratio;
    }
  }
  const extra = filming.extra.extra;
  if (isRecord(extra) && model === "MiniMax-H3-Max") {
    body.extra = extra;
  }
  return JSON.stringify(body);
}

function minimaxResolution(allowed: string[], filming: Filming): string {
  const named = filming.extra.resolution;
  if (typeof named === "string" && named.trim() !== "") {
    return named.trim().toUpperCase();
  }
  let want = "";
  switch (pixelResolution(filming.size)) {
    case "1080p":
      want = "2K";
      break;
    case "720p":
      want = "768P";
      break;
    case "480p":
      want = "480P";
      break;
  }
  if (allowed.includes(want)) {
    return want;
  }
  if ((want === "2K" || want === "480P") && allowed.includes("768P")) {
    return "768P";
  }
  return allowed[0] ?? "768P";
}

function minimaxRatio(filming: Filming): string {
  let size = filming.size.trim();
  const named = filming.extra.ratio;
  if (typeof named === "string" && named.trim() !== "") {
    size = named.trim();
  }
  if (size.toLowerCase() === "adaptive") {
    return "adaptive";
  }
  if (size.includes(":")) {
    size = size.replace(":", "x");
  }
  return aspectAmong(size, MINIMAX_VIDEO_RATIOS);
}

/* ------------------------------------------------------------------ ids */

const ID_PART = /^[A-Za-z0-9_-]+$/;

function accountMark(account: GatewayAccount | undefined): string {
  if (account === undefined) {
    return "0";
  }
  return `k${account.id.replace(/[^A-Za-z0-9]/g, "-")}`;
}

function encodeVendorId(vendorId: string): string {
  return Buffer.from(vendorId, "utf8").toString("base64url");
}

function decodeVendorId(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

function videoId(input: {
  provider: GatewayProvider;
  vendorId: string;
  started: number;
  account: GatewayAccount | undefined;
  mechanism: VideoMechanism;
}): string {
  const vendor = input.mechanism === "custom" ? encodeVendorId(input.vendorId) : input.vendorId;
  return `video_${input.provider.id}.${vendor}.${Math.floor(input.started / 1000)}.${accountMark(
    input.account,
  )}`;
}

interface ParsedVideoId {
  providerId: string;
  vendorId: string;
  started: number;
  mark: string;
}

function parseVideoId(id: string): ParsedVideoId | null {
  if (!id.startsWith("video_")) {
    return null;
  }
  const parts = id.slice("video_".length).split(".");
  if (parts.length !== 4) {
    return null;
  }
  const [providerId, vendorId, started, mark] = parts;
  if (
    providerId === undefined ||
    vendorId === undefined ||
    started === undefined ||
    mark === undefined ||
    !ID_PART.test(providerId) ||
    !ID_PART.test(vendorId) ||
    !ID_PART.test(mark)
  ) {
    return null;
  }
  const seconds = Number(started);
  if (!Number.isInteger(seconds) || seconds < 0) {
    return null;
  }
  return { providerId, vendorId, started: seconds * 1000, mark };
}

/* ------------------------------------------------------------- vendor calls */

interface VideoState {
  status: string;
  progress: number;
  model: string;
  video: { url: string; duration: number };
  content: { video_url: string };
  duration: number;
  error: { code: string; message: string };
  ark: Record<string, unknown> | null;
}

function emptyState(): VideoState {
  return {
    status: "",
    progress: 0,
    model: "",
    video: { url: "", duration: 0 },
    content: { video_url: "" },
    duration: 0,
    error: { code: "", message: "" },
    ark: null,
  };
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The vendor's answer, read leniently: Grok, Ark and MiniMax each say it differently. */
function readVideoState(payload: unknown, ark: boolean): VideoState {
  const state = emptyState();
  if (!isRecord(payload)) {
    return state;
  }
  state.status = stringField(payload.status);
  state.progress = numberField(payload.progress);
  state.model = stringField(payload.model);
  state.duration = numberField(payload.duration);
  const video = payload.video;
  if (isRecord(video)) {
    state.video.url = stringField(video.url);
    state.video.duration = numberField(video.duration);
  }
  const content = payload.content;
  if (isRecord(content)) {
    state.content.video_url = stringField(content.video_url);
  }
  const error = payload.error;
  if (isRecord(error)) {
    state.error.code =
      typeof error.code === "number" ? String(error.code) : stringField(error.code);
    state.error.message = stringField(error.message);
  }
  if (ark) {
    state.ark = payload;
  }
  return state;
}

function videoObject(input: {
  id: string;
  model: string;
  started: number;
  state: VideoState;
  filming: Filming;
}): Record<string, unknown> {
  const { status, progress } = openAiStatus(input.state);
  const object: Record<string, unknown> = {
    id: input.id,
    object: "video",
    created_at: Math.floor(input.started / 1000),
    status,
    progress,
    model: input.model,
  };
  if (input.filming.prompt !== "") {
    object.prompt = input.filming.prompt;
  }
  if (input.filming.size !== "") {
    object.size = input.filming.size;
  }
  if (input.state.video.duration > 0) {
    object.seconds = String(input.state.video.duration);
  } else if (input.state.duration > 0) {
    object.seconds = String(input.state.duration);
  } else if (input.filming.seconds !== "") {
    object.seconds = input.filming.seconds;
  }
  if (input.state.ark !== null) {
    for (const [key, value] of Object.entries(input.state.ark)) {
      if (!ARK_OWN_FIELDS.has(key)) {
        object[key] = value;
      }
    }
  }
  if (status === "failed") {
    object.error = videoErrorOf(input.state);
  }
  return object;
}

function openAiStatus(state: VideoState): { status: string; progress: number } {
  switch (state.status) {
    case "done":
    case "succeeded":
      return { status: "completed", progress: 100 };
    case "running":
      return { status: "in_progress", progress: state.progress };
    case "failed":
    case "expired":
    case "cancelled":
      return { status: "failed", progress: state.progress };
    default:
      return state.progress > 0
        ? { status: "in_progress", progress: state.progress }
        : { status: "queued", progress: 0 };
  }
}

function videoErrorOf(state: VideoState): { code: string; message: string } {
  if (state.status === "expired") {
    return {
      code: "expired",
      message:
        state.ark === null
          ? "the vendor no longer keeps this video"
          : "the task timed out: Volcengine Ark ended it unfinished once its execution_expires_after had passed",
    };
  }
  if (state.status === "cancelled") {
    return { code: "cancelled", message: "the video was cancelled" };
  }
  return {
    code: state.error.code,
    message: state.error.message === "" ? "the video failed" : state.error.message,
  };
}

function joinPath(base: string, path: string): string {
  const trimmed = base.replace(/\/+$/, "");
  for (const version of ["/v1beta", "/v1"]) {
    if (trimmed.endsWith(version) && path.startsWith(`${version}/`)) {
      return `${trimmed}${path.slice(version.length)}`;
    }
  }
  return `${trimmed}${path}`;
}

function arkTasksUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/contents/generations/tasks`;
}

function minimaxHost(base: string): string {
  const url = new URL(base);
  return `${url.protocol}//${url.host}`;
}

interface VendorCall {
  provider: GatewayProvider;
  account: GatewayAccount | undefined;
  mechanism: VideoMechanism;
  base: string;
}

function mapAccounts(provider: GatewayProvider): GatewayAccount[] {
  return providerAccounts(provider).filter((account) => account.enabled);
}

function accountForMark(provider: GatewayProvider, mark: string): GatewayAccount | undefined {
  return mapAccounts(provider).find((account) => accountMark(account) === mark);
}

async function vendorFetch(
  call: VendorCall,
  url: string,
  init: { method: string; body?: string; acceptRedirect?: boolean },
  fetchImpl: typeof fetch,
): Promise<Response> {
  const headers = buildUpstreamHeaders(call.provider, call.account, {});
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  return fetchImpl(url, {
    method: init.method,
    headers,
    body: init.body,
    redirect: init.acceptRedirect === true ? "follow" : "manual",
    signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
  });
}

function vendorLabel(provider: GatewayProvider): string {
  return provider.label ?? provider.id;
}

async function callBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function vendorMessage(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string") {
        return error.message;
      }
      if (typeof parsed.message === "string") {
        return parsed.message;
      }
      const base = parsed.base_resp;
      if (isRecord(base) && typeof base.status_msg === "string") {
        return base.status_msg;
      }
    }
  } catch {
    // A vendor that answers text gets its text.
  }
  return body.trim().slice(0, 300);
}

const MINIMAX_CODE = /\((\d{3,5})\)\s*$/;

function minimaxSaid(body: string): { message: string; code: string } {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string" && error.message !== "") {
        const code = MINIMAX_CODE.exec(error.message)?.[1] ?? "";
        return { message: error.message, code };
      }
      const base = parsed.base_resp;
      if (isRecord(base) && numberField(base.status_code) !== 0) {
        return {
          message: stringField(base.status_msg),
          code: String(numberField(base.status_code)),
        };
      }
    }
  } catch {
    // Not MiniMax's error shape.
  }
  return { message: "", code: "" };
}

function minimaxWhy(code: string, status: number): string {
  if (code === "1004" || code === "2049" || (code === "" && status === 401)) {
    return "MiniMax turned the API key away: it is wrong, or was deleted. Put a working key in the MiniMax provider";
  }
  if (code === "1008" || (code === "" && status === 402)) {
    return "the MiniMax account is out of balance: H3 videos are paid from the pay-as-you-go balance. Top it up on MiniMax's platform";
  }
  if (code === "1026") {
    return "MiniMax refused the prompt or images as sensitive content: change what the video asks for";
  }
  if (code === "1027") {
    return "MiniMax refused the video it made as sensitive content: change what the video asks for";
  }
  if (code === "2061" || code === "2068" || code === "2057") {
    return "this MiniMax key's plan doesn't make H3 videos: a Token Plan or video package doesn't cover H3; it needs a pay-as-you-go API key";
  }
  if (code === "1002" || code === "1045" || (code === "" && status === 429)) {
    return "MiniMax is making as many videos as this account may at once, or was asked too often: try again shortly";
  }
  return "";
}

/* ----------------------------------------------------------------- errors */

interface VideoFailure {
  status: number;
  message: string;
}

function fail(status: number, message: string): VideoFailure {
  return { status, message };
}

function writeFailure(res: ExpressResponse, failure: VideoFailure): void {
  res.status(failure.status).json({
    error: {
      message: failure.message,
      type: failure.status >= 500 ? "gateway_error" : "invalid_request",
    },
  });
}

/** An access refusal, in the shape chat's checkAccess answers with. */
function writeDenial(res: ExpressResponse, denial: AccessDenial): void {
  if (denial.retryAfterSeconds !== undefined) {
    res.setHeader("Retry-After", String(denial.retryAfterSeconds));
  }
  res.status(denial.status).json({ error: { message: denial.message, type: denial.type } });
}

/* ------------------------------------------------------------------ start */

export interface VideoRouteOptions {
  configStore: GatewayConfigStore;
  ledger: UsageLedger;
  accountState: AccountRoutingState;
  /** The gateway's per-key pace; omitted when called outside the router. */
  rateLimiter?: RateLimiter;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

interface ResolvedCall extends VendorCall {
  model: GatewayModel;
}

function chooseAccount(
  options: VideoRouteOptions,
  principal: GatewayPrincipal,
  provider: GatewayProvider,
  model: GatewayModel,
  now: number,
): GatewayAccount | undefined {
  return planAccounts({
    provider,
    state: options.accountState,
    now,
    modelId: model.id,
  }).find((account) => allowsAccount(principal.accounts ?? [], provider.id, account.id));
}

/** Whether a key may poll a video its provider made with that account. */
function lookupPermission(
  principal: GatewayPrincipal,
  provider: GatewayProvider,
  account: GatewayAccount | undefined,
): string | null {
  if (principal.models.length > 0) {
    const models = [...provider.models, ...videoModelsOf(provider)];
    const allowed = principal.models.some(
      (entry) =>
        entry.toLowerCase() === `${provider.id}/*`.toLowerCase() ||
        models.some((model) => entry === model.id || entry === `${provider.id}/${model.id}`),
    );
    if (!allowed) {
      return `This key cannot use ${provider.id}`;
    }
  }
  if (!allowsAccount(principal.accounts ?? [], provider.id, account?.id ?? "")) {
    return `This key cannot use this account of ${provider.id}`;
  }
  return null;
}

function modelPermission(principal: GatewayPrincipal, resolved: ResolvedVideoModel): string | null {
  if (principal.models.length === 0) {
    return null;
  }
  const names = new Set([
    resolved.model.id,
    `${resolved.provider.id}/${resolved.model.id}`,
    `${resolved.provider.id}/*`,
  ]);
  return principal.models.some((entry) => names.has(entry))
    ? null
    : `This key cannot use ${resolved.provider.id}/${resolved.model.id}`;
}

interface StartPlan {
  url: string;
  body: string;
  field: string;
}

function planStart(call: ResolvedCall, filming: Filming): StartPlan | VideoFailure {
  try {
    return planStartOf(call, filming);
  } catch (error) {
    if (error instanceof VideoInputError) {
      return fail(error.status, error.message);
    }
    throw error;
  }
}

function planStartOf(call: ResolvedCall, filming: Filming): StartPlan {
  switch (call.mechanism) {
    case "ark":
      return {
        url: arkTasksUrl(call.base),
        body: arkVideoBody(call.model.id, filming),
        field: "id",
      };
    case "minimax":
      return {
        url: `${minimaxHost(call.base)}/v2/video_generation`,
        body: minimaxVideoBody(call.model.id, filming),
        field: "task_id",
      };
    case "grok":
      return {
        url: joinPath(call.base, "/videos/generations"),
        body: grokVideoBody(call.model.id, filming),
        field: "request_id",
      };
    default:
      return {
        url: joinPath(call.base, "/videos"),
        body: customVideoBody(call.model.id, filming),
        field: "id",
      };
  }
}

async function startVendor(
  call: ResolvedCall,
  plan: StartPlan,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<{ response: Response; answer: string } | VideoFailure> {
  let response: Response;
  try {
    response = await vendorFetch(call, plan.url, { method: "POST", body: plan.body }, fetchImpl);
  } catch (error) {
    logger.info({ err: error, provider: call.provider.id }, "Video start failed");
    return fail(502, `${vendorLabel(call.provider)} cannot be reached`);
  }
  return { response, answer: await callBody(response) };
}

function startFailure(call: ResolvedCall, answer: string, status: number): string {
  const said = vendorMessage(answer);
  if (call.mechanism === "minimax") {
    const { code } = minimaxSaid(answer);
    const why = minimaxWhy(code, status);
    if (why !== "") {
      return `${why} — ${vendorLabel(call.provider)}: ${said}`;
    }
  }
  return `${vendorLabel(call.provider)}: ${said}`;
}

interface PreparedVideo {
  resolved: ResolvedVideoModel;
  account: GatewayAccount | undefined;
}

function prepareVideo(
  config: GatewayConfig,
  principal: GatewayPrincipal,
  filming: Filming,
  options: VideoRouteOptions,
  started: number,
): PreparedVideo | VideoFailure {
  const named = filming.model !== "";
  if (!named) {
    const auto = autoVideoModel(config);
    if (auto === null) {
      return fail(
        400,
        'no model to make videos with: set up a provider that makes videos (a model marked kind "video", a MiniMax API key for MiniMax-H3, a Grok subscription, or Volcengine Ark\'s Seedance), or name one',
      );
    }
    filming.model = `${auto.provider.id}/${auto.model.id}`;
  }
  const resolution = resolveVideoModel(config, filming.model);
  if ("known" in resolution) {
    if (!resolution.known) {
      return fail(404, `Neox knows no model ${JSON.stringify(filming.model)} to make videos with`);
    }
    return fail(
      400,
      `${filming.model} can't make videos: mark the model kind "video" in the provider's models, or use a MiniMax H3, Grok Imagine or Volcengine Ark Seedance model`,
    );
  }
  const resolved = resolution.resolved;
  // A model chosen automatically is still a model the key must be allowed:
  // an unnamed request must not reach one the key could not name.
  const denied = modelPermission(principal, resolved);
  if (denied !== null) {
    return fail(403, denied);
  }
  const arkOnly = arkOnlyReason(filming, resolved.mechanism);
  if (arkOnly !== null) {
    return fail(400, arkOnly);
  }
  const offered = mapAccounts(resolved.provider);
  const account = chooseAccount(options, principal, resolved.provider, resolved.model, started);
  if (account === undefined && offered.length > 0) {
    const keyHeld = !offered.some((entry) =>
      allowsAccount(principal.accounts ?? [], resolved.provider.id, entry.id),
    );
    return fail(
      keyHeld ? 403 : 503,
      keyHeld
        ? `This key cannot use an account of ${vendorLabel(resolved.provider)}`
        : `Every account of ${vendorLabel(resolved.provider)} is resting or in use`,
    );
  }
  return { resolved, account };
}

/**
 * The key's access to the call a video start is about to make: model list,
 * pace and budget window. Null when a refusal was written.
 */
function reserveVideoStart(
  req: ExpressRequest,
  res: ExpressResponse,
  config: GatewayConfig,
  principal: GatewayPrincipal,
  resolved: ResolvedVideoModel,
  options: VideoRouteOptions,
  started: number,
): Reservation | null {
  if (options.rateLimiter !== undefined) {
    const denial = checkAccess({
      config,
      ledger: options.ledger,
      principal,
      requestedModel: `${resolved.provider.id}/${resolved.model.id}`,
      routingModel: `${resolved.provider.id}/${resolved.model.id}`,
      candidates: [{ provider: resolved.provider, model: resolved.model }],
      rateLimiter: options.rateLimiter,
      now: started,
    });
    if (denial !== null) {
      writeDenial(res, denial);
      return null;
    }
  }
  const reservation = reserveBudget({
    config,
    key: principal.key,
    bodyBytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
    now: new Date(started),
    ledgerPath: options.ledger.filePath,
  });
  if ("refusal" in reservation) {
    res.setHeader("Retry-After", String(reservation.refusal.retryAfterSeconds));
    res.status(429).json({
      error: { message: reservation.refusal.message, type: "quota_exceeded" },
    });
    return null;
  }
  return reservation.reservation;
}

export async function handleVideosCreate(
  req: ExpressRequest,
  res: ExpressResponse,
  options: VideoRouteOptions,
): Promise<void> {
  const config = options.configStore.get();
  const principal = resolvePrincipal(req, config);
  if (principal === null) {
    res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return;
  }
  const started = Date.now();
  const contentType =
    typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
  let filming: Filming;
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    filming = readFilming(body, contentType);
  } catch (error) {
    if (error instanceof VideoInputError) {
      writeFailure(res, fail(error.status, error.message));
      return;
    }
    throw error;
  }
  const prepared = prepareVideo(config, principal, filming, options, started);
  if ("status" in prepared) {
    writeFailure(res, prepared);
    return;
  }
  const { resolved, account } = prepared;
  // Starting a video spends a vendor call as much as a chat does: the key's
  // model list, pace and budget windows hold it before anything is sent.
  const reservation = reserveVideoStart(req, res, config, principal, resolved, options, started);
  if (reservation === null) {
    return;
  }
  const call: ResolvedCall = {
    provider: resolved.provider,
    account,
    mechanism: resolved.mechanism,
    base: providerBase(resolved.provider, account),
    model: resolved.model,
  };
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const plan = planStart(call, filming);
    if ("status" in plan) {
      writeFailure(res, plan);
      return;
    }
    const startedCall = await startVendor(call, plan, fetchImpl, options.logger);
    if ("status" in startedCall) {
      writeFailure(res, startedCall);
      return;
    }
    const { response, answer } = startedCall;
    const answerField = plan.field;
    if (!response.ok) {
      writeFailure(res, fail(response.status, startFailure(call, answer, response.status)));
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(answer);
    } catch {
      payload = null;
    }
    const vendorId =
      isRecord(payload) && typeof payload[answerField] === "string"
        ? (payload[answerField] as string)
        : "";
    if (vendorId === "") {
      writeFailure(
        res,
        fail(
          502,
          `${vendorLabel(call.provider)} started no video: its answer had no ${answerField}`,
        ),
      );
      return;
    }
    const id = videoId({
      provider: call.provider,
      vendorId,
      started,
      account,
      mechanism: call.mechanism,
    });
    options.ledger.record({
      time: new Date(started).toISOString(),
      requested: filming.model,
      provider: call.provider.id,
      account: account?.id ?? null,
      model: call.model.id,
      protocol: call.provider.protocol,
      status: 200,
      ok: true,
      inputTokens: 0,
      outputTokens: 0,
      attempts: 1,
      durationMs: Date.now() - started,
      costUsd: 0,
      key: principal.key,
    });
    writeStartedVideo(res, call, payload, id, filming, started);
  } finally {
    reservation.release();
  }
}

function writeStartedVideo(
  res: ExpressResponse,
  call: ResolvedCall,
  payload: unknown,
  id: string,
  filming: Filming,
  started: number,
): void {
  if (call.mechanism === "custom" && isRecord(payload)) {
    const object: Record<string, unknown> = { ...payload, id };
    const vendorModel = typeof payload.model === "string" ? payload.model : "";
    object.model = `${call.provider.id}/${vendorModel === "" ? call.model.id : vendorModel}`;
    res.json(object);
    return;
  }
  res.json(
    videoObject({
      id,
      model: `${call.provider.id}/${call.model.id}`,
      started,
      state: emptyState(),
      filming,
    }),
  );
}

/* ------------------------------------------------------------- status/content */

interface Lookup {
  provider: GatewayProvider;
  mechanism: VideoMechanism;
  vendorId: string;
  started: number;
  account: GatewayAccount | undefined;
  base: string;
}

function lookupVideo(config: GatewayConfig, id: ParsedVideoId): Lookup | { error: VideoFailure } {
  const provider = config.providers.find((entry) => entry.id === id.providerId);
  if (provider === undefined) {
    return {
      error: fail(404, `no provider ${JSON.stringify(id.providerId)} makes videos here`),
    };
  }
  const models = videoModelsOf(provider);
  const mechanism = mechanismFromProvider(provider, models);
  if (mechanism === null) {
    return {
      error: fail(404, `no provider ${JSON.stringify(id.providerId)} makes videos here`),
    };
  }
  const account = accountForMark(provider, id.mark);
  if (account === undefined && id.mark !== "0") {
    return {
      error: fail(
        404,
        `this video was started with a key of ${vendorLabel(provider)} that is no longer on: turn it back on to get the video`,
      ),
    };
  }
  const vendorId = mechanism === "custom" ? decodeVendorId(id.vendorId) : id.vendorId;
  return {
    provider,
    mechanism,
    vendorId,
    started: id.started,
    account,
    base: providerBase(provider, account),
  };
}

function mechanismFromProvider(
  provider: GatewayProvider,
  models: GatewayModel[],
): VideoMechanism | null {
  if (isMiniMaxProvider(provider)) {
    return "minimax";
  }
  if (isGrokProvider(provider)) {
    return "grok";
  }
  if (isArkProvider(provider)) {
    return "ark";
  }
  return models.some((model) => model.kind === "video") ? "custom" : null;
}

async function statusOf(
  call: VendorCall & { vendorId: string },
  fetchImpl: typeof fetch,
): Promise<{ state: VideoState; status: number } | { error: VideoFailure }> {
  let url: string;
  if (call.mechanism === "minimax") {
    url = `${minimaxHost(call.base)}/v2/query/video_generation/${encodeURIComponent(call.vendorId)}`;
  } else if (call.mechanism === "ark") {
    url = `${arkTasksUrl(call.base)}/${encodeURIComponent(call.vendorId)}`;
  } else if (call.mechanism === "grok") {
    url = joinPath(call.base, `/videos/${encodeURIComponent(call.vendorId)}`);
  } else {
    url = joinPath(call.base, `/videos/${encodeURIComponent(call.vendorId)}`);
  }
  let response: Response;
  try {
    response = await vendorFetch(call, url, { method: "GET" }, fetchImpl);
  } catch {
    return { error: fail(502, `${vendorLabel(call.provider)} cannot be reached`) };
  }
  const answer = await callBody(response);
  if (!response.ok) {
    if (call.mechanism === "minimax") {
      const { message, code } = minimaxSaid(answer);
      const why = minimaxWhy(code, response.status);
      if (why !== "") {
        return {
          error: fail(response.status, `${why} — ${vendorLabel(call.provider)}: ${message}`),
        };
      }
    }
    return {
      error: fail(
        response.status,
        `${vendorLabel(call.provider)}: ${vendorMessage(answer) || `answered ${response.status}`}`,
      ),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(answer);
  } catch {
    return { error: fail(502, `${vendorLabel(call.provider)}'s answer isn't a video's`) };
  }
  if (call.mechanism === "minimax") {
    return minimaxState(payload, answer, call.provider);
  }
  return { state: readVideoState(payload, call.mechanism === "ark"), status: 200 };
}

function minimaxState(
  payload: unknown,
  answer: string,
  provider: GatewayProvider,
): { state: VideoState; status: number } | { error: VideoFailure } {
  const task = isRecord(payload) && isRecord(payload.task) ? payload.task : null;
  if (task === null || typeof task.status !== "string") {
    const said = minimaxSaid(answer);
    return {
      error:
        said.message === ""
          ? fail(502, `${vendorLabel(provider)}'s answer isn't a video task's`)
          : fail(502, `${vendorLabel(provider)}: ${said.message}`),
    };
  }
  const state = emptyState();
  state.status = stringField(task.status);
  state.model = stringField(task.model);
  state.duration = numberField(task.duration);
  const content = isRecord(task.content) ? task.content : null;
  state.video.url = content === null ? "" : stringField(content.url);
  const error = isRecord(task.error) ? task.error : null;
  if (error !== null) {
    state.error.code =
      typeof error.code === "number" ? String(error.code) : stringField(error.code);
    state.error.message = stringField(error.message);
    const why = minimaxWhy(state.error.code, 0);
    if (why !== "") {
      state.error.message = `${why} — MiniMax: ${state.error.message || "the video failed"} (${
        state.error.code
      })`;
    }
  }
  return { state, status: 200 };
}

export interface VideoLookupOptions {
  configStore: GatewayConfigStore;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export async function handleVideoGet(
  req: ExpressRequest,
  res: ExpressResponse,
  options: VideoLookupOptions,
  id: string,
): Promise<boolean> {
  const config = options.configStore.get();
  const principal = resolvePrincipal(req, config);
  if (principal === null) {
    res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return true;
  }
  const parsed = parseVideoId(id);
  if (parsed === null) {
    return false;
  }
  const target = lookupVideo(config, parsed);
  if ("error" in target) {
    writeFailure(res, target.error);
    return true;
  }
  const denied = lookupPermission(principal, target.provider, target.account);
  if (denied !== null) {
    writeFailure(res, fail(403, denied));
    return true;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = {
    provider: target.provider,
    account: target.account,
    mechanism: target.mechanism,
    base: target.base,
    vendorId: target.vendorId,
  };
  const result = await statusOf(call, fetchImpl);
  if ("error" in result) {
    writeFailure(res, result.error);
    return true;
  }
  if (target.mechanism === "custom") {
    const url = joinPath(target.base, `/videos/${encodeURIComponent(target.vendorId)}`);
    let response: Response;
    try {
      response = await vendorFetch(call, url, { method: "GET" }, fetchImpl);
    } catch {
      writeFailure(res, fail(502, `${vendorLabel(target.provider)} cannot be reached`));
      return true;
    }
    const answer = await callBody(response);
    if (!response.ok) {
      writeFailure(
        res,
        fail(response.status, `${vendorLabel(target.provider)}: ${vendorMessage(answer)}`),
      );
      return true;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(answer);
    } catch {
      payload = null;
    }
    if (!isRecord(payload)) {
      writeFailure(res, fail(502, `${vendorLabel(target.provider)}'s answer isn't a video's`));
      return true;
    }
    const object: Record<string, unknown> = { ...payload, id };
    if (typeof payload.model === "string" && payload.model !== "") {
      object.model = `${target.provider.id}/${payload.model}`;
    }
    res.json(object);
    return true;
  }
  const model = result.state.model === "" ? "video" : result.state.model;
  res.json(
    videoObject({
      id,
      model: `${target.provider.id}/${model}`,
      started: target.started,
      state: result.state,
      filming: {
        model: "",
        prompt: "",
        seconds: "",
        size: "",
        references: [],
        extra: {},
        form: false,
      },
    }),
  );
  return true;
}

export async function handleVideoContent(
  req: ExpressRequest,
  res: ExpressResponse,
  options: VideoLookupOptions,
  id: string,
): Promise<boolean> {
  const config = options.configStore.get();
  const principal = resolvePrincipal(req, config);
  if (principal === null) {
    res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
    return true;
  }
  const parsed = parseVideoId(id);
  if (parsed === null) {
    return false;
  }
  const target = lookupVideo(config, parsed);
  if ("error" in target) {
    writeFailure(res, target.error);
    return true;
  }
  const denied = lookupPermission(principal, target.provider, target.account);
  if (denied !== null) {
    writeFailure(res, fail(403, denied));
    return true;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const call = {
    provider: target.provider,
    account: target.account,
    mechanism: target.mechanism,
    base: target.base,
    vendorId: target.vendorId,
  };
  if (target.mechanism === "custom") {
    const url = joinPath(target.base, `/videos/${encodeURIComponent(target.vendorId)}/content`);
    let response: Response;
    try {
      response = await vendorFetch(call, url, { method: "GET" }, fetchImpl);
    } catch {
      writeFailure(res, fail(502, "the video couldn't be fetched"));
      return true;
    }
    if (!response.ok) {
      writeFailure(
        res,
        fail(response.status, `${vendorLabel(target.provider)}: ${await callBody(response)}`),
      );
      return true;
    }
    res.setHeader("content-type", response.headers.get("content-type") ?? "video/mp4");
    const length = response.headers.get("content-length");
    if (length !== null) {
      res.setHeader("content-length", length);
    }
    await pipeVideo(res, response);
    return true;
  }
  const result = await statusOf(call, fetchImpl);
  if ("error" in result) {
    writeFailure(res, result.error);
    return true;
  }
  const state = result.state;
  if (state.status !== "done" && state.status !== "succeeded") {
    const object = videoObject({
      id,
      model: "",
      started: target.started,
      state,
      filming: {
        model: "",
        prompt: "",
        seconds: "",
        size: "",
        references: [],
        extra: {},
        form: false,
      },
    });
    let message = `the video isn't ready: it is ${String(object.status)}`;
    const error = object.error;
    if (isRecord(error) && typeof error.message === "string") {
      message += `: ${error.message}`;
    }
    writeFailure(res, fail(409, message));
    return true;
  }
  const url = state.video.url !== "" ? state.video.url : state.content.video_url;
  if (url === "") {
    writeFailure(
      res,
      fail(502, `${vendorLabel(target.provider)} made the video but gave no URL for it`),
    );
    return true;
  }
  const allowed = await fetchVendorVideo(url, target.base, fetchImpl);
  if ("error" in allowed) {
    writeFailure(res, allowed.error);
    return true;
  }
  const type = videoType(allowed.head, allowed.response.headers.get("content-type"), state.ark);
  res.setHeader("content-type", type);
  const length = allowed.response.headers.get("content-length");
  if (length !== null) {
    res.setHeader("content-length", length);
  }
  await pipeVideo(res, allowed.response);
  return true;
}

function videoType(head: Buffer, said: string | null, ark: Record<string, unknown> | null): string {
  if (
    head.length >= 12 &&
    head.subarray(4, 8).toString("latin1") === "ftyp" &&
    head.subarray(8, 12).toString("latin1") === "qt  "
  ) {
    return "video/quicktime";
  }
  if (said !== null) {
    const type = said.split(";")[0]?.trim().toLowerCase() ?? "";
    if (type.startsWith("video/")) {
      return type;
    }
  }
  if (ark !== null && String(ark.output_format ?? "").toLowerCase() === "mov") {
    return "video/quicktime";
  }
  return "video/mp4";
}

async function pipeVideo(res: ExpressResponse, response: Response): Promise<void> {
  if (res.headersSent) {
    return;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    res.end();
    return;
  }
  let sent = 0;
  try {
    while (sent < MAX_VIDEO_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      const room = MAX_VIDEO_BYTES - sent;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      sent += chunk.byteLength;
      if (!res.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
    }
  } catch {
    // The vendor stopped mid-stream; what was sent stays sent.
  } finally {
    res.end();
  }
}

/* ------------------------------------------------------------- SSRF guard */

function privateV6(address: string): boolean {
  return (
    address === "::1" ||
    address === "::" ||
    address.startsWith("fc") ||
    address.startsWith("fd") ||
    address.startsWith("fe80")
  );
}

export function privateAddress(address: string): boolean {
  if (address.startsWith("::ffff:")) {
    return privateAddress(address.slice("::ffff:".length));
  }
  if (privateV6(address)) {
    return true;
  }
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * A vendor's video URL is fetched only when it is public, or on the vendor's
 * own host: the URL comes from an upstream answer, so it must not lead the
 * daemon into its own network.
 */
async function fetchVendorVideo(
  url: string,
  vendorBase: string,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; head: Buffer } | { error: VideoFailure }> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { error: fail(502, "the video's URL is not a URL") };
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return { error: fail(502, "the video's URL is not http(s)") };
  }
  let vendorHost = "";
  try {
    vendorHost = new URL(vendorBase).hostname;
  } catch {
    vendorHost = "";
  }
  if (target.hostname !== vendorHost) {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(target.hostname, { all: true });
    } catch {
      return { error: fail(502, "the video's host cannot be resolved") };
    }
    if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) {
      return { error: fail(502, "the video's host is not a public address") };
    }
  }
  let response: Response;
  try {
    response = await fetchImpl(target, {
      redirect: "manual",
      signal: AbortSignal.timeout(VIDEO_TIMEOUT_MS),
    });
  } catch {
    return { error: fail(502, "the video couldn't be fetched") };
  }
  if (!response.ok) {
    return {
      error: fail(502, `the video couldn't be fetched: ${response.status}`),
    };
  }
  const reader = response.body?.getReader();
  let head = Buffer.alloc(0);
  if (reader !== undefined && response.body !== null) {
    // Peek the first bytes for the media type, then put them back.
    const first = await reader.read();
    if (!first.done && first.value !== undefined) {
      head = Buffer.from(first.value);
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first.value as Uint8Array);
          void (async () => {
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) {
                  controller.close();
                  return;
                }
                if (next.value !== undefined) {
                  controller.enqueue(next.value);
                }
              }
            } catch (error) {
              controller.error(error);
            }
          })();
        },
      });
      return {
        response: new Response(rest, {
          status: response.status,
          headers: response.headers,
        }),
        head,
      };
    }
    try {
      reader.releaseLock();
    } catch {
      // Already closed.
    }
  }
  return { response, head };
}

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
