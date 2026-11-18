import { access } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { DaemonTransportFactory } from "@neolix/client/internal/daemon-client-transport-types";
import type { ListenTarget } from "./listen-address.js";
import type { WebAppPaths } from "./web-app-paths.js";
import { createWebAppTransportFactory, type WebAppSocket } from "./web-app-socket.js";

export { webAppCandidates, type WebAppPaths } from "./web-app-paths.js";

/**
 * The desktop web app on the daemon's own port, the way T3 Code's server hosts its
 * web client: the page, its RPC socket (`/rpc`) and its upload/download routes.
 * The routes live in a bundle built from `packages/desktop-web/apps/bridge`
 * (`embed.js`), loaded at runtime. The bundle carries Effect and the bridge's own code;
 * the Neox client and its protocol modules are injected from this process instead of
 * being shipped a second time.
 *
 * Only this machine may use it. Its RPC has no daemon password, so a request must
 * come from a loopback peer, name a loopback Host and carry no foreign Origin.
 */

interface EmbeddedWebApp {
  handleRequest(request: IncomingMessage, response: ServerResponse): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  dispose(): Promise<void>;
}

/**
 * The bridge bundle's copies of the Neox client. `embed.js` leaves them out: shipping
 * them inside it duplicated the client and the protocol's generated validators (~15 MB)
 * that this daemon already has loaded.
 */
interface EmbedClientRuntime {
  node: typeof import("@neolix/client/node");
  daemonClient: typeof import("@neolix/client/internal/daemon-client");
  hosts: typeof import("@neolix/client/internal/hosts");
  clientCaps: typeof import("@neolix/protocol/client-capabilities").CLIENT_CAPS;
  readLocalCredentialForTarget: typeof import("./local-credential.js").readLocalCredentialForTarget;
}

interface EmbedModule {
  startEmbeddedWebApp(options: {
    daemonHost: string;
    neolixHome: string;
    webDistDir: string;
    /** The daemon-side socket the bridge's client uses instead of dialing loopback TCP. */
    daemonTransport?: DaemonTransportFactory;
    clientRuntime: EmbedClientRuntime;
    log: (line: string) => void;
  }): Promise<EmbeddedWebApp>;
}

/** Loaded only when the web app starts, so a disabled app costs the daemon nothing. */
async function loadEmbedClientRuntime(): Promise<EmbedClientRuntime> {
  const [node, daemonClient, hosts, clientCapabilities, localCredential] = await Promise.all([
    import("@neolix/client/node"),
    import("@neolix/client/internal/daemon-client"),
    import("@neolix/client/internal/hosts"),
    import("@neolix/protocol/client-capabilities"),
    import("./local-credential.js"),
  ]);
  return {
    node,
    daemonClient,
    hosts,
    clientCaps: clientCapabilities.CLIENT_CAPS,
    readLocalCredentialForTarget: localCredential.readLocalCredentialForTarget,
  };
}

const OWNED_EXACT_PATHS = new Set([
  "/rpc",
  "/api/attachments/upload",
  "/api/attachments/cancel",
  "/api/project-favicon",
  "/api/site-favicon",
  "/api/terminal/upload",
  "/api/thread-export",
]);
const OWNED_PATH_PREFIXES = ["/rpc/", "/attachments/", "/plugin-web/"];
/** Paths the daemon answers itself; the page's history fallback never takes them. */
const DAEMON_PATH_PREFIXES = ["/api/", "/mcp", "/public/", "/.well-known/", "/ws"];

