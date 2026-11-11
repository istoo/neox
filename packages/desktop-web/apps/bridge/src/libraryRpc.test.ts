import { NEOLIX_LIBRARY_WS_METHODS, WS_METHODS, type McpConnector } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeLibraryHandlers } from "./libraryRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

const library = {
  dir: "/home/u/.neox/library",
  backupsDir: "/home/u/.neox/library-backups",
  homeDir: "/home/u",
  agents: [
    {
      id: "claude",
      name: "Claude",
      icon: "claude",
      instructionsPath: "/home/u/.claude/CLAUDE.md",
      mcpPath: null,
      skillsDir: null,
      hooksPath: null,
      subagentsDir: null,
    },
    {
      id: "codex",
      name: "Codex",
      icon: "codex",
      instructionsPath: "/home/u/.codex/AGENTS.md",
      mcpPath: null,
      skillsDir: null,
      hooksPath: null,
      subagentsDir: null,
    },
  ],
  instructions: { shared: "", sets: [], agents: [] },
  mcp: [
    {
      name: "docs",
      transport: "http" as const,
      url: "https://mcp.example.com/mcp",
      agents: ["claude"],
      signIn: { signedIn: false, dead: true },
      oauth: { clientId: "client" },
    },
    {
      name: "local",
      transport: "stdio" as const,
      command: "npx",
      args: ["-y", "server"],
      env: { TOKEN: "x" },
      agents: [],
    },
  ],
  skills: [],
  hooks: [],
  subagents: [],
  counts: { mcp: 2, skills: 0, hooks: 0, subagents: 0, rtk: 0 },
};

function harness(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    getLibrary: async () => ({ library }),
    syncLibrary: async () => ({ library, result: { changed: [], problems: [] } }),
    saveLibraryMcpServer: async (server: unknown, options: unknown) => {
      calls.push(["saveLibraryMcpServer", { server, options }]);
      return { library: { ...library, mcp: [server] }, result: { changed: [], problems: [] } };
    },
    signInLibraryMcpServer: async (name: string) => {
      calls.push(["signInLibraryMcpServer", name]);
      return {
        state: {
          id: "signin_1",
          server: name,
          url: "https://auth.example.com/start",
          state: "waiting" as const,
        },
      };
    },
    removeLibraryMcpServer: async (name: string) => {
      calls.push(["removeLibraryMcpServer", name]);
      return { library, result: { changed: [], problems: [] } };
    },
    setLibraryMcpAgents: async (name: string, agents: string[]) => {
      calls.push(["setLibraryMcpAgents", { name, agents }]);
      return { library, result: { changed: [], problems: [] } };
    },
    setLibraryMcpHub: async (on: boolean) => {
      calls.push(["setLibraryMcpHub", on]);
      return { library: { ...library, mcpHub: on }, result: { changed: [], problems: [] } };
    },
    setLibraryMcpRouter: async (name: string, direct: boolean) => {
      calls.push(["setLibraryMcpRouter", { name, direct }]);
      return { library, result: { changed: [], problems: [] } };
    },
    checkLibraryMcpServer: async (name: string) => {
      calls.push(["checkLibraryMcpServer", name]);
      return { health: { ok: true, tools: ["search"], ms: 12 } };
    },
    getMynaLibrary: async () => {
      calls.push(["getMynaLibrary", null]);
      return { myna: { dir: "/home/u/.myna", available: true, servers: [], skills: [] } };
    },
    importMynaLibrary: async (selection: unknown) => {
      calls.push(["importMynaLibrary", selection]);
      return { library, result: { changed: ["myna"], problems: [] } };
    },
    saveLibraryHook: async (hook: unknown, options: unknown) => {
      calls.push(["saveLibraryHook", { hook, options }]);
      return { library, result: { changed: [], problems: [] } };
    },
    getDaemonConfig: async () => ({
      requestId: "r",
      config: { mcp: { injectIntoAgents: true, enabled: true } },
    }),
    getDaemonStatus: async () => ({ listen: "127.0.0.1:6768" }),
    patchDaemonConfig: async (config: unknown) => {
      calls.push(["patchDaemonConfig", config]);
      return { requestId: "r", config: { mcp: { injectIntoAgents: false, enabled: true } } };
    },
    ...overrides,
  };
  const model = { client } as unknown as BridgeModel;
  return { handlers: makeLibraryHandlers(model), calls, client };
}

