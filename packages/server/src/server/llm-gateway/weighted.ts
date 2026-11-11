/**
 * Weighted routing over a provider's keys or accounts (myna's
 * `internal/gateway/weighted.go` and `internal/routes/round.go`): a pool's
 * requests spread by each seat's weight, as NGINX's smooth weighted round
 * robin does — seats weighing 3 and 1 go a, a, b, a, a, a, b, a…, the ratio
 * held over a handful of requests rather than only on average. A seat
 * resting after a failure is left out while it rests, so the others share
 * its requests by their own weights and it takes up its share when it is
 * back. The seat picked first, the others follow in the pool's order, for
 * failover (myna's `routes.First`).
 *
 * The pool is the provider's id; its seats are each key's or account's id,
 * weighing what `routing=weight` says. The state lives beside the routing's
 * other state, so the round survives across requests.
 */

/** One key or account as the round sees it. */
export interface WeightedSeat {
  /** The key's or account's id, as the provider names it. */
  id: string;
  /** How many requests it takes for each one of a seat weighing 1. */
  weight: number;
  /** Resting after a failure: left out of this round while it rests. */
  resting?: boolean;
}

/** What a weighted provider remembers between requests. */
export interface WeightedRound {
  /** Pool → seat id → its running score in the round. */
  scores: Map<string, Map<string, number>>;
}

export function weightedRound(): WeightedRound {
  return { scores: new Map() };
}

/**
 * The pool's seats in the order to try them: the one the round picks first,
 * then the rest in their own order. Seats no longer in the pool leave the
 * round; one resting neither takes a pick nor adds to the round's total. A
 * pool whose every seat rests keeps its own order.
 */
export function pickWeighted(
  round: WeightedRound,
  pool: string,
  seats: readonly WeightedSeat[],
): string[] {
  const order = seats.map((seat) => seat.id);
  if (seats.length === 0) {
    return order;
  }
  let scores = round.scores.get(pool);
  if (scores === undefined) {
    scores = new Map();
    round.scores.set(pool, scores);
  }
  const on = new Set(order);
  for (const id of scores.keys()) {
    if (!on.has(id)) {
      scores.delete(id);
    }
  }
  let total = 0;
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const [index, seat] of seats.entries()) {
    if (seat.resting === true) {
      continue;
    }
    const weight = Math.max(1, Math.trunc(seat.weight));
    const score = (scores.get(seat.id) ?? 0) + weight;
    scores.set(seat.id, score);
    total += weight;
    // a tie goes to the seat listed first, as myna's `>` keeps it
    if (best < 0 || score > bestScore) {
      best = index;
      bestScore = score;
    }
  }
  if (best < 0) {
    return order;
  }
  const picked = order[best] ?? "";
  scores.set(picked, (scores.get(picked) ?? 0) - total);
  return [picked, ...order.filter((id) => id !== picked)];
}
