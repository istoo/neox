import { createSign } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, posix, relative, sep, win32 } from "node:path";
import { fetchThroughProxy } from "./proxy-fetch.js";

/**
 * Google Vertex AI's credentials and addresses (`internal/provider/vertex.go`).
 * A Vertex provider is a Google Cloud project at a location, signed with a
 * service account, a person's Application Default Credentials, or one the
 * credentials are traded for. The token endpoint is Google's; tokens are
 * minted once per file and kept until shortly before they lapse.
 *
 * Nothing here is stored by Neolix: the credentials are the user's own
 * files, read and never written.
 */

export interface VertexSettings {
  /** The Google Cloud project requests are made, and billed, in. */
  project: string;
  /** global, us, eu or a region (us-central1); global when unset. */
  location?: string;
  /** A credentials file; "" finds them as Google's libraries do. */
  credentials?: string;
  /** A service account's email the credentials are traded for. */
  impersonate?: string;
}

export interface NormalizedVertex {
  project: string;
  location: string;
  credentials: string;
  impersonate: string;
}

/** The provider as it is kept: trimmed and lower-cased, at global when no location is given. */
export function normalizeVertex(value: VertexSettings | null | undefined): NormalizedVertex | null {
  if (value === null || value === undefined) {
    return null;
  }
  const project = (value.project ?? "").trim().toLowerCase();
  const location = (value.location ?? "").trim().toLowerCase();
  const credentials = (value.credentials ?? "").trim();
  const impersonate = (value.impersonate ?? "").trim().toLowerCase();
  if (project === "" && location === "" && credentials === "" && impersonate === "") {
    return null;
  }
  return { project, location: location === "" ? "global" : location, credentials, impersonate };
}

const PROJECT_ID = /^[a-z0-9][a-z0-9.:-]*[a-z0-9]$/;
const LOCATION = /^[a-z]+(-[a-z0-9]+)*$/;
const ACCOUNT = /^[^\s@/]+@[^\s@/]+$/;

/** Why a provider with these settings can't be saved; null when it can. */
export function vertexCheck(value: VertexSettings | null | undefined): string | null {
  const v = normalizeVertex(value);
  if (v === null || v.project === "") {
    return "Google Vertex AI needs the id of your Google Cloud project";
  }
  if (!PROJECT_ID.test(v.project)) {
    return `"${v.project}" is no Google Cloud project id`;
  }
  if (!LOCATION.test(v.location)) {
    return `"${v.location}" is no Vertex AI location: global, us, eu or a region such as us-central1`;
  }
  if (v.credentials !== "" && !isAbsolute(v.credentials) && !startsWithHome(v.credentials)) {
    return `give the credentials file's full path, not "${v.credentials}"`;
  }
  if (v.impersonate !== "" && !ACCOUNT.test(v.impersonate)) {
    return `"${v.impersonate}" is no service account's email`;
  }
  return null;
}

/** The API's host at a location (`vertex.go:124`). */
export function vertexHost(location: string): string {
  const loc = location === "" ? "global" : location;
  if (loc === "global") {
    return "aiplatform.googleapis.com";
  }
  if (loc === "us" || loc === "eu") {
    return `aiplatform.${loc}.rep.googleapis.com`;
  }
  return `${loc}-aiplatform.googleapis.com`;
}

/** Where the provider's requests go, the model's path after it. */
export function vertexBase(value: VertexSettings): string {
  const v = normalizeVertex(value);
  if (v === null || !PROJECT_ID.test(v.project) || !LOCATION.test(v.location)) {
    return "";
  }
  return `https://${vertexHost(v.location)}/v1/projects/${v.project}/locations/${v.location}`;
}

/** Where a streamed request for model goes (`vertex.go:171-174`). */
export function vertexPath(model: string, streaming: boolean): string {
  return streaming
    ? `/publishers/google/models/${pathEscape(model)}:streamGenerateContent?alt=sse`
    : `/publishers/google/models/${pathEscape(model)}:generateContent`;
}

/** Where a request answered as one JSON body goes (`vertex.go:257-261`). */
export function vertexWholePath(model: string): string {
  return `/publishers/google/models/${pathEscape(model)}:generateContent`;
}

