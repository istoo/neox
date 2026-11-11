import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer as createSecureServer } from "node:https";
import { chmod, mkdir, rename, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { networkInterfaces } from "node:os";
import path from "node:path";
import express from "express";
import type { Logger } from "pino";
import { createWebUiMiddleware } from "./web-ui.js";

/**
 * Settings › Network › Browser access (myna's apppage.go): the bundled web UI
 * served to a browser on a port of its own, while the daemon runs. myna's page
 * is served on 3430 with a key in its link; a browser trades that key for a
 * cookie, and without either gets a sign-in form. "local" listens on
 * 127.0.0.1 alone, for a tunnel or an SSH forward; "lan" on every address.
 *
 * The settings live in `$NEOLIX_HOME/web-page.json` (0600), apart from
 * config.json: the key opens every setting the daemon has, and a backup of the
 * daemon's config must not carry it to another computer. A change is applied
 * at once — off, or on another port, closes and rebinds — and a port another
 * program holds is tried again every few seconds (myna's appPageRetry).
 */

export const WEB_PAGE_DEFAULT_PORT = 3430;
export const WEB_PAGE_RETRY_MS = 4_000;
const WEB_PAGE_KEY_MIN = 16;
const COOKIE_NAME = "neolix_web";
const COOKIE_AGE_S = 400 * 24 * 60 * 60;
const SIGN_IN_PATH = "/__neolix_web/signin";
const FILE_NAME = "web-page.json";

export type WebPageMode = "off" | "local" | "lan";

export interface WebPageSettings {
  mode: WebPageMode;
  port: number;
  key: string;
  /** The address it listens on, host:port; absent is the mode's own. */
  addr?: string;
  /** The TLS certificate and key files; both serve the page over HTTPS. */
  tlsCert?: string;
  tlsKey?: string;
}

/** What the settings page draws. */
export interface WebPageState {
  mode: WebPageMode;
  port: number;
  /** Whether the page is served over HTTPS. */
  tls: boolean;
  /** The address it listens on, host:port; null when it serves nothing. */
  addr: string | null;
  serving: boolean;
  /** This computer's link, with the key; null until one is made. */
  link: string | null;
  /** Other computers' links, on "lan" only. */
  network: string[];
  /** Why the page is not served where asked, if it is not. */
  error: string | null;
}

/** Where the daemon's own routes are, for the page to pass them on. */
export interface WebPageTarget {
  host: string;
  port: number;
}

export interface WebPageOptions {
  neolixHome: string;
  distDir: string | null;
  logger: Logger;
  /** The daemon's own TCP address; null when it listens on a socket. */
  daemonAddress: () => WebPageTarget | null;
}

export function checkWebPagePort(port: number, daemonPort: number | null = null): string | null {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return "a port is a number from 1024 to 65535";
  }
  if (daemonPort !== null && port === daemonPort) {
    return `port ${port} is the daemon's: pick another one`;
  }
  return null;
}

export function checkWebPageKey(key: string): string | null {
  if (key.length < WEB_PAGE_KEY_MIN) {
    return `the key is ${key.length} characters; it needs at least ${WEB_PAGE_KEY_MIN}`;
  }
  if (!/^[A-Za-z0-9._~-]+$/.test(key)) {
    return "the key takes letters, digits and - . _ ~ only";
  }
  return null;
}

export function newWebPageKey(): string {
  return randomBytes(16).toString("hex");
}

function settingsPath(neolixHome: string): string {
  return path.join(neolixHome, FILE_NAME);
}

export async function loadWebPageSettings(neolixHome: string): Promise<WebPageSettings> {
  const empty: WebPageSettings = { mode: "off", port: WEB_PAGE_DEFAULT_PORT, key: "" };
  let text: string;
  try {
    text = await readFile(settingsPath(neolixHome), "utf8");
  } catch {
    return empty;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty;
  }
  return settingsOf(raw);
}

