// Every RPC the Synara front end can call gets a handler. The bridge implements the ones Neox
// can back; the rest answer with a typed "not supported" error (unary) or an idle stream, so the
// UI degrades per feature instead of the whole socket failing to build.
import { WsRpcError } from "@synara/contracts";
import { Effect, Stream } from "effect";
import { RpcSchema, type RpcGroup } from "effect/unstable/rpc";

export type AnyHandler = (payload: unknown, options: unknown) => unknown;

export const NOT_SUPPORTED_CODE = "neolix.not-supported";

export function notSupported(method: string): WsRpcError {
  return new WsRpcError({
    message: `Neox does not support ${method} yet.`,
    code: NOT_SUPPORTED_CODE,
    params: { method },
    retryable: false,
  });
}

// oxlint-disable-next-line typescript/no-explicit-any -- any group; only its request map is read
type AnyGroup = RpcGroup.RpcGroup<any>;

export function isStreamRpc(group: AnyGroup, tag: string): boolean {
  const rpc = group.requests.get(tag) as
    | { successSchema: Parameters<typeof RpcSchema.isStreamSchema>[0] }
    | undefined;
  return rpc !== undefined && RpcSchema.isStreamSchema(rpc.successSchema);
}

/** Fills every method of `group` that `implemented` leaves out, and logs each call once. */
export function withStubs(
  group: AnyGroup,
  implemented: Record<string, AnyHandler>,
  log: (line: string) => void,
): Record<string, AnyHandler> {
  const seen = new Set<string>();
  const handlers: Record<string, AnyHandler> = {};
  for (const tag of group.requests.keys()) {
    const real = implemented[tag];
    const stream = isStreamRpc(group, tag);
    handlers[tag] = (payload, options) => {
      if (!seen.has(tag)) {
        seen.add(tag);
        log(`${real ? "rpc" : "stub"} ${stream ? "stream" : "unary"} ${tag}`);
      }
      if (real) return real(payload, options);
      return stream ? Stream.never : Effect.fail(notSupported(tag));
    };
  }
  return handlers;
}
