import { describe, expect, it } from "vitest";
import {
  codexCopyKind,
  parseElapsed,
  parseProcessList,
  restartCommands,
  staleCopies,
} from "./stale-copies.js";

describe("stale copies", () => {
  it("reads ps rows as commands and their running time", () => {
    const processes = parseProcessList(
      [
        "  101 01:02:03 codex --managed-daemon",
        "  102 2-00:00:10 /Applications/Codex.app/Contents/MacOS/codex",
        "  103   05:11 codex exec hi",
      ].join("\n"),
    );
    expect(processes).toEqual([
      { command: "codex --managed-daemon", uptimeMs: 3_723_000 },
      {
        command: "/Applications/Codex.app/Contents/MacOS/codex",
        uptimeMs: 172_810_000,
      },
      { command: "codex exec hi", uptimeMs: 311_000 },
    ]);
    expect(parseElapsed("10:00")).toBe(600_000);
  });

  it("tells Codex's copies apart and ignores its daemon's helpers", () => {
    expect(codexCopyKind("codex --managed-daemon")).toEqual({ kind: "daemon" });
    expect(codexCopyKind("/usr/local/bin/codex exec hi")).toEqual({ kind: "cli" });
    expect(codexCopyKind("/Users/me/.vscode/extensions/x/bin/codex")).toEqual({ kind: "ide" });
    expect(codexCopyKind("/Applications/Codex.app/Contents/MacOS/codex --app-server")).toEqual({
      kind: "app",
      bundle: "/Applications/Codex.app",
    });
    expect(codexCopyKind("codex pid-update-loop")).toBeNull();
    expect(codexCopyKind("/usr/bin/claude")).toBeNull();
  });

  it("keeps only copies started before the config changed, one per app", () => {
    const now = 1_000_000_000;
    const changedAt = now - 10_000;
    const copies = staleCopies({
      agent: "codex",
      now,
      changedAt,
      processes: [
        // Started 60s before the change.
        { command: "codex --managed-daemon", uptimeMs: 70_000 },
        // Started after the change.
        { command: "codex exec hi", uptimeMs: 5_000 },
        // Two processes of the same app, started at different times.
        { command: "/Applications/Codex.app/Contents/MacOS/codex", uptimeMs: 90_000 },
        { command: "/Applications/Codex.app/Contents/MacOS/codex helper", uptimeMs: 50_000 },
      ],
    });
    expect(copies).toEqual([
      { kind: "daemon", since: now - 70_000 },
      { kind: "app", since: now - 90_000, bundle: "/Applications/Codex.app" },
    ]);
  });

  it("restarts a daemon and an app, and leaves the rest to the reader", () => {
    expect(restartCommands("codex", "daemon")).toEqual([
      { command: "codex", args: ["app-server", "daemon", "restart"] },
    ]);
    expect(restartCommands("codex", "app", "/Applications/Codex.app")).toEqual([
      { command: "osascript", args: ["-e", 'tell application "Codex" to quit'] },
      { command: "open", args: ["/Applications/Codex.app"] },
    ]);
    expect(restartCommands("codex", "cli")).toBeNull();
    expect(restartCommands("codex", "app")).toBeNull();
  });
});
