import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScienceKeeper,
  readScienceMark,
  scienceConnect,
  scienceDisconnect,
  scienceMarkPath,
  type ScienceEnvironment,
  type ScienceRun,
} from "./claude-science.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "neolix-science-home-"));
  await fs.mkdir(path.join(home, ".local", "bin"), { recursive: true });
  await fs.writeFile(path.join(home, ".local", "bin", "claude-science"), "#!/bin/sh\n", {
    mode: 0o755,
  });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  vi.useRealTimers();
});

function environment(runWithEnv: ScienceRun): ScienceEnvironment {
  return { homeDir: home, platform: "darwin", env: { PATH: "" }, runWithEnv };
}

/** A daemon whose status, stop and serve answer as claude-science's do. */
function fakeDaemon(initial: { running: boolean; pid: number; port: number }) {
  const state = { ...initial };
  const calls: { args: string[]; baseUrl: string | undefined }[] = [];
  let nextPid = 500;
  const run: ScienceRun = async (_command, args, env) => {
    calls.push({ args, baseUrl: env.ANTHROPIC_BASE_URL });
    if (args[0] === "status") {
      return JSON.stringify({
        running: state.running,
        pid: state.running ? state.pid : 0,
        port: state.port,
      });
    }
    if (args[0] === "stop") {
      state.running = false;
      return "";
    }
    if (args[0] === "serve") {
      state.running = true;
      state.pid = nextPid;
      nextPid += 1;
      const portAt = args.indexOf("--port");
      if (portAt >= 0) state.port = Number(args[portAt + 1]);
      return "";
    }
    return "";
  };
  return { state, calls, run };
}

describe("Claude Science", () => {
  it("starts the daemon on the gateway and puts it back off on disconnect", async () => {
    const daemon = fakeDaemon({ running: true, pid: 42, port: 4321 });
    const env = environment(daemon.run);
    const mark = await scienceConnect(env, "http://127.0.0.1:6767");

    expect(mark).toEqual({ url: "http://127.0.0.1:6767", pid: 500, port: 4321 });
    expect(daemon.calls.map((call) => call.args[0])).toEqual(["status", "stop", "serve", "status"]);
    expect(daemon.calls[2]?.baseUrl).toBe("http://127.0.0.1:6767");
    expect(await readScienceMark(env)).toEqual(mark);

    daemon.calls.length = 0;
    await scienceDisconnect(env);
    expect(daemon.calls.map((call) => call.args[0])).toEqual(["status", "stop", "serve", "status"]);
    expect(daemon.calls[2]?.baseUrl).toBeUndefined();
    expect(await readScienceMark(env)).toBeNull();
  });

  it("starts a daemon that is not running, and leaves one that is", async () => {
    const daemon = fakeDaemon({ running: false, pid: 0, port: 4321 });
    const env = environment(daemon.run);
    await fs.mkdir(path.dirname(scienceMarkPath(env)), { recursive: true });
    await fs.writeFile(
      scienceMarkPath(env),
      JSON.stringify({ url: "http://127.0.0.1:6767", pid: 42, port: 4321 }),
    );
    const keeper = createScienceKeeper({ environment: () => env });

    await keeper.tick();
    expect(daemon.calls.map((call) => call.args[0])).toEqual(["status", "serve", "status"]);
    expect(daemon.calls[1]?.baseUrl).toBe("http://127.0.0.1:6767");
    expect((await readScienceMark(env))?.pid).toBe(500);

    daemon.calls.length = 0;
    await keeper.tick();
    expect(daemon.calls.map((call) => call.args[0])).toEqual(["status"]);
  });

  it("does nothing while nothing is connected, and ticks once a minute", async () => {
    const daemon = fakeDaemon({ running: false, pid: 0, port: 4321 });
    const env = environment(daemon.run);
    const keeper = createScienceKeeper({ environment: () => env, intervalMs: 60_000 });
    await keeper.tick();
    expect(daemon.calls).toHaveLength(0);

    await fs.mkdir(path.dirname(scienceMarkPath(env)), { recursive: true });
    await fs.writeFile(
      scienceMarkPath(env),
      JSON.stringify({ url: "http://127.0.0.1:6767", pid: 42, port: 4321 }),
    );
    vi.useFakeTimers();
    const stop = await keeper.start();
    expect(daemon.calls.map((call) => call.args[0])).toEqual(["status", "serve", "status"]);
    // The minute's timer is armed, and stays armed after its first tick.
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
