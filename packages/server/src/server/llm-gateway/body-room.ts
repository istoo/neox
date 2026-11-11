import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { RequestHandler } from "express";
import type { Logger } from "pino";

/**
 * Bounds the decoded request bytes the gateway serves at once (myna's
 * body_room.go). One request's own limit bounds no sum: several Codex turns
 * with inline screenshots, side by side, hold several times their size. A
 * body of BODY_ROOM_FREE or more takes room for its size until its request
 * ends; with too little left it waits its turn, first come first served, and
 * is answered 503 when none ends in time. A body bigger than the whole room
 * runs alone.
 *
 * debt: Node sees the machine's memory, not a container's limit (myna reads
 * the cgroup). Where the daemon runs in a small container, the room is the
 * host's thirty-second rather than the container's.
 */

export const BODY_ROOM_FREE = 1 << 20;
export const BODY_ROOM_WAIT_MS = 100_000;
export const BODY_ROOM_FLOOR = 64 << 20;

export interface RoomSize {
  bytes: number;
  why: string;
}

/**
 * A thirty-second of the memory this process may use, at least
 * BODY_ROOM_FLOOR. In a container that is the cgroup's limit, not the
 * computer's memory: the daemon would otherwise budget several times what
 * it may hold (myna reads the same files).
 */
export function defaultRoomSize(): RoomSize {
  const total = totalmem();
  const cgroup = cgroupLimit();
  const use = cgroup === null ? total : Math.min(total, cgroup);
  const bytes = Math.max(Math.floor(use / 32), BODY_ROOM_FLOOR);
  const why =
    cgroup === null
      ? `a thirty-second of ${mib(total)} MiB (the computer's memory)`
      : `a thirty-second of ${mib(cgroup)} MiB (the container's memory limit)`;
  return { bytes, why };
}

function mib(bytes: number): number {
  return Math.floor(bytes / (1 << 20));
}

/**
 * The cgroup's memory limit, or null when it names none. cgroup v2 writes
 * memory.max ("max" for none), v1 memory.limit_in_bytes (an enormous
 * number for none). Read once, before the first body: a few bytes.
 */
function cgroupLimit(): number | null {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      continue;
    }
    if (text.length === 0 || text === "max") {
      continue;
    }
    const bytes = Number(text);
    if (Number.isSafeInteger(bytes) && bytes > 0) {
      return bytes;
    }
  }
  return null;
}

export class BodyRoomFull extends Error {
  constructor(
    public readonly bytes: number,
    public readonly held: number,
    public readonly room: number,
    public readonly why: string,
    public readonly waitedMs: number,
  ) {
    super(
      `Neox is serving ${Math.floor(held / (1 << 20))} MiB of request bodies at once, as much as it holds ` +
        `(${Math.floor(room / (1 << 20))} MiB, ${why}), and none of them ended within ` +
        `${Math.round(waitedMs / 1000)}s to make room for this ${Math.floor(bytes / (1 << 20))} MiB one; ` +
        "the provider was not asked",
    );
  }
}

interface Waiter {
  id: string;
  bytes: number;
  signal?: AbortSignal | undefined;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  onAbort?: (() => void) | undefined;
}

export class BodyRoom {
  private held = 0;
  private readonly by = new Map<string, number>();
  private readonly queue: Waiter[] = [];
  private size: RoomSize | null = null;

  constructor(
    private readonly sizeOf: () => RoomSize = defaultRoomSize,
    private readonly waitMs = BODY_ROOM_WAIT_MS,
  ) {}

  /** The room in force, read once. */
  public limits(): RoomSize {
    this.size ??= this.sizeOf();
    return this.size;
  }

  public heldBytes(): number {
    return this.held;
  }

  public waiting(): number {
    return this.queue.length;
  }

  /**
   * Holds room for `bytes` for the request `id` until `release`. Rejects with
   * BodyRoomFull when no room frees in time, or with the signal's reason when
   * the client went while waiting.
   */
  public take(id: string, bytes: number, signal?: AbortSignal): Promise<void> {
    if (bytes < BODY_ROOM_FREE) {
      return Promise.resolve();
    }
    const room = this.limits();
    if (room.bytes <= 0 || this.by.has(id)) {
      return Promise.resolve();
    }
    if (this.held === 0 || this.held + bytes <= room.bytes) {
      this.hold(id, bytes);
      return Promise.resolve();
    }
    const started = Date.now();
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        id,
        bytes,
        signal,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drop(waiter);
          reject(new BodyRoomFull(bytes, this.held, room.bytes, room.why, Date.now() - started));
        }, this.waitMs),
      };
      waiter.timer.unref();
      if (signal !== undefined) {
        waiter.onAbort = () => {
          this.drop(waiter);
          reject(signal.reason ?? new Error("request ended"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** Gives back what the request `id` held. */
  public release(id: string): void {
    const bytes = this.by.get(id);
    if (bytes === undefined) {
      return;
    }
    this.by.delete(id);
    this.held -= bytes;
    this.letIn();
  }

  private hold(id: string, bytes: number): void {
    this.by.set(id, bytes);
    this.held += bytes;
  }

  private drop(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    const index = this.queue.indexOf(waiter);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.letIn();
  }

  /** Lets in, in order, each waiter there is room for. */
  private letIn(): void {
    const room = this.limits().bytes;
    while (this.queue.length > 0) {
      const waiter = this.queue[0]!;
      if (this.held > 0 && this.held + waiter.bytes > room) {
        return;
      }
      this.queue.shift();
      clearTimeout(waiter.timer);
      if (waiter.onAbort !== undefined && waiter.signal !== undefined) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      this.hold(waiter.id, waiter.bytes);
      waiter.resolve();
    }
  }
}

/**
 * Reserves room for each gateway request whose Content-Length says it may
 * need some, before any parser reads it. A refused request is answered 503
 * with its body left unread.
 */
export function createBodyRoomMiddleware(room: BodyRoom, logger?: Logger): RequestHandler {
  return (req, res, next) => {
    const length = Number(req.headers["content-length"] ?? 0);
    if (!Number.isFinite(length) || length < BODY_ROOM_FREE) {
      next();
      return;
    }
    const id = randomUUID();
    const abort = new AbortController();
    const onClose = (): void => abort.abort();
    res.once("close", onClose);
    void (async () => {
      try {
        await room.take(id, length, abort.signal);
        res.once("close", () => room.release(id));
        next();
      } catch (error) {
        res.off("close", onClose);
        if (abort.signal.aborted) {
          return;
        }
        logger?.info({ err: error, bytes: length }, "Request body waited for room and was refused");
        res.setHeader("connection", "close");
        res.status(503).json({
          error: {
            message: error instanceof Error ? error.message : String(error),
            type: "service_unavailable",
          },
        });
      }
    })();
  };
}
