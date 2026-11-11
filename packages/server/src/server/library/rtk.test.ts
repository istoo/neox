import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  brewSaysBottled,
  readRtkStatus,
  rtkInstallPlan,
  runRtkInstall,
  type RtkCommandRunner,
} from "./rtk.js";

describe("rtk install plan", () => {
  let root: string;
  let bin: string;

  const envFor = (names: string[]): NodeJS.ProcessEnv =>
    ({ PATH: bin, HOME: root, names }) as unknown as NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "neolix-rtk-"));
    bin = path.join(root, "bin");
    await mkdir(bin, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const put = async (name: string): Promise<string> => {
    const file = path.join(bin, name);
    await writeFile(file, "#!/bin/sh\n");
    await chmod(file, 0o755);
    return file;
  };

  const runner =
    (output: string, code = 0): RtkCommandRunner =>
    async () => ({ code, stdout: output });

  test("uses Homebrew only when it has rtk's bottle here", async () => {
    const brew = await put("brew");
    await put("curl");
    const plan = await rtkInstallPlan(envFor([]), {
      platform: "darwin",
      run: runner("==> rtk: stable 1.1.0 (bottled)\n"),
    });
    expect(plan).toEqual({ install: "brew install rtk", upgrade: "brew upgrade rtk" });

    const otherBin = await mkdtemp(path.join(tmpdir(), "neolix-rtk-other-"));
    const other = path.join(otherBin, "brew");
    await writeFile(other, "#!/bin/sh\n");
    await chmod(other, 0o755);
    const notBottled = await rtkInstallPlan(
      { PATH: `${otherBin}:${bin}`, HOME: root } as NodeJS.ProcessEnv,
      {
        platform: "darwin",
        run: runner("==> rtk: stable 1.1.0\n"),
      },
    );
    expect(notBottled.install).toContain("raw.githubusercontent.com/rtk-ai/rtk");
    expect(notBottled.install).toContain("curl -fsSL");
    await rm(otherBin, { recursive: true, force: true });
    expect(brew.length).toBeGreaterThan(0);
  });

  test("offers nothing when brew has no bottle and there is no curl", async () => {
    await put("brew");
    const plan = await rtkInstallPlan(envFor([]), {
      platform: "linux",
      run: runner("==> rtk: stable 1.1.0\n"),
    });
    expect(plan).toEqual({ install: null, upgrade: null });
  });

  test("uses winget on Windows, and nothing without it", async () => {
    await put("winget");
    const withWinget = await rtkInstallPlan(envFor([]), { platform: "win32" });
    expect(withWinget.install).toBe(
      "winget install --id rtk-ai.rtk --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity",
    );
    expect(withWinget.upgrade).toBe(withWinget.install);

    const otherBin = await mkdtemp(path.join(tmpdir(), "neolix-rtk-empty-"));
    const without = await rtkInstallPlan({ PATH: otherBin, HOME: root } as NodeJS.ProcessEnv, {
      platform: "win32",
    });
    expect(without).toEqual({ install: null, upgrade: null });
    await rm(otherBin, { recursive: true, force: true });
  });

  test("reads the bottle from brew info's line, past colour codes", () => {
    expect(brewSaysBottled("\u001b[32m==> rtk: \u001b[0mstable 1.1.0 (bottled)\n")).toBe(true);
    expect(brewSaysBottled("==> rtk: stable 1.1.0\n")).toBe(false);
    expect(brewSaysBottled("==> something: rtk (bottled)\n")).toBe(false);
  });
});

describe("rtk in a WSL distro", () => {
  const wslTarget = {
    id: "claude@wsl:Ubuntu",
    name: "Claude Code (WSL: Ubuntu)",
    icon: "claude",
    distro: "Ubuntu",
    instructionsPath: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\CLAUDE.md",
  };

  test("reports each distro's own rtk", async () => {
    const status = await readRtkStatus([wslTarget], {
      homeDir: "/host/home",
      env: { PATH: "" },
      findDistro: async (distro) => ({
        distro,
        path: "/home/me/.local/bin/rtk",
        pathEnv: "/usr/bin",
        host: null,
        home: "/home/me",
      }),
      distroRunner: async (command) => {
        expect(command).toBe("wsl.exe");
        return { stdout: "rtk 1.2.3\n" };
      },
    });
    expect(status.distros).toEqual([
      {
        distro: "Ubuntu",
        installed: true,
        path: "/home/me/.local/bin/rtk",
        version: "1.2.3",
      },
    ]);
    expect(status.agents).toEqual([
      {
        id: "claude@wsl:Ubuntu",
        name: wslTarget.name,
        icon: "claude",
        on: false,
        distro: "Ubuntu",
      },
    ]);
  });

  test("says a distro has none", async () => {
    const status = await readRtkStatus([wslTarget], {
      homeDir: "/host/home",
      env: { PATH: "" },
      findDistro: async () => null,
    });
    expect(status.distros).toEqual([
      { distro: "Ubuntu", installed: false, path: null, version: null },
    ]);
  });
});

describe("rtk install in a WSL distro", () => {
  test("runs RTK's own installer inside the distro named", async () => {
    const calls: { distro: string; script: string }[] = [];
    const result = await runRtkInstall("install", {
      distro: "Ubuntu",
      runIn: async (distro, script) => {
        calls.push({ distro, script });
        return { code: 0, output: "installed", timedOut: false };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.distro).toBe("Ubuntu");
    expect(calls[0]?.script).toContain("install.sh");
    expect(result.command).toContain("wsl.exe -d Ubuntu");
  });

  test("says the installer failed there", async () => {
    const result = await runRtkInstall("upgrade", {
      distro: "Ubuntu",
      runIn: async () => ({ code: 2, output: "no rtk", timedOut: false }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no rtk");
  });
});
