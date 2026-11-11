// FILE: errors.ts
// Purpose: Translate an RPC failure by its stable `neolix.*` code. The bridge
//          keeps sending the English message the daemon and CLI show; the UI
//          renders the keyed copy in the reader's language and falls back to
//          that message for a code this build does not know.
// Layer: i18n.

import { tWithDefault } from "./index";

const NEOLIX_ERROR_PREFIX = "neolix.error.";
const NOT_SUPPORTED_CODE = "neolix.not-supported";

type ErrorLike = {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly params?: unknown;
};

function asErrorLike(error: unknown): ErrorLike | null {
  return typeof error === "object" && error !== null ? (error as ErrorLike) : null;
}

/** The code an RPC failure carries, when it is one the bridge labeled. */
export function errorCodeOf(error: unknown): string | null {
  const code = asErrorLike(error)?.code;
  return typeof code === "string" ? code : null;
}

function translationKey(code: string): string | null {
  if (code === NOT_SUPPORTED_CODE) return "common:error_not_supported";
  if (!code.startsWith(NEOLIX_ERROR_PREFIX)) return null;
  const token = code.slice(NEOLIX_ERROR_PREFIX.length).replaceAll(/[.-]/g, "_");
  return `common:error_${token}`;
}

function valuesOf(error: ErrorLike): Record<string, string | number> {
  const params = error.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return {};
  const values: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number") values[key] = value;
  }
  return values;
}

/**
 * The message to show for a failure. A labeled bridge failure uses its locale
 * entry; anything else (a daemon message, a transport error, a plain `Error`)
 * keeps the text it arrived with.
 */
export function translateErrorMessage(error: unknown): string {
  const like = asErrorLike(error);
  const raw = like?.message;
  const fallback = typeof raw === "string" ? raw : String(error);
  if (like === null) return fallback;
  const code = errorCodeOf(error);
  if (code === null) return fallback;
  const key = translationKey(code);
  if (key === null) return fallback;
  return tWithDefault(key, fallback, valuesOf(like));
}

/**
 * Returns an error of the same shape whose `message` is translated. Identity is
 * preserved when there is nothing to translate, so callers that compare or log
 * the original keep seeing it.
 */
export function localizeRpcError<T>(error: T): T {
  const like = asErrorLike(error);
  if (like === null || typeof like.message !== "string") return error;
  const message = translateErrorMessage(error);
  if (message === like.message) return error;
  return Object.assign(Object.create(Object.getPrototypeOf(error)), error, { message }) as T;
}