/** Whether model is a partner or open model, served on chat completions (`vertex.go:181`). */
export function vertexPartner(model: string): boolean {
  return model.includes("/");
}

/** Whether model is an Anthropic Claude model, served on the Messages API (`vertex.go:191`). */
export function vertexClaude(model: string): boolean {
  return !vertexPartner(model) && model.toLowerCase().startsWith("claude-");
}

/** The Messages API's version a Claude request on Vertex names in its body. */
const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

export interface VertexClaudeRequest {
  path: string;
  body: string;
}

/**
 * Where a Messages API request goes at a Vertex provider, and with what
 * body: a message streamed at `:streamRawPredict` or whole at
 * `:rawPredict`, the model taken out of the body; a count at the
 * publisher's `count-tokens:rawPredict`, model kept. A body names
 * anthropic_version unless it does (`vertex.go:206-245`). Null for a body
 * with no model.
 */
export function vertexClaudeRequest(path: string, body: string): VertexClaudeRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const model = typeof parsed.model === "string" ? parsed.model : "";
  if (model === "") {
    return null;
  }
  if (parsed.anthropic_version === undefined) {
    parsed.anthropic_version = VERTEX_ANTHROPIC_VERSION;
  }
  const bare = path.split("?")[0] ?? path;
  let at = "/publishers/anthropic/models/";
  if (bare.endsWith("/count_tokens")) {
    at += "count-tokens:rawPredict";
  } else {
    const stream = parsed.stream === true;
    at += `${pathEscape(model)}${stream ? ":streamRawPredict" : ":rawPredict"}`;
    delete parsed.model;
  }
  return { path: at, body: JSON.stringify(parsed) };
}

export interface VertexAuthOptions {
  /** The folder ~ starts at; the user's home by default. */
  home?: string;
  /** The environment read for Google's variables; the process's by default. */
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  /** The proxy token mints go through. */
  proxy?: string;
  now?: () => number;
  /** Overridable so a test never reaches Google. */
  tokenUrl?: string;
  iamUrl?: string;
  readFileImpl?: (path: string) => Promise<string>;
  statImpl?: (path: string) => Promise<{ size: number; mtimeMs: number }>;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_IAM_URL = "https://iamcredentials.googleapis.com/v1";
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
/** How long before a token lapses another is minted (`vertex.go:318`). */
const REFRESH_LEAD_MS = 5 * 60_000;
/** How long minting one may take, every exchange included. */
const MINT_WAIT_MS = 30_000;

export interface VertexAuth {
  headers: Record<string, string>;
  /** The project's base, the model's path after it. */
  baseUrl: string;
  expiresAt: number;
}

/**
 * The headers and base a Vertex provider's request is sent with. The
 * token is minted from the credentials when none is kept yet, or when
 * the one kept nearly lapsed or its file changed.
 */
export async function vertexAuth(
  value: VertexSettings,
  options: VertexAuthOptions = {},
): Promise<VertexAuth | { error: string }> {
  const invalid = vertexCheck(value);
  if (invalid !== null) {
    return { error: invalid };
  }
  const token = await vertexAccessToken(value, options);
  if ("error" in token) {
    return token;
  }
  return {
    headers: { authorization: `Bearer ${token.token}` },
    baseUrl: vertexBase(value),
    expiresAt: token.expiresAt,
  };
}

/**
 * The access token a request to the provider is signed with: the one
 * minted before, until it nearly lapses or its file changes (gcloud
 * signed in again). Requests made together mint it once.
 */
export async function vertexAccessToken(
  value: VertexSettings,
  options: VertexAuthOptions = {},
): Promise<{ token: string; expiresAt: number } | { error: string }> {
  const now = options.now?.() ?? Date.now();
  let file: string;
  try {
    file = await vertexCredentialsFile(value.credentials ?? "", options);
  } catch (error) {
    return { error: messageOf(error) };
  }
  const statFile = options.statImpl ?? ((path: string) => stat(path));
  let info: { size: number; mtimeMs: number };
  try {
    info = await statFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { error: `Google credentials: ${messageOf(error)}` };
    }
    return { error: missingCredentials(file, value.credentials ?? "", options) };
  }
  const stamp = `${info.size} ${Math.trunc(info.mtimeMs)}`;
  const key = `${file}\u0000${value.impersonate ?? ""}`;
  const cached = vertexTokens.get(key);
  if (cached?.pending !== undefined) {
    return settlePending(cached.pending);
  }
  if (
    cached !== undefined &&
    cached.stamp === stamp &&
    cached.token !== "" &&
    now < cached.expiresAt - REFRESH_LEAD_MS
  ) {
    return { token: cached.token, expiresAt: cached.expiresAt };
  }
  const pending = mintWithin(options, file, value.impersonate ?? "");
  vertexTokens.set(key, { stamp, token: "", expiresAt: 0, pending });
  const result = await settlePending(pending);
  if ("error" in result) {
    vertexTokens.delete(key);
    return result;
  }
  vertexTokens.set(key, { stamp, token: result.token, expiresAt: result.expiresAt });
  return result;
}

