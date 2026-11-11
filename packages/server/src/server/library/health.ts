import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StoredMcpServer } from "./store.js";
import { mcpWslCommand } from "./wsl.js";

export interface McpHealth {
  ok: boolean;
  tools: string[];
  error?: string;
  /** How long connecting and listing took. */
  ms: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function childEnvironment(server: StoredMcpServer, env: NodeJS.ProcessEnv): Record<string, string> {
  const inherited: Record<string, string> = getDefaultEnvironment();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") {
      inherited[key] = value;
    }
  }
  return { ...inherited, ...server.env };
}

function remoteOptions(server: StoredMcpServer): SSEClientTransportOptions {
  return server.headers && Object.keys(server.headers).length > 0
    ? { requestInit: { headers: server.headers } }
    : {};
}

export function transportFor(server: StoredMcpServer, env: NodeJS.ProcessEnv) {
  if (server.transport === "stdio") {
    return new StdioClientTransport({
      command: server.command ?? "",
      args: server.args ?? [],
      env: childEnvironment(server, env),
      stderr: "ignore",
    });
  }
  const url = new URL(server.url ?? "");
  if (server.transport === "sse") {
    return new SSEClientTransport(url, remoteOptions(server));
  }
  return new StreamableHTTPClientTransport(
    url,
    remoteOptions(server) as ConstructorParameters<typeof StreamableHTTPClientTransport>[1],
  );
}

/**
 * A stdio server started in a WSL distro: the distro's own command, as an
 * agent there starts it (myna's library/mcp_check.go).
 */
export async function wslStdioTransport(
  server: StoredMcpServer,
  env: NodeJS.ProcessEnv,
  distro: string,
): Promise<StdioClientTransport> {
  const launch = await mcpWslCommand({
    command: server.command ?? "",
    args: server.args ?? [],
    ...(server.env === undefined ? {} : { env: server.env }),
  });
  if (launch === null) {
    throw new Error(`${server.command ?? ""} isn't installed in WSL ${distro}`);
  }
  return new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    env: childEnvironment(server, env),
    stderr: "ignore",
  });
}

/**
 * Starts the server, lists its tools, and stops it. The same check works
 * for a command and for a URL; a timeout is a failed check, not a hang.
 */
export async function checkMcpServerHealth(
  server: StoredMcpServer,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; distro?: string } = {},
): Promise<McpHealth> {
  const started = Date.now();
  const timeoutMs =
    options.timeoutMs ??
    (server.startupTimeout ? server.startupTimeout * 1000 : DEFAULT_TIMEOUT_MS);
  const client = new Client({ name: "neolix-library", version: "1.0.0" });
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    const env = options.env ?? process.env;
    const transport =
      options.distro === undefined
        ? transportFor(server, env)
        : await wslStdioTransport(server, env, options.distro);
    await Promise.race([client.connect(transport), timedOut]);
    const listed = await Promise.race([
      client.listTools(undefined, { timeout: timeoutMs }),
      timedOut,
    ]);
    return {
      ok: true,
      tools: listed.tools.map((tool) => tool.name).sort(),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      tools: [],
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    await client.close().catch(() => undefined);
  }
}
