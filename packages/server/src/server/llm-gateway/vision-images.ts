import type { GatewayProtocol } from "./upstream.js";

/**
 * An image inside a wire request, where a walk found it. `src` is the image
 * as a URL (a `data:` URL for an inline image); it is empty for one only its
 * vendor can open (a Responses `file_id`).
 */
export interface GatewayImageSite {
  src: string;
  /** An image the latest turn gives the model, which the model is asked about. */
  current: boolean;
  /** An image a tool returned rather than one the user attached. */
  tool: boolean;
  block: Record<string, unknown>;
}

/** What a walk replaces an image block with; null leaves it as it was. */
export type ImageSwap = (site: GatewayImageSite) => Record<string, unknown> | null;

/** The image in the latest user turn could not be described or omitted. */
export class CurrentImageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CurrentImageError";
  }
}

interface TurnWalk {
  contentKey: string;
  toolKey: string | null;
}

/** Where a protocol keeps its turns. */
function turnsKey(protocol: GatewayProtocol): string {
  if (protocol === "openai-responses") {
    return "input";
  }
  if (protocol === "gemini") {
    return "contents";
  }
  return "messages";
}

function turnsOf(protocol: GatewayProtocol, body: Record<string, unknown>): unknown[] | null {
  const value = body[turnsKey(protocol)];
  return Array.isArray(value) ? value : null;
}

function walkTurns(
  protocol: GatewayProtocol,
  turns: unknown[],
  swap: ImageSwap,
): { turns: unknown[]; changed: boolean } {
  let changed = false;
  const out = turns.map((rawTurn, index) => {
    if (!isRecord(rawTurn)) {
      return rawTurn;
    }
    const walk = turnWalk(protocol, rawTurn);
    if (walk === null) {
      return rawTurn;
    }
    const content = rawTurn[walk.contentKey];
    const swapped = swapBlocks(
      protocol,
      content,
      index === turns.length - 1,
      walk.toolKey !== null,
      swap,
    );
    if (!swapped.changed) {
      return rawTurn;
    }
    changed = true;
    return { ...rawTurn, [walk.contentKey]: swapped.blocks };
  });
  return { turns: out, changed };
}

function turnWalk(protocol: GatewayProtocol, turn: Record<string, unknown>): TurnWalk | null {
  if (protocol === "gemini") {
    return { contentKey: "parts", toolKey: null };
  }
  if (protocol === "openai") {
    return { contentKey: "content", toolKey: turn.role === "tool" ? "content" : null };
  }
  if (protocol === "openai-responses") {
    const kind = typeof turn.type === "string" ? turn.type : "";
    return kind === "function_call_output"
      ? { contentKey: "output", toolKey: "output" }
      : { contentKey: "content", toolKey: null };
  }
  return { contentKey: "content", toolKey: null };
}

function swapBlocks(
  protocol: GatewayProtocol,
  raw: unknown,
  last: boolean,
  tool: boolean,
  swap: ImageSwap,
): { blocks: unknown; changed: boolean } {
  if (!Array.isArray(raw)) {
    return { blocks: raw, changed: false };
  }
  let changed = false;
  const blocks = raw.map((block) => {
    if (!isRecord(block)) {
      return block;
    }
    const src = imageSource(protocol, block);
    if (src !== null) {
      const replacement = swap({ src, current: last && !tool, tool, block });
      if (replacement !== null) {
        changed = true;
        return replacement;
      }
      return block;
    }
    const nested = nestedImageWalk(protocol, block);
    if (nested === null) {
      return block;
    }
    const inner = swapBlocks(protocol, nested.content, last, true, swap);
    if (!inner.changed) {
      return block;
    }
    changed = true;
    return { ...block, [nested.key]: inner.blocks };
  });
  return { blocks: changed ? blocks : raw, changed };
}

function nestedImageWalk(
  protocol: GatewayProtocol,
  block: Record<string, unknown>,
): { key: string; content: unknown } | null {
  if (protocol === "anthropic" && block.type === "tool_result") {
    return { key: "content", content: block.content };
  }
  if (protocol === "gemini" && isRecord(block.functionResponse)) {
    return { key: "functionResponse", content: block.functionResponse };
  }
  return null;
}

/**
 * The image as a URL when the block is one, null for any other block. A
 * Gemini file whose type is unknown counts as an image: failing closed is
 * better than sending a picture to a model that cannot see it.
 */
export function imageSource(
  protocol: GatewayProtocol,
  block: Record<string, unknown>,
): string | null {
  switch (protocol) {
    case "openai":
      return openaiImageSource(block);
    case "openai-responses":
      return responsesImageSource(block);
    case "anthropic":
      return anthropicImageSource(block);
    case "gemini":
      return geminiImageSource(block);
  }
}

