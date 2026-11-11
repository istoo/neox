import { describe, expect, it } from "vitest";
import { AUTH_FAIL_BURST, AUTH_FAIL_REFILL_MS, AuthFailThrottle } from "./auth-throttle.js";

describe("AuthFailThrottle", () => {
  it("tolerates the burst, then answers over with a wait", () => {
    const throttle = new AuthFailThrottle();
    let now = 1_000;
    for (let index = 0; index < AUTH_FAIL_BURST; index += 1) {
      expect(throttle.check(now).over).toBe(false);
    }
    const over = throttle.check(now);
    expect(over.over).toBe(true);
    expect(over.retryAfterMs).toBeGreaterThan(0);
    expect(over.retryAfterMs).toBeLessThanOrEqual(AUTH_FAIL_REFILL_MS);
  });

  it("frees one attempt per refill period", () => {
    const throttle = new AuthFailThrottle();
    let now = 5_000;
    for (let index = 0; index < AUTH_FAIL_BURST; index += 1) {
      throttle.check(now);
    }
    expect(throttle.check(now).over).toBe(true);
    now += AUTH_FAIL_REFILL_MS;
    expect(throttle.check(now).over).toBe(false);
    // The freed token was spent; the next attempt is over again.
    expect(throttle.check(now).over).toBe(true);
  });

  it("never carries more than the burst after an idle spell", () => {
    const throttle = new AuthFailThrottle();
    let now = 10_000;
    throttle.check(now);
    now += AUTH_FAIL_REFILL_MS * 10_000;
    for (let index = 0; index < AUTH_FAIL_BURST; index += 1) {
      expect(throttle.check(now).over).toBe(false);
    }
    expect(throttle.check(now).over).toBe(true);
  });

  it("resets to a full bucket", () => {
    const throttle = new AuthFailThrottle();
    const now = 20_000;
    for (let index = 0; index < AUTH_FAIL_BURST + 1; index += 1) {
      throttle.check(now);
    }
    expect(throttle.check(now).over).toBe(true);
    throttle.reset(now);
    expect(throttle.check(now).over).toBe(false);
  });
});
