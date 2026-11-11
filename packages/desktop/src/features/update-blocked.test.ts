import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearBlockedUpdate,
  isNewerVersion,
  isPolicyRefusal,
  noteBlockedUpdate,
  readBlockedUpdate,
} from "./update-blocked";

let userData = "";

describe("update-blocked", () => {
  beforeEach(() => {
    userData = mkdtempSync(path.join(os.tmpdir(), "neolix-blocked-"));
  });

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true });
  });

  it("recognises Windows application control refusals", () => {
    expect(isPolicyRefusal({ errno: 1260 })).toBe(true);
    expect(isPolicyRefusal({ code: "0x800711C7" })).toBe(true);
    expect(isPolicyRefusal(new Error("Blocked by policy"))).toBe(true);
    expect(isPolicyRefusal(new Error("Smart App Control prevented this app from starting"))).toBe(
      true,
    );
    expect(isPolicyRefusal(new Error("net::ERR_CONNECTION_RESET"))).toBe(false);
  });

  it("records a refused version with its policy flag", () => {
    const note = noteBlockedUpdate(userData, "0.16.0", new Error("Access is denied"));
    expect(note).toMatchObject({ version: "0.16.0", policy: true });
    expect(readBlockedUpdate(userData, "0.15.0")).toMatchObject({
      version: "0.16.0",
      error: "Access is denied",
      policy: true,
    });
  });

  it("drops the note once the running version has caught up", () => {
    noteBlockedUpdate(userData, "0.16.0", new Error("blocked by policy"));
    expect(readBlockedUpdate(userData, "0.16.0")).toBeNull();
    expect(readBlockedUpdate(userData, "0.15.0")).toBeNull();
  });

  it("clears on request", () => {
    noteBlockedUpdate(userData, "0.16.0", new Error("blocked by policy"));
    clearBlockedUpdate(userData);
    expect(readBlockedUpdate(userData, "0.15.0")).toBeNull();
  });

  it("orders versions the way semver does", () => {
    expect(isNewerVersion("0.16.0", "0.15.9")).toBe(true);
    expect(isNewerVersion("0.15.10", "0.15.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
    expect(isNewerVersion("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isNewerVersion("nonsense", "1.0.0")).toBe(false);
  });
});
