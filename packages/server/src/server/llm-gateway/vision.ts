import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { isProviderEnabled, type GatewayConfig } from "./config.js";
import { resolveGatewayCandidates, servesModel, type GatewayCandidate } from "./catalog.js";
import type { Masker } from "./masking.js";
import type { GatewayProtocol } from "./upstream.js";
import { VisionCache, type CachedSight } from "./vision-cache.js";
import { loadImageSource } from "./vision-fetch.js";
import { fitForVision, convertForVendor } from "./vision-image.js";
import {
  CurrentImageError,
  hasImages,
  parseDataUrl,
  textBlock,
  walkImages,
  withImageData,
  type GatewayImageSite,
} from "./vision-images.js";

const VISION_SYSTEM = `You describe images for an AI model that cannot see them. It will answer the user from your description alone, so leave nothing out that it may need.
- Transcribe all text exactly as written, keeping its layout: code, terminal output, error messages, logs, UI labels, menus, file names, numbers.
- For a screenshot of an app or page: which app or page it is, its layout, and the state of what is on it (selected, disabled, checked, highlighted, error states).
- For a chart or table: its kind, axes and labels, and every value you can read.
- For a diagram: its elements and how they are connected.
- For a photo or drawing: what it shows, with the details that matter.
Describe only what is there. Don't guess at what can't be read, say it can't be read. Don't answer questions or give advice. No preamble.`;

const VISION_ASK_SYSTEM = `You look at an image for an AI agent that cannot see it, and answer what it asks about the image from what the image shows.
- Transcribe text exactly as written wherever the answer needs it: code, terminal output, error messages, UI labels, numbers.
- Say so when what is asked can't be read or isn't in the image; don't guess.
No preamble.`;

export const IMAGE_OMITTED = "[Image omitted: this model accepts text only.]";
const IMAGE_UNDESCRIBED =
  "[Image omitted: this model accepts text only, and the image couldn't be described.]";
const IMAGE_VENDOR_ONLY = "[Image omitted: a file only its vendor can open.]";

const PARALLEL = 4;
const MAX_TRIES = 3;
const TRY_TIMEOUT_MS = 3 * 60_000;
const WAIT_MOST_MS = 10 * 60_000;

/** The client name a description's usage is recorded under. */
export const VISION_USER_AGENT = "neolix-vision/1";

/** What the service asks: one image, through the gateway itself. */
export interface VisionAsk {
  /** The describer as the gateway resolves it, with `:effort` when picked. */
  model: string;
  system: string;
  prompt: string;
  /** The image as a data URL. */
  image: string;
}

/**
 * Sends a description request through the gateway's own routing, quota and
 * billing, as myna's vision asks itself: routes.ts supplies this and posts to
 * the daemon's own /v1/chat/completions with the router's call token.
 */
export type VisionSend = (ask: VisionAsk, signal: AbortSignal) => Promise<string>;

interface VisionTarget {
  candidate: GatewayCandidate;
  label: string;
}

export interface VisionPrepareInput {
  config: GatewayConfig;
  candidate: GatewayCandidate;
  protocol: GatewayProtocol;
  body: Record<string, unknown>;
  masker: Masker | null;
  /** Asks the gateway for a description. */
  send: VisionSend;
  /** Rewrite WebP too, after a provider refused one. */
  convertWebp?: boolean;
  /** Treat the model as text-only after it turned an image away. */
  blind?: boolean;
}

/**
 * Describes images to models that cannot see them, and rewrites HEIC (and a
 * refused WebP) for every upstream. The description model comes from
 * `gateway.json` `vision.model`; without one, the first served model marked
 * `images: true` is used. Descriptions are cached by the image's own bytes or
 * URL, the newest 2048 in memory and inline images on disk.
 */
export class VisionService {
  private readonly logger: Logger;
  private readonly cache: VisionCache;
  private readonly inflight = new Map<string, Promise<CachedSight>>();
  private readonly blind = new Set<string>();
  private readonly webpRefusedProviders = new Set<string>();