interface KeptToken {
  stamp: string;
  token: string;
  expiresAt: number;
  pending?: Promise<{ token: string; expiresAt: number } | { error: string }>;
}

const vertexTokens = new Map<string, KeptToken>();

/** Forgets every minted token; a test, or a credentials change. */
export function clearVertexTokens(): void {
  vertexTokens.clear();
}

async function settlePending(
  pending: Promise<{ token: string; expiresAt: number } | { error: string }>,
): Promise<{ token: string; expiresAt: number } | { error: string }> {
  try {
    return await pending;
  } catch (error) {
    return { error: messageOf(error) };
  }
}

async function mintWithin(
  options: VertexAuthOptions,
  file: string,
  impersonate: string,
): Promise<{ token: string; expiresAt: number } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINT_WAIT_MS);
  timer.unref?.();
  try {
    return await mintVertexToken(file, impersonate, options, controller.signal);
  } catch (error) {
    return { error: messageOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The credentials file tokens are minted from: the one given, else
 * GOOGLE_APPLICATION_CREDENTIALS's, else the one gcloud keeps
 * (`vertex.go:391-431`). A ~ that starts a path is the home folder.
 */
export async function vertexCredentialsFile(
  given: string,
  options: VertexAuthOptions = {},
): Promise<string> {
  if (given !== "") {
    return homePath(given, options);
  }
  const fromEnv = await vertexEnvPath("GOOGLE_APPLICATION_CREDENTIALS", options);
  if (fromEnv !== "") {
    return fromEnv;
  }
  return pathsFor(options).join(await gcloudDir(options), "application_default_credentials.json");
}

/** The path flavor of the platform a call is for, not this machine's. */
function pathsFor(options: VertexAuthOptions): typeof posix {
  return (options.platform ?? process.platform) === "win32" ? win32 : posix;
}

/** The folder gcloud keeps its files in (`vertex.go:434-446`). */
async function gcloudDir(options: VertexAuthOptions): Promise<string> {
  const configured = await vertexEnvPath("CLOUDSDK_CONFIG", options);
  if (configured !== "") {
    return configured;
  }
  const paths = pathsFor(options);
  if ((options.platform ?? process.platform) === "win32") {
    return paths.join((options.env ?? process.env).APPDATA ?? "", "gcloud");
  }
  return paths.join(options.home ?? homedir(), ".config", "gcloud");
}

/**
 * The path a Google variable names; "" when it is unset. A value that is
 * no full path is an error, since the file read in its place, gcloud's
 * own, may be another account's (`vertex.go:448-462`).
 */
async function vertexEnvPath(name: string, options: VertexAuthOptions): Promise<string> {
  const value = (options.env ?? process.env)[name] ?? "";
  if (value === "") {
    return "";
  }
  const path = await homePath(value, options);
  if (path === value && !pathsFor(options).isAbsolute(path)) {
    throw new Error(
      `${name} is "${value}", not a full path: give the whole path, unset it, or give the provider a credentials file`,
    );
  }
  return path;
}

/** p with a ~ that starts it made the home folder (`vertex.go:465-475`). */
async function homePath(path: string, options: VertexAuthOptions): Promise<string> {
  if (!path.startsWith("~")) {
    return path;
  }
  const rest = path.slice(1);
  if (rest !== "" && rest[0] !== "/" && rest[0] !== "\\") {
    return path;
  }
  return pathsFor(options).join(options.home ?? homedir(), rest);
}

function startsWithHome(path: string): boolean {
  return path.startsWith("~") && (path.length === 1 || path[1] === "/" || path[1] === "\\");
}

function missingCredentials(file: string, given: string, options: VertexAuthOptions): string {
  if (given !== "") {
    return `no Google credentials at ${file}: correct the provider's credentials file, or clear it to use Application Default Credentials`;
  }
  if (((options.env ?? process.env).GOOGLE_APPLICATION_CREDENTIALS ?? "") !== "") {
    return `GOOGLE_APPLICATION_CREDENTIALS names ${file}, which isn't there: correct or unset it, or give the provider a credentials file`;
  }
  return `no Google credentials at ${file}: sign in with \`gcloud auth application-default login\`, or give the provider a credentials file`;
}

/* ------------------------------------------------------- credentials ---- */

/** A credentials file as Google's tools write it (`vertex.go:478-496`). */
interface GoogleCredentials {
  type?: string;
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
  client_email?: string;
  private_key?: string;
  private_key_id?: string;
  service_account_impersonation_url?: string;
  delegates?: string[];
  source_credentials?: unknown;
  universe_domain?: string;
}

/** Google refusing a person's sign-in: revoked, or past the organization's session length. */
class PersonRefusedError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "PersonRefusedError";
  }
}

