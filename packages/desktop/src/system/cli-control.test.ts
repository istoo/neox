import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasPanelArg,
  PANEL_ARG,
  parseCliControlRequest,
  writeCliControlReply,
} from "./cli-control";

const directories: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "neolix-cli-control-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseCliControlRequest", () => {
  it("reads an autostart command with its reply path", () => {
    expect(
      parseCliControlRequest([
        "/Applications/Neolix.app/Contents/MacOS/Neolix",
        "--neolix-cli-autostart=on",
        "--neolix-cli-reply=/tmp/reply.json",
      ]),
    ).toEqual({
      action: { kind: "autostart", value: "on" },
      replyPath: "/tmp/reply.json",
    });
  });

  it("reads an update check with a one-run proxy and mirror", () => {
    expect(
      parseCliControlRequest([
        "--neolix-cli-update=check",
        "--neolix-cli-update-proxy=socks5://127.0.0.1:1080",
        "--neolix-cli-mirror=https://mirror.example/",
        "--neolix-cli-reply=/tmp/reply.json",
      ]),
    ).toEqual({
      action: {
        kind: "update",
        check: true,
        proxy: "socks5://127.0.0.1:1080",
        mirror: "https://mirror.example/",
      },
      replyPath: "/tmp/reply.json",
    });
  });

  it("tells a mirror setting from asking which one is set", () => {
    expect(
      parseCliControlRequest(["--neolix-cli-update-mirror=off", "--neolix-cli-reply=/tmp/r"])
        ?.action,
    ).toEqual({ kind: "update-mirror", prefix: "off" });
    expect(
      parseCliControlRequest(["--neolix-cli-update-mirror=", "--neolix-cli-reply=/tmp/r"])?.action,
    ).toEqual({ kind: "update-mirror", prefix: null });
  });

  it("tells a channel setting from asking which one is set", () => {
    expect(
      parseCliControlRequest(["--neolix-cli-update-channel=beta", "--neolix-cli-reply=/tmp/r"])
        ?.action,
    ).toEqual({ kind: "update-channel", channel: "beta" });
    expect(
      parseCliControlRequest(["--neolix-cli-update-channel=", "--neolix-cli-reply=/tmp/r"])?.action,
    ).toEqual({ kind: "update-channel", channel: null });
  });

  it("splits update auto's tokens, and an empty list asks for the policy", () => {
    expect(
      parseCliControlRequest(["--neolix-cli-update-auto=on,notify,6h", "--neolix-cli-reply=/tmp/r"])
        ?.action,
    ).toEqual({ kind: "update-auto", tokens: ["on", "notify", "6h"] });
    expect(
      parseCliControlRequest(["--neolix-cli-update-auto=", "--neolix-cli-reply=/tmp/r"])?.action,
    ).toEqual({ kind: "update-auto", tokens: [] });
  });

  it("ignores launches that are not control commands", () => {
    expect(parseCliControlRequest(["--hidden"])).toBeNull();
    expect(parseCliControlRequest(["--neolix-cli-reply=/tmp/r"])).toBeNull();
    expect(
      parseCliControlRequest(["--neolix-cli-autostart=maybe", "--neolix-cli-reply=/tmp/r"]),
    ).toBeNull();
  });

  it("recognises the quick-panel argument", () => {
    expect(hasPanelArg([PANEL_ARG])).toBe(true);
    expect(hasPanelArg(["--hidden"])).toBe(false);
  });
});

describe("writeCliControlReply", () => {
  it("writes the answer where the CLI polls for it", async () => {
    const directory = tempDir();
    const replyPath = path.join(directory, "reply.json");

    await writeCliControlReply(replyPath, { ok: true, message: "updated" });

    expect(JSON.parse(readFileSync(replyPath, "utf8"))).toEqual({
      ok: true,
      message: "updated",
    });
  });

  it("leaves nothing behind when the CLI has gone", async () => {
    const directory = tempDir();
    const replyPath = path.join(directory, "missing", "reply.json");

    await expect(
      writeCliControlReply(replyPath, { ok: false, message: "gone" }),
    ).resolves.toBeUndefined();
  });
});
