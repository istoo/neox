import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import type { GatewayConfig } from "./config.js";
import type { Masker } from "./masking.js";
import { SYNC_CONFIG_FILENAME, normalizeSyncConfig } from "../sync/config.js";
import { createRemote, type SyncRemote } from "../sync/remote.js";

/**
 * The request archive on this computer, myna's archive_local: every call the
 * gateway serves is kept — the headers and bodies both ways, secrets taken
 * out first — at `$NEOLIX_HOME/request-archive/<date>/<id>.json`, and the id is
 * sent back as `X-Magpie-Archive-Id`. The archive's own switch (`archive.local`)
 * keeps request bodies off a disk the user did not turn it on for.
 */

export const ARCHIVE_HEADER = "X-Neolix-Archive-Id";

/** Marks a request the archive will capture, before its body is parsed. */
interface RawBodyRequest extends Request {
  archiveCapture?: boolean;
  rawBody?: Buffer;
}

/**
 * The body parser's `verify` hook: keeps the request's own bytes for the
 * archive, as myna keeps the wire's, when the archive is on. Nothing is kept
 * for a request the archive is not watching.
 */
export function captureRawBody(req: Request, body: Buffer): void {
  const marked = req as RawBodyRequest;
  if (marked.archiveCapture === true) {
    marked.rawBody = Buffer.from(body);
  }
}

const DEFAULT_MAX_MB = 32;
const DEFAULT_KEEP_MB = 1024;
/** Uploads queued at most; a call that finds the queue full is dropped. */
const QUEUE_MOST = 16;

interface ArchivePart {
  method?: string;
  path?: string;
  status?: number;
  headers: Record<string, string[]>;
  body: string;
  size?: number;
  truncated?: boolean;
}

interface WireRecord {
  method: string;
  url: string;
  request: Record<string, string[]>;
  status: number;
  response: Record<string, string[]>;
  millis: number;
  error?: string;
}

interface ArchiveRecord {
  id: string;
  time: string;
  request: ArchivePart;
  response: ArchivePart;
  /** Each request the gateway sent upstream for it, headers both ways. */
  upstream?: WireRecord[];
}

/** A bucket the archive is written to, when sync keeps one (myna's Putter). */
export interface ArchiveBucket {
  put(name: string, data: Buffer): Promise<void>;
  get(name: string): Promise<Buffer | null>;
}

/** The S3 sync's own bucket, read from `sync.json` and refreshed slowly. */
class SyncArchiveBucket implements ArchiveBucket {
  private remote: SyncRemote | null = null;
  private readAt = 0;

  public constructor(private readonly neolixHome: string) {}

  /** Whether sync keeps a bucket to write to. */
  public async available(): Promise<boolean> {
    return (await this.current()) !== null;
  }

  public async put(name: string, data: Buffer): Promise<void> {
    const remote = await this.current();
    if (remote === null) {
      throw new Error("No S3 sync is set up");
    }
    await remote.put(name, data, undefined);
  }

  public async get(name: string): Promise<Buffer | null> {
    const remote = await this.current();
    if (remote === null) {
      return null;
    }
    const file = await remote.get(name);
    return file?.data ?? null;
  }

  private async current(): Promise<SyncRemote | null> {
    if (Date.now() - this.readAt < BUCKET_REFRESH_MS) {
      return this.remote;
    }
    this.readAt = Date.now();
    this.remote = await readSyncBucket(this.neolixHome);
    return this.remote;
  }
}

const BUCKET_REFRESH_MS = 30_000;

/** The sync's S3 remote, when sync is on and points at a bucket. */
async function readSyncBucket(neolixHome: string): Promise<SyncRemote | null> {
  try {
    const raw = await readFile(path.join(neolixHome, SYNC_CONFIG_FILENAME), "utf8");
    const config = normalizeSyncConfig(JSON.parse(raw));
    if (!config.enabled || !config.url.toLowerCase().startsWith("s3://")) {
      return null;
    }
    return createRemote(config);
  } catch {
    return null;
  }
}

/** Where a kept call goes: the bucket's `myna/archive/` folder. */
function bucketName(date: string, id: string): string {
  return `myna/archive/${date}/${id}.json`;
}

export class GatewayArchive {
  public readonly dir: string;
  private readonly logger: Logger;
  private readonly bucketProvider: () => ArchiveBucket | null;
  private bucket: ArchiveBucket | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private queued = 0;
  private bytes = 0;
  private counted = false;

  public constructor(options: {
    neolixHome: string;
    logger: Logger;
    /** Tests inject a bucket; the daemon uses the sync's own S3 bucket. */
    bucket?: () => ArchiveBucket | null;
  }) {
    this.dir = path.join(options.neolixHome, "request-archive");
    this.logger = options.logger;
    const syncBucket = new SyncArchiveBucket(options.neolixHome);
    if (options.bucket !== undefined) {
      this.bucketProvider = options.bucket;
      return;
    }
    // A bucket that appears or goes away is looked for now and then, never
    // on the request's own way; the first answer is this computer's folder.
    const refresh = (): void => {
      void syncBucket.available().then((there) => {
        this.bucket = there ? syncBucket : null;
        return undefined;
      });
    };
    refresh();
    this.refreshTimer = setInterval(refresh, BUCKET_REFRESH_MS);
    this.refreshTimer.unref?.();
    this.bucketProvider = () => this.bucket;
  }

