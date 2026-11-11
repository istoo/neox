import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Recordings a browser tool call made, kept on the gateway for an hour and
 * served at a link. The link carries a token so a person can open it without
 * a gateway key; everything else asks for the key that had it made, as myna's
 * made files do.
 */

/** Where the browser bridge serves the recordings it made. */
export const BROWSER_FILES_PATH = "/mcp/myna/browser/files/";
/** The query parameter of a file's URL that holds its token. */
export const BROWSER_FILE_TOKEN = "t";

const KEEP_MS = 60 * 60 * 1000;
const FILES_MOST = 256 << 20;
const TOKEN_CONTEXT = "neolix browser file";

interface KeptFile {
  data: Buffer;
  mime: string;
  /** The gateway key that had it made; null for a keyless loopback caller. */
  key: string | null;
  made: number;
}

export type BrowserFileRead =
  | { ok: true; data: Buffer; mime: string }
  | { ok: false; status: 401 | 403 | 404; message: string };

const NO_SUCH =
  "no such recording: recordings are kept for an hour, and only for the key that had them made or the link they were handed out at";
const NOT_SHARED =
  "Neox's recordings are served to another machine only with the key that had them made or the link's own token";
const LINK_REFUSED =
  "the link doesn't open this recording: it may have expired, or it belongs to another gateway or key";

export class BrowserFileStore {
  private readonly files = new Map<string, KeptFile>();
  /** File names, oldest first. */
  private readonly order: string[] = [];
  private bytes = 0;
  private secret: Buffer | undefined;
  private readonly now: () => number;
  private readonly name: () => string;

  constructor(options: { now?: () => number; name?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.name = options.name ?? (() => randomBytes(16).toString("hex"));
  }

  /** Keeps data for an hour and is its name with the token that opens it. */
  public keep(data: Buffer, mime: string, key: string | null): string {
    this.secret ??= randomBytes(32);
    const name = `${this.name()}${extensionOf(mime)}`;
    const made = this.now();
    this.files.set(name, { data, mime, key, made });
    this.order.push(name);
    this.bytes += data.length;
    this.trim();
    return `${name}?${BROWSER_FILE_TOKEN}=${this.token(name, key, made + KEEP_MS)}`;
  }

  /**
   * The file a request may have: this computer's caller, the link's own
   * token, or the key that had it made while that key is still enabled.
   */
  public read(input: {
    name: string;
    token: string | null;
    key: string | null;
    local: boolean;
    keyLive: (key: string) => boolean;
  }): BrowserFileRead {
    const file = this.find(input.name);
    if (file === undefined) {
      return { ok: false, status: 404, message: NO_SUCH };
    }
    if (input.local) {
      return { ok: true, data: file.data, mime: file.mime };
    }
    const live = file.key === null || input.keyLive(file.key);
    if (live && input.token !== null && this.opens(input.name, input.token, file.key)) {
      return { ok: true, data: file.data, mime: file.mime };
    }
    if (live && file.key !== null && input.key === file.key) {
      return { ok: true, data: file.data, mime: file.mime };
    }
    if (input.token !== null && input.key === null) {
      return { ok: false, status: 401, message: LINK_REFUSED };
    }
    if (input.key === null) {
      return { ok: false, status: 403, message: NOT_SHARED };
    }
    // Another key's file is as good as none: its name says nothing.
    return { ok: false, status: 404, message: NO_SUCH };
  }

  private find(name: string): KeptFile | undefined {
    const file = this.files.get(name);
    if (file === undefined) {
      return undefined;
    }
    if (this.now() - file.made > KEEP_MS) {
      this.forget(name);
      return undefined;
    }
    return file;
  }

  private forget(name: string): void {
    const file = this.files.get(name);
    if (file === undefined) {
      return;
    }
    this.files.delete(name);
    this.bytes -= file.data.length;
  }

  private trim(): void {
    // The newest file stays even when it alone is over the cap, as myna does.
    while (this.order.length > 1) {
      const oldest = this.order[0] ?? "";
      const file = this.files.get(oldest);
      if (file !== undefined && this.bytes <= FILES_MOST && this.now() - file.made <= KEEP_MS) {
        return;
      }
      this.order.shift();
      if (file !== undefined) {
        this.forget(oldest);
      }
    }
  }

  private token(name: string, key: string | null, expiresMs: number): string {
    const secret = this.secret;
    if (secret === undefined) {
      throw new Error("the browser file store has no secret");
    }
    const expires = Math.floor(expiresMs / 1000);
    return `${expires}.${fileToken(secret, name, key, expires)}`;
  }

  private opens(name: string, token: string, key: string | null): boolean {
    const dot = token.indexOf(".");
    if (dot <= 0 || this.secret === undefined) {
      return false;
    }
    const expires = Number(token.slice(0, dot));
    if (!Number.isSafeInteger(expires) || this.now() > expires * 1000) {
      return false;
    }
    const expected = Buffer.from(this.token(name, key, expires * 1000));
    const presented = Buffer.from(token);
    return expected.length === presented.length && timingSafeEqual(expected, presented);
  }
}

/** A token for one file, key and expiry is no other's. */
function fileToken(secret: Buffer, name: string, key: string | null, expires: number): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${TOKEN_CONTEXT}\0${name}\0${expires}\0${key ?? ""}`);
  return hmac.digest("base64url");
}

function extensionOf(mime: string): string {
  if (mime === "image/gif") {
    return ".gif";
  }
  if (mime === "image/png") {
    return ".png";
  }
  return mime === "image/jpeg" ? ".jpg" : "";
}
