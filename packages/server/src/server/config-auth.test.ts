import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";
import { isBearerTokenValidAsync } from "./auth.js";

const roots: string[] = [];
const CONFIG_PASSWORD_HASH = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";

async function createNeolixHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "neolix-config-auth-"));
  roots.push(root);
  const neolixHome = path.join(root, ".neox");
  await mkdir(neolixHome, { recursive: true });
  await writeFile(path.join(neolixHome, "config.json"), JSON.stringify(config, null, 2));
  return neolixHome;
}

describe("daemon auth config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("loads optional auth password hash from config.json", async () => {
    const neolixHome = await createNeolixHome({
      version: 1,
      daemon: {
        auth: { password: CONFIG_PASSWORD_HASH },
      },
    });

    const config = loadConfig(neolixHome, { env: {} });

    expect(config.auth?.password).toBe(CONFIG_PASSWORD_HASH);
    expect(
      await isBearerTokenValidAsync({ password: config.auth?.password, token: "correct-password" }),
    ).toBe(true);
  });

  test("lets NEOLIX_PASSWORD override config.json auth password hash", async () => {
    const neolixHome = await createNeolixHome({
      version: 1,
      daemon: {
        auth: { password: CONFIG_PASSWORD_HASH },
      },
    });

    const config = loadConfig(neolixHome, {
      env: { NEOLIX_PASSWORD: "from-env" },
    });

    expect(config.auth?.password).not.toBe(CONFIG_PASSWORD_HASH);
    expect(config.auth?.password).toMatch(/^\$2[aby]\$12\$/);
    expect(
      await isBearerTokenValidAsync({ password: config.auth?.password, token: "from-env" }),
    ).toBe(true);
  });
});
