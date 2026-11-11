import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_READS,
  SessionNotReadError,
  foundSessionAgents,
  readSessionReads,
  readsSessions,
  sessionReadsOf,
  setSessionReads,
} from "./session-reads.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "neolix-session-reads-"));
  roots.push(root);
  return root;
}

describe("session reads consent", () => {
  it("settles an install that never answered as reading every agent", () => {
    expect(sessionReadsOf({})).toEqual(DEFAULT_SESSION_READS);
    expect(readsSessions(DEFAULT_SESSION_READS, "claude")).toBe(true);
    expect(readsSessions(DEFAULT_SESSION_READS, "codex")).toBe(true);
  });

  it("reads none before it is asked, then a named agent as it says and the rest by all", () => {
    const unasked = sessionReadsOf({ codexSessionReads: { asked: false } });
    expect(readsSessions(unasked, "claude")).toBe(false);

    const onlyClaude = sessionReadsOf({
      codexSessionReads: { asked: true, agents: { claude: true } },
    });
    expect(readsSessions(onlyClaude, "claude")).toBe(true);
    expect(readsSessions(onlyClaude, "codex")).toBe(false);

    const allButClaude = sessionReadsOf({
      codexSessionReads: { asked: true, all: true, agents: { claude: false } },
    });
    expect(readsSessions(allButClaude, "claude")).toBe(false);
    expect(readsSessions(allButClaude, "codex")).toBe(true);
  });

  it("changes only what it names, and keeps the rest", () => {
    const first = setSessionReads(DEFAULT_SESSION_READS, false, {
      claude: true,
      codex: false,
    });
    expect(first).toEqual({ asked: true, all: false, agents: { claude: true, codex: false } });

    const second = setSessionReads(first, true, { codex: true });
    expect(second).toEqual({ asked: true, all: true, agents: { claude: true, codex: true } });
  });

  it("refuses an agent without being asked, as myna's ErrNotRead does", () => {
    const error = new SessionNotReadError();
    expect(error.message).toBe(
      "Neox is not allowed to read this agent's sessions (Settings, Sessions)",
    );
  });
});

describe("session reads on disk", () => {
  it("reads gateway.json's setting without a daemon, and the default when it cannot", async () => {
    const root = await home();
    expect(await readSessionReads(root)).toEqual(DEFAULT_SESSION_READS);

    await writeFile(
      path.join(root, "gateway.json"),
      JSON.stringify({ codexSessionReads: { asked: true, agents: { claude: false } } }),
    );
    expect(readsSessions(await readSessionReads(root), "claude")).toBe(false);

    await writeFile(path.join(root, "gateway.json"), "{ not json");
    expect(await readSessionReads(root)).toEqual(DEFAULT_SESSION_READS);
  });

  it("finds the agents with a session store, by their folders alone", async () => {
    const root = await home();
    const env = {
      CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      CODEX_HOME: path.join(root, "codex"),
      PI_CODING_AGENT_DIR: path.join(root, "pi"),
      XDG_DATA_HOME: path.join(root, "share"),
    };
    expect(await foundSessionAgents(root, env)).toEqual([]);

    await mkdir(path.join(root, "claude", "projects"), { recursive: true });
    await mkdir(path.join(root, "codex", "sessions"), { recursive: true });
    expect(await foundSessionAgents(root, env)).toEqual(["claude", "codex"]);
  });
});
