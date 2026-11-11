// The front end stages composer attachments over HTTP (`POST /api/attachments/upload`) and then
// sends the short ids on `thread.turn.start`. Neox needs the bytes, so the bridge keeps the
// staged uploads here and forwards them with the turn: images become inline base64, files are
// uploaded to the daemon, and assistant selections become text attachments.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
} from "@synara/contracts";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import type { DaemonClient } from "./neolix.ts";
import { bridgeError } from "./rpcErrors.ts";

export const ATTACHMENT_UPLOAD_PATH = "/api/attachments/upload";
export const ATTACHMENT_CANCEL_PATH = "/api/attachments/cancel";
export const ATTACHMENT_DOWNLOAD_PREFIX = "/attachments/";

const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
// debt: staged bytes live in memory for one bridge process. Move them to a temp directory with
// an LRU cap when attachments larger than a handful of files must survive long sessions.
const MAX_STAGED_BYTES = 256 * 1024 * 1024;
const MAX_NAME_CHARS = 255;
const MAX_MIME_CHARS = 100;

interface StagedAttachment {
  readonly id: string;
  readonly threadId: string | null;
  readonly type: "image" | "file";
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly createdAt: number;
}

export interface NeolixSendAttachments {
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
  readonly attachments?: ReadonlyArray<Record<string, unknown>>;
}

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
    headers.Vary = "Origin";
  }
  return headers;
}

function textResponse(
  text: string,
  status: number,
  origin: string | undefined,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.text(text, { status, headers: corsHeaders(origin) });
}

function jsonResponse(
  value: unknown,
  status: number,
  origin: string | undefined,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(value, { status, headers: corsHeaders(origin) });
}

