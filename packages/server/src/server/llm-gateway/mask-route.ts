/**
 * "Instead of masking, send to" (myna's RedactRouteTo): an agent's request
 * that masking would change goes as written to the model the user picked,
 * one whose every route is set to take requests unmasked, so it answers
 * about the real names. The request is never masked and sent elsewhere, and
 * a failure of that model is the request's. This is the decision; routing
 * the request there stays in the attempt loop.
 */

import type { MaskHit } from "./masking.js";

/** A model the user may pick: only one that takes requests unmasked. */
export interface MaskRouteTarget {
  /** "provider/model" or a group's id, as the gateway resolves it. */
  id: string;
  /** Every place it can go is set to take requests unmasked. */
  unmasked: boolean;
}

/** How many values masking actually swapped (a warned one goes as written). */
export function maskedCount(hits: readonly MaskHit[]): number {
  return hits.filter((hit) => hit.action === undefined || hit.action === "mask").length;
}

/** Whether every provider a request may go to takes it unmasked. */
export function unmaskedRoute(providers: readonly { unredacted?: boolean }[]): boolean {
  return providers.length > 0 && providers.every((provider) => provider.unredacted === true);
}

/** Whether a route id has the "provider/model" shape the settings ask for. */
export function validRouteId(id: string): boolean {
  const trimmed = id.trim();
  return (
    trimmed !== "" && trimmed.includes("/") && !trimmed.startsWith("/") && !trimmed.endsWith("/")
  );
}

/**
 * The model an agent's request that masking changed goes to as written,
 * or null to mask it as before.
 */
export function maskRouteFor(input: {
  hits: readonly MaskHit[];
  /** The request came from an agent, not the gateway asking for itself. */
  agentTurn: boolean;
  routeTo: string | undefined;
  /** The route resolved, and every place it can go takes requests unmasked. */
  target: MaskRouteTarget | null;
  /** The calling key may use that model. */
  keyAllows: boolean;
}): string | null {
  if (maskedCount(input.hits) === 0 || !input.agentTurn) {
    return null;
  }
  const route = (input.routeTo ?? "").trim();
  if (!validRouteId(route) || input.target === null || !input.target.unmasked) {
    return null;
  }
  return input.keyAllows ? route : null;
}