function openaiImageSource(block: Record<string, unknown>): string | null {
  if (block.type !== "image_url") {
    return null;
  }
  const value = block.image_url;
  if (typeof value === "string") {
    return value;
  }
  return isRecord(value) && typeof value.url === "string" ? value.url : "";
}

function responsesImageSource(block: Record<string, unknown>): string | null {
  if (block.type !== "input_image") {
    return null;
  }
  return typeof block.image_url === "string" ? block.image_url : "";
}

function anthropicImageSource(block: Record<string, unknown>): string | null {
  if (block.type !== "image") {
    return null;
  }
  const source = isRecord(block.source) ? block.source : {};
  if (source.type === "base64" && typeof source.data === "string" && source.data.length > 0) {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "image/png";
    return `data:${mediaType};base64,${source.data}`;
  }
  if (source.type === "url" && typeof source.url === "string") {
    return source.url;
  }
  return "";
}

function geminiImageSource(block: Record<string, unknown>): string | null {
  if (isRecord(block.inlineData)) {
    const mimeType = block.inlineData.mimeType;
    const data = block.inlineData.data;
    if (typeof mimeType === "string" && mimeType.startsWith("image/") && typeof data === "string") {
      return `data:${mimeType};base64,${data}`;
    }
  }
  if (isRecord(block.fileData)) {
    const mimeType = block.fileData.mimeType;
    return typeof mimeType === "string" && !mimeType.startsWith("image/") ? null : "";
  }
  return null;
}

/** Whether the body carries any image at all. */
export function hasImages(protocol: GatewayProtocol, body: Record<string, unknown>): boolean {
  const turns = turnsOf(protocol, body);
  if (turns === null) {
    return false;
  }
  let found = false;
  walkTurns(protocol, turns, () => {
    found = true;
    return null;
  });
  return found;
}

/**
 * Replaces every image block in the body with what `swap` returns. The body
 * is returned as it was when nothing changed. Throws `CurrentImageError`
 * when the swap throws one; the walk stops there.
 */
export function walkImages(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
  swap: ImageSwap,
): Record<string, unknown> {
  const turns = turnsOf(protocol, body);
  if (turns === null) {
    return body;
  }
  const key = turnsKey(protocol);
  const walked = walkTurns(protocol, turns, swap);
  return walked.changed ? { ...body, [key]: walked.turns } : body;
}

/** The body with every image replaced by a text line saying it was omitted. */
export function omitImages(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
  text: string,
): Record<string, unknown> {
  return walkImages(protocol, body, (site) => {
    if (site.current) {
      throw new CurrentImageError(text);
    }
    return textBlock(protocol, text);
  });
}

/** A text block in the protocol's own shape. */
export function textBlock(protocol: GatewayProtocol, text: string): Record<string, unknown> {
  if (protocol === "openai-responses") {
    return { type: "input_text", text };
  }
  if (protocol === "gemini") {
    return { text };
  }
  return { type: "text", text };
}

/**
 * The image block with its bytes replaced, keeping the fields around them
 * (a Chat `detail`, an Anthropic `cache_control`). Null when the block cannot
 * be read.
 */
export function withImageData(
  protocol: GatewayProtocol,
  block: Record<string, unknown>,
  mediaType: string,
  base64: string,
): Record<string, unknown> | null {
  const url = `data:${mediaType};base64,${base64}`;
  switch (protocol) {
    case "openai": {
      const value = block.image_url;
      if (typeof value === "string") {
        return { ...block, image_url: url };
      }
      return {
        ...block,
        image_url: { ...(isRecord(value) ? value : {}), url },
      };
    }
    case "openai-responses":
      return { ...block, image_url: url };
    case "anthropic":
      return {
        ...block,
        source: { type: "base64", media_type: mediaType, data: base64 },
      };
    case "gemini":
      return { ...block, inlineData: { mimeType: mediaType, data: base64 } };
  }
}

export interface ParsedDataUrl {
  mediaType: string;
  base64: string;
  bytes: Buffer;
}

/** A base64 `data:` URL's bytes, or null for any other source. */
export function parseDataUrl(src: string): ParsedDataUrl | null {
  if (!src.startsWith("data:")) {
    return null;
  }
  const comma = src.indexOf(",");
  if (comma < 0) {
    return null;
  }
  const meta = src.slice("data:".length, comma);
  if (!meta.toLowerCase().endsWith(";base64")) {
    return null;
  }
  const mediaType = meta.slice(0, -";base64".length).split(";")[0] || "application/octet-stream";
  const base64 = src.slice(comma + 1);
  try {
    const bytes = Buffer.from(base64, "base64");
    return bytes.length === 0 ? null : { mediaType, base64, bytes };
  } catch {
    return null;
  }
}

/** A base64 data URL of some bytes. */
export function dataUrl(mediaType: string, bytes: Buffer): string {
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