/** A token endpoint's refusal, as postTokenAs answers it. */
class TokenRefusedError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TokenRefusedError";
  }
}

async function mintVertexToken(
  file: string,
  impersonate: string,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Promise<{ token: string; expiresAt: number } | { error: string }> {
  let text: string;
  try {
    text = await (options.readFileImpl ?? ((path: string) => readFile(path, "utf8")))(file);
  } catch (error) {
    return { error: `Google credentials: ${messageOf(error)}` };
  }
  let creds: GoogleCredentials;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new Error("no credentials in it");
    }
    creds = parsed as GoogleCredentials;
  } catch (error) {
    return { error: `${file} holds no Google credentials: ${messageOf(error)}` };
  }
  try {
    const minted = await mintAs(creds, true, options, signal);
    if (impersonate !== "") {
      return await impersonateFor(minted, impersonate, [], options, signal);
    }
    return minted;
  } catch (error) {
    const person = error instanceof PersonRefusedError;
    const suffix = person
      ? `; ${await signInAgain(file, impersonatedAccount(creds), options)}`
      : "";
    return { error: `the Google credentials in ${file}: ${messageOf(error)}${suffix}` };
  }
}

type Minted = Promise<{ token: string; expiresAt: number }>;

/** A token from the credentials; top is false for an impersonation's source. */
async function mintAs(
  creds: GoogleCredentials,
  top: boolean,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Minted {
  assertGoogleUniverse(creds);
  const kind = creds.type ?? "";
  switch (kind) {
    case "authorized_user":
      return personGrant(creds, options, signal);
    case "service_account":
      return signedGrant(creds, options, signal);
    case "impersonated_service_account":
      return impersonationGrant(creds, top, options, signal);
    case "external_account":
    case "external_account_authorized_user":
      throw new Error(
        `workload identity federation (${kind}) isn't read: use a person's credentials, a service account key, or impersonation`,
      );
    default:
      throw new Error(
        `they are of type "${kind}"; authorized_user, service_account and impersonated_service_account are read`,
      );
  }
}

/** A sovereign cloud's credentials are asked at another host. */
function assertGoogleUniverse(creds: GoogleCredentials): void {
  const universe = creds.universe_domain ?? "";
  if (universe !== "" && universe !== "googleapis.com") {
    throw new Error(`they are for ${universe}; Vertex AI is asked at googleapis.com`);
  }
}

/** A person's credentials, refreshed at Google's token endpoint. */
async function personGrant(
  creds: GoogleCredentials,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Minted {
  if ((creds.refresh_token ?? "") === "" || (creds.client_id ?? "") === "") {
    throw new Error("they have no refresh token");
  }
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.client_id ?? "",
    client_secret: creds.client_secret ?? "",
    refresh_token: creds.refresh_token ?? "",
  });
  try {
    return await tokenGrant(form, options, signal);
  } catch (error) {
    const refused = error instanceof TokenRefusedError ? error : null;
    if (
      refused !== null &&
      refused.status < 500 &&
      refused.status !== 408 &&
      refused.status !== 429
    ) {
      // Revoked, or expired by the organization's session length.
      throw new PersonRefusedError(refused);
    }
    throw error;
  }
}

