/**
 * Reply headers a gateway middleware changed. The response a middleware
 * returns carries them, but delivery only passes a provider's listed reply
 * headers on; this marks the names its middleware added or changed so they
 * reach the client too.
 */
const marked = new WeakMap<object, string[]>();

/** Records the reply-header names a middleware set on `response`. */
export function markMiddlewareReplyHeaders(response: unknown, names: string[]): void {
  if (typeof response === "object" && response !== null) {
    marked.set(response, names);
  }
}

/** The reply-header names a middleware set on `response`, if any. */
export function middlewareReplyHeaderNames(response: unknown): string[] {
  if (typeof response !== "object" || response === null) return [];
  return marked.get(response) ?? [];
}
