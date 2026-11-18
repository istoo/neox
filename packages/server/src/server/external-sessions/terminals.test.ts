import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findRex,
  installedTerminals,
  resetRexForTests,
  resumeScript,
  terminalCommandOf,
  terminalOpenArgs,
  validateResumeCommand,
  validateTerminalRequest,
} from "./terminals.js";

const roots: string[] = [];

afterEach(async () => {
  resetRexForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-terminals-"));
  roots.push(root);
  return root;
}

const INSTALLED = [
  { id: "com.apple.Terminal", name: "Terminal" },
  { id: "com.googlecode.iterm2", name: "iTerm" },
];

describe("terminal detection", () => {
  it("lists the terminals found in the standard places, in myna's order", async () => {
    expect(
      await installedTerminals(
        (candidatePath) => candidatePath === "/Applications/iTerm.app",
        "/Users/nobody",
      ),
    ).toEqual([{ id: "com.googlecode.iterm2", name: "iTerm" }]);
  });

  // Mac terminals are the only ones this module offers; Windows has no .app bundles.
  it.skipIf(process.platform === "win32")(
    "finds an app installed under the home folder",
    async () => {
      expect(
        (
          await installedTerminals(
            (candidatePath) => candidatePath === "/Users/nobody/Applications/Ghostty.app",
            "/Users/nobody",
          )
        ).map((app) => app.id),
      ).toEqual(["com.mitchellh.ghostty"]);
    },
  );

  // Rex is a Mac terminal; Windows has neither the native Mach-O CLI nor the .app.
  it.skipIf(process.platform === "win32")("offers Rex when its native CLI is on PATH", async () => {
    const bin = await temp();
    const rex = path.join(bin, "rex");
    await writeFile(rex, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
    await chmod(rex, 0o755);
    expect(await findRex({ PATH: bin }, await temp(), [])).toBe(rex);
  });

  it("does not take a script named rex for the CLI", async () => {
    const bin = await temp();
    const rex = path.join(bin, "rex");
    await writeFile(rex, "#!/usr/bin/env perl\n");
    await chmod(rex, 0o755);
    expect(await findRex({ PATH: bin }, await temp(), [])).toBeNull();
  });
});

describe("terminalOpenArgs", () => {
  it("opens Terminal by name, the others by bundle id, and the system's by none", () => {
    expect(terminalOpenArgs("com.apple.Terminal", INSTALLED)).toEqual(["-a", "Terminal"]);
    expect(terminalOpenArgs("com.googlecode.iterm2", INSTALLED)).toEqual([
      "-b",
      "com.googlecode.iterm2",
    ]);
    expect(terminalOpenArgs("system", INSTALLED)).toEqual([]);
    expect(terminalOpenArgs("", INSTALLED)).toEqual([]);
  });

  it("refuses an app that is no longer installed", () => {
    expect(() => terminalOpenArgs("com.mitchellh.ghostty", INSTALLED)).toThrow(
      "no longer available",
    );
  });
});

describe("resume command validation", () => {
  it("accepts the resume commands Neox composes", () => {
    expect(validateResumeCommand("claude --resume session-1")).toBeNull();
    expect(validateResumeCommand("codex resume 0f3a-11bc")).toBeNull();
    expect(validateResumeCommand("opencode --session abc/def")).toBeNull();
  });

  it("refuses shell syntax and unknown binaries", () => {
    expect(validateResumeCommand("claude; rm -rf /")).not.toBeNull();
    expect(validateResumeCommand("claude --resume $(whoami)")).not.toBeNull();
    expect(validateResumeCommand("claude --resume x | cat")).not.toBeNull();
    expect(validateResumeCommand("rm -rf /")).not.toBeNull();
    expect(validateResumeCommand("claude --resume 'x'")).not.toBeNull();
    expect(validateResumeCommand("claude\nrm -rf /")).not.toBeNull();
    expect(validateResumeCommand("")).not.toBeNull();
  });

  it("checks the app, command and folder together", () => {
    expect(
      validateTerminalRequest(
        { app: "com.googlecode.iterm2", command: "claude --resume s", cwd: "/tmp" },
        INSTALLED,
      ),
    ).toBeNull();
    expect(
      validateTerminalRequest(
        { app: "org.evil", command: "claude --resume s", cwd: "/tmp" },
        INSTALLED,
      ),
    ).not.toBeNull();
    expect(
      validateTerminalRequest(
        { app: "system", command: "claude --resume s", cwd: "relative" },
        INSTALLED,
      ),
    ).not.toBeNull();
    expect(
      validateTerminalRequest(
        { app: "system", command: "claude --resume s", cwd: "/tmp/\nrm" },
        INSTALLED,
      ),
    ).not.toBeNull();
  });
});

describe("resumeScript", () => {
  it("quotes the folder and leaves the reader's shell open", () => {
    expect(resumeScript("claude --resume s", "/Users/a b/it's here")).toBe(
      `#!/bin/sh\ncd '/Users/a b/it'\\''s here' && claude --resume s\nexec "\${SHELL:-/bin/zsh}" -l\n`,
    );
  });

  it("drops Neox's own cd prefix before the script adds one", () => {
    expect(terminalCommandOf("cd '/work/it'\\''s' && agy --conversation x", "/work/it's")).toBe(
      "agy --conversation x",
    );
    expect(terminalCommandOf("claude --resume x", "/work")).toBe("claude --resume x");
    expect(terminalCommandOf("cd '/elsewhere' && agy --conversation x", "/work")).toBe(
      "cd '/elsewhere' && agy --conversation x",
    );
  });
});
