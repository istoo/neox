import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalSession } from "./types.js";
import { readWslSaved, wslStorePath, writeWslSaved } from "./wsl-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-wsl-store-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

function session(id: string): ExternalSession {
  return {
    id,
    agent: "claude",
    cwd: "/home/me/app",
    title: "Ubuntu session",
    start: "2026-09-20T10:00:00.000Z",
    last: "2026-09-20T10:05:00.000Z",
    messages: 2,
    size: 100,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    models: [],
    cost: 0,
    priced: false,
    resume: "wsl.exe -d 'Ubuntu' -e sh -lc 'claude --resume one'",
    path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\.claude\\projects\\-app\\one.jsonl",
    deletable: true,
    wsl: "Ubuntu",
  };
}

describe("WSL saved listings", () => {
  it("keeps a stopped distro's sessions across reads", async () => {
    const neolixHome = await home();
    const saved = {
      version: 1 as const,
      distros: {
        Ubuntu: { home: "\\\\wsl.localhost\\Ubuntu\\home\\me", sessions: [session("one")] },
      },
    };

    await writeWslSaved(neolixHome, saved);

    expect(await readWslSaved(neolixHome)).toEqual(saved);
  });

  it("reads nothing useful from a broken or empty store", async () => {
    const neolixHome = await home();
    expect(await readWslSaved(neolixHome)).toEqual({ version: 1, distros: {} });

    await writeFile(wslStorePath(neolixHome), '{"version":2,"distros":{"Ubuntu":{}}}', "utf8");
    expect(await readWslSaved(neolixHome)).toEqual({ version: 1, distros: {} });

    await writeFile(
      wslStorePath(neolixHome),
      JSON.stringify({
        version: 1,
        distros: { Ubuntu: { home: 3, sessions: [{ id: "one" }, { id: "two", agent: "claude" }] } },
      }),
      "utf8",
    );
    const read = await readWslSaved(neolixHome);
    expect(read.distros.Ubuntu?.home).toBe("");
    expect(read.distros.Ubuntu?.sessions.map((entry) => entry.id)).toEqual(["two"]);
  });
});
