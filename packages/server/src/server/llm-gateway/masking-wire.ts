import type { MaskHit } from "./masking.js";

/** A hit as the wire carries it: the value's length is `len` there. */
export interface MaskHitWire extends Omit<MaskHit, "length"> {
  len: number;
}

export function maskHitsToWire(hits: readonly MaskHit[]): MaskHitWire[] {
  return hits.map(({ length, ...hit }) => ({ ...hit, len: length }));
}
