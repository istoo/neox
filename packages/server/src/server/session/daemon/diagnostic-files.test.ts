import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDaemonHandlesDump, writeDaemonHeapSnapshot } from "./diagnostic-files.js";

describe("daemon diagnostic files", () => {
  it("dumps the active handles and requests as JSON", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-diagnostics-"));
    const file = join(home, "goroutines.json");
    await writeDaemonHandlesDump(file);
    const body = JSON.parse(readFileSync(file, "utf8")) as {
      program: string;
      resources: string[];
      handles: string[];
      requests: string[];
    };
    expect(body.program).toBe("neolix");
    expect(Array.isArray(body.resources)).toBe(true);
    expect(Array.isArray(body.handles)).toBe(true);
    expect(Array.isArray(body.requests)).toBe(true);
  });

  it("never writes over a file that is there", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-diagnostics-"));
    const file = join(home, "heap.heapsnapshot");
    writeFileSync(file, "already");
    await expect(writeDaemonHeapSnapshot(file)).rejects.toThrow(/is there already/);
    expect(readFileSync(file, "utf8")).toBe("already");
  });
});
