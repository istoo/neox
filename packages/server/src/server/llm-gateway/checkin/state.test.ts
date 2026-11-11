import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeCheckins, type CheckinRecord } from "./store.js";
import {
  beijingDay,
  beijingHour,
  isProvisional,
  retryAfter,
  runCheckin,
  settled,
  type CheckinAccount,
  type CheckinResult,
} from "./state.js";

function tempStore(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "neolix-checkin-")).then((dir) =>
    path.join(dir, "workbuddy-checkin.json"),
  );
}

function account(
  key: string,
  run: (signal?: AbortSignal) => Promise<CheckinResult>,
  overrides: Partial<CheckinAccount> = {},
): CheckinAccount {
  return { user: key, key, provider: "workbuddy", on: true, run, ...overrides };
}

describe("Beijing day", () => {
  it("turns at 16:00 UTC without a time zone database", () => {
    expect(beijingDay(new Date("2026-01-01T15:59:59.999Z"))).toBe("2026-01-01");
    expect(beijingDay(new Date("2026-01-01T16:00:00.000Z"))).toBe("2026-01-02");
    expect(beijingHour(new Date("2026-01-01T16:00:00.000Z"))).toBe(0);
    expect(beijingHour(new Date("2026-01-01T17:30:00.000Z"))).toBe(1);
  });
});

describe("provisional answers", () => {
  const beforeNoon: CheckinRecord = {
    day: "2026-01-02",
    at: "2026-01-01T17:00:00.000Z", // 01:00 Beijing
    outcome: "done",
  };

  it("asks a done before noon again, and settles it from noon on", () => {
    expect(isProvisional(beforeNoon)).toBe(true);
    expect(isProvisional({ ...beforeNoon, at: "2026-01-02T03:59:59.000Z" })).toBe(true);
    expect(isProvisional({ ...beforeNoon, at: "2026-01-02T04:00:00.000Z" })).toBe(false);
    expect(isProvisional({ ...beforeNoon, at: "2026-01-02T04:00:00.001Z" })).toBe(false);
  });

  it("settles an answer myna saw no claim for, and not a claim", () => {
    expect(isProvisional({ ...beforeNoon, outcome: "inactive" })).toBe(true);
    expect(isProvisional({ ...beforeNoon, outcome: "ineligible" })).toBe(true);
    expect(isProvisional({ ...beforeNoon, outcome: "claimed" })).toBe(false);
    expect(isProvisional({ ...beforeNoon, claimed: "2026-01-01T18:00:00.000Z" })).toBe(false);
  });
});

describe("retryAfter", () => {
  it("waits 30 minutes for an answer and backs off for an offline failure", () => {
    expect(retryAfter({ day: "d", at: "t", outcome: "failed" })).toBe(30 * 60_000);
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true })).toBe(60_000);
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true, tries: 1 })).toBe(
      2 * 60_000,
    );
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true, tries: 2 })).toBe(
      4 * 60_000,
    );
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true, tries: 3 })).toBe(
      8 * 60_000,
    );
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true, tries: 4 })).toBe(
      16 * 60_000,
    );
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true, tries: 5 })).toBe(
      30 * 60_000,
    );
    expect(retryAfter({ day: "d", at: "t", outcome: "failed", offline: true, tries: 9 })).toBe(
      30 * 60_000,
    );
  });
});

describe("settled", () => {
  const now = new Date("2026-01-02T04:00:00.000Z");
  const record: CheckinRecord = {
    day: "2026-01-02",
    at: "2026-01-02T03:45:00.000Z",
    outcome: "failed",
  };

  it("holds an answer of the day and waits out a failure's retry", () => {
    expect(settled(record, "2026-01-02", now, false)).toBe(true);
    expect(settled(record, "2026-01-02", now, true)).toBe(false);
    expect(settled(record, "2026-01-01", now, false)).toBe(false);
    expect(
      settled(
        { ...record, outcome: "done" },
        "2026-01-03",
        new Date("2026-01-03T00:00:00Z"),
        false,
      ),
    ).toBe(false);
    expect(settled({ ...record, outcome: "done" }, "2026-01-02", now, false)).toBe(true);
  });

  it("stops holding past until", () => {
    const withUntil: CheckinRecord = {
      ...record,
      outcome: "done",
      until: "2026-01-02T03:59:00.000Z",
    };
    expect(settled(withUntil, "2026-01-02", now, false)).toBe(false);
  });
});

