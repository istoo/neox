import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renewOnce, tokenStale, writeAuthTokens } from "./oauth.js";

async function authFile(entry: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-auth-"));
  const file = path.join(dir, "plugin-auth.json");
  await writeFile(file, JSON.stringify({ workbuddy: entry }), "utf8");
  return file;
}

describe("tokenStale", () => {
  it("renews inside ten minutes, not before, and never without an expiry", () => {
    const now = 1_000_000_000;
    expect(tokenStale(undefined, now)).toBe(false);
    expect(tokenStale(0, now)).toBe(false);
    expect(tokenStale(now + 20 * 60_000, now)).toBe(false);
    expect(tokenStale(now + 5 * 60_000, now)).toBe(true);
    expect(tokenStale(now - 1, now)).toBe(true);
  });
});

describe("writeAuthTokens", () => {
  it("merges the token fields where the file still holds the spent token", async () => {
    const file = await authFile({ access: "old", refresh: "r1", uid: "u1", expires: 1 });
    const written = await writeAuthTokens({
      authPath: file,
      authKey: "workbuddy",
      expectedAccess: "old",
      tokens: { access: "new", refresh: "r2", expires: 99 },
    });
    expect(written).toBe(true);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      workbuddy: Record<string, unknown>;
    };
    expect(saved.workbuddy).toEqual({
      access: "new",
      refresh: "r2",
      uid: "u1",
      expires: 99,
    });
  });

  it("leaves a file another renewal changed alone", async () => {
    const file = await authFile({ access: "theirs", refresh: "r9", uid: "u1" });
    const written = await writeAuthTokens({
      authPath: file,
      authKey: "workbuddy",
      expectedAccess: "ours",
      tokens: { access: "new" },
    });
    expect(written).toBe(false);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      workbuddy: Record<string, unknown>;
    };
    expect(saved.workbuddy.access).toBe("theirs");
    expect(saved.workbuddy.refresh).toBe("r9");
  });

  it("says no for a missing or unreadable file", async () => {
    const missing = path.join(await mkdtemp(path.join(os.tmpdir(), "neolix-auth-")), "nope.json");
    await expect(
      writeAuthTokens({
        authPath: missing,
        authKey: "workbuddy",
        expectedAccess: "old",
        tokens: { access: "new" },
      }),
    ).resolves.toBe(false);
  });
});

describe("renewOnce", () => {
  it("runs one renewal per key while it is in flight", async () => {
    let calls = 0;
    const renew = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { access: "new" };
    };
    const [first, second] = await Promise.all([
      renewOnce("workbuddy:k1", renew),
      renewOnce("workbuddy:k1", renew),
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual({ access: "new" });
    expect(second).toEqual({ access: "new" });
    await renewOnce("workbuddy:k1", renew);
    expect(calls).toBe(2);
  });
});
