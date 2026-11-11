import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalSessionsService } from "./service.js";
import { writeWslSaved } from "./wsl-store.js";
import type { ExternalSession } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

async function savedHome(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-wsl-setting-"));
  roots.push(root);
  const neolixHome = path.join(root, "neox-home");
  await mkdir(path.join(root, "home"), { recursive: true });
  await mkdir(neolixHome, { recursive: true });
  await writeWslSaved(neolixHome, {
    version: 1,
    distros: {
      Ubuntu: { home: "\\\\wsl.localhost\\Ubuntu\\home\\me", sessions: [session("one")] },
    },
  });
  return root;
}

describe("the noWSLAgents setting", () => {
  it("shows a distro's saved sessions while WSL detection is on", async () => {
    const root = await savedHome();
    const service = new ExternalSessionsService({
      neolixHome: path.join(root, "neox-home"),
      homeDir: path.join(root, "home"),
      env: {},
    });
    const list = await service.list("claude");
    expect(list.sessions.map((entry) => entry.id)).toContain("one");
  });

  it("probes nothing and shows none of them once it is off", async () => {
    const root = await savedHome();
    const service = new ExternalSessionsService({
      neolixHome: path.join(root, "neox-home"),
      homeDir: path.join(root, "home"),
      env: {},
      wslEnabled: () => false,
    });
    const list = await service.list("claude");
    expect(list.sessions.map((entry) => entry.id)).not.toContain("one");
  });
});
