import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  configureHeldReports,
  HELD_KEPT,
  HeldReportStore,
  revealCommand,
  revealHeldReport,
} from "./held-report.js";

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-held-"));
}

const input = {
  method: "POST",
  path: "/v1/responses",
  model: "m1",
  agent: "codex",
  provider: "fake",
  waitedMs: 91_000,
  inFlight: 3,
};

describe("HeldReportStore", () => {
  it("writes a report that names the request and the wait, never the body", async () => {
    const store = new HeldReportStore(home());
    const name = await store.record(input);
    expect(name).toMatch(/^held-\d{8}-\d{6}-\d{9}\.txt$/);
    const report = await store.read(name!);
    expect(report).toContain("POST /v1/responses");
    expect(report).toContain("model: m1");
    expect(report).toContain("held: 91s waiting for an account");
    expect(report).toContain("requests in flight: 3");
    expect(report).toContain("where the event loop stood");
  });

  it("keeps the newest reports only", async () => {
    const store = new HeldReportStore(home());
    let now = Date.now();
    for (let index = 0; index < HELD_KEPT + 2; index += 1) {
      now += 1000;
      await store.record(input);
    }
    const names = readdirSync(store.dir).filter((name) => name.endsWith(".txt"));
    expect(names).toHaveLength(HELD_KEPT);
  });

  it("lists what it keeps, newest first, for the routing page", async () => {
    const store = new HeldReportStore(home());
    const first = await store.record(input);
    const second = await store.record(input);
    expect(await store.list()).toEqual([second, first]);
  });

  it("refuses a name that isn't a report's", async () => {
    const store = new HeldReportStore(home());
    expect(await store.read("../config.json")).toBeNull();
    expect(await store.read("held-nope.txt")).toBeNull();
  });

  it("builds the desktop's reveal command, and refuses names that aren't reports", async () => {
    expect(revealCommand("darwin", "/home/held", "held-1.txt")).toEqual({
      command: "open",
      args: ["-R", "/home/held/held-1.txt"],
    });
    expect(revealCommand("darwin", "/home/held")).toEqual({
      command: "open",
      args: ["/home/held"],
    });
    expect(revealCommand("linux", "/home/held", "held-1.txt")).toEqual({
      command: "xdg-open",
      args: ["/home/held"],
    });
    expect(revealCommand("win32", "C:\\home\\held").args).toEqual(["C:\\home\\held"]);

    const store = new HeldReportStore(home());
    configureHeldReports(store);
    expect((await revealHeldReport("../config.json")).ok).toBe(false);
    expect((await revealHeldReport("held-20000101-000000-000000000.txt")).error).toMatch(
      /no longer kept/,
    );
  });
});
