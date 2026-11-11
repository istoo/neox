import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  codexProcessIds,
  isCodexGatewayRequest,
  leaveCodexRelay,
  readState,
  runCodexRelay,
  startCodexRelay,
  startCodexRelayOnShutdown,
  type CodexRelayHandle,
} from "./codex-relay.js";

// The relay is reached over real HTTP; only a backend call is stubbed.
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

const dirs: string[] = [];
const handles: CodexRelayHandle[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) {
    handle.leave();
    await handle.done;
  }
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempState(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-codex-relay-"));
  dirs.push(dir);
  return join(dir, "codex-relay.json");
}

async function start(): Promise<{ handle: CodexRelayHandle; statePath: string }> {
  const statePath = tempState();
  const handle = await runCodexRelay({
    addr: "127.0.0.1:0",
    pids: [1],
    statePath,
    alive: () => true,
    watchEveryMs: 20,
    readSignIn: () => Promise.resolve({ accessToken: "tok", accountId: "acct-1" }),
    fetchImpl: (input, init) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/codex/responses");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer tok");
      expect(headers["chatgpt-account-id"]).toBe("acct-1");
      return Promise.resolve(
        new Response("data: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    },
  });
  handles.push(handle);
  return { handle, statePath };
}

describe("codex relay", () => {
  it("passes a turn on to ChatGPT with Codex's own sign-in", async () => {
    const { handle, statePath } = await start();
    const answer = await realFetch(`http://${handle.state.addr}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6.1-sol" }),
    });
    expect(answer.status).toBe(200);
    expect(await answer.text()).toBe("data: {}\n\n");
    expect((await readState(statePath))?.addr).toBe(handle.state.addr);
  });

  it("leaves the port when the next Neox asks", async () => {
    const statePath = tempState();
    const handle = await runCodexRelay({
      addr: "127.0.0.1:0",
      pids: [1],
      statePath,
      alive: () => true,
      watchEveryMs: 20,
      readSignIn: () => Promise.resolve(null),
    });
    handles.push(handle);
    expect(await leaveCodexRelay(statePath, realFetch)).toBe(true);
    await handle.done;
    expect(await readState(statePath)).toBeNull();
  });

  it("refuses a page from another origin", async () => {
    const { handle } = await start();
    const answer = await realFetch(`http://${handle.state.addr}/backend-api/codex/responses`, {
      method: "POST",
      headers: { origin: "https://elsewhere.example" },
    });
    expect(answer.status).toBe(403);
  });

  it("speaks HTTP, not WebSocket", async () => {
    const { handle } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `http://${handle.state.addr}/backend-api/codex/responses`,
        { headers: { upgrade: "websocket", connection: "Upgrade" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("upgrade", () => resolve(101));
      request.on("error", reject);
      request.end();
    });
    expect(status).toBe(426);
  });
});

describe("starting the relay apart", () => {
  it("runs the CLI with the port and the Codex processes", () => {
    let ran: { program: string; args: readonly string[] } | null = null;
    const pid = startCodexRelay({
      addr: "127.0.0.1:6768",
      pids: [11, 12],
      statePath: "/tmp/state.json",
      program: "neolix",
      spawn: (program, args) => {
        ran = { program, args };
        return { pid: 4242, unref: () => undefined };
      },
    });
    expect(pid).toBe(4242);
    expect(ran).toEqual({
      program: "neolix",
      args: [
        "codex-relay",
        "--addr",
        "127.0.0.1:6768",
        "--pids",
        "11,12",
        "--state",
        "/tmp/state.json",
      ],
    });
  });

  it("stays out of the way without the CLI or Codex processes", () => {
    const spawn = (): { pid: number } => ({ pid: 1 });
    expect(
      startCodexRelay({
        addr: "127.0.0.1:1",
        pids: [1],
        statePath: "/tmp/s",
        program: null,
        spawn,
      }),
    ).toBeNull();
    expect(
      startCodexRelay({
        addr: "127.0.0.1:1",
        pids: [],
        statePath: "/tmp/s",
        program: "neolix",
        spawn,
      }),
    ).toBeNull();
  });

  it("finds Codex's processes and not this relay", () => {
    expect(
      codexProcessIds(
        [
          "  101 /Applications/Codex.app/Contents/MacOS/codex",
          "  102 codex exec --model gpt-6",
          "  103 node /usr/local/bin/neolix codex-relay --addr x",
          "  104 node server.js",
          "  105 /usr/bin/codex-history",
          "  106 node vitest run src/server/llm-gateway/codex-accounts.test.ts",
        ].join("\n"),
      ),
    ).toEqual([101, 102, 105]);
  });

  it("leaves a relay when Codex was served and is still running", async () => {
    let args: readonly string[] = [];
    const pid = await startCodexRelayOnShutdown({
      addr: "127.0.0.1:6768",
      statePath: "/tmp/state.json",
      program: "neolix",
      servedCodex: true,
      spawn: (_program, spawned) => {
        args = spawned;
        return { pid: 7 };
      },
      run: () => Promise.resolve(" 55 codex exec\n 56 node server.js\n"),
    });
    expect(pid).toBe(7);
    expect(args).toEqual([
      "codex-relay",
      "--addr",
      "127.0.0.1:6768",
      "--pids",
      "55",
      "--state",
      "/tmp/state.json",
    ]);
  });

  it("leaves none when no Codex thread ever reached this daemon", async () => {
    let ran = false;
    const spawned: string[] = [];
    const pid = await startCodexRelayOnShutdown({
      addr: "127.0.0.1:6768",
      statePath: "/tmp/state.json",
      program: "neolix",
      servedCodex: false,
      spawn: (program) => {
        spawned.push(program);
        return { pid: 7 };
      },
      // A Codex process on the machine is not enough: the daemon never served
      // one, so `ps` is not even asked.
      run: () => {
        ran = true;
        return Promise.resolve(" 55 codex exec\n");
      },
    });
    expect(pid).toBeNull();
    expect(ran).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe("isCodexGatewayRequest", () => {
  it("recognizes Codex's own backend and nothing beside it", () => {
    expect(isCodexGatewayRequest("/backend-api/codex/responses")).toBe(true);
    expect(isCodexGatewayRequest("/backend-api/codex/responses?stream=1")).toBe(true);
    expect(isCodexGatewayRequest("/backend-api/codex")).toBe(true);
    expect(isCodexGatewayRequest("/backend-api/codex/models")).toBe(true);
    expect(isCodexGatewayRequest("/backend-api/codexfoo")).toBe(false);
    expect(isCodexGatewayRequest("/v1/responses")).toBe(false);
    expect(isCodexGatewayRequest("/api/status")).toBe(false);
    expect(isCodexGatewayRequest(undefined)).toBe(false);
  });
});
