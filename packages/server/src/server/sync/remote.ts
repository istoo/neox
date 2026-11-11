import { createHash, createHmac } from "node:crypto";

import type { SyncConfig } from "./config.js";
import { WebDavClient } from "./webdav.js";

/**
 * The small surface the sync engine needs of a WebDAV folder, an
 * S3-compatible bucket or a GitHub repository: list what is there, read,
 * write and delete a file, with the version (an ETag, an object's ETag or
 * a Contents API SHA) checked when a file is written.
 */
export interface RemoteEntry {
  name: string;
  etag: string | null;
}

export interface RemoteFile {
  data: Buffer;
  etag: string | null;
}

export interface SyncRemote {
  readonly kind: "webdav" | "s3" | "github";
  /** Where messages name this remote. */
  readonly where: string;
  /** Makes the sync folder, or one folder under it, where the backend has folders. */
  ensure(prefix?: string): Promise<void>;
  /** The files in the sync folder, or in one folder under it. */
  list(prefix?: string): Promise<RemoteEntry[]>;
  get(name: string): Promise<RemoteFile | null>;
  /** `expected` is the version last seen; null means "nothing there yet". */
  put(name: string, data: Buffer, expected: string | null | undefined): Promise<RemoteFile>;
  delete(name: string): Promise<void>;
}

/** Another computer wrote the file between this one's read and its write. */
export class RemoteConflictError extends Error {
  constructor(message = "the file on the server changed meanwhile") {
    super(message);
    this.name = "RemoteConflictError";
  }
}

/** The server is limiting requests (429/503), as myna handles it (`dav.go:86`). */
export class RemoteRateLimitedError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "RemoteRateLimitedError";
  }
}

export class RemoteAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteAuthError";
  }
}

export class RemoteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}

const TIMEOUT_MS = 60_000;

export function createRemote(config: SyncConfig, fetchImpl: typeof fetch = fetch): SyncRemote {
  const url = config.url.trim();
  if (url.toLowerCase().startsWith("github://")) {
    return new GitHubRemote(config, fetchImpl);
  }
  if (url.toLowerCase().startsWith("s3://")) {
    return new S3Remote(config, fetchImpl);
  }
  return new WebDavRemote(config, fetchImpl);
}

function limited(kind: string, response: Response): RemoteRateLimitedError {
  const after = parseRetryAfterMs(response.headers.get("retry-after"));
  return new RemoteRateLimitedError(
    `the ${kind} server is limiting how often Neox may reach it (HTTP ${response.status}): sync waits longer before trying again`,
    after,
  );
}

export function parseRetryAfterMs(value: string | null): number {
  if (!value) {
    return 0;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(at - Date.now(), 0) : 0;
}

function classify(kind: string, response: Response, message: string): Error {
  if (response.status === 429 || response.status === 503) {
    return limited(kind, response);
  }
  if (response.status === 401 || response.status === 403) {
    return new RemoteAuthError(response.status, message);
  }
  if (response.status === 409 || response.status === 412) {
    return new RemoteConflictError();
  }
  return new RemoteError(response.status, message);
}

// ---------------------------------------------------------------------------
// WebDAV

class WebDavRemote implements SyncRemote {
  readonly kind = "webdav" as const;
  readonly where: string;
  private readonly client: WebDavClient;

  constructor(config: SyncConfig, fetchImpl: typeof fetch) {
    this.where = config.url;
    this.client = new WebDavClient(
      {
        url: config.url,
        username: config.user ?? "",
        password: config.password ?? "",
      },
      fetchImpl,
    );
  }

  async ensure(prefix?: string): Promise<void> {
    try {
      await this.client.ensureFolder(prefix);
    } catch (error) {
      throw this.map(error);
    }
  }

  async list(prefix?: string): Promise<RemoteEntry[]> {
    try {
      const entries = await this.client.list(prefix);
      return entries
        .filter((entry) => !entry.isDirectory)
        .map((entry) => ({ name: entry.name, etag: entry.etag }));
    } catch (error) {
      throw this.map(error);
    }
  }

  async get(name: string): Promise<RemoteFile | null> {
    try {
      const file = await this.client.get(name);
      return file ? { data: file.body, etag: file.etag } : null;
    } catch (error) {
      throw this.map(error);
    }
  }

  async put(name: string, data: Buffer, expected: string | null | undefined): Promise<RemoteFile> {
    try {
      const etag = await this.client.put(name, data, {
        ...(expected === null ? { ifNoneMatch: "*" } : {}),
        ...(typeof expected === "string" ? { ifMatch: expected } : {}),
      });
      return { data, etag };
    } catch (error) {
      throw this.map(error);
    }
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.delete(name);
    } catch (error) {
      throw this.map(error);
    }
  }

  private map(error: unknown): Error {
    if (error instanceof RemoteConflictError) {
      return error;
    }
    if (error instanceof Error && "status" in error) {
      const status = (error as { status: number }).status;
      if (status === 429 || status === 503) {
        return new RemoteRateLimitedError(
          `the WebDAV server is limiting how often Neox may reach it (HTTP ${status}): sync waits longer before trying again`,
          parseRetryAfterMs(null),
        );
      }
      if (status === 401 || status === 403) {
        return new RemoteAuthError(status, error.message);
      }
      if (status === 409 || status === 412) {
        return new RemoteConflictError();
      }
      return new RemoteError(status, error.message);
    }
    return error instanceof Error ? error : new RemoteError(0, String(error));
  }
}

