import { Buffer } from "node:buffer";

/**
 * The WebDAV client the sync engine needs: create the folder, put and get a
 * file, list a folder, delete, with Basic auth and conditional requests.
 * Deliberately small: no locking, no properties beyond size, ETag and mtime.
 */

const TIMEOUT_MS = 20_000;

export interface WebDavTarget {
  /** The folder's URL, e.g. https://dav.example/remote.php/dav/files/me/neolix. */
  url: string;
  username: string;
  password: string;
}

export interface WebDavEntry {
  name: string;
  etag: string | null;
  lastModified: string | null;
  isDirectory: boolean;
}

export class WebDavError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WebDavError";
  }
}

function joinUrl(base: string, name: string): string {
  return `${base.replace(/\/+$/, "")}/${name.split("/").map(encodeURIComponent).join("/")}`;
}

function authHeader(target: WebDavTarget): Record<string, string> {
  const credentials = `${target.username}:${target.password}`;
  return { authorization: `Basic ${Buffer.from(credentials, "utf8").toString("base64")}` };
}

export class WebDavClient {
  private readonly base: string;

  constructor(
    private readonly target: WebDavTarget,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = target.url.replace(/\/+$/, "");
  }

  private async request(
    method: string,
    url: string,
    init: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        ...authHeader(this.target),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** MKCOL the sync folder, or one folder inside it; an existing one answers 405. */
  async ensureFolder(name?: string): Promise<void> {
    const url = name ? joinUrl(this.base, name) : this.base;
    const response = await this.request("MKCOL", url);
    if (!response.ok && response.status !== 405) {
      throw new WebDavError(`MKCOL ${url} answered ${response.status}`, response.status);
    }
  }

  async put(
    name: string,
    body: Buffer,
    options: { ifMatch?: string; ifNoneMatch?: string } = {},
  ): Promise<string | null> {
    const response = await this.request("PUT", joinUrl(this.base, name), {
      body,
      headers: {
        "content-type": "application/octet-stream",
        ...(options.ifMatch === undefined ? {} : { "if-match": options.ifMatch }),
        ...(options.ifNoneMatch === undefined ? {} : { "if-none-match": options.ifNoneMatch }),
      },
    });
    if (!response.ok) {
      throw new WebDavError(`PUT ${name} answered ${response.status}`, response.status);
    }
    return response.headers.get("etag");
  }

  /** The file's bytes, or null when the server says it has none. */
  async get(name: string): Promise<{ body: Buffer; etag: string | null } | null> {
    const response = await this.request("GET", joinUrl(this.base, name));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new WebDavError(`GET ${name} answered ${response.status}`, response.status);
    }
    return { body: Buffer.from(await response.arrayBuffer()), etag: response.headers.get("etag") };
  }

  /**
   * The files in the folder, or in one folder under it. A name is the path
   * from the sync folder, so a subfolder's entry is `usage/<file>`.
   */
  async list(prefix?: string): Promise<WebDavEntry[]> {
    const url = prefix ? joinUrl(this.base, prefix) : this.base;
    const response = await this.request("PROPFIND", url, {
      body:
        '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop>' +
        "<d:getetag/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>",
      headers: { depth: "1", "content-type": "application/xml" },
    });
    if (response.status === 404) {
      return [];
    }
    if (!response.ok && response.status !== 207) {
      throw new WebDavError(`PROPFIND answered ${response.status}`, response.status);
    }
    const entries = parseMultiStatus(await response.text(), url);
    return prefix
      ? entries.map((entry) => ({ ...entry, name: `${prefix}/${entry.name}` }))
      : entries;
  }

  async delete(name: string): Promise<void> {
    const response = await this.request("DELETE", joinUrl(this.base, name));
    if (!response.ok && response.status !== 404) {
      throw new WebDavError(`DELETE ${name} answered ${response.status}`, response.status);
    }
  }
}

/** The entries a PROPFIND Depth: 1 answer names, the folder itself left out. */
export function parseMultiStatus(xml: string, base: string): WebDavEntry[] {
  const entries: WebDavEntry[] = [];
  const responses = xml.match(/<(?:d:|D:)?response\b[\s\S]*?<\/(?:d:|D:)?response>/g) ?? [];
  for (const block of responses) {
    const href = tagText(block, "href");
    if (href === null) {
      continue;
    }
    const decoded = safeDecode(href).replace(/\/+$/, "");
    const self = basePathOf(base);
    if (decoded === self || decoded === safeDecode(self)) {
      continue;
    }
    const name = decoded.slice(decoded.lastIndexOf("/") + 1);
    if (name.length === 0) {
      continue;
    }
    entries.push({
      name,
      etag: tagText(block, "getetag"),
      lastModified: tagText(block, "getlastmodified"),
      isDirectory: /<(?:d:|D:)?collection\b/.test(block),
    });
  }
  return entries;
}

function tagText(xml: string, tag: string): string | null {
  const match = new RegExp(`<(?:d:|D:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:d:|D:)?${tag}>`).exec(xml);
  if (match === null) {
    return null;
  }
  return match[1]?.trim() ?? null;
}

/** A DAV answer names hrefs by path, while the target is an absolute URL. */
function basePathOf(base: string): string {
  try {
    return new URL(base).pathname.replace(/\/+$/, "");
  } catch {
    return base.replace(/\/+$/, "");
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