  public constructor(options: { neolixHome: string; logger: Logger }) {
    this.logger = options.logger;
    this.cache = new VisionCache(options.neolixHome);
  }

  public async start(): Promise<void> {
    await this.cache.start();
  }

  public async dispose(): Promise<void> {
    await this.cache.dispose();
  }

  /** Whether a description model is configured or can be picked. */
  public hasModel(config: GatewayConfig): boolean {
    return this.targets(config).length > 0;
  }

  /**
   * The body with its images made sendable: HEIC rewritten everywhere, and,
   * for a model marked `images: false`, each image replaced by a description.
   * Throws `CurrentImageError` when the latest turn's image cannot be
   * described (or the model cannot see it).
   */
  public async prepareBody(input: VisionPrepareInput): Promise<Record<string, unknown>> {
    if (!hasImages(input.protocol, input.body)) {
      return input.body;
    }
    const converted = await this.convertImages(
      input.protocol,
      input.body,
      input.convertWebp === true,
    );
    const blind = input.blind === true || input.candidate.model.images === false;
    if (!blind) {
      return converted;
    }
    return this.describeImages(input, converted);
  }

  /** Whether this model turned an image away (and every later image is described). */
  public isBlind(candidate: GatewayCandidate): boolean {
    return this.blind.has(`${candidate.provider.id}/${candidate.model.id}`);
  }

  /** Records that a model refused an image it said it accepted. */
  public markBlind(candidate: GatewayCandidate): void {
    this.blind.add(`${candidate.provider.id}/${candidate.model.id}`);
  }

  /** Whether this provider refused a WebP before (every later one is rewritten). */
  public webpRefused(providerId: string): boolean {
    return this.webpRefusedProviders.has(providerId);
  }

  public markWebpRefused(providerId: string): void {
    this.webpRefusedProviders.add(providerId);
  }

  /** Looks at one image, for the vision MCP tool. */
  public async analyze(
    config: GatewayConfig,
    image: string,
    prompt: string,
    masker: Masker | null,
    send: VisionSend,
  ): Promise<string> {
    if (this.targets(config).length === 0) {
      throw new Error(
        "No image recognition model is configured: set gateway.json vision.model, or mark a model images: true",
      );
    }
    const sight =
      prompt.length === 0
        ? await this.describe(config, image, masker, send)
        : await this.describeUncached(
            config,
            image,
            prompt,
            VISION_ASK_SYSTEM,
            masker,
            null,
            false,
            send,
          );
    return sight.text;
  }

  private async convertImages(
    protocol: GatewayProtocol,
    body: Record<string, unknown>,
    convertWebp: boolean,
  ): Promise<Record<string, unknown>> {
    const sources = new Set<string>();
    walkImages(protocol, body, (site) => {
      const inline = parseDataUrl(site.src);
      if (inline !== null) {
        sources.add(site.src);
      }
      return null;
    });
    const converted = new Map<string, { mediaType: string; base64: string }>();
    for (const src of sources) {
      const inline = parseDataUrl(src);
      if (inline === null) {
        continue;
      }
      const image = await convertForVendor(inline.bytes, inline.mediaType, { convertWebp });
      if (image.bytes !== inline.bytes) {
        converted.set(src, {
          mediaType: image.mediaType,
          base64: image.bytes.toString("base64"),
        });
      }
    }
    if (converted.size === 0) {
      return body;
    }
    return walkImages(protocol, body, (site) => {
      const image = converted.get(site.src);
      return image === undefined
        ? null
        : withImageData(protocol, site.block, image.mediaType, image.base64);
    });
  }