describe("runCheckin", () => {
  it("reuses the day's answer instead of asking again", async () => {
    const storePath = await tempStore();
    await writeCheckins(storePath, {
      "workbuddy|u1": {
        day: "2026-01-02",
        at: "2026-01-02T01:00:00.000Z",
        outcome: "claimed",
        credit: 5,
      },
    });
    let called = 0;
    const entries = await runCheckin(
      [
        account("workbuddy|u1", async () => {
          called += 1;
          return { outcome: "claimed" };
        }),
      ],
      false,
      {
        storePath,
        by: "workbuddy",
        now: new Date("2026-01-02T02:00:00.000Z"),
      },
    );
    expect(called).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "claimed", asked: false, by: "workbuddy" });
  });

  it("asks a provisional answer again after 30 minutes, and a press at once", async () => {
    const storePath = await tempStore();
    await writeCheckins(storePath, {
      "workbuddy|u1": {
        day: "2026-01-02",
        at: "2026-01-01T17:00:00.000Z", // 01:00 Beijing, before noon
        outcome: "done",
      },
    });
    let called = 0;
    const make = () =>
      account("workbuddy|u1", async () => {
        called += 1;
        return { outcome: "claimed", credit: 7 };
      });

    await runCheckin([make()], false, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-01T17:10:00.000Z"),
    });
    expect(called).toBe(0);

    const entries = await runCheckin([make()], false, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T03:00:00.000Z"),
    });
    expect(called).toBe(1);
    expect(entries[0]).toMatchObject({ outcome: "claimed", asked: true });
    expect(entries[0].claimed).toBe("2026-01-02T03:00:00.000Z");

    // A press asks an unclaimed answer again even inside the 30 minutes.
    await writeCheckins(storePath, {
      "workbuddy|u1": {
        day: "2026-01-02",
        at: "2026-01-02T03:00:00.000Z",
        outcome: "done",
      },
    });
    called = 0;
    await runCheckin([make()], true, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T03:01:00.000Z"),
    });
    expect(called).toBe(1);
  });

  it("leaves an account the user switched off alone, unless asked by its key", async () => {
    const storePath = await tempStore();
    let called = 0;
    const make = () =>
      account("workbuddy|u1", async () => {
        called += 1;
        return { outcome: "claimed" };
      });

    const skipped = await runCheckin([make()], false, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T02:00:00.000Z"),
      off: ["workbuddy|u1"],
    });
    expect(called).toBe(0);
    expect(skipped).toHaveLength(0);

    await runCheckin([make()], true, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T02:00:00.000Z"),
      off: ["workbuddy|u1"],
      only: "workbuddy|u1",
    });
    expect(called).toBe(1);
  });

  it("asks an account signed in twice only once", async () => {
    const storePath = await tempStore();
    let called = 0;
    const make = () =>
      account("workbuddy|u1", async () => {
        called += 1;
        return { outcome: "done" };
      });
    const entries = await runCheckin([make(), make()], false, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T02:00:00.000Z"),
    });
    expect(called).toBe(1);
    expect(entries).toHaveLength(1);
  });

  it("treats an unreadable file as unknown: asks nothing and writes nothing", async () => {
    const storePath = await tempStore();
    await writeFile(storePath, "{ cut short");
    let called = 0;
    const entries = await runCheckin(
      [
        account("workbuddy|u1", async () => {
          called += 1;
          return { outcome: "claimed" };
        }),
      ],
      false,
      {
        storePath,
        by: "workbuddy",
        now: new Date("2026-01-02T02:00:00.000Z"),
      },
    );
    expect(called).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("failed");
    expect(entries[0].msg).toContain("doesn't parse");
    expect(await readFile(storePath, "utf8")).toBe("{ cut short");
  });

  it("counts offline tries across runs and writes the file 0600", async () => {
    const storePath = await tempStore();
    const offline = (): Promise<CheckinResult> =>
      Promise.resolve({ outcome: "failed", msg: "fetch failed", offline: true });

    await runCheckin([account("workbuddy|u1", offline)], false, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T02:00:00.000Z"),
    });
    const entries = await runCheckin([account("workbuddy|u1", offline)], true, {
      storePath,
      by: "workbuddy",
      now: new Date("2026-01-02T02:01:00.000Z"),
    });
    expect(entries[0].tries).toBe(1);
    expect(entries[0].offline).toBe(true);
    const mode = (await stat(storePath)).mode & 0o777;
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });
});
