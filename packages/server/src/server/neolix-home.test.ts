import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveNeolixHome } from "./neolix-home.js";
describe("resolveNeolixHome", () => {
  test("resolves NEOLIX_HOME without creating it", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "neolix-home-parent-"));
    const neolixHome = path.join(parent, "home");
    try {
      expect(resolveNeolixHome({ NEOLIX_HOME: neolixHome })).toBe(neolixHome);
      expect(existsSync(neolixHome)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
