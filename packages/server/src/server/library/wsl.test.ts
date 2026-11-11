import { describe, expect, it } from "vitest";
import type { WslTool } from "../wslrun/wslrun.js";
import { checkMcpServerHealth } from "./health.js";
import { resolveLibraryAgentTargets } from "./paths.js";
import { rtkAgentKind } from "./rtk.js";
import {
  mcpWslCommand,
  rtkWslCommand,
  windowsCommandInWsl,
  wslEnvNames,
  wslMcpServer,
} from "./wsl.js";

const tool: WslTool = {
  distro: "Ubuntu",
  path: "/usr/bin/node",
  pathEnv: "/usr/local/bin:/usr/bin:/bin",
  host: "172.20.16.1",
  home: "/home/me",
};

describe("mcpWslCommand", () => {
  it("starts the distro's command, with the server's arguments", async () => {
    const launch = await mcpWslCommand(
      { command: "node", args: ["server.js"] },
      { find: async () => tool },
    );
    expect(launch?.command).toBe("wsl.exe");
    expect(launch?.args).toEqual(["-d", "Ubuntu", "-e", "/usr/bin/node", "server.js"]);
    expect(launch?.cwd).toBe("/home/me");
    expect(launch?.tool).toBe(tool);
  });

  it("hands the server's variables to the distro, Windows paths spelt for it", async () => {
    const launch = await mcpWslCommand(
      {
        command: "node",
        args: ["server.js"],
        env: { CONFIG: "C:\\Users\\me\\config.json", TOKEN: "abc" },
      },
      { find: async () => tool },
    );
    expect(launch?.args).toEqual([
      "-d",
      "Ubuntu",
      "--exec",
      "/usr/bin/env",
      `PATH=${tool.pathEnv}`,
      "CONFIG=/mnt/c/Users/me/config.json",
      "TOKEN=abc",
      "/usr/bin/node",
      "server.js",
    ]);
  });

  it("is null when the distro has no such command", async () => {
    expect(await mcpWslCommand({ command: "missing" }, { find: async () => null })).toBeNull();
  });
});

describe("rtkWslCommand", () => {
  it("runs the distro's rtk, not a Windows one", async () => {
    const rtk = { ...tool, path: "/home/me/.local/bin/rtk" };
    const launch = await rtkWslCommand(["init", "-g", "--claude"], { find: async () => rtk });
    expect(launch?.args).toEqual([
      "-d",
      "Ubuntu",
      "-e",
      "/home/me/.local/bin/rtk",
      "init",
      "-g",
      "--claude",
    ]);
  });
});

describe("windowsCommandInWsl", () => {
  it("spells a Windows program's path as the distro sees it", () => {
    expect(windowsCommandInWsl("C:\\Program Files\\Neox\\neolix.exe")).toBe(
      "/mnt/c/Program Files/Neox/neolix.exe",
    );
    expect(windowsCommandInWsl("D:\\tools\\neolix.exe", "/windows/")).toBe(
      "/windows/d/tools/neolix.exe",
    );
  });

  it("leaves a command that isn't a path alone", () => {
    expect(windowsCommandInWsl("node")).toBeNull();
    expect(windowsCommandInWsl("/usr/bin/node")).toBeNull();
  });
});

describe("wslEnvNames", () => {
  it("names every variable, sorted", () => {
    expect(wslEnvNames({ B: "2", A: "1" })).toBe("A:B");
    expect(wslEnvNames(undefined)).toBe("");
  });
});

describe("checkMcpServerHealth in a distro", () => {
  it("tells the caller when the distro has no such command", async () => {
    const health = await checkMcpServerHealth(
      { name: "missing", transport: "stdio", command: "neolix-no-such-command", args: [] },
      { distro: "Ubuntu", timeoutMs: 1_000 },
    );
    expect(health.ok).toBe(false);
    expect(health.error).toContain("isn't installed in WSL Ubuntu");
  });
});

describe("a WSL agent's Library target", () => {
  const row = {
    provider: "claude@wsl:Ubuntu",
    name: "Claude Code (WSL: Ubuntu)",
    icon: "claude-color",
    distro: "Ubuntu",
    home: "/home/me",
    uncHome: "\\\\wsl.localhost\\Ubuntu\\home\\me",
    baseUrl: "http://172.20.0.1:6767",
  };

  it("is built from its distro's home, its files through the share", async () => {
    const targets = await resolveLibraryAgentTargets({
      homeDir: "/host/home",
      env: {},
      wslRows: [row],
    });
    const target = targets.find((one) => one.id === "claude@wsl:Ubuntu");
    expect(target).toMatchObject({ name: row.name, distro: "Ubuntu" });
    expect(target?.instructionsPath).toBe(
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\CLAUDE.md",
    );
  });

  it("names the agent without its distro for RTK's specs", () => {
    expect(rtkAgentKind("claude@wsl:Ubuntu")).toBe("claude");
    expect(rtkAgentKind("codex")).toBe("codex");
  });
});

describe("wslMcpServer", () => {
  it("writes neolix's Windows path as the distro sees it, and names its variables for WSLENV", () => {
    const server = wslMcpServer({
      name: "neox",
      transport: "stdio",
      command: "C:\\Program Files\\Neox\\neolix.exe",
      args: ["mcp", "image"],
      env: { NEOLIX_TOKEN: "abc", NEOLIX_HOME: "C:\\Users\\me\\.neox" },
    });
    expect(server.command).toBe("/mnt/c/Program Files/Neox/neolix.exe");
    expect(server.args).toEqual(["mcp", "image"]);
    expect(server.env).toEqual({
      NEOLIX_TOKEN: "abc",
      NEOLIX_HOME: "C:\\Users\\me\\.neox",
      WSLENV: "NEOLIX_HOME:NEOLIX_TOKEN",
    });
  });

  it("leaves a command the distro has alone", () => {
    const server = { name: "x", transport: "stdio" as const, command: "node", args: [] };
    expect(wslMcpServer(server)).toBe(server);
  });
});

describe("commands in a named distro", () => {
  it("looks in that distro, not the default one", async () => {
    const found: string[] = [];
    const launch = await mcpWslCommand(
      { command: "node", args: ["x"], distro: "Ubuntu" },
      {
        findIn: async (distro, command) => {
          found.push(`${distro}:${command}`);
          return tool;
        },
        find: async () => {
          throw new Error("the default distro must not be looked in");
        },
      },
    );
    expect(found).toEqual(["Ubuntu:node"]);
    expect(launch?.args).toEqual(["-d", "Ubuntu", "-e", "/usr/bin/node", "x"]);
  });

  it("runs RTK there too", async () => {
    const launch = await rtkWslCommand(
      ["init", "-g"],
      { findIn: async () => ({ ...tool, path: "/usr/bin/rtk" }) },
      "Ubuntu",
    );
    expect(launch?.args).toEqual(["-d", "Ubuntu", "-e", "/usr/bin/rtk", "init", "-g"]);
  });
});