  private async describeImages(
    input: VisionPrepareInput,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const config = input.config;
    const targets = this.targets(config);
    const sources: string[] = [];
    const seen = new Set<string>();
    const sites: GatewayImageSite[] = [];
    walkImages(input.protocol, body, (site) => {
      sites.push(site);
      if (site.src.length > 0 && !seen.has(site.src)) {
        seen.add(site.src);
        sources.push(site.src);
      }
      return null;
    });

    const described = new Map<string, { text: string; by: string } | { error: Error }>();
    if (targets.length === 0) {
      this.rejectUndescribedCurrent(sites, config);
    } else {
      for (let index = 0; index < sources.length; index += PARALLEL) {
        const batch = sources.slice(index, index + PARALLEL);
        const results = await Promise.all(
          batch.map(
            async (
              src,
            ): Promise<{ src: string; sight: CachedSight | null; failure: Error | null }> => {
              try {
                return {
                  src,
                  sight: await this.describe(config, src, input.masker, input.send),
                  failure: null,
                };
              } catch (error) {
                return {
                  src,
                  sight: null,
                  failure: error instanceof Error ? error : new Error(String(error)),
                };
              }
            },
          ),
        );
        for (const result of results) {
          if (result.sight !== null) {
            described.set(result.src, result.sight);
          } else {
            described.set(result.src, {
              error: result.failure ?? new Error("The image was not described."),
            });
          }
        }
      }
    }

    return walkImages(input.protocol, body, (site) => {
      if (site.src.length === 0) {
        if (site.current) {
          throw new CurrentImageError("The image is a file only its vendor can open.");
        }
        return textBlock(input.protocol, IMAGE_VENDOR_ONLY);
      }
      const result = described.get(site.src);
      if (result === undefined) {
        if (site.current) {
          throw new CurrentImageError(this.noModelMessage(config));
        }
        return textBlock(input.protocol, IMAGE_OMITTED);
      }
      if ("error" in result) {
        if (site.current) {
          throw new CurrentImageError(`The image could not be described: ${result.error.message}`);
        }
        return textBlock(input.protocol, IMAGE_UNDESCRIBED);
      }
      const text = `\n[Image, as ${result.by} describes it for this model, which can't see images:]\n${result.text}\n[End of the image's description]\n`;
      return textBlock(input.protocol, text);
    });
  }

  private rejectUndescribedCurrent(
    sites: readonly GatewayImageSite[],
    config: GatewayConfig,
  ): void {
    for (const site of sites) {
      if (site.current) {
        throw new CurrentImageError(this.noModelMessage(config));
      }
    }
  }

  private noModelMessage(config: GatewayConfig): string {
    if (config.vision?.model === "off") {
      return 'Image recognition is turned off (gateway.json vision.model is "off"), and this model accepts text only. Turn it on, or use a model that accepts images.';
    }
    return "This model accepts text only and no image recognition model is configured. Set gateway.json vision.model, or mark a model images: true.";
  }

