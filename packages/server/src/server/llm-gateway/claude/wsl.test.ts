import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WslTool } from "../../wslrun/wslrun.js";
import { claudeWslLaunch, startWslTranscript, WSL_TRANSCRIPT_SCRIPT } from "./wsl.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

const tool: WslTool = {
  distro: "Ubuntu",
  path: "/usr/bin/claude",
  host: "172.20.16.1",
  home: "/home/me",
};

const launch = {
  binary: "claude",
  args: ["-p", "--model", "claude-haiku"],
  cwd: "C:\\Users\\me\\AppData\\Local\\Temp\\neolix-claude-work-1",
  env: {
    BUN_OPTIONS: "--preload C:\\Users\\me\\AppData\\Local\\Temp\\neolix-claude-tap-1\\tap.cjs",
    NEOLIX_CLAUDE_TAP: "C:\\Users\\me\\AppData\\Local\\Temp\\neolix-claude-tap-1\\tap.jsonl",
  },
  sessionDirs: ["C:\\Users\\me\\.claude\\projects\\neolix"],
};

describe("claudeWslLaunch", () => {
  it("starts the distro's Claude Code, its folder and config folder spelt as it spells them", async () => {
    const out = await claudeWslLaunch(launch, { find: async () => tool });
    expect(out.binary).toBe("wsl.exe");
    expect(out.args).toEqual([
      "-d",
      "Ubuntu",
      "--exec",
      "/usr/bin/claude",
      "-p",
      "--model",
      "claude-haiku",
    ]);
    expect(out.cwd).toBe("/mnt/c/Users/me/AppData/Local/Temp/neolix-claude-work-1");
    expect(out.env.CLAUDE_CONFIG_DIR).toBe("/home/me/.claude");
    expect(out.sessionDirs).toEqual([
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects\\-mnt-c-Users-me-AppData-Local-Temp-neolix-claude-work-1",
    ]);
    expect(out.wsl).toEqual({
      distro: "Ubuntu",
      home: "/home/me",
      projects: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects",
    });
  });

  it("hands the tap's path to the distro, and the variables it needs through WSLENV", async () => {
    const out = await claudeWslLaunch(launch, { find: async () => tool });
    expect(out.env.BUN_OPTIONS).toBe(
      "--preload /mnt/c/Users/me/AppData/Local/Temp/neolix-claude-tap-1/tap.cjs",
    );
    expect(out.env.NEOLIX_CLAUDE_TAP).toBe(
      "C:\\Users\\me\\AppData\\Local\\Temp\\neolix-claude-tap-1\\tap.jsonl",
    );
    expect(out.env.WSLENV).toBe(
      "CLAUDE_CONFIG_DIR/p:NEOLIX_CLAUDE_TAP/p:BUN_OPTIONS:NEOLIX_CLAUDE_GUARD:TERM",
    );
  });

  it("keeps a config folder its caller gave, spelt for the distro", async () => {
    const out = await claudeWslLaunch(
      { ...launch, env: { ...launch.env, CLAUDE_CONFIG_DIR: "D:\\accounts\\me" } },
      { find: async () => tool },
    );
    expect(out.env.CLAUDE_CONFIG_DIR).toBe("/mnt/d/accounts/me");
    expect(out.sessionDirs[0]).toBe(
      "\\\\wsl.localhost\\Ubuntu\\mnt\\d\\accounts\\me\\projects\\-mnt-c-Users-me-AppData-Local-Temp-neolix-claude-work-1",
    );
  });

  it("leaves a host Claude Code alone", async () => {
    expect(await claudeWslLaunch(launch, { find: async () => null })).toBe(launch);
  });
});

describe("startWslTranscript", { timeout: 20_000 }, () => {
  // The distro script is POSIX sh, run here through /bin/sh; Windows CI has no
  // POSIX shell, and the script's real home is inside the WSL distro.
  it.skipIf(process.platform === "win32")(
    "copies what the distro writes after the session's earlier turns",
    async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "neolix-wsl-home-"));
      dirs.push(home);
      const project = path.join(home, ".claude", "projects", "-work");
      await mkdir(project, { recursive: true });
      const transcript = path.join(project, "sid-1.jsonl");
      await writeFile(transcript, '{"type":"user","message":"earlier"}\n');
      const copy = await mkdtemp(path.join(os.tmpdir(), "neolix-wsl-copy-"));
      dirs.push(copy);

      const reader = await startWslTranscript({
        distro: "Ubuntu",
        sid: "sid-1",
        dir: copy,
        // The shell runs here, where the script does the same as in a distro.
        spawnImpl: ((_command: string, _args: readonly string[], options: unknown) =>
          spawn("/bin/sh", ["-c", WSL_TRANSCRIPT_SCRIPT, "sh", "sid-1"], {
            ...(options as Record<string, unknown>),
            env: { ...process.env, HOME: home },
          })) as unknown as typeof spawn,
      });
      await reader.ready;
      await writeFile(transcript, '{"type":"assistant","message":"later"}\n', { flag: "a" });
      await waitFor(async () => (await readFile(reader.path, "utf8")).includes("later"));
      expect(await readFile(reader.path, "utf8")).not.toContain("earlier");
      await reader.stop();
    },
  );
});

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition not met");
}

it("names the script it runs in the distro", () => {
  expect(WSL_TRANSCRIPT_SCRIPT).toContain("tail -c");
});
