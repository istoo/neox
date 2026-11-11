import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OMARCHY_WIDGET_ID,
  addOmarchyWidget,
  isOmarchy,
  isOmarchyWidgetInstalled,
  omarchyWidgetDir,
  removeOmarchyWidget,
} from "./omarchy-widget";

let root = "";
const previousEnv: Record<string, string | undefined> = {};

describe("omarchy widget", () => {
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "neolix-omarchy-widget-"));
    for (const key of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "NEOLIX_OMARCHY"]) {
      previousEnv[key] = process.env[key];
    }
    process.env.XDG_CONFIG_HOME = path.join(root, ".config");
    process.env.XDG_STATE_HOME = path.join(root, ".local", "state");
    delete process.env.NEOLIX_OMARCHY;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("recognises Omarchy by its current theme", () => {
    expect(isOmarchy({ platform: "linux", homeDir: root })).toBe(false);
    expect(isOmarchy({ env: { ...process.env, NEOLIX_OMARCHY: "1" }, platform: "linux" })).toBe(
      true,
    );
    expect(isOmarchy({ env: { ...process.env, NEOLIX_OMARCHY: "0" }, platform: "linux" })).toBe(
      false,
    );
  });

  it("writes the widget files and enables it, then removes them", async () => {
    const calls: string[] = [];
    const run = async (file: string, args: readonly string[]): Promise<void> => {
      calls.push([file, ...args].join(" "));
    };

    await addOmarchyWidget("/opt/Neolix/Neolix", { run });
    const dir = omarchyWidgetDir();
    expect(dir.endsWith(path.join("omarchy", "plugins", OMARCHY_WIDGET_ID))).toBe(true);
    expect(isOmarchyWidgetInstalled()).toBe(true);
    expect(readFileSync(path.join(dir, "Widget.qml"), "utf8")).toContain('"/opt/Neolix/Neolix"');
    expect(readFileSync(path.join(dir, "manifest.json"), "utf8")).toContain(OMARCHY_WIDGET_ID);
    expect(calls).toContain("omarchy-shell shell rescanPlugins");
    expect(calls).toContain(`omarchy plugin enable ${OMARCHY_WIDGET_ID}`);

    await removeOmarchyWidget({ run });
    expect(isOmarchyWidgetInstalled()).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});
