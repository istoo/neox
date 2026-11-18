import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { creditRestMs, isCreditFailure, REST_KEEP_MS, RestStore } from "./rests.js";

const logger = pino({ level: "silent" });

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-rests-"));
}

describe("credit ladder", () => {
  it("doubles the wait on every repeat and caps at a week", () => {
    expect(creditRestMs(1)).toBe(30 * 60_000);
    expect(creditRestMs(3)).toBe(8 * 60 * 60_000);
    expect(creditRestMs(20)).toBe(7 * 24 * 60 * 60_000);
  });

  it("treats payment and balance errors as credit failures", () => {
    expect(isCreditFailure(402, "")).toBe(true);
    expect(isCreditFailure(429, '{"error":"insufficient credit"}')).toBe(true);
    expect(isCreditFailure(400, "insufficient balance")).toBe(true);
    expect(isCreditFailure(500, "credit")).toBe(false);
    expect(isCreditFailure(429, "too many requests")).toBe(false);
  });
});

describe("RestStore", () => {
  it("keeps a lapsed rest's rung until it is over a month old", async () => {
    const dir = home();
    const now = Date.now();
    const file = path.join(dir, "gateway-rests.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        rests: [
          { key: "p/a", until: now + 60_000, level: 2 },
          { key: "p/b", until: now - 60_000, level: 3 },
          { key: "p/c", until: now - REST_KEEP_MS - 60_000, level: 4 },
          { key: "p/d", until: now + 60_000, level: 99 },
        ],
      }),
    );
    const store = new RestStore({ neolixHome: dir, logger });
    const loaded = await store.load(now);
    expect([...loaded.keys()].sort()).toEqual(["p/a", "p/b", "p/d"]);
    expect(loaded.get("p/b")?.level).toBe(3);
    expect(loaded.get("p/d")?.level).toBe(6);
  });

  it("saves a lapsed rest's rung while it is still kept", async () => {
    const dir = home();
    const store = new RestStore({ neolixHome: dir, logger });
    const now = Date.now();
    store.scheduleSave(
      new Map([
        ["p/a", { key: "p/a", until: now - 60_000, level: 2 }],
        ["p/b", { key: "p/b", until: now - REST_KEEP_MS - 60_000, level: 2 }],
      ]),
    );
    await store.dispose();
    const file = path.join(dir, "gateway-rests.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      rests: Array<{ key: string; level: number }>;
    };
    expect(parsed.rests.map((entry) => entry.key)).toEqual(["p/a"]);
  });

  it("saves active rests", async () => {
    const dir = home();
    const store = new RestStore({ neolixHome: dir, logger });
    store.scheduleSave(new Map([["p/a", { key: "p/a", until: Date.now() + 60_000, level: 3 }]]));
    await store.dispose();
    const file = path.join(dir, "gateway-rests.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      rests: Array<{ key: string; level: number }>;
    };
    expect(parsed.rests).toContainEqual(expect.objectContaining({ key: "p/a", level: 3 }));
  });

  it("writes nothing once disposed, and dispose waits for the save in flight", async () => {
    const dir = home();
    const file = path.join(dir, "gateway-rests.json");
    const store = new RestStore({ neolixHome: dir, logger });

    store.scheduleSave(new Map([["p/a", { key: "p/a", until: Date.now() + 60_000, level: 2 }]]));
    await store.dispose();
    // The save started by dispose() finished before it resolved.
    const written = readFileSync(file, "utf8");

    store.scheduleSave(new Map([["p/b", { key: "p/b", until: Date.now() + 60_000, level: 3 }]]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readFileSync(file, "utf8")).toBe(written);
  });
});