/** A route of the web app's own: RPC, attachments, favicons, export, plugin views. */
export function isWebAppRoute(pathname: string): boolean {
  return (
    OWNED_EXACT_PATHS.has(pathname) ||
    OWNED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/** A page load the web app answers: its static files and its history fallback. */
export function isWebAppPage(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return pathname !== "/api" && !DAEMON_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isWebAppUpgrade(pathname: string): boolean {
  return pathname === "/rpc" || pathname.startsWith("/rpc/");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || isLoopbackAddress(bare);
}

function hostnameOfHostHeader(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end > 0 ? host.slice(0, end + 1) : host;
  }
  const colon = host.lastIndexOf(":");
  return colon > 0 ? host.slice(0, colon) : host;
}

/**
 * From this machine: a loopback peer, a loopback Host (no DNS rebinding through a
 * public name) and no Origin, or a loopback one. A unix socket has no peer address
 * and is local by construction.
 */
export function isLocalWebAppRequest(request: IncomingMessage): boolean {
  const socket = request.socket;
  const isUnixSocket = socket.remoteAddress === undefined && socket.remoteFamily === undefined;
  if (!isUnixSocket && !isLoopbackAddress(socket.remoteAddress)) return false;
  const host = request.headers.host;
  if (
    !isUnixSocket &&
    (typeof host !== "string" || !isLoopbackHostname(hostnameOfHostHeader(host)))
  )
    return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate whose bundle and page are both built. */
export async function resolveWebAppPaths(
  candidates: readonly WebAppPaths[],
): Promise<WebAppPaths | null> {
  for (const candidate of candidates) {
    if (
      (await exists(candidate.bundlePath)) &&
      (await exists(path.join(candidate.distDir, "index.html")))
    ) {
      return candidate;
    }
  }
  return null;
}

/** The daemon's address as its own client dials it: loopback for a wildcard bind. */
export function daemonAddressForWebApp(target: ListenTarget): string {
  if (target.type !== "tcp") return target.path;
  const host = target.host === "0.0.0.0" || target.host === "::" ? "127.0.0.1" : target.host;
  return `${host.includes(":") ? `[${host}]` : host}:${target.port}`;
}

type HostState =
  | { status: "idle" }
  | { status: "starting"; ready: Promise<void> }
  | { status: "running"; app: EmbeddedWebApp }
  /** No candidate is built: the routes pass through as if the app were off. */
  | { status: "absent" }
  | { status: "failed" }
  | { status: "stopped" };

export class WebAppHost {
  private state: HostState = { status: "idle" };

  constructor(
    private readonly options: {
      /** Where the built app may be (`webAppCandidates`); none leaves it off. */
      candidates: readonly WebAppPaths[] | null | undefined;
      neolixHome: string;
      logger: Logger;
    },
  ) {}

  private get enabled(): boolean {
    return (this.options.candidates?.length ?? 0) > 0 && this.state.status !== "absent";
  }

  /**
   * Finds the build, loads the bundle and connects it to the daemon. Called once the
   * daemon accepts connections; a failure leaves the daemon running without the app.
   * `attachSocket` hands the daemon's WebSocket server the in-process socket the bridge
   * connects through; without it (a caller with no server) the bridge dials the daemon
   * host as the standalone one does.
   */
  public start(
    daemonAddress: string,
    attachSocket?: (socket: WebAppSocket) => Promise<void>,
  ): Promise<void> {
    const candidates = this.options.candidates ?? [];
    if (candidates.length === 0 || this.state.status !== "idle") return Promise.resolve();
    const logger = this.options.logger;
    const ready = (async () => {
      try {
        const paths = await resolveWebAppPaths(candidates);
        if (paths === null) {
          if (this.state.status !== "stopped") this.state = { status: "absent" };
          logger.info("No built web app found; the daemon port serves none");
          return;
        }
        const module = (await import(pathToFileURL(paths.bundlePath).href)) as EmbedModule;
        const clientRuntime = await loadEmbedClientRuntime();
        const daemonTransport = attachSocket
          ? createWebAppTransportFactory(attachSocket)
          : undefined;
        const app = await module.startEmbeddedWebApp({
          daemonHost: daemonAddress,
          neolixHome: this.options.neolixHome,
          webDistDir: paths.distDir,
          clientRuntime,
          ...(daemonTransport ? { daemonTransport } : {}),
          log: (line) => logger.debug({ line }, "web app"),
        });
        if (this.state.status === "stopped") {
          await app.dispose();
          return;
        }
        this.state = { status: "running", app };
        logger.info({ bundle: paths.bundlePath }, "Web app serving on the daemon port");
      } catch (error) {
        if (this.state.status !== "stopped") this.state = { status: "failed" };
        logger.error({ err: error }, "Web app failed to start");
      }
    })();
    this.state = { status: "starting", ready };
    return ready;
  }

  /** Express middleware: answers the web app's routes and page loads, passes the rest on. */
  public middleware(): (req: Request, res: Response, next: NextFunction) => void {
    return this.webAppMiddleware(true);
  }

  /**
   * The same routes behind an entrance that already authenticated the browser
   * (Settings › Network › Browser access): the caller has checked its key and
   * Host, so the loopback check would only turn a LAN page away from its own API.
   */
  public trustedMiddleware(): (req: Request, res: Response, next: NextFunction) => void {
    return this.webAppMiddleware(false);
  }

  /** `upgrade` listener: takes `/rpc` sockets and leaves every other path alone. */
  public upgradeListener(): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
    return this.webAppUpgradeListener(true);
  }

  /** `upgrade` behind the Browser access guard; the caller checks the cookie and Host. */
  public trustedUpgrade(): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
    return this.webAppUpgradeListener(false);
  }

  private webAppMiddleware(
    localOnly: boolean,
  ): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      if (!this.enabled) {
        next();
        return;
      }
      const route = isWebAppRoute(req.path);
      if (!route && !isWebAppPage(req.method, req.path)) {
        next();
        return;
      }
      if (localOnly && !isLocalWebAppRequest(req)) {
        if (route) {
          res.status(403).json({ error: "The web app is only served to this computer" });
          return;
        }
        next();
        return;
      }
      const state = this.state;
      if (state.status !== "running") {
        res.status(503).setHeader("Retry-After", "1");
        res
          .type("text/plain")
          .send(state.status === "failed" ? "The web app failed to start." : "Starting…");
        return;
      }
      state.app.handleRequest(req, res);
    };
  }

  private webAppUpgradeListener(
    localOnly: boolean,
  ): (request: IncomingMessage, socket: Duplex, head: Buffer) => void {
    return (request, socket, head) => {
      const pathname = (request.url ?? "").split("?")[0] ?? "";
      if (!this.enabled || !isWebAppUpgrade(pathname)) return;
      const state = this.state;
      if ((localOnly && !isLocalWebAppRequest(request)) || state.status !== "running") {
        const status = state.status === "running" ? "403 Forbidden" : "503 Service Unavailable";
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      state.app.handleUpgrade(request, socket, head);
    };
  }

  public async dispose(): Promise<void> {
    const state = this.state;
    this.state = { status: "stopped" };
    if (state.status === "starting") await state.ready;
    if (state.status === "running") await state.app.dispose();
    // A start that finished during the wait above saw "stopped" and disposed itself.
  }
}
