/**
 * The route-events feed's ring: every finished route, in order, with the
 * cursor a reader resumes from — myna's `route_events.go`. Nothing is
 * persisted: the routing history is what survives a restart.
 */

const KEEP = 512;

interface RingEntry {
  cursor: number;
  route: Record<string, unknown>;
}

const ring: RingEntry[] = [];
let cursor = 0;

/** Publishes a finished route to readers, and drops the oldest past 512. */
export function publishRoute(route: Record<string, unknown>): number {
  cursor += 1;
  ring.push({ cursor, route });
  while (ring.length > KEEP) {
    ring.shift();
  }
  return cursor;
}

/** The routes after a cursor, and the feed's newest cursor. */
export function routesAfter(after: number): {
  cursor: number;
  routes: { cursor: number; route: Record<string, unknown> }[];
} {
  return { cursor, routes: ring.filter((entry) => entry.cursor > after) };
}

/** The feed's newest cursor. */
export function routeCursor(): number {
  return cursor;
}

/** Forgets the ring (tests, and a daemon shutting down). */
export function clearRouteEvents(): void {
  ring.length = 0;
  cursor = 0;
}
