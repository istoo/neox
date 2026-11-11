// FILE: rpcErrors.ts
// Purpose: One place where bridge failures get the stable `neolix.*` token the
//          front end translates. Handlers keep writing the English message the
//          daemon and CLI show; the token and its interpolation values ride
//          alongside it so the desktop UI can render the user's language.
// Layer: Bridge error plumbing.

import { WsRpcError } from "@synara/contracts";
import { Effect } from "effect";

export type ErrorParams = Readonly<Record<string, string | number>>;

/** A failure a handler knows how to name, thrown from async code. */
export class BridgeError extends Error {
  readonly token: string;
  readonly params: ErrorParams | undefined;

  constructor(token: string, message: string, params?: ErrorParams) {
    super(message);
    this.name = "BridgeError";
    this.token = token;
    this.params = params;
  }
}

/** `project.directory-missing` becomes the wire code `neolix.error.project.directory-missing`. */
export function bridgeError(token: string, message: string, params?: ErrorParams): BridgeError {
  return new BridgeError(token, message, params);
}

export function codedError(
  token: string,
  message: string,
  params?: ErrorParams,
  options?: { readonly retryable?: boolean },
): WsRpcError {
  return new WsRpcError({
    message,
    code: `neolix.error.${token}`,
    ...(params === undefined ? {} : { params }),
    ...(options?.retryable === undefined ? {} : { retryable: options.retryable }),
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Turns anything a handler throws into the RPC error the front end receives.
 * A named failure keeps its token; an already-tokenised error passes through;
 * anything else keeps its English message and is left untranslated.
 */
export function rpcError(cause: unknown): WsRpcError {
  if (cause instanceof WsRpcError) return cause;
  if (cause instanceof BridgeError) {
    return codedError(cause.token, cause.message, cause.params, { retryable: true });
  }
  return new WsRpcError({
    message: messageOf(cause),
    code: "neolix.error.unmapped",
    retryable: true,
  });
}

/**
 * The shared handler wrapper. The method name stays out of the message the user reads; an
 * unnamed failure is logged with it so the bridge log still says which call broke.
 */
export function fromPromise<A>(
  method: string,
  run: () => Promise<A>,
): Effect.Effect<A, WsRpcError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const error = rpcError(cause);
      if (error.code === "neolix.error.unmapped") {
        console.warn(`[bridge] ${method} failed: ${error.message}`);
      }
      return error;
    },
  });
}
