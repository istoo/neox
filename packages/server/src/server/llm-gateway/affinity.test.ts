import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AffinityStore } from "./affinity.js";

const logger = pino({ level: "silent" });

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-affinity-"));
}

describe("AffinityStore", () => {
  it("loads bindings written by a previous run", async () => {
    const dir = home();
    const now = Date.now();
    writeFileSync(
      path.join(dir, "gateway-affinity.json"),
      JSON.stringify({
        version: 1,
        bindings: [{ conversation: "conv-1", value: "p/m#a", at: now }],
      }),
    );
    const store = new AffinityStore({ neolixHome: dir, logger });
    const bindings = await store.load(now);
    expect(bindings.get("conv-1")).toBe("p/m#a");
  });

  it("drops bindings older than a day", async () => {
    const dir = home();
    const now = Date.now();
    writeFileSync(
      path.join(dir, "gateway-affinity.json"),
      JSON.stringify({
        version: 1,
        bindings: [
          { conversation: "old", value: "p/m", at: now - 25 * 60 * 60_000 },
          { conversation: "new", value: "p/m", at: now - 60_000 },
        ],
      }),
    );
    const store = new AffinityStore({ neolixHome: dir, logger });
    const bindings = await store.load(now);
    expect([...bindings.keys()]).toEqual(["new"]);
  });

  it("saves the current bindings", async () => {
    const dir = home();
    const store = new AffinityStore({ neolixHome: dir, logger });
    store.scheduleSave(new Map([["conv-9", "p/m#b"]]));
    store.dispose();
    const file = path.join(dir, "gateway-affinity.json");
    await waitForFile(file);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      bindings: Array<{ conversation: string; value: string }>;
    };
    expect(parsed.bindings).toContainEqual(
      expect.objectContaining({ conversation: "conv-9", value: "p/m#b" }),
    );
  });

  it("saves each binding's own time instead of refreshing them together", async () => {
    const dir = home();
    const now = Date.now();
    const oldAt = now - 23 * 60 * 60_000;
    const file = path.join(dir, "gateway-affinity.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        bindings: [{ conversation: "old", value: "p/m", at: oldAt }],
      }),
    );
    const store = new AffinityStore({ neolixHome: dir, logger });
    const bindings = await store.load(now);
    bindings.set("new", "q/m");
    store.scheduleSave(bindings);
    store.dispose();

    const parsed = await waitForBindings(file, 2);

    expect(parsed.bindings.find((entry) => entry.conversation === "old")?.at).toBe(oldAt);
    expect(
      parsed.bindings.find((entry) => entry.conversation === "new")?.at,
    ).toBeGreaterThanOrEqual(now);
  });
});

interface SavedBinding {
  conversation: string;
  value: string;
  at: number;
}

async function waitForBindings(file: string, count: number): Promise<{ bindings: SavedBinding[] }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { bindings: SavedBinding[] };
      if (parsed.bindings.length === count) {
        return parsed;
      }
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} bindings in ${file}`);
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      readFileSync(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}
