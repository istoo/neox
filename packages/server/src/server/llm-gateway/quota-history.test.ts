import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_QUOTA_HISTORY_FILENAME, QuotaHistoryStore } from "./quota-history.js";

const logger = pino({ level: "silent" });
const DAY_MS = 24 * 60 * 60_000;

describe("QuotaHistoryStore", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "neolix-quota-history-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("keeps a reading written before a restart", async () => {
    const readAt = Date.now() - 60_000;
    const resetAt = readAt + 3_600_000;
    const first = new QuotaHistoryStore({ neolixHome: home, logger });
    await first.start();
    first.record("p", "a", {
      remaining: 40,
      limit: 100,
      resetAt,
      usedPercent: 60,
      readAt,
    });
    await first.flush();

    const second = new QuotaHistoryStore({ neolixHome: home, logger });
    await second.start();
    const history = second.history(0);
    expect(history.get("p/a")).toEqual([
      {
        at: readAt,
        provider: "p",
        account: "a",
        remaining: 40,
        limit: 100,
        resetAt,
        usedPercent: 60,
      },
    ]);
  });

  it("leaves out a reading older than the 45 days it keeps", async () => {
    const now = Date.now();
    const old = {
      at: now - 46 * DAY_MS,
      provider: "p",
      account: "a",
      remaining: 1,
      limit: 2,
      resetAt: null,
      usedPercent: 50,
    };
    await appendFile(
      path.join(home, GATEWAY_QUOTA_HISTORY_FILENAME),
      `${JSON.stringify(old)}\n`,
      "utf8",
    );

    const store = new QuotaHistoryStore({ neolixHome: home, logger });
    await store.start();
    expect(store.history(0).size).toBe(0);
  });

  it("returns every reading, as myna's QuotaHistories does", async () => {
    const store = new QuotaHistoryStore({ neolixHome: home, logger });
    await store.start();
    const total = 1_000;
    for (let index = 0; index < total; index += 1) {
      store.record("p", "a", {
        remaining: index,
        limit: total,
        resetAt: null,
        usedPercent: null,
        readAt: index,
      });
    }
    const points = store.history(0).get("p/a") ?? [];
    expect(points).toHaveLength(total);
    expect(points.at(-1)?.at).toBe(total - 1);
  });

  it("narrows to one provider or one account, the account without case", async () => {
    const store = new QuotaHistoryStore({ neolixHome: home, logger });
    await store.start();
    const reading = { remaining: 1, limit: 2, resetAt: null, usedPercent: 50, readAt: 10 };
    store.record("codex", "Solo@Example.com", reading);
    store.record("claude", "own", reading);

    expect([...store.history(0, { provider: "codex" }).keys()]).toEqual(["codex/Solo@Example.com"]);
    expect([...store.history(0, { account: "solo@example.com" }).keys()]).toEqual([
      "codex/Solo@Example.com",
    ]);
    expect(store.history(0, { provider: "codex", account: "own" }).size).toBe(0);
  });

  it("adds the other computers' readings to the same account, each saying its computer", async () => {
    const other = {
      at: 20,
      provider: "p",
      account: "a",
      remaining: 30,
      limit: 100,
      resetAt: null,
      usedPercent: 70,
      device: "other",
    };
    const store = new QuotaHistoryStore({
      neolixHome: home,
      logger,
      sharedHistory: async () => [other],
    });
    await store.start();
    store.record("p", "a", {
      remaining: 40,
      limit: 100,
      resetAt: null,
      usedPercent: 60,
      readAt: 10,
    });

    const history = await store.historyWithShared(0);
    expect(history.get("p/a")).toEqual([
      {
        at: 10,
        provider: "p",
        account: "a",
        remaining: 40,
        limit: 100,
        resetAt: null,
        usedPercent: 60,
        device: "this",
      },
      other,
    ]);
  });

  it("keeps the other computers' different accounts apart", async () => {
    const store = new QuotaHistoryStore({
      neolixHome: home,
      logger,
      sharedHistory: async () => [
        {
          at: 20,
          provider: "p",
          account: "b",
          remaining: 30,
          limit: 100,
          resetAt: null,
          usedPercent: 70,
          device: "other",
        },
      ],
    });
    await store.start();
    store.record("p", "a", {
      remaining: 40,
      limit: 100,
      resetAt: null,
      usedPercent: 60,
      readAt: 10,
    });

    const history = await store.historyWithShared(0);
    expect([...history.keys()]).toEqual(["p/a", "p/b"]);
    expect(history.get("p/b")?.map((entry) => entry.device)).toEqual(["other"]);
  });

  it("is exactly the local history with no other computer's readings", async () => {
    const store = new QuotaHistoryStore({
      neolixHome: home,
      logger,
      sharedHistory: async () => [],
    });
    await store.start();
    store.record("p", "a", {
      remaining: 40,
      limit: 100,
      resetAt: null,
      usedPercent: 60,
      readAt: 10,
    });

    expect(await store.historyWithShared(0)).toEqual(store.history(0));
  });

  it("skips a line it cannot parse", async () => {
    await appendFile(path.join(home, GATEWAY_QUOTA_HISTORY_FILENAME), "not json\n", "utf8");
    const store = new QuotaHistoryStore({ neolixHome: home, logger });
    await store.start();
    expect(store.history(0).size).toBe(0);
  });
});
