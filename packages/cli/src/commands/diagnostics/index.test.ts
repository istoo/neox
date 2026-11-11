import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import {
  createCpuCommand,
  createGoroutinesCommand,
  createHeapCommand,
  createHealthcheckCommand,
  createLogCommand,
} from "./index.js";

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return { ...actual, connectToDaemon: vi.fn() };
});

function fakeDaemon() {
  const client = {
    getLastServerInfoMessage: () => ({ features: { daemonDiagnostics: true } }),
    writeDaemonHeapSnapshot: vi.fn(async () => undefined),
    writeDaemonCpuProfile: vi.fn(async () => undefined),
    writeDaemonHandlesDump: vi.fn(async () => undefined),
    getDaemonStatus: vi.fn(async () => ({ running: true })),
    close: vi.fn(async () => undefined),
  };
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client as never);
  return client;
}

let home: string;
let printed: string[];

async function run(...args: string[]): Promise<string[]> {
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    printed.push(values.map(String).join(" "));
  });
  await createLogCommand().parseAsync(args, { from: "user" });
  return printed;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-log-cli-"));
  process.env.NEOLIX_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

describe("neox log", () => {
  it("prints the daemon log's path alone with --path", async () => {
    expect((await run("--path")).join(" ")).toBe(join(home, "daemon.log"));
  });

  it("says nothing is written yet when there is no log", async () => {
    expect((await run()).join("\n")).toContain("nothing yet");
  });

  it("tails the last n lines", async () => {
    writeFileSync(join(home, "daemon.log"), "one\ntwo\nthree\nfour\n");
    expect(await run("-n", "2")).toEqual(["three", "four"]);
  });

  it("refuses -n with --path", async () => {
    await expect(run("--path", "-n", "2")).rejects.toThrow(/--path prints the path alone/);
  });

  it("refuses a lines count that is not one", async () => {
    writeFileSync(join(home, "daemon.log"), "one\n");
    await expect(run("-n", "soon")).rejects.toThrow(/-n takes a number of lines/);
  });

  it("reads the log of the home --home selects", async () => {
    const other = mkdtempSync(join(tmpdir(), "neolix-log-other-"));
    process.env.NEOLIX_HOME = other;
    expect((await run("--path", "--home", home)).join(" ")).toBe(join(home, "daemon.log"));
  });

  it("refuses --host: the log is a local file", async () => {
    await expect(run("--path", "--host", "127.0.0.1:6767")).rejects.toMatchObject({
      code: "LOCAL_OPERATION",
    });
  });
});

describe("neox heap, cpu, goroutines and healthcheck", () => {
  it("uses the daemon --home selects", async () => {
    const target = { kind: "instance" as const, home: resolveNeolixHome({ NEOLIX_HOME: home }) };
    for (const [make, args] of [
      [createHeapCommand, [join(home, "heap.snapshot")]],
      [createCpuCommand, [join(home, "cpu.cpuprofile")]],
      [createGoroutinesCommand, [join(home, "handles.json")]],
      [createHealthcheckCommand, []],
    ] as const) {
      const client = fakeDaemon();
      await make().parseAsync([...args, "--home", home], { from: "user" });
      expect(client.close).toHaveBeenCalled();
      expect(connectToDaemon).toHaveBeenLastCalledWith({ target });
    }
  });

  it("healthcheck exits 0 when the daemon answers", async () => {
    const client = fakeDaemon();
    await createHealthcheckCommand().parseAsync(["--home", home], { from: "user" });
    expect(client.getDaemonStatus).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });
});
