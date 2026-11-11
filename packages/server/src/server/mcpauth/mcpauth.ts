import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writePrivateFileAtomic } from "../private-files.js";

/**
 * Signs Neolix in to a remote MCP server that asks for OAuth (Neon, Notion,
 * Supabase…), once for every agent, and keeps the tokens beside Neolix's
 * other secrets: `$NEOLIX_HOME/mcp-signins.json`.
 *
 * This is myna's `internal/mcpauth/mcpauth.go` brought over whole. The
 * sign-in is the one the MCP spec lays out (2025-06-18, Authorization): the
 * server's 401 names its protected resource metadata (RFC 9728), that names
 * the authorization server, whose metadata (RFC 8414) says where to register
 * a client (RFC 7591), authorize with PKCE (S256) and get tokens. A server
 * of the older spec (2025-03-26) with no resource metadata has its
 * authorization server at its own origin.
 *
 * Agents reach a signed-in server through the gateway's `/mcp/<name>`, which
 * adds the token (myna `internal/gateway/mcp.go`). Nothing here is returned
 * over an RPC: only the sign-in's state is.
 */

export const MCPAUTH_FILENAME = "mcp-signins.json";
export const MCP_RENEW_LEAD_MS = 2 * 60_000;
export const MCP_SIGNIN_TIMEOUT_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_MS = 30_000;
const CALLBACK_EXCHANGE_TIMEOUT_MS = 30_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

export type McpauthErrorCode =
  | "not_signed_in"
  | "expired"
  | "no_signin"
  | "client_refused"
  | "turned_away"
  | "no_registration"
  | "pkce_unsupported"
  | "auth_method_unsupported"
  | "server_refused";

/** A sign-in error the UI may word differently by code. */
export class McpauthError extends Error {
  constructor(
    public readonly code: McpauthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpauthError";
  }
}

export interface McpauthRecord {
  /** The server's URL, as the library has it. */
  url: string;
  /** What the tokens are for (RFC 8707). */
  resource?: string;
  issuer?: string;
  tokenURL: string;
  clientID: string;
  clientSecret?: string;
  authMethod?: "none" | "client_secret_post" | "client_secret_basic";
  scope?: string;
  access: string;
  refresh?: string;
  /** Unix ms; 0/absent when the server didn't say. */
  expires?: number;
  /** When it was signed in, unix ms. */
  at: number;
  /** A sign-in the server refused to renew: the page asks for it again. */
  dead?: boolean;
}

/** A server's sign-in as the Library shows it. */
export interface McpauthStatus {
  signedIn: boolean;
  dead?: boolean;
  at?: number;
}

/** Where a sign-in stands, for the page to show. */
export interface McpauthState {
  id: string;
  server: string;
  /** The sign-in page, to open. */
  url?: string;
  state: "waiting" | "done" | "failed" | "canceled";
  error?: string;
}

/** An OAuth app of the user's own, for a server that doesn't allow
 * dynamic registration (Claude Code's --client-id). Its callback is
 * Claude Code's, http://localhost:<port>/callback. */
export interface McpauthApp {
  clientID: string;
  clientSecret?: string;
  callbackPort?: number;
}

export interface McpauthOptions {
  neolixHome: string;
  /** Injected in tests; the daemon uses the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
  renewLeadMs?: number;
  signInTimeoutMs?: number;
  /** Called when a server is signed in or out, for the library to give
   * the agents its new address. */
  onChanged?: (name: string) => void;
}

interface Meta {
  resource: string;
  issuer: string;
  authorizeURL: string;
  tokenURL: string;
  registerURL: string;
  scope: string;
  authMethods: string[];
}

interface Tokens {
  access: string;
  refresh?: string;
  expiresIn?: number;
  scope?: string;
}

interface Flow {
  id: string;
  server: string;
  state: McpauthState;
  server_: Server;
  done: Promise<void>;
  markDone: () => void;
  claimed: boolean;
  finished: boolean;
}

class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly description?: string,
  ) {
    super(
      `the token endpoint answered ${status}${code ? `: ${code}` : ""}${
        description ? ` (${description})` : ""
      }`,
    );
    this.name = "TokenEndpointError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function formEscape(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function contains(list: readonly string[], value: string): boolean {
  return list.includes(value);
}

