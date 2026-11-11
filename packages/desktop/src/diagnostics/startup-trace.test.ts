import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("startup trace", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("appends phases to the file named by NEOLIX_DESKTOP_STARTUP_TRACE", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "neolix-startup-trace-"));
    dirs.push(dir);
    const tracePath = path.join(dir, "trace.log");
    vi.stubEnv("NEOLIX_DESKTOP_STARTUP_TRACE", tracePath);

    const { traceStartup } = await import("./startup-trace");
    traceStartup("bootstrap: app ready");

    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    expect(lines[0]).toContain("main process start");
    expect(lines.at(-1)).toMatch(/ bootstrap: app ready$/);
  });

  it("writes nothing when the variable is unset", async () => {
    vi.stubEnv("NEOLIX_DESKTOP_STARTUP_TRACE", "");
    const { traceStartup } = await import("./startup-trace");
    expect(() => traceStartup("bootstrap: app ready")).not.toThrow();
  });
});
