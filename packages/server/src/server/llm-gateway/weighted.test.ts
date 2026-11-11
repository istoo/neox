import { describe, expect, it } from "vitest";
import { pickWeighted, weightedRound, type WeightedSeat } from "./weighted.js";

function seats(...weights: Array<[string, number, boolean?]>): WeightedSeat[] {
  return weights.map(([id, weight, resting]) => {
    const seat: WeightedSeat = { id, weight };
    if (resting !== undefined) seat.resting = resting;
    return seat;
  });
}

describe("pickWeighted", () => {
  it("spreads by weight as a smooth round, keys of 3 and 1", () => {
    const round = weightedRound();
    const pool = seats(["a", 3], ["b", 1]);
    const picks = Array.from({ length: 8 }, () => pickWeighted(round, "p", pool)[0]);
    // myna's comment on weighted.go: a, a, b, a, a, a, b, a
    expect(picks).toEqual(["a", "a", "b", "a", "a", "a", "b", "a"]);
  });

  it("keeps the other seats in their own order after the pick", () => {
    const round = weightedRound();
    expect(pickWeighted(round, "p", seats(["a", 1], ["b", 1], ["c", 1]))).toEqual(["a", "b", "c"]);
    expect(pickWeighted(round, "p", seats(["a", 1], ["b", 1], ["c", 1]))).toEqual(["b", "a", "c"]);
  });

  it("leaves a resting seat out of the round, and the total", () => {
    const round = weightedRound();
    const rest = seats(["a", 1], ["b", 1, true]);
    for (let turn = 0; turn < 3; turn += 1) {
      expect(pickWeighted(round, "p", rest)[0]).toBe("a");
    }
    // back, it takes its share again: the two alternate from there
    const back = seats(["a", 1], ["b", 1]);
    const picks = Array.from({ length: 4 }, () => pickWeighted(round, "p", back)[0]);
    expect(picks).toEqual(["a", "b", "a", "b"]);
  });

  it("drops a seat that left the pool from the round", () => {
    const round = weightedRound();
    pickWeighted(round, "p", seats(["a", 1], ["b", 1]));
    pickWeighted(round, "p", seats(["a", 1]));
    expect(round.scores.get("p")?.has("b")).toBe(false);
  });

  it("keeps the pool's order when every seat rests", () => {
    const round = weightedRound();
    expect(pickWeighted(round, "p", seats(["a", 1, true], ["b", 2, true]))).toEqual(["a", "b"]);
    expect(round.scores.get("p")?.size).toBe(0);
  });

  it("keeps each pool's round apart", () => {
    const round = weightedRound();
    const pool = seats(["a", 1], ["b", 1]);
    expect(pickWeighted(round, "one", pool)[0]).toBe("a");
    expect(pickWeighted(round, "two", pool)[0]).toBe("a");
    expect(pickWeighted(round, "one", pool)[0]).toBe("b");
  });
});