/** Images the daemon kept for an old message live under its home; the id names the file. */
const STORED_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function readStoredImage(id: string): StagedAttachment | undefined {
  // Only ids the daemon minted (uuid hex) become paths; anything else is simply not found.
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return undefined;
  const home = process.env.NEOLIX_HOME?.trim() || path.join(homedir(), ".neox");
  const directory = path.join(home, "attachments");
  let entry: string | undefined;
  try {
    entry = readdirSync(directory).find((candidate) => candidate.startsWith(`${id}.`));
  } catch {
    return undefined;
  }
  if (!entry) return undefined;
  const extension = entry.slice(entry.lastIndexOf(".") + 1).toLowerCase();
  const mimeType = STORED_IMAGE_TYPES[extension];
  if (!mimeType) return undefined;
  try {
    const bytes = new Uint8Array(readFileSync(path.join(directory, entry)));
    return {
      id,
      threadId: null,
      type: "image",
      name: entry,
      mimeType,
      bytes,
      createdAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

export class AttachmentStore {
  private readonly items = new Map<string, StagedAttachment>();
  private storedBytes = 0;

  /** Stages one upload and returns the descriptor the front end puts on the message. */
  stage(input: {
    readonly threadId?: string | undefined;
    readonly type: "image" | "file";
    readonly name: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }): ChatImageAttachment | ChatFileAttachment {
    const limit =
      input.type === "image"
        ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
    if (input.bytes.byteLength > limit) {
      throw bridgeError(
        "attachment.too-large",
        `"${input.name}" is larger than the ${Math.round(limit / (1024 * 1024))} MB limit.`,
        { name: input.name, size: Math.round(limit / (1024 * 1024)) },
      );
    }
    const name = input.name.trim();
    const mimeType = input.mimeType.trim();
    if (!name || name.length > MAX_NAME_CHARS) {
      throw bridgeError("attachment.invalid-name", "Invalid attachment name.");
    }
    if (!mimeType || mimeType.length > MAX_MIME_CHARS) {
      throw bridgeError("attachment.invalid-type", "Invalid attachment type.");
    }
    if (input.type === "image" && !/^image\//i.test(mimeType)) {
      throw bridgeError(
        "attachment.image-type-required",
        "Image attachments need an image content type.",
      );
    }
    this.prune();
    if (this.storedBytes + input.bytes.byteLength > MAX_STAGED_BYTES) {
      throw bridgeError(
        "attachment.staging-full",
        "Attachment staging is full. Send or remove attachments and try again.",
      );
    }
    const id = randomUUID();
    this.items.set(id, {
      id,
      threadId: input.threadId?.trim() || null,
      type: input.type,
      name,
      mimeType,
      bytes: input.bytes,
      createdAt: Date.now(),
    });
    this.storedBytes += input.bytes.byteLength;
    return {
      type: input.type,
      id,
      name,
      mimeType,
      sizeBytes: input.bytes.byteLength,
    } as ChatImageAttachment | ChatFileAttachment;
  }

  get(id: string): StagedAttachment | undefined {
    const item = this.items.get(id);
    if (item) {
      if (Date.now() - item.createdAt > ATTACHMENT_TTL_MS) {
        this.delete(id);
        return undefined;
      }
      return item;
    }
    return readStoredImage(id);
  }

  delete(id: string): void {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    this.storedBytes -= item.bytes.byteLength;
  }

  private prune(): void {
    const cutoff = Date.now() - ATTACHMENT_TTL_MS;
    for (const item of this.items.values()) {
      if (item.createdAt < cutoff) this.delete(item.id);
    }
  }

  /**
   * Turns the message's attachments into the Neox send payload. A staged id that is gone is an
   * error, never silently dropped: the user typed their message expecting the file to arrive.
   */
  async resolve(
    client: DaemonClient,
    attachments: readonly ChatAttachment[],
  ): Promise<NeolixSendAttachments> {
    const images: Array<{ data: string; mimeType: string }> = [];
    const forwarded: Array<Record<string, unknown>> = [];
    for (const attachment of attachments) {
      if (attachment.type === "assistant-selection") {
        forwarded.push({
          type: "text",
          mimeType: "text/plain",
          title: "Selected text",
          text: attachment.text,
        });
        continue;
      }
      if (attachment.type === "review") {
        // Already a daemon attachment; only the client-side id is stripped.
        forwarded.push({
          type: "review",
          mimeType: "application/neolix-review",
          cwd: attachment.cwd,
          mode: attachment.mode,
          ...(attachment.baseRef !== undefined ? { baseRef: attachment.baseRef } : {}),
          comments: attachment.comments,
        });
        continue;
      }
      const staged = this.get(attachment.id);
      if (!staged) {
        throw bridgeError(
          "attachment.missing",
          `Attachment "${attachment.name}" is no longer available. Attach it again and resend.`,
          { name: attachment.name },
        );
      }
      if (attachment.type === "image") {
        images.push({
          data: Buffer.from(staged.bytes).toString("base64"),
          mimeType: staged.mimeType,
        });
        continue;
      }
      const result = await client.uploadFile({
        fileName: staged.name,
        mimeType: staged.mimeType,
        bytes: staged.bytes,
      });
      if (result.error || !result.file) {
        throw bridgeError(
          "attachment.upload-failed",
          result.error ?? `Uploading "${staged.name}" failed.`,
          { name: staged.name, ...(result.error ? { detail: result.error } : {}) },
        );
      }
      forwarded.push(result.file as unknown as Record<string, unknown>);
    }
    return {
      ...(images.length > 0 ? { images } : {}),
      ...(forwarded.length > 0 ? { attachments: forwarded } : {}),
    };
  }
}

/** One store per bridge process; the WS handlers and the HTTP routes share it. */
export const sharedAttachmentStore = new AttachmentStore();

function requestOrigin(request: HttpServerRequest.HttpServerRequest): string | undefined {
  const origin = request.headers.origin;
  return typeof origin === "string" ? origin : undefined;
}

function requestPath(request: HttpServerRequest.HttpServerRequest): string {
  try {
    return new URL(request.url, "http://bridge.local").pathname;
  } catch {
    return request.url;
  }
}

/** Preflight for the cross-origin composer uploads (the web app is served by another port). */
export function makeAttachmentPreflightHandler(): (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return (request) => {
    const origin = requestOrigin(request);
    if (!isLoopbackOrigin(origin)) return Effect.succeed(textResponse("Forbidden", 403, origin));
    return Effect.succeed(
      HttpServerResponse.empty({
        status: 204,
        headers: {
          ...corsHeaders(origin),
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      }),
    );
  };
}

export function makeAttachmentUploadHandler(
  store: AttachmentStore,
): (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return (request) =>
    Effect.gen(function* () {
      const origin = requestOrigin(request);
      if (!isLoopbackOrigin(origin)) return textResponse("Forbidden", 403, origin);
      const url = HttpServerRequest.toURL(request);
      if (!url) return textResponse("Bad request", 400, origin);
      const type = url.searchParams.get("type");
      if (type !== "image" && type !== "file")
        return textResponse("Unsupported attachment type.", 400, origin);
      const name = url.searchParams.get("name") ?? "";
      const mimeType = url.searchParams.get("mimeType") ?? "";
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      try {
        const staged = store.stage({
          threadId: url.searchParams.get("threadId") ?? undefined,
          type,
          name,
          mimeType,
          bytes,
        });
        return jsonResponse(staged, 200, origin);
      } catch (error) {
        return textResponse(error instanceof Error ? error.message : String(error), 413, origin);
      }
    }).pipe(Effect.catch(() => Effect.succeed(textResponse("Upload failed.", 500, undefined))));
}

export function makeAttachmentCancelHandler(
  store: AttachmentStore,
): (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return (request) =>
    Effect.gen(function* () {
      const origin = requestOrigin(request);
      if (!isLoopbackOrigin(origin)) return textResponse("Forbidden", 403, origin);
      const body = (yield* request.json) as { attachmentId?: unknown } | null;
      const id = typeof body?.attachmentId === "string" ? body.attachmentId : null;
      if (id) store.delete(id);
      return jsonResponse({ ok: true }, 200, origin);
    }).pipe(Effect.catch(() => Effect.succeed(jsonResponse({ ok: false }, 200, undefined))));
}

export function makeAttachmentDownloadHandler(
  store: AttachmentStore,
): (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return (request) => {
    const origin = requestOrigin(request);
    if (!isLoopbackOrigin(origin)) return Effect.succeed(textResponse("Forbidden", 403, origin));
    const path = requestPath(request);
    const id = path.startsWith(ATTACHMENT_DOWNLOAD_PREFIX)
      ? path.slice(ATTACHMENT_DOWNLOAD_PREFIX.length)
      : "";
    const staged = id ? store.get(id) : undefined;
    if (!staged) return Effect.succeed(textResponse("Not found", 404, origin));
    return Effect.succeed(
      HttpServerResponse.uint8Array(staged.bytes, {
        headers: {
          ...corsHeaders(origin),
          "Content-Type": staged.mimeType,
          "Content-Length": String(staged.bytes.byteLength),
          "Cache-Control": "private, max-age=3600",
        },
      }),
    );
  };
}
