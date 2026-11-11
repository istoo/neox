import { beforeEach, describe, expect, it } from "vitest";
import {
  findWslTool,
  findWslToolIn,
  forgetWslTools,
  hostLoopback,
  windowsToWslPath,
  wslLaunch,
  wslToolCommand,
} from "./wslrun.js";

const LISTING = ["  NAME      STATE     VERSION", "* Ubuntu    Running   2", ""].join("\r\n");

const PROBE = [
  "home:/home/reader",
  "path:/usr/local/bin:/usr/bin:/bin",
  "bin:/home/reader/.local/bin/claude",
  "route:default via 172.20.0.1 dev eth0",
  "net:nat",
  "win:/mnt/",
  "",
].join("\n");

function fakeWsl(outputs: Record<string, string>) {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "-l" && args[1] === "-v") return LISTING;
      if (args[0] === "-l" && args[1] === "-q") return "Ubuntu\n";
      const key = args[1] ?? "";
      const output = outputs[key];
      if (output === undefined) throw new Error("no such distro");
      return output;
    },
  };
}

describe("wslrun", () => {
  beforeEach(() => {
    forgetWslTools();
  });

  it("finds a command of a running distro and runs it there", async () => {
    const wsl = fakeWsl({ Ubuntu: PROBE });
    const deps = { platform: "win32" as const, exec: wsl.exec, onHost: async () => false };
    const tool = await findWslTool("claude", deps);
    expect(tool).toMatchObject({ distro: "Ubuntu", path: "/home/reader/.local/bin/claude" });

    const launch = await wslLaunch(
      { command: "claude", args: ["--version"], cwd: "C:\\Users\\reader\\project" },
      deps,
    );
    expect(launch).toEqual({
      command: "wsl.exe",
      args: ["-d", "Ubuntu", "-e", "/home/reader/.local/bin/claude", "--version"],
      cwd: "/mnt/c/Users/reader/project",
      home: "/home/reader",
    });
    expect(wsl.calls.filter((args) => args[0] === "-d")).toHaveLength(1);

    // An environment goes in as the distro's own PATH and variables, with
    // a Windows path spelt for it.
    const withEnv = await wslLaunch(
      {
        command: "claude",
        args: ["--version"],
        cwd: "C:\\Users\\reader\\project",
        env: { CODEX_HOME: "C:\\Users\\reader\\.codex", PLAIN: "x" },
      },
      deps,
    );
    expect(withEnv?.args).toEqual([
      "-d",
      "Ubuntu",
      "--exec",
      "/usr/bin/env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "CODEX_HOME=/mnt/c/Users/reader/.codex",
      "PLAIN=x",
      "/home/reader/.local/bin/claude",
      "--version",
    ]);
  });

  it("leaves a command Windows has alone, and looks in no distro off Windows", async () => {
    const deps = {
      platform: "win32" as const,
      exec: async () => LISTING,
      onHost: async () => true,
    };
    expect(await findWslTool("claude", deps)).toBeNull();
    expect(
      await findWslTool("claude", { platform: "darwin", exec: async () => LISTING }),
    ).toBeNull();
    expect(await findWslTool("claude", { platform: "win32", enabled: false })).toBeNull();
  });

  it("does not take a command on Windows' drives for the distro's", async () => {
    const output = PROBE.replace(
      "bin:/home/reader/.local/bin/claude",
      "bin:/mnt/c/Users/reader/AppData/Roaming/npm/claude",
    );
    expect(
      await findWslTool("claude", {
        platform: "win32",
        exec: fakeWsl({ Ubuntu: output }).exec,
        onHost: async () => false,
      }),
    ).toBeNull();
  });

  it("builds a found tool's command for a caller that spawns synchronously", () => {
    expect(
      wslToolCommand(
        {
          distro: "Ubuntu",
          path: "/home/u/.local/bin/claude",
          pathEnv: "/usr/local/bin:/usr/bin",
          host: null,
          home: "/home/u",
        },
        { args: ["--version"], cwd: "C:\\work", env: { CODEX_HOME: "C:\\Users\\me\\.codex" } },
      ),
    ).toEqual({
      command: "wsl.exe",
      args: [
        "-d",
        "Ubuntu",
        "--exec",
        "/usr/bin/env",
        "PATH=/usr/local/bin:/usr/bin",
        "CODEX_HOME=/mnt/c/Users/me/.codex",
        "/home/u/.local/bin/claude",
        "--version",
      ],
      cwd: "/mnt/c/work",
    });
  });

  it("spells Windows paths for the distro and knows mirrored networking", () => {
    expect(windowsToWslPath("C:\\Users\\reader\\project")).toBe("/mnt/c/Users/reader/project");
    expect(windowsToWslPath("D:\\")).toBe("/mnt/d");
    expect(windowsToWslPath("/home/reader")).toBe("/home/reader");
    expect(hostLoopback("mirrored")).toBe(true);
    expect(hostLoopback("consomme")).toBe(true);
    expect(hostLoopback("nat")).toBe(false);
  });

  it("finds a command in the distro named, even when this machine has one too", async () => {
    const wsl = fakeWsl({ Ubuntu: PROBE });
    const tool = await findWslToolIn("Ubuntu", "claude", {
      platform: "win32",
      exec: wsl.exec,
    });
    expect(tool).toMatchObject({ distro: "Ubuntu", path: "/home/reader/.local/bin/claude" });
    expect(wsl.calls.some((args) => args[0] === "-d" && args[1] === "Ubuntu")).toBe(true);
  });

  it("never starts a stopped distro to look in it", async () => {
    const calls: string[][] = [];
    const tool = await findWslToolIn("Ubuntu", "claude", {
      platform: "win32",
      exec: async (args) => {
        calls.push(args);
        return ["  NAME      STATE     VERSION", "* Ubuntu    Stopped   2", ""].join("\r\n");
      },
    });
    expect(tool).toBeNull();
    expect(calls.some((args) => args[0] === "-d")).toBe(false);
  });
});
