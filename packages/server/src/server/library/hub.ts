import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StoredMcpServer } from "./store.js";
import { transportFor } from "./health.js";

/** One tool a library server lists, with the spec the hub gives the agent. */
export interface HubTool {
  server: string;
  tool: string;
  description?: string;
  inputSchema: unknown;
}

export interface LibraryHub {
  listTools(agent: string): Promise<HubTool[]>;
  callTool(
    agent: string,
    server: string,
    tool: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<unknown>;
  /** Ends the servers the hub started. */
  reset(): Promise<void>;
}

interface Connection {
  client: Client;
  tools: { name: string; description?: string; inputSchema: unknown }[];
  timer: NodeJS.Timeout;
  /** The token the connection was made with, null when it needed none. */
  token: string | null;
  /** Whether that token was already a renewal: a 401 then means the
   * sign-in has run out, not that the old token was stale. */
  renewed: boolean;
}

/**
 * Neolix's OAuth sign-ins, for the hub's own connections: myna's hub asks
 * mcpauth for the token (internal/gateway/mcp_check.go:745), marks a token
 * the server refused (852-855) and renews it before trying again. The
 * library's `setMcpauth` wires this in.
 */
export interface HubCredentials {
  /** The token for a server Neolix signed in to, null for any other. */
  token(server: StoredMcpServer): Promise<string | null>;
  /** The server refused this token: the sign-in is marked dead unless a
   * renewal revives it. */
  rejected(server: StoredMcpServer, token: string): Promise<void>;
  /** A fresh token; throws when the sign-in can't be renewed. */
  renew(server: StoredMcpServer, stale: string): Promise<string>;
}

const IDLE_MS = 10 * 60 * 1000;
const LIST_TIMEOUT_MS = 40_000;
const CALL_TIMEOUT_MS = 50_000;

const INSTRUCTIONS =
  "The tools of the MCP servers in Neox's Library, each named <server>__<tool>. " +
  "Add servers, or switch them on for an agent, in Neox's Settings → Use → Library.";

export function hubInstructions(): string {
  return INSTRUCTIONS;
}

/** The server with Neolix's token as its Authorization header, the agent's
 * own (if any) replaced. */
function withToken(server: StoredMcpServer, token: string): StoredMcpServer {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (key.toLowerCase() !== "authorization") {
      headers[key] = value;
    }
  }
  headers.Authorization = `Bearer ${token}`;
  return { ...server, headers };
}

/** A transport's 401: the token Neolix sent was refused. */
function refused(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 401
  );
}

/**
 * Runs the library's servers for the MCP hub: one connection per server,
 * started when a tool of it is first listed or called, ended after ten
 * minutes with no call.
 */
export function createLibraryHub(options: {
  serversForAgent: (agent: string) => StoredMcpServer[];
  env?: NodeJS.ProcessEnv;
  credentials?: HubCredentials;
}): LibraryHub {
  const env = options.env ?? process.env;
  const credentials = options.credentials;
  const connections = new Map<string, Connection>();

  const close = async (key: string): Promise<void> => {
    const connection = connections.get(key);
    if (!connection) {
      return;
    }
    connections.delete(key);
    clearTimeout(connection.timer);
    await connection.client.close().catch(() => undefined);
  };

  const reset = async (): Promise<void> => {
    await Promise.all([...connections.keys()].map((key) => close(key)));
  };

  const open = async (
    server: StoredMcpServer,
    token: string | null,
    renewed = false,
  ): Promise<Connection> => {
    const client = new Client({ name: "neolix-library-hub", version: "1.0.0" });
    const given = token === null ? server : withToken(server, token);
    try {
      await client.connect(transportFor(given, env));
      const listed = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS });
      const timer = setTimeout(() => {
        void close(server.name);
      }, IDLE_MS);
      timer.unref?.();
      const tools: Connection["tools"] = [];
      for (const tool of listed.tools) {
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
        });
      }
      const connection: Connection = { client, tools, timer, token, renewed };
      connections.set(server.name, connection);
      return connection;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  };

  /** The token Neolix holds for a signed-in server, null for any other. */
  const signInToken = async (server: StoredMcpServer): Promise<string | null> =>
    credentials === undefined ? null : credentials.token(server);

  /**
   * A 401 on a token: renew once and connect again; a 401 on a token that
   * was itself renewed marks the sign-in dead, which is myna's order in
   * internal/library/mcp_check.go:851-857.
   */
  const renewConnection = async (
    server: StoredMcpServer,
    stale: string,
    renewed: boolean,
  ): Promise<Connection> => {
    if (credentials === undefined) {
      throw new Error(`Neox has no sign-in for ${server.name}`);
    }
    await close(server.name);
    if (renewed) {
      await credentials.rejected(server, stale);
      throw new Error(`Neox's sign-in to ${server.name} has run out: sign in again in the Library`);
    }
    const fresh = await credentials.renew(server, stale);
    return open(server, fresh, true);
  };

  const connect = async (server: StoredMcpServer): Promise<Connection> => {
    const existing = connections.get(server.name);
    if (existing) {
      existing.timer.refresh();
      return existing;
    }
    const token = await signInToken(server);
    try {
      return await open(server, token);
    } catch (error) {
      if (token === null || !refused(error)) {
        throw error;
      }
      return renewConnection(server, token, false);
    }
  };

  const listedOf = (server: StoredMcpServer, connection: Connection): HubTool[] => {
    const listed: HubTool[] = [];
    for (const tool of connection.tools) {
      listed.push({
        server: server.name,
        tool: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
      });
    }
    return listed;
  };

  return {
    async listTools(agent) {
      const servers = options.serversForAgent(agent);
      const results = await Promise.allSettled(
        servers.map(async (server) => listedOf(server, await connect(server))),
      );
      const tools: HubTool[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          tools.push(...result.value);
        }
      }
      return tools.sort(
        (left, right) =>
          left.server.localeCompare(right.server) || left.tool.localeCompare(right.tool),
      );
    },

    async callTool(agent, serverName, tool, args, meta) {
      const server = options.serversForAgent(agent).find((entry) => entry.name === serverName);
      if (!server) {
        throw new Error(`No MCP server called ${serverName} is switched on for this agent`);
      }
      let connection = await connect(server);
      const call = (current: Connection) =>
        current.client.callTool(
          { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) },
          undefined,
          { timeout: CALL_TIMEOUT_MS },
        );
      try {
        return await call(connection);
      } catch (error) {
        // A token that ran out between calls: renew it as a connection's
        // first token is renewed (myna's mcp_check 852-855).
        if (connection.token === null || !refused(error)) {
          await close(server.name);
          throw error;
        }
        connection = await renewConnection(server, connection.token, connection.renewed);
        return await call(connection);
      }
    },

    reset,
  };
}

const UNSAFE_TOOL_CHARS = /[^A-Za-z0-9_-]+/g;

/** `<server>__<tool>`, cut to 64 characters, two alike told apart by a number. */
export function hubToolNames(tools: readonly HubTool[]): (HubTool & { name: string })[] {
  const seen = new Set<string>();
  return tools.map((tool) => {
    const base = `${tool.server.replace(UNSAFE_TOOL_CHARS, "-")}__${tool.tool.replace(UNSAFE_TOOL_CHARS, "-")}`;
    let name = base.slice(0, 64);
    for (let index = 2; seen.has(name); index += 1) {
      const suffix = `_${index}`;
      name = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    }
    seen.add(name);
    return { ...tool, name };
  });
}
