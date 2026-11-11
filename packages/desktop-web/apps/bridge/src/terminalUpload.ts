// HTTP file upload for terminal file drops and clipboard images.
//
// The terminal pastes a host path, and the only way to turn the renderer's
// bytes into a host file is the daemon's upload API. Binary over the JSON RPC
// socket would mean base64 in both directions, so this stays an HTTP route like
// the composer's attachment staging.
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const TERMINAL_UPLOAD_PATH = "/api/terminal/upload";

/** Stores one uploaded file on the host and returns the path the terminal pastes. */
export type TerminalUpload = (input: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}) => Promise<string>;

const MAX_NAME_CHARS = 255;
const MAX_MIME_CHARS = 100;
/** The daemon's own upload ceiling; reject before buffering a larger body. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function responseHeaders(origin: string | undefined): Record<string, string> {
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
  return HttpServerResponse.text(text, { status, headers: responseHeaders(origin) });
}

function jsonResponse(
  value: unknown,
  status: number,
  origin: string | undefined,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(value, { status, headers: responseHeaders(origin) });
}

/** Cross-origin preflight for the renderer served from another port. */
export function makeTerminalUploadPreflightHandler(): (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return (request) => {
    const origin = request.headers.origin;
    if (!isLoopbackOrigin(origin)) return Effect.succeed(textResponse("Forbidden", 403, origin));
    return Effect.succeed(
      HttpServerResponse.empty({
        status: 204,
        headers: {
          ...responseHeaders(origin),
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      }),
    );
  };
}

export function makeTerminalUploadHandler(
  upload: TerminalUpload,
): (
  request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse> {
  return (request) =>
    Effect.gen(function* () {
      const origin =
        typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      if (!isLoopbackOrigin(origin)) return textResponse("Forbidden", 403, origin);
      const url = HttpServerRequest.toURL(request);
      if (!url) return textResponse("Bad request", 400, origin);
      const fileName = (url.searchParams.get("name") ?? "").trim();
      const mimeType = (url.searchParams.get("mimeType") ?? "").trim();
      if (!fileName || fileName.length > MAX_NAME_CHARS)
        return textResponse("Invalid file name.", 400, origin);
      if (!mimeType || mimeType.length > MAX_MIME_CHARS)
        return textResponse("Invalid file type.", 400, origin);
      const declared = Number(request.headers["content-length"] ?? 0);
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES)
        return textResponse("File is too large.", 413, origin);
      // debt: the body is buffered in memory before the daemon upload. Stream it
      // through if maximum-size terminal drops become common.
      const bytes = new Uint8Array(yield* request.arrayBuffer);
      if (bytes.byteLength === 0) return textResponse("Empty file.", 400, origin);
      if (bytes.byteLength > MAX_UPLOAD_BYTES)
        return textResponse("File is too large.", 413, origin);
      // Effect.promise would turn a rejection into a defect that skips the catch below.
      return yield* Effect.tryPromise({
        try: () => upload({ fileName, mimeType, bytes }),
        catch: (error) => (error instanceof Error ? error.message : String(error)),
      }).pipe(
        Effect.map((path) => jsonResponse({ path }, 200, origin)),
        Effect.catch((message) => Effect.succeed(textResponse(message, 500, origin))),
      );
    }).pipe(Effect.catch(() => Effect.succeed(textResponse("Upload failed.", 500, undefined))));
}
