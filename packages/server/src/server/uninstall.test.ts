import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  describeUninstallReport,
  isRemovablePath,
  isWithin,
  libraryKeepPath,
  resolveNeolixDataDirectories,
  runUninstall,
  uninstallFailed,
} from "./uninstall.js";

let root = "";

describe("uninstall", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "neolix-uninstall-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("never treats the home, a root or a relative path as Neox's folder", () => {
    const home = path.join(root, "home");
    expect(isRemovablePath(home, home)).toBe(false);
    expect(isRemovablePath("/", home)).toBe(false);
    expect(isRemovablePath("relative/dir", home)).toBe(false);
    expect(isRemovablePath(path.join(home, ".neox"), home)).toBe(true);
    expect(resolveNeolixDataDirectories({ neolixHome: home, homeDir: home })).toEqual([]);
  });

  it("disconnects agents, turns off autostart, stops the service, then deletes", async () => {
    const neolixHome = path.join(root, ".neox");
    mkdirSync(path.join(neolixHome, "agents"), { recursive: true });
    writeFileSync(path.join(neolixHome, "agents", "a.json"), "{}");

    const order: string[] = [];
    const report = await runUninstall({
      dataDirectories: [neolixHome],
      listAgents: async () => [
        { provider: "claude", label: "Claude Code" },
        { provider: "codex", label: "Codex" },
      ],
      disconnectAgent: async (agent) => {
        order.push(`disconnect:${agent.provider}`);
      },
      disableAutostart: async () => {
        order.push("autostart");
      },
      beforeRemoveData: async () => {
        order.push("stop");
      },
    });

    expect(order).toEqual(["disconnect:claude", "disconnect:codex", "autostart", "stop"]);
    expect(existsSync(neolixHome)).toBe(false);
    expect(report.agents.map((step) => step.what)).toEqual(["Claude Code", "Codex"]);
    expect(report.data).toEqual([{ what: neolixHome, error: null }]);
    expect(uninstallFailed(report)).toBe(false);
  });

  it("keeps the Library while it holds things agents use", async () => {
    const neolixHome = path.join(root, ".neox");
    mkdirSync(path.join(neolixHome, "library", "skills", "demo"), { recursive: true });
    writeFileSync(path.join(neolixHome, "library", "skills", "demo", "SKILL.md"), "#");
    writeFileSync(path.join(neolixHome, "settings.json"), "{}");

    const keep = await libraryKeepPath(neolixHome);
    expect(keep).not.toBeNull();

    const report = await runUninstall({
      dataDirectories: [neolixHome],
      listAgents: async () => [],
      disconnectAgent: async () => undefined,
      disableAutostart: async () => undefined,
      ...(keep ? { keepPaths: [keep] } : {}),
    });

    expect(existsSync(path.join(neolixHome, "library", "skills", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(neolixHome, "settings.json"))).toBe(false);
    expect(report.kept).toHaveLength(1);
  });

  it("reports each failure and keeps going", async () => {
    const neolixHome = path.join(root, ".neox");
    mkdirSync(neolixHome, { recursive: true });

    const report = await runUninstall({
      dataDirectories: [neolixHome],
      listAgents: async () => {
        throw new Error("daemon unreachable");
      },
      disconnectAgent: async () => undefined,
      disableAutostart: async () => {
        throw new Error("no permission");
      },
    });

    expect(report.agents[0]?.error).toBe("daemon unreachable");
    expect(report.system[0]?.error).toBe("no permission");
    expect(uninstallFailed(report)).toBe(true);
    expect(describeUninstallReport(report)).toEqual([
      "! disconnected Agents: daemon unreachable",
      "! removed open at login: no permission",
      `✓ deleted ${neolixHome}`,
    ]);
  });

  it("knows what lies inside what", () => {
    expect(isWithin("/a/b", "/a")).toBe(true);
    expect(isWithin("/a", "/a")).toBe(true);
    expect(isWithin("/ab", "/a")).toBe(false);
    expect(isWithin("/a/../b", "/a")).toBe(false);
  });

  it("does not delete a folder that no longer exists", async () => {
    const missing = path.join(root, "missing");
    const report = await runUninstall({
      dataDirectories: [missing],
      listAgents: async () => [],
      disconnectAgent: async () => undefined,
      disableAutostart: async () => undefined,
    });
    expect(report.data).toEqual([{ what: missing, error: null }]);
  });
});