// ---------------------------------------------------------------------------
// S3 (SigV4, the smallest set the sync needs)

interface S3Location {
  bucket: string;
  prefix: string;
}

export function parseS3Url(url: string): S3Location {
  const rest = url.replace(/^s3:\/\//i, "");
  const [bucket, ...parts] = rest.split("/");
  if (!bucket) {
    throw new Error("An S3 address needs a bucket: s3://bucket/prefix");
  }
  const prefix = parts.join("/").replace(/^\/+|\/+$/g, "");
  return { bucket, prefix };
}

export class S3Remote implements SyncRemote {
  readonly kind = "s3" as const;
  readonly where: string;
  private readonly location: S3Location;
  private readonly endpoint: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly pathStyle: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly basePath: string;

  constructor(config: SyncConfig, fetchImpl: typeof fetch) {
    this.location = parseS3Url(config.url);
    this.region = config.region?.trim() || "us-east-1";
    this.accessKey = config.user ?? "";
    this.secretKey = config.password ?? "";
    this.pathStyle = config.pathStyle === true;
    this.fetchImpl = fetchImpl;
    this.where = config.url;

    const endpoint = config.endpoint?.trim();
    const host = endpoint
      ? endpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "")
      : `s3.${this.region}.amazonaws.com`;
    const scheme = endpoint?.startsWith("http://") ? "http" : "https";
    if (this.pathStyle) {
      this.endpoint = `${scheme}://${host}`;
      this.basePath = `/${this.location.bucket}`;
    } else {
      this.endpoint = `${scheme}://${this.location.bucket}.${host}`;
      this.basePath = "";
    }
  }

  async ensure(_prefix?: string): Promise<void> {
    // The bucket must exist; creating it is not sync's job.
  }

  async list(prefix?: string): Promise<RemoteEntry[]> {
    const base = this.location.prefix ? `${this.location.prefix}/` : "";
    const wanted = prefix ? `${base}${prefix}/` : base;
    const query = new URLSearchParams({ "list-type": "2", prefix: wanted });
    const response = await this.send("GET", "", query, Buffer.alloc(0), {});
    if (!response.ok) {
      throw classify("S3", response, `listing ${this.where} answered ${response.status}`);
    }
    const xml = await response.text();
    const out: RemoteEntry[] = [];
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = decodeXml(/<Key>([\s\S]*?)<\/Key>/.exec(match[1] ?? "")?.[1] ?? "");
      if (!key.startsWith(wanted)) {
        continue;
      }
      const etag = decodeXml(/<ETag>([\s\S]*?)<\/ETag>/.exec(match[1] ?? "")?.[1] ?? "");
      out.push({ name: key.slice(base.length), etag: etag.replace(/^"|"$/g, "") || null });
    }
    return out;
  }

  async get(name: string): Promise<RemoteFile | null> {
    const response = await this.send("GET", name, null, Buffer.alloc(0), {});
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw classify("S3", response, `reading ${name} answered ${response.status}`);
    }
    return {
      data: Buffer.from(await response.arrayBuffer()),
      etag: stripQuotes(response.headers.get("etag")),
    };
  }

  async put(name: string, data: Buffer, expected: string | null | undefined): Promise<RemoteFile> {
    const headers: Record<string, string> = {};
    if (expected === null) {
      headers["if-none-match"] = "*";
    } else if (typeof expected === "string") {
      headers["if-match"] = expected;
    }
    const response = await this.send("PUT", name, null, data, headers);
    if (!response.ok) {
      throw classify("S3", response, `writing ${name} answered ${response.status}`);
    }
    return { data, etag: stripQuotes(response.headers.get("etag")) };
  }

  async delete(name: string): Promise<void> {
    const response = await this.send("DELETE", name, null, Buffer.alloc(0), {});
    if (!response.ok && response.status !== 404) {
      throw classify("S3", response, `deleting ${name} answered ${response.status}`);
    }
  }

  private async send(
    method: string,
    name: string,
    query: URLSearchParams | null,
    body: Buffer,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    const key =
      name.length > 0 ? `${this.location.prefix ? `${this.location.prefix}/` : ""}${name}` : "";
    const rawPath = `${this.basePath}/${key}`.replace(/\/+/g, "/");
    const url = `${this.endpoint}${rawPath}${query ? `?${query.toString()}` : ""}`;
    const headers = this.authorization(method, rawPath, query, body, extraHeaders);
    return this.fetchImpl(url, {
      method,
      headers: { ...headers, ...extraHeaders },
      ...(method === "GET" || method === "DELETE" ? {} : { body: body as unknown as BodyInit }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** The SigV4 headers for one request (`AWS4-HMAC-SHA256`). */
  private authorization(
    method: string,
    rawPath: string,
    query: URLSearchParams | null,
    body: Buffer,
    extraHeaders: Record<string, string>,
  ): Record<string, string> {
    return signAwsRequest({
      method,
      path: rawPath,
      query,
      body,
      headers: extraHeaders,
      host: this.endpoint.replace(/^https?:\/\//, ""),
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region: this.region,
      service: "s3",
    });
  }
}

export interface AwsSignInput {
  method: string;
  /** The canonical URI's path, unencoded. */
  path: string;
  query?: URLSearchParams | null;
  body: Buffer;
  /** Headers to sign besides host and x-amz-date. */
  headers?: Record<string, string>;
  host: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service?: string;
  /** `YYYYMMDDTHHMMSSZ`; now when absent. */
  amzDate?: string;
  /** S3 sends the payload hash as a header; the official test vectors don't. */
  contentSha256?: boolean;
}

/**
 * AWS Signature Version 4 for one request, as the official test suite
 * (`aws-sig-v4-test-suite`, get-vanilla) expects it. S3 uses it through
 * `S3Remote`; the tests sign the suite's vectors with it.
 */
export function signAwsRequest(input: AwsSignInput): Record<string, string> {
  const amzDate = input.amzDate ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = input.service ?? "s3";
  const payloadHash = createHash("sha256").update(input.body).digest("hex");
  const canonicalHeaders: Record<string, string> = {
    host: input.host,
    "x-amz-date": amzDate,
  };
  if (input.contentSha256 !== false) {
    canonicalHeaders["x-amz-content-sha256"] = payloadHash;
  }
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    canonicalHeaders[key.toLowerCase()] = value.trim();
  }
  const signedHeaderNames = Object.keys(canonicalHeaders).sort();
  const signedHeaders = signedHeaderNames.join(";");
  const headerBlock = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaders[name]}\n`)
    .join("");
  const canonicalQuery = input.query ? canonicalQueryString(input.query) : "";
  const canonicalRequest = [
    input.method,
    encodeRfc3986Path(input.path),
    canonicalQuery,
    headerBlock,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const signingKey = hmacChain(input.secretKey, dateStamp, input.region, service);
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...canonicalHeaders,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function hmacChain(secret: string, dateStamp: string, region: string, service = "s3"): Buffer {
  const date = createHmac("sha256", `AWS4${secret}`).update(dateStamp).digest();
  const regional = createHmac("sha256", date).update(region).digest();
  const scoped = createHmac("sha256", regional).update(service).digest();
  return createHmac("sha256", scoped).update("aws4_request").digest();
}

function encodeRfc3986Path(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

function canonicalQueryString(query: URLSearchParams): string {
  return [...query.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function stripQuotes(value: string | null): string | null {
  return value ? value.replace(/^"|"$/g, "") : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// GitHub Contents API (myna `internal/davsync/github.go`)

export interface GitHubLocation {
  owner: string;
  repo: string;
  prefix: string;
}

export function parseGitHubUrl(url: string): GitHubLocation {
  const rest = url.replace(/^github:\/\//i, "");
  const [owner, repo, ...parts] = rest.split("/");
  if (!owner || !repo) {
    throw new Error("A GitHub address needs a repository: github://owner/repo/prefix");
  }
  return {
    owner,
    repo,
    prefix: parts.join("/").replace(/^\/+|\/+$/g, ""),
  };
}

const GITHUB_API = "https://api.github.com";
/** The most one sync file may hold; a blob goes up base64 in a JSON body. */
const GITHUB_MAX_FILE = 64 << 20;

export class GitHubRemote implements SyncRemote {
  readonly kind = "github" as const;
  readonly where: string;
  private readonly location: GitHubLocation;
  private readonly token: string;
  private readonly branchSetting: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private branch = "";
  private empty = false;
  private ready = false;

  constructor(config: SyncConfig, fetchImpl: typeof fetch, apiBase = GITHUB_API) {
    this.location = parseGitHubUrl(config.url);
    this.token = config.password ?? "";
    this.branchSetting = config.branch?.trim() || undefined;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.where = config.url;
  }

  async ensure(_prefix?: string): Promise<void> {
    // The repository and branch must exist; creating them is not sync's job.
  }

  async list(prefix?: string): Promise<RemoteEntry[]> {
    const path = [this.location.prefix, prefix].filter((part) => part).join("/");
    const response = await this.send(
      "GET",
      `${this.repoBase()}/contents${path ? `/${encodePath(path)}` : ""}`,
    );
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw await this.error(response, "listing");
    }
    const body: unknown = await response.json();
    if (!Array.isArray(body)) {
      return [];
    }
    return body
      .filter(
        (entry): entry is { name: string; sha: string; type: string } =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { type?: string }).type === "file",
      )
      .map((entry) => ({
        name: prefix ? `${prefix}/${entry.name}` : entry.name,
        etag: entry.sha,
      }));
  }

  async get(name: string): Promise<RemoteFile | null> {
    await this.prepare();
    const metadata = await this.metadataAt(name, this.branch);
    if (!metadata) {
      return null;
    }
    return { data: await this.bytesOf(metadata), etag: metadata.sha };
  }

  async put(name: string, data: Buffer, expected: string | null | undefined): Promise<RemoteFile> {
    if (data.byteLength > GITHUB_MAX_FILE) {
      throw new RemoteError(413, `${name} is larger than the 64 MiB a GitHub sync file may hold`);
    }
    const sha = await this.gitDataWrite(name, data, expected);
    return { data, etag: sha };
  }

  async delete(name: string): Promise<void> {
    await this.prepare();
    if (this.empty) {
      return;
    }
    await this.gitDataWrite(name, null, undefined);
  }

  /** The repository's default branch and whether it has commits yet. */
  private async prepare(): Promise<void> {
    if (this.ready) {
      return;
    }
    const repoResponse = await this.send("GET", this.repoBase());
    if (!repoResponse.ok) {
      throw await this.error(repoResponse, "reading the repository");
    }
    const repo = (await repoResponse.json()) as { default_branch?: string; private?: boolean };
    if (repo.private !== true) {
      throw new RemoteError(
        403,
        `the GitHub repository ${this.location.owner}/${this.location.repo} is public, or GitHub didn't say it is private: anyone could download every version of the sealed files from its history. Make it private`,
      );
    }
    this.branch = this.branchSetting || repo.default_branch || "";
    if (!this.branch) {
      throw new RemoteError(
        400,
        "the GitHub repository has no default branch: create an initial commit first",
      );
    }
    const head = await this.send("GET", this.refPath());
    if (head.status === 409) {
      const body = await head.text().catch(() => "");
      if (!body.toLowerCase().includes("empty")) {
        throw await this.error(head, "reading the branch");
      }
      if (this.branchSetting && this.branchSetting !== repo.default_branch) {
        throw new RemoteError(
          409,
          "the GitHub repository is empty: leave Branch empty or use its default branch for the first sync",
        );
      }
      this.empty = true;
    } else if (!head.ok) {
      throw await this.error(head, "reading the branch");
    }
    this.ready = true;
  }

  private repoBase(): string {
    return `/repos/${encodeURIComponent(this.location.owner)}/${encodeURIComponent(this.location.repo)}`;
  }

  private refPath(): string {
    return `${this.repoBase()}/git/ref/heads/${encodePath(this.branch)}`;
  }

  private fullPath(name: string): string {
    return this.location.prefix ? `${this.location.prefix}/${name}` : name;
  }

  private contentPath(name: string): string {
    return `${this.repoBase()}/contents/${encodePath(this.fullPath(name))}`;
  }

  private async metadataAt(
    name: string,
    ref: string,
  ): Promise<{ sha: string; size: number; encoding: string; content: string } | null> {
    const response = await this.send(
      "GET",
      `${this.contentPath(name)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      "application/vnd.github.object+json",
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await this.error(response, `reading ${name}`);
    }
    const body = (await response.json()) as {
      type?: string;
      sha?: string;
      size?: number;
      encoding?: string;
      content?: string;
    };
    if (body.type !== "file" || typeof body.sha !== "string") {
      return null;
    }
    return {
      sha: body.sha,
      size: typeof body.size === "number" ? body.size : 0,
      encoding: typeof body.encoding === "string" ? body.encoding : "base64",
      content: typeof body.content === "string" ? body.content : "",
    };
  }

  /** A file's bytes: Contents API content when small, its blob when not. */
  private async bytesOf(metadata: {
    sha: string;
    size: number;
    encoding: string;
    content: string;
  }): Promise<Buffer> {
    if (metadata.encoding === "base64") {
      return Buffer.from(metadata.content.replace(/\s/g, ""), "base64");
    }
    if (metadata.encoding !== "none") {
      throw new RemoteError(
        422,
        `GitHub returned an unsupported file encoding ${JSON.stringify(metadata.encoding)}`,
      );
    }
    const response = await this.send(
      "GET",
      `${this.repoBase()}/git/blobs/${metadata.sha}`,
      undefined,
      "application/vnd.github.raw+json",
    );
    if (!response.ok) {
      throw await this.error(response, "reading the file's blob");
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength !== metadata.size) {
      throw new RemoteError(422, "GitHub returned an incomplete file");
    }
    return data;
  }

  /**
   * Writes (or with `null`, removes) one file in one commit. A repository
   * with commits goes through the Git Data API (blob, tree, commit, ref),
   * which takes a file up to 100 MB where the Contents API refuses large
   * ones (myna `gitCommit`, `internal/davsync/github.go:475`). An empty
   * repository gets its first commit through the Contents API, which
   * creates the default branch.
   */
  private async gitDataWrite(
    name: string,
    data: Buffer | null,
    expected: string | null | undefined,
  ): Promise<string | null> {
    await this.prepare();
    if (this.empty) {
      if (data === null) {
        return null;
      }
      const created = await this.contentsPut(name, data);
      if (created !== null) {
        this.empty = false;
        return created;
      }
      // Too large for the Contents API: give the repository a first commit
      // of its own, then build the file's commit on it.
      const note = Buffer.from("This folder holds Neox's sealed sync files.\n");
      await this.contentsPut("README.md", note);
      this.empty = false;
    }
    const head = await this.headSha();
    await this.checkExpected(name, head, expected);
    const blobSha = data === null ? null : await this.createBlob(data);
    const tree = await this.headTree(head);
    const treeSha = await this.createTree(tree, name, blobSha);
    const madeSha = await this.createCommit(treeSha, head, data === null, name);
    await this.moveRef(madeSha);
    return blobSha;
  }

  private async headSha(): Promise<string> {
    const response = await this.send("GET", this.refPath());
    if (!response.ok) {
      throw await this.error(response, "reading the branch");
    }
    const sha = ((await response.json()) as { object?: { sha?: string } }).object?.sha;
    if (!sha) {
      throw new RemoteError(422, "GitHub did not return the branch's head commit");
    }
    return sha;
  }

  private async checkExpected(
    name: string,
    head: string,
    expected: string | null | undefined,
  ): Promise<void> {
    const current = await this.metadataAt(name, head);
    if (expected === null && current) {
      throw new RemoteConflictError();
    }
    if (typeof expected === "string" && current?.sha !== expected) {
      throw new RemoteConflictError();
    }
  }

  private async createBlob(data: Buffer): Promise<string> {
    const response = await this.send("POST", `${this.repoBase()}/git/blobs`, {
      content: data.toString("base64"),
      encoding: "base64",
    });
    if (!response.ok) {
      throw await this.error(response, "writing the file's blob");
    }
    const sha = ((await response.json()) as { sha?: string }).sha;
    if (!sha) {
      throw new RemoteError(422, "GitHub did not return the new blob");
    }
    return sha;
  }

  private async headTree(head: string): Promise<string> {
    const response = await this.send("GET", `${this.repoBase()}/git/commits/${head}`);
    if (!response.ok) {
      throw await this.error(response, "reading the head commit");
    }
    const tree = ((await response.json()) as { tree?: { sha?: string } }).tree?.sha;
    if (!tree) {
      throw new RemoteError(422, "GitHub did not return the head commit's tree");
    }
    return tree;
  }

  private async createTree(base: string, name: string, blobSha: string | null): Promise<string> {
    const path = this.fullPath(name);
    const entry = { path, mode: "100644", type: "blob", sha: blobSha };
    const response = await this.send("POST", `${this.repoBase()}/git/trees`, {
      base_tree: base,
      tree: [entry],
    });
    if (!response.ok) {
      throw await this.error(response, "writing the tree");
    }
    const sha = ((await response.json()) as { sha?: string }).sha;
    if (!sha) {
      throw new RemoteError(422, "GitHub did not return the new tree");
    }
    return sha;
  }

  private async createCommit(
    tree: string,
    parent: string,
    removing: boolean,
    name: string,
  ): Promise<string> {
    const response = await this.send("POST", `${this.repoBase()}/git/commits`, {
      message: removing ? `sync: remove ${name}` : `sync: ${name}`,
      tree,
      parents: [parent],
    });
    if (!response.ok) {
      throw await this.error(response, "writing the commit");
    }
    const sha = ((await response.json()) as { sha?: string }).sha;
    if (!sha) {
      throw new RemoteError(422, "GitHub did not return the new commit");
    }
    return sha;
  }

  private async moveRef(sha: string): Promise<void> {
    const response = await this.send("PATCH", this.refPath(), { sha, force: false });
    if (response.ok) {
      return;
    }
    if (response.status === 422) {
      const body = await response.text().catch(() => "");
      if (body.toLowerCase().includes("fast forward")) {
        throw new RemoteConflictError();
      }
    }
    throw await this.error(response, "moving the branch");
  }

  /** Writes through the Contents API; null when GitHub refuses it as too large. */
  private async contentsPut(name: string, data: Buffer): Promise<string | null> {
    const response = await this.send("PUT", this.contentPath(name), {
      message: `sync: ${name}`,
      content: data.toString("base64"),
      ...(this.branchSetting ? { branch: this.branchSetting } : {}),
    });
    if (response.status === 422 || response.status === 413) {
      const body = await response.text().catch(() => "");
      if (/too large|too_large|too big/i.test(body)) {
        return null;
      }
    }
    if (!response.ok) {
      throw await this.error(response, `writing ${name}`);
    }
    const written = (await response.json()) as { content?: { sha?: string } };
    return written.content?.sha ?? null;
  }

  private send(
    method: string,
    apiPath: string,
    body?: unknown,
    accept = "application/vnd.github+json",
  ): Promise<Response> {
    return this.fetchImpl(`${this.apiBase}${apiPath}`, {
      method,
      headers: {
        accept,
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  private async error(response: Response, doing: string): Promise<Error> {
    if (response.status === 429) {
      return limited("GitHub", response);
    }
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset") ?? "0");
      const wait = reset > 0 ? Math.max(reset * 1000 - Date.now(), 0) : 0;
      return new RemoteRateLimitedError(
        "GitHub is limiting how often Neox may reach it: sync waits longer before trying again",
        wait,
      );
    }
    if (response.status === 401) {
      return new RemoteAuthError(
        401,
        "GitHub refused the token: check it has Contents read and write",
      );
    }
    if (response.status === 403) {
      return new RemoteAuthError(
        403,
        "GitHub refused the token: check it has Contents read and write",
      );
    }
    const text = await response.text().catch(() => "");
    return new RemoteError(
      response.status,
      `${doing} answered ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }
}

function encodePath(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
