import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import pino from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { RouteHistory } from "./route-history.js";

const logger = pino({ level: "silent" });
const homes: string[] = [];

afterAll(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function history(): Promise<RouteHistory> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-history-"));
  homes.push(home);
  const made = new RouteHistory({ neolixHome: home, logger });
  await made.start();
  return made;
}

const day = new Date().toISOString().slice(0, 10);

describe("the routing history", () => {
  it("keeps a day's routes in order", async () => {
    const made = await history();
    made.record({ id: "a", time: `${day}T10:00:00.000Z`, served: "probe/one" });
    made.record({ id: "b", time: `${day}T10:00:01.000Z`, served: "probe/two" });
    await made.dispose();
    const routes = await made.routes(day);
    expect(routes.map((route) => route.id)).toEqual(["a", "b"]);
    expect(await made.days()).toEqual([day]);
  });

  it("reads a day that was gzipped", async () => {
    const made = await history();
    const old = "2026-01-02";
    await writeFile(
      path.join(made.dir, `${old}.jsonl.gz`),
      gzipSync(`${JSON.stringify({ id: "old", served: "probe/one" })}\n`),
    );
    const routes = await made.routes(old);
    expect(routes.map((route) => route.id)).toEqual(["old"]);
  });

  it("ignores a day name that is not one, and a missing day", async () => {
    const made = await history();
    expect(await made.routes("../etc")).toEqual([]);
    expect(await made.routes("2020-01-01")).toEqual([]);
  });
});