function settingsOf(raw: unknown): WebPageSettings {
  if (typeof raw !== "object" || raw === null) {
    return { mode: "off", port: WEB_PAGE_DEFAULT_PORT, key: "" };
  }
  const record = raw as Record<string, unknown>;
  const mode = record.mode;
  const port = record.port;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  const addr = text(record.addr);
  const tlsCert = text(record.tlsCert);
  const tlsKey = text(record.tlsKey);
  return {
    mode: mode === "local" || mode === "lan" ? mode : "off",
    port:
      typeof port === "number" && checkWebPagePort(port) === null ? port : WEB_PAGE_DEFAULT_PORT,
    key: typeof record.key === "string" ? record.key : "",
    ...(addr === undefined ? {} : { addr }),
    ...(tlsCert === undefined ? {} : { tlsCert }),
    ...(tlsKey === undefined ? {} : { tlsKey }),
  };
}

export async function saveWebPageSettings(
  neolixHome: string,
  settings: WebPageSettings,
): Promise<void> {
  const target = settingsPath(neolixHome);
  const temporary = path.join(neolixHome, `.web-page-${process.pid}.json`);
  await mkdir(neolixHome, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => undefined);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The links to the page: this computer's, and on "lan" the network's. */
/** The host and port the page is bound to: addr when set, else the mode's own. */
function boundHostPort(settings: WebPageSettings): { host: string; port: number } {
  if (settings.addr !== undefined) {
    const match = /^(.+):(\d+)$/.exec(settings.addr.trim());
    if (match !== null) {
      return { host: match[1]!.replace(/^\[|\]$/g, ""), port: Number(match[2]) };
    }
  }
  return { host: settings.mode === "lan" ? "0.0.0.0" : "127.0.0.1", port: settings.port };
}

/** A host as a URL spells it: an IPv6 literal in brackets. */
function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

export function webPageLinks(settings: WebPageSettings): {
  link: string | null;
  network: string[];
} {
  if (settings.mode === "off" || checkWebPageKey(settings.key) !== null) {
    return { link: null, network: [] };
  }
  const query = `/?k=${encodeURIComponent(settings.key)}`;
  const scheme = settings.tlsCert !== undefined && settings.tlsKey !== undefined ? "https" : "http";
  const bound = boundHostPort(settings);
  const link = `${scheme}://${urlHost(bound.host)}:${bound.port}${query}`;
  if (settings.mode !== "lan") {
    if (bound.host !== "127.0.0.1" && bound.host !== "0.0.0.0" && bound.host !== "::") {
      return { link, network: [`${scheme}://${urlHost(bound.host)}:${bound.port}${query}`] };
    }
    return { link, network: [] };
  }
  const publicUrl = publicPageUrl();
  if (publicUrl !== null && new URL(publicUrl).port.length === 0) {
    // A tunnel or reverse proxy names the page itself; other computers reach
    // it there, not at this machine's own addresses (myna's NetworkLinks).
    return { link, network: [`${publicUrl}${query}`] };
  }
  return {
    link,
    network: networkHosts().map((host) => `${scheme}://${urlHost(host)}:${bound.port}${query}`),
  };
}

/** This computer's own IPv4 addresses, the ones other computers can reach. */
export function networkHosts(): string[] {
  const hosts: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }
      hosts.push(entry.address);
    }
  }
  return hosts;
}

/** Which requests belong to the daemon beside the page rather than to the page. */
export function isDaemonPath(pathname: string): boolean {
  return (
    pathname === "/ws" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/public/") ||
    pathname.startsWith("/mcp/")
  );
}