/** Parses a WWW-Authenticate challenge's k=v and k="v" parameters. */
export function parseAuthParams(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let s = input.trim();
  while (s.length > 0) {
    const eq = s.indexOf("=");
    if (eq < 0) {
      break;
    }
    const key = s
      .slice(0, eq)
      .replace(/^[,\s]+/, "")
      .trim();
    s = s.slice(eq + 1).trim();
    let value: string;
    if (s.startsWith('"')) {
      let i = 1;
      let built = "";
      for (; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && i + 1 < s.length) {
          i++;
        }
        built += s[i];
      }
      value = built;
      s = s.slice(Math.min(i + 1, s.length));
    } else {
      const end = s.indexOf(",");
      const stop = end < 0 ? s.length : end;
      value = s.slice(0, stop).trim();
      s = s.slice(stop);
    }
    out[key] = value;
    s = s.replace(/^\s*,?\s*/, "");
  }
  return out;
}

function bearerChallenges(header: string | null): string[] {
  if (header === null) {
    return [];
  }
  // A header may combine several challenges; a new one starts at "bearer ".
  const parts = header.split(/,\s*(?=bearer\s)/i);
  return parts.filter((part) => /^\s*bearer\b/i.test(part));
}

/** The server's 401: its resource metadata and the scope it asks for. */
export function readChallenge(headers: Headers): { metadata: string; scope: string } {
  let metadata = "";
  let scope = "";
  for (const challenge of bearerChallenges(headers.get("www-authenticate"))) {
    const trimmed = challenge.trim();
    const params = parseAuthParams(trimmed.slice("bearer".length));
    for (const [key, value] of Object.entries(params)) {
      if (key.toLowerCase() === "resource_metadata") {
        metadata = value;
      } else if (key.toLowerCase() === "scope") {
        scope = value;
      }
    }
  }
  return { metadata, scope };
}

function withOffline(scope: string, supported: readonly string[]): string {
  if (
    scope.length === 0 ||
    !contains(supported, "offline_access") ||
    contains(scope.split(/\s+/), "offline_access")
  ) {
    return scope;
  }
  return `${scope} offline_access`;
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseIssuer(issuer: string): URL {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new McpauthError(
      "no_signin",
      `the server names an authorization server that isn't a URL (${JSON.stringify(issuer)})`,
    );
  }
  if (url.host === "") {
    throw new McpauthError(
      "no_signin",
      `the server names an authorization server that isn't a URL (${JSON.stringify(issuer)})`,
    );
  }
  return url;
}

function applyAuthorizationMetadata(meta: Meta, as: Record<string, unknown>, issuer: string): void {
  const challenges = stringList(as.code_challenge_methods_supported);
  if (challenges.length > 0 && !contains(challenges, "S256")) {
    throw new McpauthError(
      "pkce_unsupported",
      "the server's sign-in doesn't offer PKCE (S256), which Neox needs",
    );
  }
  meta.issuer = typeof as.issuer === "string" && as.issuer ? as.issuer : issuer;
  meta.authorizeURL =
    typeof as.authorization_endpoint === "string" ? as.authorization_endpoint : "";
  meta.tokenURL = typeof as.token_endpoint === "string" ? as.token_endpoint : "";
  meta.registerURL = typeof as.registration_endpoint === "string" ? as.registration_endpoint : "";
  meta.authMethods = stringList(as.token_endpoint_auth_methods_supported);
  meta.scope = withOffline(meta.scope, stringList(as.scopes_supported));
}

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ response: Response; body: string }> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  return { response, body };
}