/** An impersonation: its source's token traded for the account's at IAM. */
async function impersonationGrant(
  creds: GoogleCredentials,
  top: boolean,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Minted {
  if (!top) {
    throw new Error("an impersonation's source is another impersonation");
  }
  const account = impersonatedAccount(creds);
  if (account === "") {
    throw new Error("their service_account_impersonation_url names no service account");
  }
  const source = isRecord(creds.source_credentials) ? creds.source_credentials : null;
  if (source === null || (source.type ?? "") === "") {
    throw new Error("their source_credentials can't be read");
  }
  const minted = await mintAs(source as GoogleCredentials, false, options, signal);
  return impersonateFor(minted, account, creds.delegates ?? [], options, signal);
}

/** gcloud's …/serviceAccounts/<email>:generateAccessToken, read for the email only. */
const IMPERSONATION_URL = /\/serviceAccounts\/([^/:]+):generateAccessToken$/;

function impersonatedAccount(creds: GoogleCredentials): string {
  if (creds.type !== "impersonated_service_account") {
    return "";
  }
  const match = IMPERSONATION_URL.exec(creds.service_account_impersonation_url ?? "");
  if (match === null) {
    return "";
  }
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return match[1] ?? "";
  }
}

/** Trades a service account key for a token with a JWT it signs (RFC 7523). */
async function signedGrant(
  creds: GoogleCredentials,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const email = creds.client_email ?? "";
  if (email === "") {
    throw new Error("their client_email is missing");
  }
  const pem = creds.private_key ?? "";
  if (!pem.includes("-----BEGIN")) {
    throw new Error("their private_key is no PEM key");
  }
  // A little before now, for a clock ahead of Google's; an hour is the
  // most a JWT may run (`vertex.go:640-646`).
  const iat = Math.trunc((options.now?.() ?? Date.now()) / 1000) - 10;
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if ((creds.private_key_id ?? "") !== "") {
    header.kid = creds.private_key_id ?? "";
  }
  const claims = {
    iss: email,
    scope: VERTEX_SCOPE,
    aud: options.tokenUrl ?? GOOGLE_TOKEN_URL,
    iat,
    exp: iat + 3600,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signature = signer.sign(pem);
  } catch {
    throw new Error("their private_key is no RSA key");
  }
  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature.toString("base64url")}`,
  });
  return tokenGrant(form, options, signal);
}

/** Asks Google's token endpoint for an access token (`vertex.go:672-687`). */
async function tokenGrant(
  form: URLSearchParams,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const out = await postTokenAs(
    options.tokenUrl ?? GOOGLE_TOKEN_URL,
    "application/x-www-form-urlencoded",
    "",
    form.toString(),
    options,
    signal,
  );
  const token = typeof out.access_token === "string" ? out.access_token : "";
  if (token === "") {
    throw new Error("Google gave no access token");
  }
  const expiresIn =
    typeof out.expires_in === "number" && out.expires_in > 0 ? out.expires_in : 3600;
  return {
    token,
    expiresAt: (options.now?.() ?? Date.now()) + expiresIn * 1000,
  };
}

/**
 * Trades tok for a token of account at IAM Credentials, along delegates'
 * chain when there is one (`vertex.go:690-720`).
 */
async function impersonateFor(
  minted: { token: string; expiresAt: number },
  account: string,
  delegates: string[],
  options: VertexAuthOptions,
  signal: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const request: Record<string, unknown> = { scope: [VERTEX_SCOPE], lifetime: "3600s" };
  if (delegates.length > 0) {
    request.delegates = delegates.map((delegate) =>
      delegate.startsWith("projects/") ? delegate : `projects/-/serviceAccounts/${delegate}`,
    );
  }
  const url = `${options.iamUrl ?? GOOGLE_IAM_URL}/projects/-/serviceAccounts/${pathEscape(account)}:generateAccessToken`;
  let out: Record<string, unknown>;
  try {
    out = await postTokenAs(
      url,
      "application/json",
      minted.token,
      JSON.stringify(request),
      options,
      signal,
    );
  } catch (error) {
    const refused = error instanceof TokenRefusedError ? error : null;
    if (refused !== null && refused.status === 403) {
      throw new Error(
        `impersonating ${account}: ${refused.message}; the account signed in needs the Service Account Token Creator role (roles/iam.serviceAccountTokenCreator) on it`,
        { cause: error },
      );
    }
    throw new Error(`impersonating ${account}: ${messageOf(error)}`, { cause: error });
  }
  const token = typeof out.accessToken === "string" ? out.accessToken : "";
  if (token === "") {
    throw new Error(`impersonating ${account}: IAM Credentials gave no access token`);
  }
  const expireTime = typeof out.expireTime === "string" ? Date.parse(out.expireTime) : Number.NaN;
  return {
    token,
    expiresAt: Number.isNaN(expireTime) ? minted.expiresAt : expireTime,
  };
}

async function postTokenAs(
  url: string,
  contentType: string,
  bearer: string,
  body: string,
  options: VertexAuthOptions,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "content-type": contentType,
    accept: "application/json",
  };
  if (bearer !== "") {
    headers.authorization = `Bearer ${bearer}`;
  }
  const fetchImpl = fetchThroughProxy(options.proxy, options.fetchImpl);
  const response = await fetchImpl(url, { method: "POST", headers, body, signal });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (response.status !== 200) {
    throw new TokenRefusedError(response.status, refusalMessage(parsed, text, response.status));
  }
  if (!isRecord(parsed)) {
    throw new Error("the token endpoint gave no JSON");
  }
  return parsed;
}

/** A refusal's message, as Google's endpoints write it (`signin.go:790-812`). */
function refusalMessage(parsed: unknown, text: string, status: number): string {
  if (isRecord(parsed)) {
    const fields = [parsed.error_description, parsed.detail, parsed.message];
    for (const field of fields) {
      if (typeof field === "string" && field !== "") {
        return field;
      }
    }
    if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
      return parsed.error.message;
    }
    if (typeof parsed.error === "string" && parsed.error !== "") {
      return parsed.error;
    }
  }
  if (text.trim() !== "") {
    return text.trim().slice(0, 200);
  }
  return `HTTP ${status}`;
}

/** The file gcloud keeps a signed-in account's credentials in, under its folder. */
const LEGACY_ADC = /^legacy_credentials\/([^/]+)\/adc\.json$/;

/**
 * How the person's sign-in in file is made anew (`vertex.go:580-599`).
 * gcloud writes its own files again; another file is the user's to make
 * again.
 */
async function signInAgain(
  file: string,
  account: string,
  options: VertexAuthOptions,
): Promise<string> {
  let rel = "";
  try {
    rel = relative(await gcloudDir(options), file)
      .split(sep)
      .join("/");
  } catch {
    rel = "";
  }
  if (rel === "application_default_credentials.json" && account !== "") {
    return `sign in again with \`gcloud auth application-default login --impersonate-service-account=${account}\``;
  }
  if (rel === "application_default_credentials.json") {
    return "sign in again with `gcloud auth application-default login`";
  }
  const legacy = LEGACY_ADC.exec(rel);
  if (legacy !== null) {
    return `sign in again with \`gcloud auth login ${legacy[1] ?? ""}\``;
  }
  return "sign in again and write that file anew, or give the provider another credentials file";
}

/* ------------------------------------------------------------ helpers ---- */

/** Go's url.PathEscape in a path segment: everything but these is escaped. */
function pathEscape(value: string): string {
  return value.replace(/[^A-Za-z0-9\-._~!$&'()*+=:@]/g, (char) => encodeURIComponent(char));
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
