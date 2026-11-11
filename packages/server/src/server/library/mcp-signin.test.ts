import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { McpauthService, MCPAUTH_FILENAME } from "../mcpauth/mcpauth.js";
import { getLibraryHub } from "./hub-registry.js";
import { createLibraryService, type LibraryService } from "./index.js";

const BASE = "http://127.0.0.1:6767";
const open: Server[] = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** A minimal streamable-HTTP MCP server standing in for the gateway: what
 * the hub connects to when a server is signed in. */
async function fakeMcpGateway(options: { accept?: string } = {}): Promise<{
  base: string;
  seen: { path: string; headers: string }[];
}> {
  const seen: { path: string; headers: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "fresh", refresh_token: "r2", expires_in: 3600 }));
      return;
    }
    seen.push({ path: req.url ?? "", headers: JSON.stringify(req.headers) });
    if (
      options.accept !== undefined &&
      req.headers["authorization"] !== `Bearer ${options.accept}`
    ) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const message = JSON.parse(body === "" ? "{}" : body) as {
      id?: unknown;
      method?: string;
    };
    if (message.method === "initialize") {
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          },
        }),
      );
      return;
    }
    if (message.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{ name: "look", description: "Look", inputSchema: { type: "object" } }],
          },
        }),
      );
      return;
    }
    res.writeHead(202).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  open.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address");
  }
  return { base: `http://127.0.0.1:${address.port}`, seen };
}

describe("a signed-in MCP server in the library", () => {
  let root: string;
  let neolixHome: string;
  let home: string;
  let service: LibraryService;
  let mcpauth: McpauthService;

  const env = { PATH: "", HOME: "" } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "neolix-library-signin-"));
    neolixHome = path.join(root, "neolix");
    home = path.join(root, "home");
    await mkdir(neolixHome, { recursive: true });
    await mkdir(home, { recursive: true });
    env.HOME = home;
    service = createLibraryService({ neolixHome, homeDir: home, env });
    mcpauth = new McpauthService({ neolixHome });
    service.setMcpauth(mcpauth);
    service.setHub({
      baseUrl: () => BASE,
      keyForAgent: async () => "agent-key",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function signIn(url = "https://mcp.example/mcp", name = "neon"): Promise<void> {
    await writeFile(
      path.join(neolixHome, MCPAUTH_FILENAME),
      JSON.stringify({
        [name]: {
          url,
          tokenURL: "https://auth.example/token",
          clientID: "client-1",
          authMethod: "none",
          access: "access-1",
          refresh: "refresh-1",
          at: Date.now(),
          expires: Date.now() + 3_600_000,
        },
      }),
    );
  }

  async function claudeServers(): Promise<Record<string, Record<string, unknown>>> {
    const file = path.join(home, ".claude.json");
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    return parsed.mcpServers;
  }

  test("gives the agent the gateway's address and its own key", async () => {
    await signIn();
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url: "https://mcp.example/mcp",
      headers: { "X-Extra": "kept" },
      agents: ["claude"],
    });

    const servers = await claudeServers();
    expect(servers.neon).toMatchObject({
      type: "http",
      url: `${BASE}/mcp/neon`,
      headers: { "X-Extra": "kept", authorization: "Bearer agent-key" },
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.mcp[0]?.signIn).toEqual({ signedIn: true, at: expect.any(Number) });
  });

  test("signing out gives the agent the server's own address again", async () => {
    await signIn();
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url: "https://mcp.example/mcp",
      agents: ["claude"],
    });
    expect((await claudeServers()).neon?.url).toBe(`${BASE}/mcp/neon`);

    await service.signOutMcp("neon");

    expect((await claudeServers()).neon?.url).toBe("https://mcp.example/mcp");
    const snapshot = await service.getSnapshot();
    expect(snapshot.mcp[0]?.signIn).toBeUndefined();
  });

  test("a rename carries the sign-in to the new name", async () => {
    await signIn();
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url: "https://mcp.example/mcp",
      agents: ["claude"],
    });

    await service.saveMcpServer("neon", {
      name: "neon-two",
      transport: "http",
      url: "https://mcp.example/mcp",
      agents: ["claude"],
    });

    expect((await mcpauth.statusOf("neon", "https://mcp.example/mcp")).signedIn).toBe(false);
    expect((await mcpauth.statusOf("neon-two", "https://mcp.example/mcp")).signedIn).toBe(true);
    expect((await claudeServers())["neon-two"]?.url).toBe(`${BASE}/mcp/neon-two`);
  });

  test("removing the server forgets its sign-in", async () => {
    await signIn();
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url: "https://mcp.example/mcp",
      agents: ["claude"],
    });

    await service.removeMcpServer("neon");

    expect(await mcpauth.get("neon")).toBeUndefined();
  });

  test("a sign-in to another URL than the server's does not relay it", async () => {
    await signIn("https://other.example/mcp");
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url: "https://mcp.example/mcp",
      agents: ["claude"],
    });

    expect((await claudeServers()).neon?.url).toBe("https://mcp.example/mcp");
    const snapshot = await service.getSnapshot();
    expect(snapshot.mcp[0]?.signIn).toBeUndefined();
  });

  test("the hub connects to a signed-in server itself, with Neox's token", async () => {
    const gateway = await fakeMcpGateway();
    const url = `${gateway.base}/mcp`;
    await signIn(url);
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url,
      agents: ["claude"],
    });
    await service.setMcpHub(true);

    const hub = getLibraryHub();
    expect(hub).not.toBeNull();
    const tools = await hub!.listTools("claude");
    expect(tools.map((tool) => tool.tool)).toEqual(["look"]);
    expect(gateway.seen[0]?.path).toBe("/mcp");
    expect(gateway.seen[0]?.headers).toContain("Bearer access-1");
    await hub!.reset();
  });

  test("the hub renews a token the server refuses, then connects again", async () => {
    const gateway = await fakeMcpGateway({ accept: "fresh" });
    const url = `${gateway.base}/mcp`;
    await writeFile(
      path.join(neolixHome, MCPAUTH_FILENAME),
      JSON.stringify({
        neon: {
          url,
          tokenURL: `${gateway.base}/token`,
          clientID: "client-1",
          authMethod: "none",
          access: "stale",
          refresh: "r1",
          at: Date.now(),
          expires: Date.now() + 3_600_000,
        },
      }),
    );
    await service.saveMcpServer(null, {
      name: "neon",
      transport: "http",
      url,
      agents: ["claude"],
    });
    await service.setMcpHub(true);

    const hub = getLibraryHub();
    const tools = await hub!.listTools("claude");
    const headers = gateway.seen.map((entry) => entry.headers);
    expect(headers.some((entry) => entry.includes("Bearer stale"))).toBe(true);
    expect(headers.some((entry) => entry.includes("Bearer fresh"))).toBe(true);
    expect(tools.map((tool) => tool.tool)).toEqual(["look"]);
    await hub!.reset();
  });

  test("signing in to a stdio server is refused", async () => {
    await service.saveMcpServer(null, {
      name: "local",
      transport: "stdio",
      command: "npx",
      args: ["local-server"],
      agents: ["claude"],
    });
    await expect(service.signInMcp("local")).rejects.toThrow("streamable HTTP");
  });
});