function sameKey(given: string, key: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(key);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The page's cookie. SameSite=Strict: it is sent only by this page's own
 * requests, never by another site's. No Secure: the page is served over plain
 * HTTP on a LAN where the daemon has no TLS (myna's webGuard sets none); a
 * tunnel that terminates TLS reaches it over loopback.
 */
function cookieFor(key: string, secure: boolean): string {
  const securePart = secure ? "; Secure" : "";
  return `${COOKIE_NAME}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Strict${securePart}; Max-Age=${COOKIE_AGE_S}`;
}

/** The hostname a Host header names, without its port; null for none. */
function hostnameOf(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const text = header.trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end > 0 ? text.slice(1, end) : null;
  }
  const colon = text.lastIndexOf(":");
  return colon >= 0 ? text.slice(0, colon) : text;
}

/**
 * The names this page answers to: this computer's, on "lan" its network
 * addresses, and the public address a tunnel reaches it at. myna's
 * MYNA_PUBLIC_URL is how a tunnel's own name is let in on `myna web`
 * (internal/gateway/lan.go: ownHost, NetworkLinks); there is no list of
 * allowed names beyond it. A name that is not one of these is refused
 * before any cookie or key is looked at, so a rebinding page reaches
 * nothing even with one.
 */
function allowedHost(header: string | undefined, lan: boolean, addr?: string): boolean {
  const host = hostnameOf(header);
  if (host === null) {
    return false;
  }
  const bound =
    addr === undefined ? null : /^(.+):\d+$/.exec(addr.trim())?.[1]?.replace(/^\[|\]$/g, "");
  if (bound !== null && host === bound?.toLowerCase()) {
    return true;
  }
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return true;
  }
  if (host === publicPageHost()) {
    return true;
  }
  return lan && networkHosts().includes(host);
}

/**
 * NEOLIX_PUBLIC_URL, myna's MYNA_PUBLIC_URL: the address a tunnel or reverse
 * proxy reaches this computer at, with a scheme, without trailing slashes.
 * Anything with a query, a fragment or credentials is not taken.
 */
export function publicPageUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  let text = (env.NEOLIX_PUBLIC_URL ?? "").trim();
  if (text.length === 0) {
    return null;
  }
  if (!text.includes("://")) {
    text = `http://${text}`;
  }
  text = text.replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.host.length === 0 || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return null;
  }
  if (url.search.length > 0 || url.hash.length > 0 || url.username.length > 0) {
    return null;
  }
  return text;
}

