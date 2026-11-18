import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeLaunchExecutable,
  claudeWslArguments,
  claudeWslEnvNames,
  posixShimContent,
  windowsShimContent,
  wslEnvEntries,
  writeClaudeWslShim,
} from "./wsl-shim.js";

const TOOL = {
  distro: "Ubuntu",
  path: "/home/u/.local/bin/claude",
  pathEnv: "/usr/local/bin:/usr/bin",
  host: null,
  home: "/home/u",
};

const LISTING = ["  NAME      STATE     VERSION", "* Ubuntu    Running   2", ""].join("\r\n");

const PROBE = [
  "home:/home/u",
  "path:/usr/local/bin:/usr/bin",
  "bin:/home/u/.local/bin/claude",
  "route:default via 172.20.0.1 dev eth0",
  "net:nat",
  "win:/mnt/",
  "",
].join("\n");

describe("Claude's WSL shim", () => {
  let neolixHome: string;

  beforeEach(async () => {
    neolixHome = await fs.mkdtemp(path.join(os.tmpdir(), "neolix-claude-wsl-"));
  });

  afterEach(async () => {
    await fs.rm(neolixHome, { recursive: true, force: true });
  });

  it("writes a Windows .cmd that hands the arguments to the distro's Claude", async () => {
    const file = await writeClaudeWslShim({
      neolixHome,
      tool: TOOL,
      cwd: "C:\\work",
      env: {
        SOMETHING: "C:\\Users\\me\\x",
        CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude",
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      },
      platform: "win32",
    });
    expect(path.extname(file)).toBe(".cmd");
    const text = await fs.readFile(file, "utf8");
    expect(text).toBe(
      '@echo off\r\nif defined WSLENV (set "WSLENV=%WSLENV%:SOMETHING:CLAUDE_CONFIG_DIR/p:' +
        'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS") else (set "WSLENV=SOMETHING:' +
        'CLAUDE_CONFIG_DIR/p:CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS")\r\nwsl.exe "-d" "Ubuntu" ' +
        '"--cd" "/mnt/c/work" "--exec" "/usr/bin/env" "PATH=/usr/local/bin:/usr/bin" ' +
        '"/home/u/.local/bin/claude" %*\r\n',
    );
    // A value is never written: WSLENV names it instead.
    expect(text).not.toContain("C:\\Users\\me\\x");
    expect(text).not.toContain("C:\\Users\\me\\.claude");
  });

  // Windows has no POSIX mode bits, so the 0700 the shim is written with is
  // only observable on the platforms that have them.
  it.skipIf(process.platform === "win32")("keeps the shim and its folder private", async () => {
    const file = await writeClaudeWslShim({
      neolixHome,
      tool: TOOL,
      cwd: "C:\\work",
      platform: "linux",
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it("writes a sh script off Windows and reuses the same file", async () => {
    const first = await writeClaudeWslShim({
      neolixHome,
      tool: TOOL,
      cwd: "C:\\work",
      platform: "linux",
    });
    const second = await writeClaudeWslShim({
      neolixHome,
      tool: TOOL,
      cwd: "C:\\work",
      platform: "linux",
    });
    expect(second).toBe(first);
    expect(path.extname(first)).toBe(".sh");
    const text = await fs.readFile(first, "utf8");
    expect(text.startsWith("#!/bin/sh\nexec wsl.exe ")).toBe(true);
    expect(text).toContain("'--cd' '/mnt/c/work'");
    expect(text.endsWith(`'/home/u/.local/bin/claude' "$@"\n`)).toBe(true);
  });

  it("points the SDK at the shim when Claude lives only in a distro", async () => {
    const exec = async (args: string[]) => {
      if (args[0] === "-l" && args[1] === "-v") return LISTING;
      if (args[0] === "-l" && args[1] === "-q") return "Ubuntu\n";
      if (args[0] === "-d") return PROBE;
      throw new Error("no such distro");
    };
    const executable = await claudeLaunchExecutable({
      binary: "/home/u/.local/bin/claude",
      neolixHome,
      cwd: "C:\\work",
      platform: "win32",
      deps: { exec, onHost: async () => false, platform: "win32" },
    });
    expect(path.extname(executable)).toBe(".cmd");
    expect(await fs.readFile(executable, "utf8")).toContain('"--cd" "/mnt/c/work"');

    // A Claude on this machine is started as it is.
    expect(
      await claudeLaunchExecutable({
        binary: "C:\\Users\\me\\AppData\\npm\\claude.exe",
        neolixHome,
        cwd: "C:\\work",
        platform: "win32",
        deps: { exec, onHost: async () => false, platform: "win32" },
      }),
    ).toBe("C:\\Users\\me\\AppData\\npm\\claude.exe");
  });

  it("builds the distro's arguments without a Windows PATH", () => {
    expect(claudeWslArguments(TOOL, "C:\\work")).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/mnt/c/work",
      "--exec",
      "/usr/bin/env",
      "PATH=/usr/local/bin:/usr/bin",
      "/home/u/.local/bin/claude",
    ]);
  });

  it("passes WSL the variables' names alone, and never a value", () => {
    expect(
      claudeWslEnvNames({
        PATH: "C:\\Windows",
        WSLENV: "TERM",
        "bad-name": "x",
        SOMETHING: "C:\\Users\\me\\x",
      }),
    ).toEqual(["SOMETHING"]);
    // myna's /p list, and only it: everything else goes by name alone.
    expect(wslEnvEntries(["CLAUDE_CONFIG_DIR", "BROWSER", "MYNA_OPENED_URL", "HOME", "K"])).toEqual(
      ["CLAUDE_CONFIG_DIR/p", "BROWSER/p", "MYNA_OPENED_URL/p", "HOME", "K"],
    );
    const script = posixShimContent(["a b"], ["SOMETHING"]);
    expect(script).toBe(
      `#!/bin/sh\nWSLENV="\${WSLENV:+$WSLENV:}SOMETHING" exec wsl.exe 'a b' "$@"\n`,
    );
    expect(windowsShimContent([], [])).toBe("@echo off\r\nwsl.exe  %*\r\n");
  });

  it("keeps values out of the file and reuses it for the same names", async () => {
    const injected = "injected-secret-value";
    const first = await writeClaudeWslShim({
      neolixHome,
      tool: TOOL,
      cwd: "C:\\work",
      env: { ANTHROPIC_AUTH_TOKEN: injected },
      platform: "linux",
    });
    const text = await fs.readFile(first, "utf8");
    expect(text).not.toContain(injected);
    expect(text).toContain("ANTHROPIC_AUTH_TOKEN");
    // The name comes from the parts that are not secret: another token, one file.
    const second = await writeClaudeWslShim({
      neolixHome,
      tool: TOOL,
      cwd: "C:\\work",
      env: { ANTHROPIC_AUTH_TOKEN: "another-value" },
      platform: "linux",
    });
    expect(second).toBe(first);
  });
});
