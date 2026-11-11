import { mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildAutostartArgs,
  buildUpdateArgs,
  buildUpdateAutoArgs,
  buildUpdateChannelArgs,
  buildUpdateMirrorArgs,
  createAutostartCommand,
  createUpdateCommand,
  hasGraphicalSession,
  shouldOpenDesktopApp,
  waitForDesktopReply,
} from "./desktop.js";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "neolix-cli-desktop-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop control arguments", () => {
  it("passes autostart on, off, and the status query", () => {
    expect(buildAutostartArgs("on")).toEqual(["--neolix-cli-autostart=on"]);
    expect(buildAutostartArgs("status")).toEqual(["--neolix-cli-autostart=status"]);
  });

  it("keeps a one-run proxy and mirror on the update check", () => {
    expect(buildUpdateArgs({ check: true, proxy: "http://a:1", mirror: "https://m/" })).toEqual([
      "--neolix-cli-update=check",
      "--neolix-cli-update-proxy=http://a:1",
      "--neolix-cli-mirror=https://m/",
    ]);
    expect(buildUpdateArgs({ check: false })).toEqual(["--neolix-cli-update=install"]);
    // `--mirror off` goes straight to GitHub, as myna's does.
    expect(buildUpdateArgs({ check: true, mirror: "off" })).toEqual(["--neolix-cli-update=check"]);
  });

  it("sends an empty value to ask for the setting", () => {
    expect(buildUpdateMirrorArgs("")).toEqual(["--neolix-cli-update-mirror="]);
    expect(buildUpdateChannelArgs("")).toEqual(["--neolix-cli-update-channel="]);
    expect(buildUpdateAutoArgs([])).toEqual(["--neolix-cli-update-auto="]);
  });
});

describe("command arguments are checked before the app is launched", () => {
  it("rejects an autostart value myna does not take", async () => {
    const command = createAutostartCommand();
    command.exitOverride().configureOutput({ writeErr: () => undefined });

    await expect(command.parseAsync(["maybe"], { from: "user" })).rejects.toThrow(
      "usage: neox autostart [on|off]",
    );
  });

  it("rejects an update channel myna does not take", async () => {
    const command = createUpdateCommand();
    const channel = command.commands.find((candidate) => candidate.name() === "channel")!;
    channel.exitOverride().configureOutput({ writeErr: () => undefined });

    await expect(channel.parseAsync(["every"], { from: "user" })).rejects.toThrow(
      "usage: neox update channel [stable|beta]",
    );
  });

  it("rejects an update auto token myna does not take", async () => {
    const command = createUpdateCommand();
    const auto = command.commands.find((candidate) => candidate.name() === "auto")!;
    auto.exitOverride().configureOutput({ writeErr: () => undefined });

    await expect(auto.parseAsync(["hourly"], { from: "user" })).rejects.toThrow(
      'neox update auto takes on, off, download, notify or how often (30m, 1h, 6h or 24h), not "hourly"',
    );
  });
});

describe("no-argument launch decides between the app and onboarding", () => {
  it("sees no graphical session over SSH", () => {
    expect(hasGraphicalSession({ SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" }, "linux")).toBe(false);
    expect(hasGraphicalSession({ SSH_TTY: "/dev/pts/0" }, "darwin")).toBe(false);
  });

  it("requires DISPLAY or WAYLAND_DISPLAY on Linux", () => {
    expect(hasGraphicalSession({}, "linux")).toBe(false);
    expect(hasGraphicalSession({ DISPLAY: "  " }, "linux")).toBe(false);
    expect(hasGraphicalSession({ DISPLAY: ":0" }, "linux")).toBe(true);
    expect(hasGraphicalSession({ WAYLAND_DISPLAY: "wayland-1" }, "linux")).toBe(true);
  });

  it("takes a graphical session on macOS and Windows", () => {
    expect(hasGraphicalSession({}, "darwin")).toBe(true);
    expect(hasGraphicalSession({}, "win32")).toBe(true);
  });

  it("stays on onboarding when the app is not installed", () => {
    expect(shouldOpenDesktopApp({ installed: false, env: {}, platform: "darwin" })).toBe(false);
  });

  it("opens the app only with both the app and a graphical session", () => {
    expect(shouldOpenDesktopApp({ installed: true, env: {}, platform: "darwin" })).toBe(true);
    expect(
      shouldOpenDesktopApp({
        installed: true,
        env: { SSH_CONNECTION: "10.0.0.1 22 10.0.0.2 22" },
        platform: "darwin",
      }),
    ).toBe(false);
    expect(shouldOpenDesktopApp({ installed: true, env: {}, platform: "linux" })).toBe(false);
  });

  it("honours NEOLIX_NO_DESKTOP even when everything else is in place", () => {
    expect(
      shouldOpenDesktopApp({
        installed: true,
        env: { NEOLIX_NO_DESKTOP: "1" },
        platform: "darwin",
      }),
    ).toBe(false);
  });
});

describe("waitForDesktopReply", () => {
  it("returns the reply the app writes", async () => {
    const directory = tempDir();
    const replyPath = path.join(directory, "reply.json");
    writeFileSync(replyPath, JSON.stringify({ ok: true, message: "automatic updates are off" }));

    const reply = await waitForDesktopReply(replyPath, 1_000, {
      readFile: fs.readFile,
      now: Date.now,
      sleep: () => Promise.resolve(),
    });

    expect(reply).toEqual({ ok: true, message: "automatic updates are off" });
  });

  it("waits out a half-written file and repeats the read", async () => {
    const directory = tempDir();
    const replyPath = path.join(directory, "reply.json");
    let reads = 0;
    let clock = 0;

    const reply = await waitForDesktopReply(replyPath, 1_000, {
      readFile: async () => {
        reads += 1;
        if (reads === 1) {
          return '{"ok":';
        }
        return JSON.stringify({ ok: false, message: "no update available" });
      },
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    expect(reply).toEqual({ ok: false, message: "no update available" });
    expect(reads).toBe(2);
  });

  it("gives up when the app never answers", async () => {
    const directory = tempDir();
    let clock = 0;

    const reply = await waitForDesktopReply(path.join(directory, "reply.json"), 250, {
      readFile: async () => {
        throw new Error("ENOENT");
      },
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    expect(reply).toBeNull();
  });
});
