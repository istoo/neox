import { request as httpRequest } from "node:http";
import { resolveNeolixHome, readDaemonInstance } from "@neolix/server/daemon-control";
import { readPersistedConfig } from "@neolix/server/configuration";

/** Where the bridge reaches the daemon's gateway: a TCP base URL, or the
 * daemon's Unix socket, and the key a LAN/shared gateway asks for. */
export interface GatewayTarget {
  base?: string;
  socketPath?: string;
  key?: string;
}

export interface GatewayAnswer {
  status: number;
  statusText: string;
  contentType: string | null;
  body: string;
}

export interface ResolveGatewayOptions {
  home?: string;
  gateway?: string;
  key?: string;
}

function isWildcard(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::" || host === "::0";
}

function hostForUrl(host: string): string {
  const bare = host.replace(/^\[|\]$/g, "");
  return bare.includes(":") ? `[${bare}]` : bare;
}

/** The daemon's address as an agent on this computer reaches it. `NEOLIX_GATEWAY`
 * wins, as myna's `MYNA_GATEWAY` does; otherwise the running instance's
 * published listen address, then the gateway's configured port. */
export async function resolveGatewayTarget(
  options: ResolveGatewayOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayTarget> {
  const key = options.key ?? env.NEOLIX_GATEWAY_KEY ?? undefined;
  const configured = options.gateway ?? env.NEOLIX_GATEWAY;
  if (configured !== undefined && configured.trim() !== "") {
    return { base: configured.trim().replace(/\/+$/, ""), ...(key ? { key } : {}) };
  }
  const home = resolveNeolixHome({ NEOLIX_HOME: options.home ?? env.NEOLIX_HOME });
  const instance = await readDaemonInstance(home);
  const fromInstance = listenTarget(instance?.listen ?? "", key);
  if (fromInstance !== null) {
    return fromInstance;
  }
  // myna falls back to its own settings when no gateway address is set; the
  // daemon may not be running yet, but its configured listen address is
  // where an agent will reach it.
  const fromConfig = persistedTarget(home, key);
  if (fromConfig !== null) {
    return fromConfig;
  }
  throw new Error(
    `Neox's daemon is not running for ${home}: start it, or set NEOLIX_GATEWAY to its address`,
  );
}

function tcpTarget(host: string, port: string, key: string | undefined): GatewayTarget {
  const bare = isWildcard(host) ? "127.0.0.1" : host;
  return { base: `http://${hostForUrl(bare)}:${port}`, ...(key ? { key } : {}) };
}

/** A published `host:port` or Unix socket address. */
function listenTarget(listen: string, key: string | undefined): GatewayTarget | null {
  const trimmed = listen.trim();
  if (trimmed.startsWith("/")) {
    return { socketPath: trimmed, ...(key ? { key } : {}) };
  }
  const match = /^(.*):(\d+)$/.exec(trimmed);
  return match === null ? null : tcpTarget(match[1] ?? "", match[2] ?? "", key);
}

/** The daemon's address from `$NEOLIX_HOME/config.json`, or null when the
 * file says neither a listen address nor a port. */
function persistedTarget(home: string, key: string | undefined): GatewayTarget | null {
  let config: ReturnType<typeof readPersistedConfig>;
  try {
    config = readPersistedConfig(home);
  } catch {
    return null;
  }
  const fromListen = listenTarget(config.daemon?.listen ?? "", key);
  if (fromListen !== null) {
    return fromListen;
  }
  const port = config.daemon?.port;
  return port === undefined || port === 0
    ? null
    : { base: `http://127.0.0.1:${port}`, ...(key ? { key } : {}) };
}

/** Posts a JSON-RPC message to the gateway's `/mcp/<name>`. No timeout: a
 * search or a generation may take minutes, and a GET's stream stays open. */
/** Where each of Neolix's own servers answers. The image and vision ones
 * live under the myna-compatible prefix (routes.ts), the others at their
 * plain names. A name not here is a Library server, relayed at /mcp/<name>. */
const SERVER_PATHS: Record<string, string> = {
  browser: "/mcp/browser",
  search: "/mcp/web-search",
  "web-search": "/mcp/web-search",
  vision: "/mcp/myna/vision",
  image: "/mcp/myna/image",
};

export function postToGateway(
  target: GatewayTarget,
  name: string,
  payload: string,
): Promise<GatewayAnswer> {
  const requestPath = SERVER_PATHS[name] ?? `/mcp/${encodeURIComponent(name)}`;
  return postToGatewayPath(target, requestPath, payload);
}

/** Posts to one exact gateway path, for a caller that names the server's
 * path itself rather than by the bridge's short names. */
export function postToGatewayPath(
  target: GatewayTarget,
  requestPath: string,
  payload: string,
  userAgent?: string,
): Promise<GatewayAnswer> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "content-length": String(Buffer.byteLength(payload)),
    };
    if (userAgent !== undefined) {
      headers["user-agent"] = userAgent;
    }
    if (target.key) {
      headers.authorization = `Bearer ${target.key}`;
    }
    const options =
      target.socketPath !== undefined
        ? { socketPath: target.socketPath, path: requestPath, method: "POST", headers }
        : (() => {
            const url = new URL(requestPath, `${target.base ?? ""}/`);
            return {
              host: url.hostname,
              port: url.port === "" ? 80 : Number(url.port),
              path: `${url.pathname}${url.search}`,
              method: "POST",
              headers,
            };
          })();
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 502,
          statusText: response.statusMessage ?? "",
          contentType:
            typeof response.headers["content-type"] === "string"
              ? response.headers["content-type"]
              : null,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(payload);
  });
}

/** Fetches a gateway file (an image too large to inline) with the same key. */
export function getFromGateway(
  target: GatewayTarget,
  url: string,
): Promise<{ contentType: string | null; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const headers: Record<string, string> = { accept: "*/*" };
    if (target.key) {
      headers.authorization = `Bearer ${target.key}`;
    }
    const options =
      target.socketPath !== undefined
        ? {
            socketPath: target.socketPath,
            path: `${parsed.pathname}${parsed.search}`,
            method: "GET",
            headers,
          }
        : {
            host: parsed.hostname,
            port: parsed.port === "" ? 80 : Number(parsed.port),
            path: `${parsed.pathname}${parsed.search}`,
            method: "GET",
            headers,
          };
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          contentType:
            typeof response.headers["content-type"] === "string"
              ? response.headers["content-type"]
              : null,
          bytes: Buffer.concat(chunks),
        }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

/** Fetches a gateway file by its path and query, asked of the gateway the
 * target names: a file URL may carry a public address that isn't the one
 * this computer reaches the gateway at. */
export function getFromGatewayPath(
  target: GatewayTarget,
  requestPath: string,
  userAgent?: string,
): Promise<{ contentType: string | null; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: "*/*" };
    if (userAgent !== undefined) {
      headers["user-agent"] = userAgent;
    }
    if (target.key) {
      headers.authorization = `Bearer ${target.key}`;
    }
    const options =
      target.socketPath !== undefined
        ? { socketPath: target.socketPath, path: requestPath, method: "GET", headers }
        : (() => {
            const url = new URL(requestPath, `${target.base ?? ""}/`);
            return {
              host: url.hostname,
              port: url.port === "" ? 80 : Number(url.port),
              path: `${url.pathname}${url.search}`,
              method: "GET",
              headers,
            };
          })();
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          contentType:
            typeof response.headers["content-type"] === "string"
              ? response.headers["content-type"]
              : null,
          bytes: Buffer.concat(chunks),
        }),
      );
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}