export function publicPageHost(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = publicPageUrl(env);
  if (url === null) {
    return null;
  }
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function cookieKey(header: string | undefined): string | null {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === COOKIE_NAME) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

/** The link's key, traded for a cookie, or the cookie already sent. */
function presentedKey(req: express.Request): string | null {
  const fromQuery = req.query.k;
  if (typeof fromQuery === "string") {
    return fromQuery;
  }
  return cookieKey(req.headers.cookie);
}

function withoutKey(url: string): string {
  const index = url.indexOf("?");
  if (index < 0) {
    return url;
  }
  const params = new URLSearchParams(url.slice(index + 1));
  params.delete("k");
  const rest = params.toString();
  return rest.length === 0 ? url.slice(0, index) : `${url.slice(0, index)}?${rest}`;
}

/** Signs a browser in, or says why it stays out (myna's webGuard). */
function guard(
  req: express.Request,
  res: express.Response,
  key: string,
  secure: boolean,
  next: () => void,
): void {
  const given = presentedKey(req);
  if (given !== null && sameKey(given, key)) {
    if (typeof req.query.k === "string") {
      res.setHeader("set-cookie", cookieFor(key, secure));
      res.redirect(303, withoutKey(req.originalUrl));
      return;
    }
    next();
    return;
  }
  res.setHeader("cache-control", "no-store");
  res
    .status(401)
    .type("html")
    .send(signInPage(given !== null));
}

function signInPage(wrong: boolean): string {
  const why = wrong
    ? "This link's key is not this daemon's page's."
    : "This page needs the key from the link Settings › Network shows.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neox</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32em;margin:12vh auto;padding:0 16px}input,button{font:inherit;padding:.4em .6em}input{width:100%;box-sizing:border-box;margin:.5em 0}</style>
</head><body><h1>Neox</h1><p>${why}</p>
<form method="post" action="${SIGN_IN_PATH}"><input type="password" name="key" autocomplete="current-password" autofocus required><button type="submit">Open</button></form></body></html>`;
}

interface WebPagePatch {
  mode?: WebPageMode;
  port?: number;
  newKey?: boolean;
  addr?: string | null;
  tlsCert?: string | null;
  tlsKey?: string | null;
}

/** The settings a patch asks for, with a null taking a value off again. */
function mergeWebPageSettings(current: WebPageSettings, patch: WebPagePatch): WebPageSettings {
  let addr = current.addr;
  if (patch.addr !== undefined) {
    addr = patch.addr === null ? undefined : patch.addr.trim();
  }
  let tlsCert = current.tlsCert;
  let tlsKey = current.tlsKey;
  if (patch.tlsCert !== undefined) {
    tlsCert = patch.tlsCert === null ? undefined : patch.tlsCert.trim();
  }
  if (patch.tlsKey !== undefined) {
    tlsKey = patch.tlsKey === null ? undefined : patch.tlsKey.trim();
  }
  if ((tlsCert === undefined) !== (tlsKey === undefined)) {
    throw new Error("a certificate and its key go together: --tls-cert and --tls-key");
  }
  return {
    mode: patch.mode ?? current.mode,
    port: patch.port ?? current.port,
    key:
      patch.newKey === true || checkWebPageKey(current.key) !== null
        ? newWebPageKey()
        : current.key,
    ...(addr === undefined ? {} : { addr }),
    ...(tlsCert === undefined ? {} : { tlsCert }),
    ...(tlsKey === undefined ? {} : { tlsKey }),
  };
}

export class WebPageServer {
  private settings: WebPageSettings = { mode: "off", port: WEB_PAGE_DEFAULT_PORT, key: "" };
  /** The certificate and key, read when the settings name both. */
  private tlsMaterial: { cert: Buffer; key: Buffer } | null = null;
  /** `neolix web --gateway`'s flag: the page in gateway mode, for this page's life. */
  private gatewayFlag = false;
  /** Why the TLS files could not be used, in words that name no file content. */
  private tlsError: string | null = null;
  private server: Server | null = null;
  private addr: string | null = null;
  private error: string | null = null;
  private retry: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly options: WebPageOptions) {}

  /** Reads the settings and serves what they ask; called once at start. */
  public async start(): Promise<void> {
    this.settings = await loadWebPageSettings(this.options.neolixHome);
    await this.loadTls();
    this.apply();
    await this.pending;
  }

  /** Takes a change: persisted, then bound now (myna's POST /api/web-page). */
  public async update(patch: {
    mode?: WebPageMode;
    port?: number;
    newKey?: boolean;
    /** host:port, or null to go back to the mode's own address. */
    addr?: string | null;
    /** The TLS certificate and key files, or null to serve plain HTTP again. */
    tlsCert?: string | null;
    tlsKey?: string | null;
    /** `neolix web --gateway`: the browser page in gateway mode; not saved. */
    gateway?: boolean;
  }): Promise<WebPageState> {
    if (patch.gateway !== undefined) {
      this.gatewayFlag = patch.gateway;
    }
    const daemonPort = this.options.daemonAddress()?.port ?? null;
    if (patch.port !== undefined) {
      const problem = checkWebPagePort(patch.port, daemonPort);
      if (problem !== null) {
        throw new Error(problem);
      }
    }
    if (
      patch.addr !== undefined &&
      patch.addr !== null &&
      !/^(\[[0-9a-f:.]+\]|[^:]+):\d+$/i.test(patch.addr.trim())
    ) {
      throw new Error(
        `--addr is a host and a port, as 127.0.0.1:3430, not ${JSON.stringify(patch.addr)}`,
      );
    }
    const next = mergeWebPageSettings(this.settings, patch);
    await saveWebPageSettings(this.options.neolixHome, next);
    this.settings = next;
    await this.loadTls();
    this.error = null;
    this.apply();
    this.nudge();
    await this.pending;
    return this.state();
  }

  /** Whether `neolix web --gateway` asked for gateway mode. */
  public gatewayOn(): boolean {
    return this.gatewayFlag;
  }

  public state(): WebPageState {
    const { link, network } = webPageLinks(this.settings);
    return {
      mode: this.settings.mode,
      port: this.settings.port,
      tls: this.tls(),
      addr: this.server === null ? null : this.addr,
      serving: this.server !== null && this.addr === this.wantedAddress(),
      link,
      network,
      error: this.error,
    };
  }

  public dispose(): void {
    this.closed = true;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.close();
  }

  /** Reads the certificate and key, when both are set, so a listen needs no file I/O. */
  private async loadTls(): Promise<void> {
    this.tlsMaterial = null;
    this.tlsError = null;
    if (this.settings.tlsCert === undefined || this.settings.tlsKey === undefined) {
      return;
    }
    const cert = await this.readTlsFile(this.settings.tlsCert, "certificate");
    const key = await this.readTlsFile(this.settings.tlsKey, "key");
    if (cert === null || key === null) {
      return;
    }
    this.tlsMaterial = { cert, key };
  }

  /**
   * One TLS file. A failure names the file and what kind of failure it was,
   * never a byte of what it holds: the path came over an RPC, and the file
   * may be anything the daemon can read.
   */
  private async readTlsFile(file: string, what: string): Promise<Buffer | null> {
    try {
      return await readFile(file);
    } catch (error) {
      const kind =
        error instanceof Error && "code" in error ? "could not be read" : "could not be read";
      this.tlsError = `the ${what} ${kind}: ${file}`;
      return null;
    }
  }

  /** Whether the page is served over HTTPS: a certificate and a key are both set. */
  private tls(): boolean {
    return this.settings.tlsCert !== undefined && this.settings.tlsKey !== undefined;
  }

  private wantedAddress(): string | null {
    if (this.settings.mode === "off") {
      return null;
    }
    if (this.settings.addr !== undefined) {
      return this.settings.addr;
    }
    const host = this.settings.mode === "lan" ? "0.0.0.0" : "127.0.0.1";
    return `${host}:${this.settings.port}`;
  }

  /** Brings what is served to what the settings say. */
  private apply(): void {
    if (this.closed) {
      return;
    }
    const want = this.wantedAddress();
    if (this.addr !== want) {
      this.close();
    }
    if (want === null) {
      this.error = null;
      return;
    }
    if (checkWebPageKey(this.settings.key) !== null) {
      this.error = "the page has no key yet";
      return;
    }
    if (this.server !== null) {
      return;
    }
    if (this.options.distDir === null) {
      this.error = "the daemon serves no web page on this computer (no web UI build)";
      return;
    }
    if (this.tls() && this.tlsMaterial === null) {
      this.error = this.tlsError ?? `the certificate could not be read: ${this.settings.tlsCert}`;
      return;
    }
    this.listen(want);
  }

  private listen(want: string): void {
    const [host, port] = splitHostPort(want);
    const app = this.app();
    const material = this.tls() ? this.tlsMaterial : null;
    let server: Server;
    try {
      server =
        material === null
          ? createServer(app)
          : (createSecureServer(
              { cert: material.cert, key: material.key },
              app,
            ) as unknown as Server);
    } catch {
      // OpenSSL's own words may quote what it read; the reply names the file
      // and the kind of failure only.
      this.error = `the certificate or key is not a usable PEM: ${this.settings.tlsCert ?? ""}`;
      return;
    }
    server.on("upgrade", (req, socket, head) => this.proxyUpgrade(req, socket, head));
    this.pending = new Promise<void>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        this.error = busySays(this.settings.port, error);
        this.scheduleRetry();
        this.pending = null;
        resolve();
      });
      server.listen(Number(port), host, () => {
        this.server = server;
        this.addr = want;
        this.error = null;
        this.pending = null;
        this.options.logger.info({ address: want }, "Browser access is being served");
        resolve();
      });
    });
  }

  private app(): express.Express {
    const app = express();
    app.use((req, res, next) => {
      // DNS rebinding: a page on another name that resolves to this computer
      // must not reach the cookie behind this one. Only the names the page is
      // reached by are answered (SECURITY.md, DNS rebinding).
      if (!allowedHost(req.headers.host, this.settings.mode === "lan", this.settings.addr)) {
        res.setHeader("cache-control", "no-store");
        res.status(403).type("text").send("This page is not served under that name.");
        return;
      }
      next();
    });
    app.use((req, res, next) => {
      if (req.path === SIGN_IN_PATH) {
        next();
        return;
      }
      guard(req, res, this.settings.key, this.tls(), next);
    });
    app.post(SIGN_IN_PATH, express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
      const given = typeof req.body?.key === "string" ? req.body.key : "";
      if (!sameKey(given, this.settings.key)) {
        res.status(401).type("html").send(signInPage(true));
        return;
      }
      res.setHeader("set-cookie", cookieFor(this.settings.key, this.tls()));
      res.redirect(303, "/");
    });
    app.use((req, res, next) => {
      if (!isDaemonPath(req.path)) {
        next();
        return;
      }
      this.proxyHttp(req, res);
    });
    app.use(
      createWebUiMiddleware({
        enabled: true,
        distDir: this.options.distDir,
        label: "Neox",
        logger: this.options.logger,
      }),
    );
    return app;
  }

  /** The daemon's own API and socket, passed on so the page is same-origin. */
  private proxyHttp(req: express.Request, res: express.Response): void {
    const target = this.options.daemonAddress();
    if (target === null) {
      this.error = "browser access needs the daemon on a TCP address, not a socket";
      res.status(502).json({ error: this.error });
      return;
    }
    const upstream = httpRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.originalUrl,
        headers: forwardedHeaders(req.headers),
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, withoutHopByHop(reply.headers));
        reply.pipe(res);
      },
    );
    upstream.once("error", (error) => {
      if (!res.headersSent) {
        res.status(502).json({ error: `the daemon did not answer: ${error.message}` });
        return;
      }
      res.destroy();
    });
    req.pipe(upstream);
    res.once("close", () => upstream.destroy());
  }

  private proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const target = this.options.daemonAddress();
    const key = cookieKey(req.headers.cookie);
    if (
      !allowedHost(req.headers.host, this.settings.mode === "lan", this.settings.addr) ||
      target === null ||
      key === null ||
      !sameKey(key, this.settings.key)
    ) {
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: target.host, port: target.port }, () => {
      const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
  }

  private nudge(): void {
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.apply();
  }

  private scheduleRetry(): void {
    if (this.closed || this.retry !== null) {
      return;
    }
    this.retry = setTimeout(() => {
      this.retry = null;
      this.apply();
    }, WEB_PAGE_RETRY_MS);
    this.retry.unref();
  }

  private close(): void {
    if (this.server !== null) {
      this.server.close();
      this.server = null;
    }
    this.addr = null;
  }
}

function splitHostPort(address: string): [string, string] {
  const colon = address.lastIndexOf(":");
  return [address.slice(0, colon), address.slice(colon + 1)];
}

function forwardedHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  // The page's Host and Origin are the same origin to the daemon's socket
  // check; rewriting Host would turn its own page away. Framing is Node's to
  // decide once the body is dechunked.
  return withoutHopByHop(headers);
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHop(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

function busySays(port: number, error: NodeJS.ErrnoException): string {
  if (error.code === "EADDRINUSE") {
    return `port ${port} is taken by another program; Neox tries again every few seconds`;
  }
  return `port ${port} can't be taken (${error.message}); Neox tries again every few seconds`;
}

let configured: WebPageServer | null = null;

export function configureWebPage(server: WebPageServer): void {
  configured = server;
}

export function webPageServer(): WebPageServer | null {
  return configured;
}

/** What the settings page draws; the off state before one is configured. */
export function currentWebPageState(): WebPageState {
  return (
    configured?.state() ?? {
      mode: "off",
      port: WEB_PAGE_DEFAULT_PORT,
      tls: false,
      addr: null,
      serving: false,
      link: null,
      network: [],
      error: null,
    }
  );
}