  /** The archive's middleware: a call is kept when `archive.local` is on. */
  public middleware(options: {
    configStore: { get(): GatewayConfig };
    masker: Masker;
  }): (req: Request, res: Response, next: NextFunction) => void {
    return (req, res, next) => {
      const config = options.configStore.get();
      const setting = config.archive;
      if (setting?.local !== true || req.method !== "POST") {
        next();
        return;
      }
      // With sync's bucket set up, a call is kept there (myna's S3 branch);
      // otherwise in this computer's folder.
      const bucket = this.bucketProvider();
      const started = new Date();
      const { name, id } = archiveName(started);
      res.setHeader(ARCHIVE_HEADER, id);
      // The routing history row points here, so a request whose bodies have
      // left memory can still be opened from the archive.
      (res.locals as Record<string, unknown>).archiveName = name;
      (req as RawBodyRequest).archiveCapture = true;
      const maxBytes = (setting.maxMB ?? DEFAULT_MAX_MB) << 20;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const capture = (chunk: unknown): void => {
        if (chunk === undefined || chunk === null) {
          return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size <= maxBytes) {
          chunks.push(buffer);
        } else {
          truncated = true;
        }
      };
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = ((chunk: unknown, ...rest: unknown[]) => {
        capture(chunk);
        return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof res.write;
      res.end = ((chunk?: unknown, ...rest: unknown[]) => {
        capture(chunk);
        res.once("finish", () => {
          this.enqueue(
            {
              id: name,
              time: started.toISOString(),
              request: {
                method: req.method,
                path: archivePath(req, options.masker),
                headers: maskedHeaders(req.headers, options.masker),
                ...bodyPart((req as RawBodyRequest).rawBody ?? req.body, maxBytes, options.masker),
              },
              response: {
                status: res.statusCode,
                headers: maskedHeaders(res.getHeaders(), options.masker),
                ...bodyPart(Buffer.concat(chunks), maxBytes, options.masker),
                truncated,
              },
              ...wireRecords(res, options.masker),
            },
            setting.keepMB ?? DEFAULT_KEEP_MB,
            bucket,
          );
        });
        return (end as (...args: unknown[]) => Response)(chunk, ...rest);
      }) as typeof res.end;
      next();
    };
  }

  /** A kept call, by `<date>/<id>`, or null. */
  public async read(date: string, id: string): Promise<ArchiveRecord | null> {
    const name = checkedName(date, id);
    if (name === null) {
      return null;
    }
    const bucket = this.bucketProvider();
    if (bucket !== null) {
      try {
        const data = await bucket.get(bucketName(date, id));
        if (data !== null) {
          const parsed: unknown = JSON.parse(data.toString("utf8"));
          if (isRecord(parsed)) {
            return parsed as unknown as ArchiveRecord;
          }
        }
      } catch (error) {
        this.logger.warn({ err: error, id: name }, "Cannot read the archived call from the bucket");
      }
    }
    try {
      const text = await readFile(path.join(this.dir, date, `${id}.json`), "utf8");
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) ? (parsed as unknown as ArchiveRecord) : null;
    } catch {
      return null;
    }
  }

  /** Waits for pending writes, so a restart sees a finished archive. */
  public async dispose(): Promise<void> {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    await this.saving;
  }

  private enqueue(record: ArchiveRecord, keepMB: number, bucket: ArchiveBucket | null): void {
    if (this.queued >= QUEUE_MOST) {
      this.logger.warn({ id: record.id }, "Request archive dropped: uploads already waiting");
      return;
    }
    this.queued += 1;
    this.saving = this.saving
      .then(() => this.write(record, keepMB, bucket))
      .catch((error: unknown) => {
        this.logger.warn({ err: error, id: record.id }, "Request archive write failed");
      })
      .finally(() => {
        this.queued -= 1;
      });
  }

  private async write(
    record: ArchiveRecord,
    keepMB: number,
    bucket: ArchiveBucket | null,
  ): Promise<void> {
    const [date = "", id = ""] = record.id.split("/");
    const text = JSON.stringify(record, null, 2);
    if (bucket !== null) {
      await bucket.put(bucketName(date, id), Buffer.from(text));
      return;
    }
    const dir = path.join(this.dir, date);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, `${id}.json`), text, { mode: 0o600 });
    this.bytes += Buffer.byteLength(text);
    await this.prune(keepMB << 20);
  }

  /** Removes the oldest calls while the folder is over its cap. */
  private async prune(keepBytes: number): Promise<void> {
    if (!this.counted) {
      this.counted = true;
      this.bytes = await folderBytes(this.dir);
    }
    if (this.bytes <= keepBytes) {
      return;
    }
    const files = await archiveFiles(this.dir);
    let total = this.bytes;
    const goal = keepBytes - Math.floor(keepBytes / 10);
    for (const file of files) {
      if (total <= goal) {
        break;
      }
      try {
        await rm(file.path);
        total -= file.size;
      } catch {
        // another writer may have taken it
      }
    }
    this.bytes = total;
  }
}