  private describe(
    config: GatewayConfig,
    src: string,
    masker: Masker | null,
    send: VisionSend,
  ): Promise<CachedSight> {
    const effort = config.vision?.effort ?? "";
    const key = sightKey(src, effort);
    const cached = this.cache.get(key);
    if (cached !== null) {
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(key);
    if (pending !== undefined) {
      return pending;
    }
    const persistent = parseDataUrl(src) !== null;
    const work = this.describeUncached(
      config,
      src,
      "Describe this image.",
      VISION_SYSTEM,
      masker,
      key,
      persistent,
      send,
    ).finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private async describeUncached(
    config: GatewayConfig,
    src: string,
    prompt: string,
    system: string,
    masker: Masker | null,
    cacheKey: string | null,
    persistent: boolean,
    send: VisionSend,
  ): Promise<CachedSight> {
    const targets = this.targets(config);
    if (targets.length === 0) {
      throw new Error(this.noModelMessage(config));
    }
    const image = await loadImageSource(src);
    const fitted = await fitForVision(image.bytes, image.mediaType);
    const deadline = Date.now() + WAIT_MOST_MS;
    const errors: string[] = [];
    for (const target of targets.slice(0, MAX_TRIES)) {
      if (Date.now() >= deadline) {
        break;
      }
      try {
        const text = await this.askVision(target, fitted, system, prompt, config, deadline, send);
        if (text.length === 0) {
          throw new Error("the model returned no description");
        }
        const sight = { text: masker === null ? text : masker.maskText(text), by: target.label };
        if (cacheKey !== null) {
          this.cache.set(cacheKey, sight, persistent);
        }
        return sight;
      } catch (error) {
        errors.push(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(errors.join("; ") || "No image recognition model answered");
  }

  private async askVision(
    target: VisionTarget,
    image: { bytes: Buffer; mediaType: string },
    system: string,
    prompt: string,
    config: GatewayConfig,
    deadline: number,
    send: VisionSend,
  ): Promise<string> {
    const timeout = Math.max(1, Math.min(TRY_TIMEOUT_MS, deadline - Date.now()));
    const effort = config.vision?.effort;
    return send(
      {
        // The level rides on the model ref, so the gateway writes it in the
        // describer's own protocol: an Anthropic thinking budget, a Gemini
        // thinking config, or OpenAI's reasoning effort.
        model: effort === undefined ? target.label : `${target.label}:${effort}`,
        system,
        prompt,
        image: `data:${image.mediaType};base64,${image.bytes.toString("base64")}`,
      },
      AbortSignal.timeout(timeout),
    );
  }

  private targets(config: GatewayConfig): VisionTarget[] {
    const picked = config.vision?.model;
    if (picked === "off") {
      return [];
    }
    const targets: VisionTarget[] = [];
    const seen = new Set<string>();
    const add = (candidate: GatewayCandidate, requireSeeing: boolean): void => {
      const key = `${candidate.provider.id}/${candidate.model.id}`;
      if (seen.has(key) || !isProviderEnabled(candidate.provider)) {
        return;
      }
      if (!servesModel(candidate.provider, candidate.model)) {
        return;
      }
      // A model marked text-only cannot describe anything, not even when the
      // setting names it: the next model that sees takes its place, as myna's.
      if (candidate.model.images === false || (requireSeeing && candidate.model.images !== true)) {
        return;
      }
      seen.add(key);
      targets.push({ candidate, label: key });
    };
    if (picked !== undefined && picked.length > 0 && picked !== "off") {
      try {
        for (const candidate of resolveGatewayCandidates(config, picked)) {
          add(candidate, false);
        }
      } catch {
        this.logger.warn({ model: picked }, "The configured vision model does not resolve");
      }
    }
    for (const provider of config.providers) {
      if (!isProviderEnabled(provider)) {
        continue;
      }
      for (const model of provider.models) {
        if (model.images === true) {
          add({ provider, model }, true);
        }
      }
    }
    return targets;
  }
}

function sightKey(src: string, effort: string): string {
  const hash = createHash("sha256");
  hash.update(`${effort}\x00`);
  const inline = parseDataUrl(src);
  if (inline !== null) {
    hash.update("bytes\x00");
    hash.update(inline.bytes);
  } else {
    hash.update("src\x00");
    hash.update(src);
  }
  return hash.digest("hex");
}

const IMAGE_REFUSED_WORDS =
  /unknown variant [`'"\\]*(?:image_url|input_image|image)\b|image_url is only supported by certain models|no endpoints found that support image|not a multi-?modal model|(?:does not|doesn't|do not|don't|cannot|can't|unable to) (?:support|accept|process|handle|take|read) (?:the )?(?:image|images|vision|multi-?modal)|\b(?:image|images|vision|multi-?modal|image_url|input_image)(?: (?:input|inputs|content|parts?))? (?:is |are )?(?:not supported|unsupported|not enabled|not allowed)|不支持(?:图片|图像|多模态|视觉|识图)/i;

const WEBP_REFUSED_WORDS =
  /必须传入file_id、file_url、file_data至少之一|图片输入格式|\[(?:1210|1214)\]\[/;

/** Whether a 400/415/422 is a model turning away an image it cannot read. */
export function isImageRefusal(status: number, text: string): boolean {
  if (status !== 400 && status !== 415 && status !== 422) {
    return false;
  }
  return IMAGE_REFUSED_WORDS.test(text);
}

/** Whether the refusal is GLM's word for a picture it cannot parse (a WebP). */
export function isWebpRefusal(text: string): boolean {
  return WEBP_REFUSED_WORDS.test(text);
}
