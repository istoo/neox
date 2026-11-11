import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PricingCatalog } from "./pricing-catalog.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];

async function catalog(): Promise<PricingCatalog> {
  const home = await mkdtemp(join(tmpdir(), "neolix-pricing-"));
  homes.push(home);
  return new PricingCatalog({ neolixHome: home, logger });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("PricingCatalog.refresh", () => {
  it("reports the prices it holds and writes the cache", async () => {
    const prices = await catalog();
    vi.stubGlobal("fetch", async () => {
      return new Response(
        JSON.stringify({
          acme: { models: { m: { cost: { input: 1, output: 2 } } } },
        }),
        { status: 200 },
      );
    });
    expect(await prices.refresh(Date.now())).toEqual({ ok: true, models: 1 });
    expect(await readFile(prices.filePath, "utf8")).toContain('"acme/m"');
  });

  it("says why models.dev's refusal kept the old cache", async () => {
    const prices = await catalog();
    vi.stubGlobal("fetch", async () => new Response("no", { status: 503 }));
    expect(await prices.refresh(Date.now())).toEqual({
      ok: false,
      error: "models.dev answered 503",
    });
  });

  it("reports a transport failure rather than throwing", async () => {
    const prices = await catalog();
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(await prices.refresh(Date.now())).toEqual({
      ok: false,
      error: "connect ECONNREFUSED",
    });
  });
});