interface KeptFile {
  path: string;
  name: string;
  size: number;
}

async function archiveFiles(dir: string): Promise<KeptFile[]> {
  const files: KeptFile[] = [];
  let days: string[];
  try {
    days = await readdir(dir);
  } catch {
    return files;
  }
  for (const day of days.sort()) {
    let names: string[];
    try {
      names = await readdir(path.join(dir, day));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json") || name.startsWith(".")) {
        continue;
      }
      const file = path.join(dir, day, name);
      try {
        const info = await stat(file);
        files.push({ path: file, name: `${day}/${name}`, size: info.size });
      } catch {
        // gone
      }
    }
  }
  return files;
}

async function folderBytes(dir: string): Promise<number> {
  return (await archiveFiles(dir)).reduce((total, file) => total + file.size, 0);
}

function archiveName(start: Date): { name: string; id: string } {
  const date = start.toISOString().slice(0, 10);
  const clock = start.toISOString().slice(11, 19).replaceAll(":", "");
  const id = `${clock}-${randomBytes(8).toString("hex")}`;
  return { name: `${date}/${id}`, id };
}

function checkedName(date: string, id: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || id.length === 0 || id.length > 64) {
    return null;
  }
  return /^[0-9a-z-]+$/.test(id) ? `${date}/${id}` : null;
}

function archivePath(req: Request, masker: Masker): string {
  const query = typeof req.originalUrl === "string" ? req.originalUrl.split("?")[1] : undefined;
  if (query === undefined || query.length === 0) {
    return req.path;
  }
  // the query's secret-named fields are masked by maskedHeaders/bodyPart's
  // caller only in the body; keep the path's shape and scrub its values
  const params = new URLSearchParams(query);
  for (const [name, value] of params) {
    params.set(name, isSecretName(name) ? "[redacted]" : masker.maskText(value));
  }
  return `${req.path}?${params.toString()}`;
}

function bodyPart(
  body: unknown,
  maxBytes: number,
  masker: Masker,
): { body: string; size?: number; truncated?: boolean } {
  if (body === undefined || body === null) {
    return { body: "" };
  }
  if (Buffer.isBuffer(body)) {
    // Multipart and audio bodies are bytes; a JSON or SSE reply is text.
    const text = body.toString("utf8");
    if (text.includes("\u0000")) {
      return { body: `<binary ${body.length} bytes>`, size: body.length };
    }
    const masked = maskedText(text, masker);
    const cut = masked.slice(0, maxBytes);
    return {
      body: cut,
      size: Buffer.byteLength(masked),
      ...(cut.length < masked.length ? { truncated: true } : {}),
    };
  }
  const text = typeof body === "string" ? body : safeStringify(body);
  const masked = maskedText(text, masker);
  const cut = masked.slice(0, maxBytes);
  return {
    body: cut,
    size: Buffer.byteLength(masked),
    ...(cut.length < masked.length ? { truncated: true } : {}),
  };
}

function maskedText(text: string, masker: Masker): string {
  const parsed = tryJson(text);
  if (parsed !== undefined) {
    return safeStringify(masker.maskValueWithHits(parsed).value);
  }
  return masker.maskText(text);
}

function wireRecords(res: Response, masker: Masker): { upstream?: WireRecord[] } {
  const locals = res.locals as Record<string, unknown>;
  const log = Array.isArray(locals.archiveWire) ? locals.archiveWire : [];
  const upstream = log.filter(isWire).map((wire) => {
    const record: WireRecord = {
      method: wire.method,
      url: maskedUrl(wire.url, masker),
      request: maskedHeaders(wire.request, masker),
      status: wire.status,
      response: maskedHeaders(wire.response, masker),
      millis: wire.millis,
    };
    if (typeof wire.error === "string") {
      record.error = masker.maskText(wire.error);
    }
    return record;
  });
  return upstream.length === 0 ? {} : { upstream };
}

function isWire(value: unknown): value is {
  method: string;
  url: string;
  request: Record<string, string>;
  status: number;
  response: Record<string, string>;
  millis: number;
  error?: string;
} {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    typeof value.url === "string" &&
    isRecord(value.request) &&
    isRecord(value.response) &&
    typeof value.status === "number" &&
    typeof value.millis === "number"
  );
}

/** An upstream address with its password and secret-named query values gone. */
function maskedUrl(url: string, masker: Masker): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    for (const [name, value] of parsed.searchParams) {
      parsed.searchParams.set(name, isSecretName(name) ? "[redacted]" : masker.maskText(value));
    }
    return parsed.toString();
  } catch {
    return masker.maskText(url);
  }
}

function maskedHeaders(headers: Record<string, unknown>, masker: Masker): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    out[name] = values.map((entry) => (isSecretName(name) ? "[redacted]" : masker.maskText(entry)));
  }
  return out;
}

function isSecretName(name: string): boolean {
  return (
    /^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(name) ||
    /(^|[-_])(api[-_]?key|key|token|secret|password)$/i.test(name)
  );
}

function tryJson(text: string): unknown {
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
