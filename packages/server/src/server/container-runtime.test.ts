import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isContainerRuntime } from "./container-runtime.js";

describe("isContainerRuntime", () => {
  it("follows NEOLIX_CONTAINER when it is set", async () => {
    await expect(isContainerRuntime({ NEOLIX_CONTAINER: "1" })).resolves.toBe(true);
    await expect(isContainerRuntime({ NEOLIX_CONTAINER: "true" })).resolves.toBe(true);
    await expect(isContainerRuntime({ NEOLIX_CONTAINER: "0" })).resolves.toBe(false);
    await expect(isContainerRuntime({ NEOLIX_CONTAINER: "off" })).resolves.toBe(false);
  });

  it("looks for the marker files when the override is unset", async () => {
    await expect(isContainerRuntime({})).resolves.toBe(
      (await exists("/.dockerenv")) || (await exists("/run/.containerenv")),
    );
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
