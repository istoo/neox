import type { Response as ExpressResponse } from "express";

/**
 * A publicly reachable gateway turns every request away without a valid key,
 * but nothing capped how fast a remote client could try keys: no limit let a
 * weak key be guessed, and each try was a yes/no oracle (myna's
 * auththrottle.go). This caps *failed remote* authentications. A request with
 * a valid key, and any request from this computer, never touch it, so a flood
 * of wrong keys can only turn later wrong keys into 429s.
 *
 * One token bucket is shared by all remote callers: keying it per address is
 * pointless behind a reverse proxy, where every caller arrives as the
 * proxy's. A shared bucket is safe only because valid keys bypass it.
 */

export const AUTH_FAIL_BURST = 50;
export const AUTH_FAIL_REFILL_MS = 1000;

export interface AuthThrottleVerdict {
  over: boolean;
  /** How long until a token frees, when `over`. */
  retryAfterMs: number;
}

export class AuthFailThrottle {
  private tokens = AUTH_FAIL_BURST;
  private last = 0;

  constructor(
    private readonly burst = AUTH_FAIL_BURST,
    private readonly refillMs = AUTH_FAIL_REFILL_MS,
  ) {}

  /** Records one refused remote authentication and says whether to answer 429. */
  public check(now: number = Date.now()): AuthThrottleVerdict {
    if (this.last === 0) {
      this.last = now;
    }
    this.tokens += (now - this.last) / this.refillMs;
    if (this.tokens > this.burst) {
      this.tokens = this.burst;
    }
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { over: false, retryAfterMs: 0 };
    }
    // No token left: the failure is not charged again while the bucket is empty.
    return { over: true, retryAfterMs: (1 - this.tokens) * this.refillMs };
  }

  public reset(now: number = Date.now()): void {
    this.tokens = this.burst;
    this.last = now;
  }
}

/** The gateway's bucket, as myna keeps one for the process. */
export const authFailThrottle = new AuthFailThrottle();

/**
 * Answers a failed authentication: a 429 with Retry-After while the bucket is
 * empty, the usual 401 otherwise. Only call it for a remote caller that
 * presented no valid key.
 */
export function refuseInvalidKey(res: ExpressResponse, now: number = Date.now()): void {
  const verdict = authFailThrottle.check(now);
  if (verdict.over) {
    res.setHeader("Retry-After", String(Math.floor(verdict.retryAfterMs / 1000) + 1));
    res.status(429).json({
      error: {
        message: "too many failed authentications; slow down and send an enabled gateway key",
        type: "too_many_requests",
      },
    });
    return;
  }
  res.status(401).json({ error: { message: "Invalid gateway key", type: "unauthorized" } });
}
