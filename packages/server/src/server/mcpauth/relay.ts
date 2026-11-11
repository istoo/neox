import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import type { McpauthService } from "./mcpauth.js";

/**
 * `/mcp/<name>` for a remote MCP server Neolix signed in to: the agent speaks
 * to it as to the server itself (streamable HTTP), and Neolix sends each
 * request on with its token, renewing it when it runs out or the server says
 * it has (myna internal/gateway/mcp.go:56).
 *
 * This lives beside mcpauth, not in the gateway router: the router only asks
 * whether a path is a sign-in's, and hands the request here once.
 */

/** Headers a relay doesn't pass on (myna gateway/mcp.go:36). */
const MCP_HOP_HEADERS = new Set([
  "authorization",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "accept-encoding",
]);

/** `/mcp/agents` is the daemon's own agent control plane, registered after
 * this router: it always stays the daemon's. */
const DAEMON_MCP_PATHS = new Set(["/mcp/agents"]);

/**
 * Whether `/mcp/...` is the gateway's to answer: the library hub, the
 * built-in servers, a relayed sign-in, or the empty server the gateway
 * answers for a name it has no target for (docs/llm-gateway.md). Without
 * this, a router-level `next("router")` would skip the gateway's own `/mcp`
 * routes and answer 404.
 */
export function isGatewayMcpPath(path: string): boolean {
  return path.startsWith("/mcp/") && !DAEMON_MCP_PATHS.has(path);
}

/**
 * The server a `/mcp/<name>` path names, when it is not one of the gateway's
 * own prefixes. The sign-in file decides whether it is relayed.
 */
export function signedInMcpName(path: string): string | null {
  const match = /^\/mcp\/([^/]+)(?:\/.*)?$/.exec(path);
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (name === "" || name === "myna" || name === "run" || name === "neox") {
    return null;
  }
  return name;
}

export interface SignedInRelayInput {
  req: ExpressRequest;
  res: ExpressResponse;
  logger: Logger;
  mcpauth: McpauthService | undefined;
}

/**
 * Relays one request to a signed-in server. Returns false when no sign-in
 * holds the name, for the gateway's own servers to answer.
 */
export async function serveSignedInMcp(input: SignedInRelayInput): Promise<boolean> {
  const service = input.mcpauth;
  const name = typeof input.req.params.name === "string" ? input.req.params.name : "";
  if (service === undefined || name === "" || signedInMcpName(input.req.path) !== name) {
    return false;
  }
  const record = await service.get(name);
  if (record === undefined) {
    return false;
  }
  // A web page can make the browser send a request here too (a form, or a
  // hostname of its own pointed at 127.0.0.1), and Neolix would carry it to
  // the server with the user's sign-in. Agents send no Origin.
  const origin = input.req.headers.origin;
  if (typeof origin === "string" && origin !== "") {
    input.res
      .status(403)
      .type("text/plain")
      .send("Neox lends its MCP sign-ins to agents, not to web pages");
    return true;
  }
  const target = relayTarget(record.url, input.req);
  if (target === null) {
    input.res.status(502).type("text/plain").send("the server's URL isn't one");
    return true;
  }
  const token = await tokenFor(input, name);
  if (token === null) {
    return true;
  }
  const upstream = await sendWithRenewal(input, name, target, token);
  if (upstream === null) {
    return true;
  }
  streamBack(input, upstream);
  return true;
}

function relayTarget(url: string, req: ExpressRequest): URL | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === "string") {
      target.searchParams.set(key, value);
    }
  }
  return target;
}

/** The access token, or null after answering the agent (a 502, never a 401:
 * a 401 would set it signing in itself). */
async function tokenFor(input: SignedInRelayInput, name: string): Promise<string | null> {
  try {
    return await input.mcpauth!.token(name);
  } catch (error) {
    refuse(input, name, error);
    return null;
  }
}

async function sendWithRenewal(
  input: SignedInRelayInput,
  name: string,
  target: URL,
  token: string,
): Promise<import("node:http").IncomingMessage | null> {
  const service = input.mcpauth!;
  const payload =
    input.req.method === "POST" && input.req.body !== undefined && input.req.body !== null
      ? JSON.stringify(input.req.body)
      : null;
  const send = (bearer: string) => relayMcpRequest(target, input.req, payload, bearer);
  let upstream: import("node:http").IncomingMessage;
  try {
    upstream = await send(token);
  } catch (error) {
    unreachable(input, name, error);
    return null;
  }
  if (upstream.statusCode !== 401) {
    return upstream;
  }
  upstream.resume();
  let fresh: string;
  try {
    fresh = await service.renewIfStale(name, token);
  } catch (error) {
    // A sign-in the server refused to renew, or that is already dead.
    refuse(input, name, error);
    return null;
  }
  try {
    upstream = await send(fresh);
  } catch (error) {
    unreachable(input, name, error);
    return null;
  }
  if (upstream.statusCode === 401) {
    // A token just renewed and refused all the same: the sign-in has run out.
    await service.rejected(name, fresh);
  }
  if (upstream.statusCode === 401) {
    upstream.resume();
    refuse(input, name, new McpauthExpired());
    return null;
  }
  return upstream;
}

function streamBack(
  input: SignedInRelayInput,
  upstream: import("node:http").IncomingMessage,
): void {
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (
      value === undefined ||
      MCP_HOP_HEADERS.has(key.toLowerCase()) ||
      key.toLowerCase() === "www-authenticate"
    ) {
      continue;
    }
    input.res.setHeader(key, value);
  }
  input.res.status(upstream.statusCode ?? 502);
  input.res.flushHeaders?.();
  upstream.on("data", (chunk: Buffer) => {
    if (!input.res.write(chunk)) {
      upstream.pause();
      input.res.once("drain", () => upstream.resume());
    }
  });
  upstream.on("end", () => input.res.end());
  upstream.on("error", () => input.res.end());
  input.req.on("close", () => upstream.destroy());
}

class McpauthExpired extends Error {
  constructor() {
    super("Neox's sign-in has run out");
    this.name = "McpauthExpired";
  }
}

function refuse(input: SignedInRelayInput, name: string, error: unknown): void {
  // Not a 401, which would set the agent signing in itself.
  const code =
    error instanceof McpauthExpired
      ? "expired"
      : typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: string }).code;
  const message =
    code === "expired" || code === "not_signed_in"
      ? `Neox's sign-in to the MCP server ${name} has run out: sign in to it again in Neox's Library`
      : errorText(error);
  input.res.status(502).type("text/plain").send(message);
}

function unreachable(input: SignedInRelayInput, name: string, error: unknown): void {
  input.logger.warn({ err: error, name }, "Cannot reach the MCP server");
  input.res
    .status(502)
    .type("text/plain")
    .send(`couldn't reach the MCP server ${name}: ${errorText(error)}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Sends an MCP request on with Neolix's token, without undici's browser
 * headers and with no timeout, so a GET's event stream stays open. */
function relayMcpRequest(
  target: URL,
  req: ExpressRequest,
  payload: string | null,
  token: string,
): Promise<import("node:http").IncomingMessage> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || MCP_HOP_HEADERS.has(key.toLowerCase())) {
        continue;
      }
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers.authorization = `Bearer ${token}`;
    if (payload !== null) {
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      target,
      { method: req.method, headers },
      resolve,
    );
    request.on("error", reject);
    request.end(payload ?? undefined);
  });
}
