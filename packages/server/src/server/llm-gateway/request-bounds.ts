import * as zlib from "node:zlib";
import type { Request as ExpressRequest, RequestHandler } from "express";

/**
 * Bounds a single request body without limiting how long a client may wait
 * for a provider slot (myna's request_bounds.go).
 *
 * Codex sends its bodies zstd-compressed to the ChatGPT backend and to a
 * custom provider's /v1/responses, and body-parser decodes only gzip, deflate
 * and br. A zstd body is decoded here, before any parser reads it, so the
 * parser sees the JSON it expects. The limit is on the decoded bytes, as
 * myna's is: a compressed turn of a long session is a fraction of what it
 * holds in memory.
 *
 * A body whose client stops sending is given up on after READ_TIMEOUT_MS of
 * no wire bytes, as myna's idleBody does: the timeout is the socket's own
 * inactivity and goes with the body, so a request waiting long for a
 * provider slot is not cut off.
 */

export const DEFAULT_BODY_LIMIT_BYTES = 512 << 20;
/** myna's defaultBodyTimeout, request_bounds.go. */
export const BODY_READ_TIMEOUT_MS = 60_000;

const zstd = zlib as unknown as {
  zstdDecompressSync(input: Buffer, options?: { maxOutputLength?: number }): Buffer;
};

interface BodyCarrier extends ExpressRequest {
  _body?: boolean;
}

/**
 * Decodes a zstd JSON body in place, before body-parser runs; every other
 * encoding is left to the parser. A body over the limit is answered 413
 * without asking the provider.
 */
export function createDecodedBodyMiddleware(
  limitBytes: number = DEFAULT_BODY_LIMIT_BYTES,
): RequestHandler {
  return (req, res, next) => {
    boundBodyRead(req, res);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > limitBytes) {
      refuse(res, 413, overLimit(limitBytes));
      return;
    }
    const encoding = String(req.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase();
    if (encoding !== "zstd") {
      next();
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    if (!contentType.toLowerCase().includes("json")) {
      refuse(res, 415, "a zstd body is read only as JSON");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (status: number, message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      refuse(res, status, message);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limitBytes) {
        fail(413, overLimit(limitBytes));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("aborted", () => {
      settled = true;
    });
    req.on("error", () => {
      settled = true;
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      let decoded: Buffer;
      try {
        decoded = zstd.zstdDecompressSync(Buffer.concat(chunks), {
          maxOutputLength: limitBytes,
        });
      } catch (error) {
        fail(
          error instanceof RangeError ? 413 : 400,
          error instanceof RangeError
            ? overLimit(limitBytes)
            : `request body is not zstd: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(decoded.toString("utf8"));
      } catch {
        refuse(res, 400, "request body is not JSON");
        return;
      }
      settled = true;
      const carrier = req as BodyCarrier;
      carrier.body = parsed;
      carrier._body = true;
      delete req.headers["content-encoding"];
      req.headers["content-length"] = String(decoded.byteLength);
      next();
    });
  };
}

/**
 * Gives up on a body whose client stops sending: the socket's inactivity
 * timer starts with the body and is cleared when it ends, so a turn waiting
 * for a provider slot is not cut off, and neither is a long streamed reply.
 */
function boundBodyRead(req: ExpressRequest, res: Parameters<RequestHandler>[1]): void {
  const length = Number(req.headers["content-length"] ?? 0);
  if (!(length > 0) && req.headers["transfer-encoding"] === undefined) {
    return;
  }
  const clear = (): void => {
    req.socket.setTimeout(0);
  };
  req.setTimeout(BODY_READ_TIMEOUT_MS, () => {
    clear();
    if (res.headersSent) {
      req.destroy();
      return;
    }
    refuse(res, 408, "request body read timed out");
    req.destroy();
  });
  req.once("end", clear);
  req.once("close", clear);
}

function overLimit(limit: number): string {
  return (
    `request body is over the gateway's limit of ${Math.floor(limit / (1 << 20))} MB (decoded); ` +
    "the provider was not asked"
  );
}

function refuse(res: Parameters<RequestHandler>[1], status: number, message: string): void {
  res.setHeader("connection", "close");
  res.status(status).json({ error: { message, type: "invalid_request_error" } });
}