export class McpauthService {
  private readonly filePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly renewLeadMs: number;
  private readonly signInTimeoutMs: number;
  private readonly onChanged?: (name: string) => void;
  private readonly flows = new Map<string, Flow>();
  private readonly renewing = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: McpauthOptions) {
    this.filePath = path.join(options.neolixHome, MCPAUTH_FILENAME);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.renewLeadMs = options.renewLeadMs ?? MCP_RENEW_LEAD_MS;
    this.signInTimeoutMs = options.signInTimeoutMs ?? MCP_SIGNIN_TIMEOUT_MS;
    this.onChanged = options.onChanged;
  }

  // ---- storage ------------------------------------------------------------

  /**
   * The sign-ins, or their last good generation when a crash left the
   * file all zero. An error when neither reads, so a change doesn't write
   * them over as none (myna mcpauth.go:138).
   */
  private async read(): Promise<Map<string, McpauthRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw error;
    }
    const parsed = this.parse(raw);
    if (parsed !== null) {
      return parsed;
    }
    // A zeroed or truncated file: the copy kept before the last write.
    try {
      const backup = await readFile(`${this.filePath}.bak`, "utf8");
      const fallback = this.parse(backup);
      if (fallback !== null) {
        return fallback;
      }
    } catch {
      // no backup either
    }
    throw new Error(`Neox's MCP sign-ins (${this.filePath}) don't read as JSON`);
  }

  private parse(raw: string): Map<string, McpauthRecord> | null {
    if (raw.trim().length === 0) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return null;
      }
      const out = new Map<string, McpauthRecord>();
      for (const [name, value] of Object.entries(parsed)) {
        if (isRecord(value) && typeof value.url === "string" && typeof value.access === "string") {
          out.set(name, value as unknown as McpauthRecord);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  private async save(records: Map<string, McpauthRecord>): Promise<void> {
    // Keep the last readable generation aside, as myna's lastgood does.
    try {
      const current = await readFile(this.filePath, "utf8");
      if (this.parse(current) !== null) {
        await writePrivateFileAtomic(`${this.filePath}.bak`, current);
      }
    } catch {
      // the first write
    }
    const body: Record<string, McpauthRecord> = {};
    for (const [name, record] of records) {
      body[name] = record;
    }
    await writePrivateFileAtomic(this.filePath, `${JSON.stringify(body, null, 2)}\n`);
  }

  /** One change at a time in this process; the file is replaced atomically
   * so another process reads either generation whole. */
  private update(work: (records: Map<string, McpauthRecord>) => boolean): Promise<void> {
    const run = this.queue.then(async () => {
      const records = await this.read();
      if (!work(records)) {
        return undefined;
      }
      await this.save(records);
      return undefined;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async get(name: string): Promise<McpauthRecord | undefined> {
    await this.queue;
    return (await this.read()).get(name);
  }

  /** Every sign-in, for the library to decide which servers agents reach
   * through the gateway rather than at their own address. */
  async all(): Promise<Map<string, McpauthRecord>> {
    await this.queue;
    return this.read();
  }

  /** Whether Neolix holds a sign-in to the server by that name at that URL. */
  async signedIn(name: string, serverURL: string): Promise<boolean> {
    const record = await this.get(name);
    return record !== undefined && record.url === serverURL;
  }

  async statusOf(name: string, serverURL: string): Promise<McpauthStatus> {
    const record = await this.get(name);
    if (record === undefined || record.url !== serverURL) {
      return { signedIn: false };
    }
    return {
      signedIn: true,
      ...(record.dead ? { dead: true } : {}),
      ...(record.at ? { at: record.at } : {}),
    };
  }

  async signOut(name: string): Promise<void> {
    let had = false;
    await this.update((records) => {
      had = records.has(name);
      records.delete(name);
      return had;
    });
    if (had) {
      this.onChanged?.(name);
    }
  }

  /** Forgets a server the library no longer has; there is nothing to tell. */
  async forget(name: string): Promise<void> {
    await this.update((records) => records.delete(name));
  }

  /** Moves a sign-in to the server's new name. */
  async rename(oldName: string, name: string): Promise<void> {
    if (oldName === name) {
      return;
    }
    let moved = false;
    await this.update((records) => {
      const record = records.get(oldName);
      if (record === undefined) {
        return false;
      }
      records.delete(oldName);
      records.set(name, record);
      moved = true;
      return true;
    });
    if (moved) {
      this.onChanged?.(name);
    }
  }

  // ---- tokens -------------------------------------------------------------

  /** The access token, renewed first when it runs out within the lead. */
  async token(name: string): Promise<string> {
    const record = await this.get(name);
    if (record === undefined) {
      throw new McpauthError("not_signed_in", "Neox isn't signed in to this server");
    }
    if (record.dead) {
      throw new McpauthError(
        "expired",
        "Neox's sign-in to this server has run out: sign in again in the Library",
      );
    }
    if (!this.due(record)) {
      return record.access;
    }
    return this.renew(name, (current) => this.due(current));
  }

  /** Renews a sign-in the server just refused stale, unless another request
   * renewed it meanwhile; then the new token is returned. */
  async renewIfStale(name: string, stale: string): Promise<string> {
    return this.renew(name, (current) => current.access === stale);
  }

  private due(record: McpauthRecord): boolean {
    return (
      record.expires !== undefined &&
      record.expires !== 0 &&
      this.now() + this.renewLeadMs >= record.expires
    );
  }

  private renew(name: string, still: (record: McpauthRecord) => boolean): Promise<string> {
    const running = this.renewing.get(name);
    if (running !== undefined) {
      return running;
    }
    const started = this.renewNow(name, still).finally(() => this.renewing.delete(name));
    this.renewing.set(name, started);
    return started;
  }

  private async renewNow(name: string, still: (record: McpauthRecord) => boolean): Promise<string> {
    const record = await this.get(name);
    if (record === undefined) {
      throw new McpauthError("not_signed_in", "Neox isn't signed in to this server");
    }
    if (record.dead) {
      throw new McpauthError(
        "expired",
        "Neox's sign-in to this server has run out: sign in again in the Library",
      );
    }
    if (!still(record)) {
      return record.access;
    }
    if (!record.refresh) {
      await this.markDead(name, record.access);
      throw new McpauthError(
        "expired",
        "Neox's sign-in to this server has run out: sign in again in the Library",
      );
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.refresh,
    });
    if (record.resource) {
      form.set("resource", record.resource);
    }
    let tokens: Tokens;
    try {
      tokens = await this.tokenRequest(record, form);
    } catch (error) {
      if (error instanceof TokenEndpointError && (deadCode(error.code) || error.status === 401)) {
        await this.markDead(name, record.access);
        throw new McpauthError(
          "expired",
          "Neox's sign-in to this server has run out: sign in again in the Library",
        );
      }
      throw error;
    }
    await this.update((records) => {
      const current = records.get(name);
      if (current === undefined || current.access !== record.access) {
        return false; // signed in again, or out, meanwhile
      }
      current.access = tokens.access;
      if (tokens.refresh) {
        current.refresh = tokens.refresh;
      }
      current.expires = this.expiresOf(tokens);
      return true;
    });
    return tokens.access;
  }

  /** The server refused a token just renewed: renewing again won't help. */
  async rejected(name: string, access: string): Promise<void> {
    await this.markDead(name, access);
  }

  private async markDead(name: string, access: string): Promise<void> {
    await this.update((records) => {
      const current = records.get(name);
      if (current === undefined || current.access !== access) {
        return false;
      }
      current.dead = true;
      return true;
    });
  }

  private expiresOf(tokens: Tokens): number {
    if (tokens.expiresIn === undefined || tokens.expiresIn <= 0) {
      return 0;
    }
    return this.now() + tokens.expiresIn * 1000;
  }

  private async tokenRequest(record: McpauthRecord, input: URLSearchParams): Promise<Tokens> {
    const form = tokenForm(record, input);
    const { response, body } = await readJson(this.fetchImpl, record.tokenURL, {
      method: "POST",
      headers: tokenHeaders(record),
      body: form.toString(),
      signal: AbortSignal.timeout(CALLBACK_EXCHANGE_TIMEOUT_MS),
    });
    if (response.status < 200 || response.status >= 300) {
      const parsed = parseTokenError(body);
      throw new TokenEndpointError(response.status, parsed?.error, parsed?.error_description);
    }
    return parseTokens(body);
  }

  // ---- discovery ----------------------------------------------------------

  /** Finds how to sign in to the server at serverURL. */
  async discover(serverURL: string): Promise<Meta> {
    let server: URL;
    try {
      server = new URL(serverURL);
    } catch {
      throw new McpauthError("no_signin", `${JSON.stringify(serverURL)} isn't a URL`);
    }
    if (server.host === "") {
      throw new McpauthError("no_signin", `${JSON.stringify(serverURL)} isn't a URL`);
    }
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "neox", version: "1" },
      },
    });
    let response: Response;
    let body = "";
    try {
      const result = await readJson(this.fetchImpl, serverURL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: initialize,
        signal,
      });
      response = result.response;
      body = result.body;
    } catch (error) {
      throw new McpauthError(
        "no_signin",
        `couldn't reach ${server.host}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status >= 200 && response.status < 300) {
      throw new McpauthError("no_signin", NO_SIGNIN_MESSAGE);
    }
    const { metadata, scope } = readChallenge(response.headers);
    const prm = await this.resourceMetadata(server, metadata, signal);
    const origin = originOf(server);
    const meta: Meta = {
      resource: serverURL,
      issuer: origin,
      authorizeURL: "",
      tokenURL: "",
      registerURL: "",
      scope,
      authMethods: [],
    };
    let issuer = origin;
    if (prm.found) {
      issuer = (stringList(prm.value.authorization_servers)[0] ?? origin).replace(/\/+$/, "");
      if (typeof prm.value.resource === "string" && prm.value.resource) {
        meta.resource = prm.value.resource;
      }
      const scopes = stringList(prm.value.scopes_supported);
      if (!meta.scope && scopes.length > 0) {
        meta.scope = scopes.join(" ");
      }
    }
    const issuerURL = parseIssuer(issuer);
    const as = await this.authorizationMetadata(issuer, issuerURL, signal);
    if (as !== undefined) {
      applyAuthorizationMetadata(meta, as, issuer);
    } else if (!prm.found) {
      // The older spec: the server's origin is its authorization server.
      meta.issuer = origin;
      meta.authorizeURL = `${origin}/authorize`;
      meta.tokenURL = `${origin}/token`;
      meta.registerURL = `${origin}/register`;
    } else {
      throw new McpauthError(
        "no_signin",
        `couldn't read the metadata of ${issuer}, the server's authorization server`,
      );
    }
    if (response.status !== 401 && !prm.found && as === undefined) {
      if (turnedAway(response, body)) {
        throw new McpauthError("turned_away", TURNED_AWAY_MESSAGE);
      }
      throw new McpauthError(
        "no_signin",
        `the server answered ${response.status} and says nothing of a sign-in`,
      );
    }
    return meta;
  }

  /** RFC 9728: the metadata the server's 401 names, then the well-known
   * paths for its own address. */
  private async resourceMetadata(
    server: URL,
    named: string,
    signal: AbortSignal,
  ): Promise<{ found: boolean; value: Record<string, unknown> }> {
    const tries: string[] = [];
    if (named) {
      tries.push(named);
    }
    const serverPath = server.pathname.replace(/\/+$/, "");
    if (serverPath) {
      tries.push(`${originOf(server)}/.well-known/oauth-protected-resource${serverPath}`);
    }
    tries.push(`${originOf(server)}/.well-known/oauth-protected-resource`);
    for (const candidate of tries) {
      const value = await this.getJson(candidate, signal);
      if (value !== null && stringList(value.authorization_servers).length > 0) {
        return { found: true, value };
      }
    }
    return { found: false, value: {} };
  }

  /** RFC 8414: the authorization server's metadata, or its OpenID one. */
  private async authorizationMetadata(
    issuer: string,
    issuerURL: URL,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const issuerPath = issuerURL.pathname.replace(/\/+$/, "");
    const tries = issuerPath
      ? [
          `${originOf(issuerURL)}/.well-known/oauth-authorization-server${issuerPath}`,
          `${originOf(issuerURL)}/.well-known/openid-configuration${issuerPath}`,
          `${issuer}/.well-known/openid-configuration`,
        ]
      : [
          `${issuer}/.well-known/oauth-authorization-server`,
          `${issuer}/.well-known/openid-configuration`,
        ];
    for (const candidate of tries) {
      const value = await this.getJson(candidate, signal);
      if (
        value !== null &&
        typeof value.authorization_endpoint === "string" &&
        value.authorization_endpoint &&
        typeof value.token_endpoint === "string" &&
        value.token_endpoint
      ) {
        return value;
      }
    }
    return undefined;
  }

  private async getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    try {
      const { response, body } = await readJson(this.fetchImpl, url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        signal,
      });
      if (response.status < 200 || response.status >= 300) {
        return null;
      }
      const parsed: unknown = JSON.parse(body);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Makes Neolix a client of the authorization server, sent back to redirect. */
  async register(
    meta: Meta,
    redirect: string,
  ): Promise<{ id: string; secret?: string; method: string }> {
    if (!meta.registerURL) {
      throw new McpauthError("no_registration", NO_REGISTRATION_MESSAGE);
    }
    let method = "none";
    if (meta.authMethods.length > 0 && !contains(meta.authMethods, "none")) {
      // The metadata's order is no preference: one listing private_key_jwt
      // first may take a secret too.
      if (contains(meta.authMethods, "client_secret_post")) {
        method = "client_secret_post";
      } else if (contains(meta.authMethods, "client_secret_basic")) {
        method = "client_secret_basic";
      } else {
        throw new McpauthError(
          "auth_method_unsupported",
          `the server's token endpoint takes only ${meta.authMethods.join(", ")}, which Neox can't do`,
        );
      }
    }
    const registration: Record<string, unknown> = {
      client_name: "Neox",
      client_uri: "https://github.com/istoo/neox",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
    };
    if (meta.scope) {
      registration.scope = meta.scope;
    }
    const { response, body } = await readJson(this.fetchImpl, meta.registerURL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(registration),
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      throw new McpauthError("client_refused", CLIENT_REFUSED_MESSAGE);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new McpauthError(
        "server_refused",
        `registering Neox with the server's sign-in failed (${response.status}): ${body.trim()}`,
      );
    }
    let out: { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string };
    try {
      out = JSON.parse(body) as typeof out;
    } catch {
      throw new McpauthError(
        "server_refused",
        "the server's sign-in registered Neox but gave it no client id",
      );
    }
    if (typeof out.client_id !== "string" || out.client_id === "") {
      throw new McpauthError(
        "server_refused",
        "the server's sign-in registered Neox but gave it no client id",
      );
    }
    if (out.token_endpoint_auth_method) {
      // RFC 7591's response may register another method than asked for.
      if (
        !contains(
          ["none", "client_secret_post", "client_secret_basic"],
          out.token_endpoint_auth_method,
        )
      ) {
        throw new McpauthError(
          "auth_method_unsupported",
          `the server's sign-in registered Neox for ${out.token_endpoint_auth_method}, which Neox can't do`,
        );
      }
      method = out.token_endpoint_auth_method;
    }
    let secret = out.client_secret;
    if (!secret) {
      method = "none";
    } else if (method === "none") {
      method = "client_secret_post";
    }
    return {
      id: out.client_id,
      ...(secret ? { secret } : {}),
      method,
    };
  }

  private appMethod(meta: Meta, secret: string | undefined): string {
    if (!secret) {
      return "none";
    }
    if (
      contains(meta.authMethods, "client_secret_basic") &&
      !contains(meta.authMethods, "client_secret_post")
    ) {
      return "client_secret_basic";
    }
    return "client_secret_post";
  }

  // ---- the sign-in --------------------------------------------------------

  /** Begins signing Neolix in to the server called name at serverURL: open
   * the state's URL in a browser and the rest happens on its own. */
  async start(name: string, serverURL: string, app?: McpauthApp): Promise<McpauthState> {
    const meta = await this.discover(serverURL);
    const port = app?.callbackPort ?? 0;
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          port !== 0
            ? new McpauthError(
                "server_refused",
                `the OAuth app's callback port ${port} is in use by another program: ${error.message}`,
              )
            : error,
        );
      });
      listener.listen(port, "127.0.0.1", () => resolve());
    });
    const actualPort = (listener.address() as AddressInfo).port;
    // Neolix's own registration names 127.0.0.1, as RFC 8252 asks; an app of
    // the user's own is called back at localhost, as Claude Code's is.
    const host = app ? "localhost" : "127.0.0.1";
    const redirect = `http://${host}:${actualPort}/callback`;

    let clientID: string;
    let secret: string | undefined;
    let method: string;
    try {
      if (app) {
        clientID = app.clientID;
        secret = app.clientSecret;
        method = this.appMethod(meta, secret);
      } else {
        const registered = await this.register(meta, redirect);
        clientID = registered.id;
        secret = registered.secret;
        method = registered.method;
      }
    } catch (error) {
      listener.close();
      throw error;
    }

    const verifier = randomToken(48);
    const state = randomToken(24);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientID,
      redirect_uri: redirect,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: meta.resource,
    });
    if (meta.scope) {
      query.set("scope", meta.scope);
    }
    const authorize = new URL(meta.authorizeURL);
    for (const [key, value] of query) {
      authorize.searchParams.set(key, value);
    }

    const flow = this.makeFlow(name, authorize.toString(), listener);
    const record: Omit<McpauthRecord, "access" | "refresh" | "expires" | "at"> = {
      url: serverURL,
      ...(meta.resource ? { resource: meta.resource } : {}),
      ...(meta.issuer ? { issuer: meta.issuer } : {}),
      tokenURL: meta.tokenURL,
      clientID,
      ...(secret ? { clientSecret: secret } : {}),
      authMethod: method as McpauthRecord["authMethod"],
      ...(meta.scope ? { scope: meta.scope } : {}),
    };

    listener.on("request", (request, response) => {
      void this.handleCallback({
        flow,
        request,
        response,
        expectedState: state,
        verifier,
        redirect,
        record,
      });
    });

    const timer = setTimeout(() => {
      this.finish(flow, {
        state: "failed",
        error: "the sign-in timed out; start it again",
      });
    }, this.signInTimeoutMs);
    timer.unref?.();
    flow.done.then(() => clearTimeout(timer)).catch(() => undefined);

    return { ...flow.state };
  }

  private makeFlow(name: string, url: string, server: Server): Flow {
    let markDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    const flow: Flow = {
      id: randomToken(9),
      server: name,
      state: { id: "", server: name, url, state: "waiting" },
      server_: server,
      done,
      markDone,
      claimed: false,
      finished: false,
    };
    flow.state.id = flow.id;
    this.flows.set(flow.id, flow);
    return flow;
  }

  private async handleCallback(input: {
    flow: Flow;
    request: import("node:http").IncomingMessage;
    response: import("node:http").ServerResponse;
    expectedState: string;
    verifier: string;
    redirect: string;
    record: Omit<McpauthRecord, "access" | "refresh" | "expires" | "at">;
  }): Promise<void> {
    const { flow, request, response } = input;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      writePage(response, 404, "Not found");
      return;
    }
    const values = url.searchParams;
    if (values.get("state") !== input.expectedState) {
      writePage(
        response,
        400,
        "This sign-in link is out of date. Start the sign-in again from Neox.",
      );
      return;
    }
    if (flow.claimed || flow.finished) {
      writePage(response, 200, "Neox has this sign-in already. You can close this tab.");
      return;
    }
    flow.claimed = true;
    const error = values.get("error");
    if (error) {
      const description = values.get("error_description");
      const message = description ? `${error}: ${description}` : error;
      this.finish(flow, { state: "failed", error: `the sign-in was refused (${message})` });
      writePage(response, 200, `The sign-in was refused: ${message}`);
      return;
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: values.get("code") ?? "",
      redirect_uri: input.redirect,
      code_verifier: input.verifier,
    });
    if (input.record.resource) {
      form.set("resource", input.record.resource);
    }
    let tokens: Tokens;
    try {
      tokens = await this.tokenRequest({ ...input.record, access: "", at: 0 }, form);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      this.finish(flow, { state: "failed", error: message });
      writePage(response, 200, `Neox couldn't finish the sign-in: ${message}`);
      return;
    }
    const saved: McpauthRecord = {
      ...input.record,
      access: tokens.access,
      ...(tokens.refresh ? { refresh: tokens.refresh } : {}),
      expires: this.expiresOf(tokens),
      at: this.now(),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
    try {
      await this.keep(flow, saved);
    } catch (failure) {
      writePage(
        response,
        200,
        `Neox couldn't keep the sign-in: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
      return;
    }
    writePage(
      response,
      200,
      `Neox is signed in to ${flow.server}. Every agent given it in the Library uses this sign-in. You can close this tab.`,
    );
  }

  /** Commits the callback only while the flow is still live: cancel or
   * timeout and the write take the same decision, so a late token cannot
   * save a sign-in the user already ended. */
  private async keep(flow: Flow, record: McpauthRecord): Promise<void> {
    if (flow.finished) {
      throw new Error("the sign-in has ended; start it again");
    }
    // Claim the flow before the write: a cancel or timeout that arrives
    // while the file is written must not end a sign-in this commit saves.
    flow.finished = true;
    try {
      await this.update((records) => {
        records.set(flow.server, record);
        return true;
      });
    } catch (error) {
      this.end(flow, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.onChanged?.(flow.server);
    this.end(flow, { state: "done" });
  }

  private finish(flow: Flow, next: { state: McpauthState["state"]; error?: string }): void {
    if (flow.finished) {
      return;
    }
    flow.finished = true;
    this.end(flow, next);
  }

  private end(flow: Flow, next: { state: McpauthState["state"]; error?: string }): void {
    flow.state.state = next.state;
    if (next.error !== undefined) {
      flow.state.error = next.error;
    }
    flow.markDone();
    // the browser still has the page to load
    const close = setTimeout(() => flow.server_.close(), 2000);
    close.unref?.();
    const forget = setTimeout(() => this.flows.delete(flow.id), 10 * 60_000);
    forget.unref?.();
  }

  progress(id: string): McpauthState | undefined {
    const flow = this.flows.get(id);
    return flow === undefined ? undefined : { ...flow.state };
  }

  cancel(id: string): void {
    const flow = this.flows.get(id);
    if (flow !== undefined) {
      this.finish(flow, { state: "canceled" });
    }
  }
}

function tokenForm(record: McpauthRecord, input: URLSearchParams): URLSearchParams {
  const form = new URLSearchParams(input);
  if (record.authMethod !== "client_secret_basic") {
    form.set("client_id", record.clientID);
  }
  if (record.authMethod === "client_secret_post" && record.clientSecret) {
    form.set("client_secret", record.clientSecret);
  }
  return form;
}

function tokenHeaders(record: McpauthRecord): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (record.authMethod === "client_secret_basic") {
    headers.authorization = `Basic ${Buffer.from(
      `${formEscape(record.clientID)}:${formEscape(record.clientSecret ?? "")}`,
    ).toString("base64")}`;
  }
  return headers;
}

/** The token endpoint's answer: JSON as the spec says, a form as GitHub's
 * older endpoint does, and GitHub's errors that come with a 200. */
function parseTokens(body: string): Tokens {
  const asError = parseTokenError(body);
  if (asError?.error) {
    throw new TokenEndpointError(200, asError.error, asError.error_description);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return parseFormTokens(body);
  }
  if (!isRecord(json) || typeof json.access_token !== "string" || json.access_token === "") {
    throw new Error("the token endpoint gave no access token");
  }
  const expires = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    access: json.access_token,
    ...(typeof json.refresh_token === "string" && json.refresh_token
      ? { refresh: json.refresh_token }
      : {}),
    ...(expires !== undefined ? { expiresIn: expires } : {}),
    ...(typeof json.scope === "string" ? { scope: json.scope } : {}),
  };
}

function parseFormTokens(body: string): Tokens {
  const values = new URLSearchParams(body);
  const access = values.get("access_token");
  if (access === null || access === "") {
    throw new Error("the token endpoint's answer isn't JSON");
  }
  const expires = Number.parseInt(values.get("expires_in") ?? "", 10);
  return {
    access,
    ...(values.get("refresh_token") ? { refresh: values.get("refresh_token") ?? "" } : {}),
    ...(Number.isFinite(expires) ? { expiresIn: expires } : {}),
    ...(values.get("scope") ? { scope: values.get("scope") ?? "" } : {}),
  };
}

function parseTokenError(body: string): { error?: string; error_description?: string } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      ...(typeof parsed.error_description === "string"
        ? { error_description: parsed.error_description }
        : {}),
    };
  } catch {
    return null;
  }
}

function deadCode(code: string | undefined): boolean {
  switch (code) {
    case "invalid_grant":
    case "invalid_client":
    case "bad_refresh_token":
    case "incorrect_client_credentials":
      return true;
    default:
      return false;
  }
}

/** A 403 from a firewall rather than the MCP server: a web page to a
 * JSON-RPC request, or Cloudflare saying it stopped it. */
function turnedAway(response: Response, body: string): boolean {
  if (response.status !== 403) {
    return false;
  }
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim();
  return (
    contentType === "text/html" ||
    response.headers.get("cf-mitigated") !== null ||
    /^\s*</.test(body)
  );
}

function writePage(
  response: import("node:http").ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Neox</title><body style="font:15px -apple-system,system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;color:#222">${escapeHtml(
      message,
    )}</body>`,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const NO_SIGNIN_MESSAGE =
  "this server already works without signing in, so there is nothing to sign in to: the agents given it can use it as it is. A key it takes goes in Headers; a server that signs in at another address (as Exa's ?login) needs that URL";

const CLIENT_REFUSED_MESSAGE =
  "this server's sign-in admits only the apps it lists and turned Neox away, so Neox can't sign in for the agents. The agents given it still have the server's own address: sign in from each agent itself (in Claude Code, run /mcp and pick the server)";

const TURNED_AWAY_MESSAGE =
  "a firewall in front of this server turned Neox's request away (403) before the server could offer a sign-in. It judges the network the request came from: try again on another network, or give Neox a proxy";

const NO_REGISTRATION_MESSAGE =
  "the server's sign-in doesn't let an app register itself (no dynamic client registration), so Neox signs in to it only as an OAuth app of your own: make one with the server's vendor (GitHub's under Settings › Developer settings › OAuth Apps), with http://localhost/callback as its callback URL, then give its client ID and secret under \"OAuth app\" in the server's editor";
