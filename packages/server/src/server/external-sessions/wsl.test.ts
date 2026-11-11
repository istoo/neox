import { describe, expect, it } from "vitest";
import { resumeCommand } from "./sources.js";
import { discoverWslRoots, parseWslDistros, sessionRootsOf, wslUncPath } from "./wsl.js";

const LISTING = [
  "  NAME      STATE           VERSION",
  "* Ubuntu    Running         2",
  "  Debian    Stopped         2",
  "",
].join("\r\n");

describe("WSL session roots", () => {
  it("reads wsl.exe's listing into distros and their state", () => {
    expect(parseWslDistros(LISTING)).toEqual([
      { name: "Ubuntu", running: true },
      { name: "Debian", running: false },
    ]);
  });

  it("ignores the UTF-16 NULs of a listing read as bytes", () => {
    const utf16ish = LISTING.replace(/\r\n/gu, "\u0000\r\u0000\n\u0000");
    expect(parseWslDistros(utf16ish).map((distro) => distro.name)).toEqual(["Ubuntu", "Debian"]);
  });

  it("maps a distro's home and session folders onto its Windows share", () => {
    expect(wslUncPath("Ubuntu", "/home/me")).toBe("\\\\wsl.localhost\\Ubuntu\\home\\me");
    expect(sessionRootsOf("Ubuntu", "/home/me")).toEqual({
      claude: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude",
      codex: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex",
      pi: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.pi\\agent\\sessions",
      opencode: "",
      agy: "",
    });
  });

  it("reads only the homes of running distros, and only on Windows", async () => {
    const roots = await discoverWslRoots({
      platform: "win32",
      list: () => Promise.resolve(LISTING),
      home: (distro) => Promise.resolve(distro === "Ubuntu" ? "/home/me" : "/home/other"),
    });

    expect(roots.map((entry) => entry.distro)).toEqual(["Ubuntu"]);
    expect(roots[0]?.roots.claude).toContain("\\Ubuntu\\home\\me\\.claude");

    expect(
      await discoverWslRoots({
        platform: "darwin",
        list: () => Promise.resolve(LISTING),
      }),
    ).toEqual([]);
  });

  it("keeps out of a distro whose home can't be read", async () => {
    const roots = await discoverWslRoots({
      platform: "win32",
      list: () => Promise.resolve(LISTING),
      home: () => Promise.reject(new Error("no such distro")),
    });

    expect(roots).toEqual([]);
  });
});

describe("WSL and Antigravity resume lines", () => {
  it("gives myna's line for a distro, and Antigravity's own", () => {
    const line = resumeCommand("claude", "abc", { wsl: "Ubuntu", cwd: "/home/me/p" });
    expect(line).toBe(
      "wsl.exe -d 'Ubuntu' --cd '/home/me/p' -e sh -lc 'exec ${SHELL:-sh} -lic ''claude --resume abc'''",
    );
    const agy = resumeCommand("agy", "conv-1", { cwd: "/work/ag y" });
    expect(agy).toBe(
      process.platform === "win32"
        ? "Set-Location -LiteralPath '/work/ag y'; agy --conversation conv-1"
        : "cd '/work/ag y' && agy --conversation conv-1",
    );
  });
});