describe("library RPC handlers", () => {
  it("passes library.get through to the daemon", async () => {
    const { handlers } = harness();
    const result = await run<{ library: typeof library }>(
      handlers[NEOLIX_LIBRARY_WS_METHODS.get],
      {},
    );
    expect(result.library.dir).toBe(library.dir);
  });

  it("maps library MCP servers to Synara connectors", async () => {
    const { handlers } = harness();
    const connectors = await run<ReadonlyArray<McpConnector>>(
      handlers[WS_METHODS.serverListMcpConnectors],
      {},
    );
    expect(connectors).toHaveLength(2);
    expect(connectors[0]).toMatchObject({
      connectorId: "docs",
      transport: "remote-http",
      url: "https://mcp.example.com/mcp",
      authKind: "oauth",
      status: "needs-auth",
      presetId: null,
    });
    expect(connectors[1]).toMatchObject({
      connectorId: "local",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server"],
      envKeys: ["TOKEN"],
    });
  });

  it("connects a preset into every library agent and starts sign-in", async () => {
    const { handlers, calls } = harness();
    const result = await run<{ authorizationUrl: string | null; connector: unknown }>(
      handlers[WS_METHODS.serverConnectMcpConnector],
      { presetId: "supabase" },
    );
    expect(result.authorizationUrl).toBe("https://auth.example.com/start");
    expect(result.connector).toBeNull();
    const save = calls.find(([name]) => name === "saveLibraryMcpServer");
    expect(save?.[1]).toMatchObject({
      server: {
        name: "Supabase",
        transport: "http",
        url: "https://mcp.supabase.com/mcp",
        agents: ["claude", "codex"],
      },
    });
    expect(calls.find(([name]) => name === "signInLibraryMcpServer")?.[1]).toBe("Supabase");
  });

  it("disconnects by removing the library server", async () => {
    const { handlers, calls } = harness();
    const result = await run<{ disconnected: boolean }>(
      handlers[WS_METHODS.serverDisconnectMcpConnector],
      { connectorId: "docs" },
    );
    expect(result.disconnected).toBe(true);
    expect(calls.find(([name]) => name === "removeLibraryMcpServer")?.[1]).toBe("docs");
  });

  it("toggles the MCP hub, health and router through the daemon", async () => {
    const { handlers, calls } = harness();
    const hub = await run<{ library: { mcpHub?: boolean } }>(
      handlers[NEOLIX_LIBRARY_WS_METHODS.setMcpHub],
      { on: true },
    );
    expect(hub.library.mcpHub).toBe(true);
    expect(await run(handlers[NEOLIX_LIBRARY_WS_METHODS.checkMcpServer], { name: "docs" })).toEqual(
      { health: { ok: true, tools: ["search"], ms: 12 } },
    );
    await run(handlers[NEOLIX_LIBRARY_WS_METHODS.setMcpRouter], { name: "docs", direct: true });
    expect(calls.find(([name]) => name === "setLibraryMcpRouter")?.[1]).toEqual({
      name: "docs",
      direct: true,
    });
  });

  it("gets and imports the myna library", async () => {
    const { handlers, calls } = harness();
    const myna = await run<{ myna: { available: boolean } }>(
      handlers[NEOLIX_LIBRARY_WS_METHODS.getMynaLibrary],
      {},
    );
    expect(myna.myna.available).toBe(true);
    await run(handlers[NEOLIX_LIBRARY_WS_METHODS.importMynaLibrary], {
      servers: ["myna-docs"],
      skills: [],
    });
    expect(calls.find(([name]) => name === "importMynaLibrary")?.[1]).toEqual({
      servers: ["myna-docs"],
      skills: [],
    });
  });

  it("keeps the old name when saving an edited hook", async () => {
    const { handlers, calls } = harness();
    const hook = {
      name: "notify",
      event: "turn-end",
      command: "say done",
      agents: ["claude"],
    };
    await run(handlers[NEOLIX_LIBRARY_WS_METHODS.saveHook], { hook, oldName: "old" });
    expect(calls.find(([name]) => name === "saveLibraryHook")?.[1]).toMatchObject({
      options: { oldName: "old" },
    });
  });

  it("reports the built-in MCP address and toggles the tools switch", async () => {
    const { handlers, calls } = harness();
    expect(await run(handlers[NEOLIX_LIBRARY_WS_METHODS.getNeolixTools], {})).toEqual({
      address: "http://127.0.0.1:6768/mcp/agents",
      injectIntoAgents: true,
      enabled: true,
    });
    await run(handlers[NEOLIX_LIBRARY_WS_METHODS.setNeolixTools], { injectIntoAgents: false });
    expect(calls.find(([name]) => name === "patchDaemonConfig")?.[1]).toEqual({
      mcp: { injectIntoAgents: false },
    });
  });

  it("wraps daemon failures in a WsRpcError", async () => {
    const { handlers } = harness({
      getLibrary: async () => {
        throw new Error("daemon down");
      },
    });
    await expect(run(handlers[NEOLIX_LIBRARY_WS_METHODS.get], {})).rejects.toThrow("daemon down");
  });
});
