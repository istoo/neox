import { describe, expect, it } from "vitest";
import {
  CODEX_RESET_LEAD_DEFAULT,
  RESET_EXPIRY_CLOSE_MS,
  RESET_EXPIRY_WATCH_MS,
  autoResetMode,
  autoResetWhen,
  expiringResetSpent,
  nextResetLook,
  resetExpiryNear,
  resetLeadMinutes,
} from "./codex-reset.js";

const now = Date.parse("2026-11-06T12:00:00.000Z");
const minutes = (n: number): number => n * 60_000;

describe("resetLeadMinutes", () => {
  it("keeps a set value inside myna's range", () => {
    expect(resetLeadMinutes(15)).toBe(15);
    expect(resetLeadMinutes(1440)).toBe(1440);
  });

  it("falls back to half an hour when unset or out of range", () => {
    expect(resetLeadMinutes(undefined)).toBe(CODEX_RESET_LEAD_DEFAULT);
    expect(resetLeadMinutes(14)).toBe(30);
    expect(resetLeadMinutes(1441)).toBe(30);
  });
});

describe("autoResetWhen", () => {
  it("reads the mode myna keeps", () => {
    expect(autoResetWhen("auto")).toEqual({ week: true, expiring: true });
    expect(autoResetWhen("week")).toEqual({ week: true, expiring: false });
    expect(autoResetWhen("expiring")).toEqual({ week: false, expiring: true });
    expect(autoResetWhen(undefined)).toEqual({ week: false, expiring: false });
  });

  it("turns two switches back into a mode, off when neither is on", () => {
    expect(autoResetMode(true, true)).toBe("auto");
    expect(autoResetMode(true, false)).toBe("week");
    expect(autoResetMode(false, true)).toBe("expiring");
    expect(autoResetMode(false, false)).toBeUndefined();
  });
});

describe("expiringResetSpent", () => {
  it("spends the reset the lead before it runs out", () => {
    expect(expiringResetSpent({ until: now + minutes(120), now, stopped: false, back: null })).toBe(
      now + minutes(90),
    );
  });

  it("uses a lead of its own", () => {
    expect(
      expiringResetSpent({
        until: now + minutes(120),
        now,
        stopped: false,
        back: null,
        leadMinutes: 60,
      }),
    ).toBe(now + minutes(60));
  });

  it("spends it at once when the lead has already passed", () => {
    expect(expiringResetSpent({ until: now + minutes(10), now, stopped: false, back: null })).toBe(
      now,
    );
  });

  it("spends it at once when the account is held up past then", () => {
    expect(
      expiringResetSpent({
        until: now + minutes(120),
        now,
        stopped: true,
        back: now + minutes(100),
      }),
    ).toBe(now);
  });

  it("waits when the account is free well before then", () => {
    expect(
      expiringResetSpent({
        until: now + minutes(120),
        now,
        stopped: true,
        back: now + minutes(30),
      }),
    ).toBe(now + minutes(90));
  });

  it("does nothing for a reset that has run out already", () => {
    expect(expiringResetSpent({ until: now, now, stopped: false, back: null })).toBe(0);
  });
});

describe("nextResetLook", () => {
  it("looks every watch interval until the near window starts", () => {
    expect(nextResetLook({ until: now + minutes(240), now })).toBe(now + RESET_EXPIRY_WATCH_MS);
  });

  it("never looks past the start of the near window", () => {
    expect(nextResetLook({ until: now + minutes(80), now })).toBe(
      now + minutes(80) - resetExpiryNear(30),
    );
  });

  it("looks every close interval inside the near window", () => {
    expect(nextResetLook({ until: now + minutes(45), now })).toBe(now + RESET_EXPIRY_CLOSE_MS);
  });
});
