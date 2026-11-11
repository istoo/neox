import { rm } from "node:fs/promises";
import type { Logger } from "pino";
import {
  GUARD_TOTAL_SIZE,
  downloadGuard,
  guardDirectory,
  guardInstalled,
  guardRoot,
} from "./guard-download.js";
import { GUARD_LABEL_KINDS, GUARD_MIN_SCORE, GuardModel, type GuardSpan } from "./guard-model.js";

/** How long the model stays loaded with no request (myna's idleAfter). */
const IDLE_AFTER_MS = 10 * 60_000;
/** The first failure holds requests back for this long (myna's retryAfter). */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

export const GUARD_MODEL_ID = "astrlink-guard";

/** What Settings → Masking shows of the local model. */
export interface GuardStatus {
  model: string;
  supported: boolean;
  installed: boolean;
  size: number;
  downloading: boolean;
  done: number;
  total: number;
  error?: string;
  running: boolean;
  device?: string;
  loadMs?: number;
  failed?: string;
  score: number;
}

/** What the local model found in a text, as masking's kinds. */
export interface GuardFound {
  start: number;
  end: number;
  label: string;
  kind: string;
  score: number;
}

/** The model couldn't read a request: masking holds it back. */
export class GuardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardUnavailableError";
  }
}

/** The model isn't downloaded; masking goes on with the rules alone. */
export class GuardNotInstalledError extends GuardUnavailableError {
  constructor() {
    super(
      "the local masking model isn't downloaded; download it again in Settings → Model gateway → Masking, or turn it off",
    );
    this.name = "GuardNotInstalledError";
  }
}

/** AstrLink Guard's files run here: darwin, linux and windows, x64 or arm64. */
export function guardSupportedHere(): boolean {
  const platform = process.platform;
  return (
    (platform === "darwin" || platform === "linux" || platform === "win32") &&
    (process.arch === "arm64" || process.arch === "x64")
  );
}

/** 30s, doubled for each failure in a row, 10 minutes at most. */
export function guardRetryAfter(failures: number): number {
  let delay = RETRY_BASE_MS;
  for (let index = 1; index < failures && delay < RETRY_MAX_MS; index += 1) {
    delay *= 2;
  }
  return Math.min(delay, RETRY_MAX_MS);
}

interface GuardServiceOptions {
  neolixHome: string;
  logger: Logger;
  /** The threshold the user set; 0.8 when none (status only). */
  score?: () => number;
}

/**
 * AstrLink Guard as Settings → Masking runs it: the files under
 * `$NEOLIX_HOME/cache/astrlink-guard`, loaded on the first request that
 * needs them and let go after ten minutes with none. Nothing is
 * downloaded at start; the settings page's download is the only call.
 */
export class GuardService {
  private readonly neolixHome: string;
  private readonly logger: Logger;
  private readonly scoreOf: () => number;
  private model: GuardModel | null = null;
  private loading: Promise<GuardModel> | null = null;
  private running = false;
  private loadMs: number | undefined;
  private failed: string | undefined;
  private lastError: Error | null = null;
  private failures = 0;
  private retryAt = 0;
  private active = 0;
  private idle: NodeJS.Timeout | null = null;
  private controller: AbortController | null = null;
  private done = 0;
  private error: string | undefined;
  private unsupported = false;

  constructor(options: GuardServiceOptions) {
    this.neolixHome = options.neolixHome;
    this.logger = options.logger;
    this.scoreOf = options.score ?? (() => GUARD_MIN_SCORE);
  }

  public async status(): Promise<GuardStatus> {
    return {
      model: GUARD_MODEL_ID,
      supported: guardSupportedHere() && !this.unsupported,
      installed: await guardInstalled(this.neolixHome),
      size: GUARD_TOTAL_SIZE,
      downloading: this.controller !== null,
      done: this.done,
      total: GUARD_TOTAL_SIZE,
      ...(this.error === undefined ? {} : { error: this.error }),
      running: this.running,
      ...(this.running ? { device: "CPU" } : {}),
      ...(this.loadMs === undefined ? {} : { loadMs: this.loadMs }),
      ...(this.failed === undefined ? {} : { failed: this.failed }),
      score: this.scoreOf(),
    };
  }

  /** Downloads the files in the background; the status says how far it got. */
  public startDownload(): void {
    if (this.controller !== null) {
      return;
    }
    if (!guardSupportedHere()) {
      this.error = `the local masking model doesn't run on ${process.platform}-${process.arch} yet`;
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.error = undefined;
    this.done = 0;
    void downloadGuard({
      neolixHome: this.neolixHome,
      signal: controller.signal,
      onProgress: (done) => {
        this.done = done;
      },
    })
      .then(() => {
        this.done = GUARD_TOTAL_SIZE;
        this.error = undefined;
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          this.error = cause instanceof Error ? cause.message : String(cause);
          this.logger.warn({ err: cause }, "Cannot download the local masking model");
        }
      })
      .finally(() => {
        this.controller = null;
      });
  }

  public cancelDownload(): void {
    if (this.controller === null) {
      return;
    }
    this.controller.abort();
    this.controller = null;
  }

  /** Stops the model and deletes its files. */
  public async remove(): Promise<void> {
    this.cancelDownload();
    await this.unload();
    this.error = undefined;
    this.done = 0;
    this.lastError = null;
    this.failures = 0;
    this.retryAt = 0;
    this.failed = undefined;
    await rm(guardRoot(this.neolixHome), { recursive: true, force: true });
  }

  /** Whether every file is on disk at its pinned size. */
  public installed(): Promise<boolean> {
    return guardInstalled(this.neolixHome);
  }

  /** Loads the model, unless it is loaded or a load is under way. */
  public async ensureLoaded(): Promise<GuardModel> {
    if (this.model !== null) {
      return this.model;
    }
    const loaded = await guardInstalled(this.neolixHome);
    if (!loaded) {
      throw new GuardNotInstalledError();
    }
    if (this.loading !== null) {
      return this.loading;
    }
    const started = Date.now();
    this.loading = GuardModel.load(guardDirectory(this.neolixHome))
      .then((model) => {
        this.model = model;
        this.running = true;
        this.loadMs = Date.now() - started;
        return model;
      })
      .catch((cause: unknown) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        this.model = null;
        this.running = false;
        this.recordFailure(error);
        if (isUnsupportedRuntime(error)) {
          // No ONNX Runtime for this platform: the settings page says so
          // instead of offering a model that never loads.
          this.unsupported = true;
        }
        throw new GuardUnavailableError(`the local masking model didn't load: ${error.message}`);
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /**
   * What the model finds in each text. The caller masks with these and
   * leaves out the labels it doesn't mask. A read gives up before the
   * model is loaded fails the request as myna does when the model is on.
   */
  public async find(texts: readonly string[]): Promise<GuardFound[][]> {
    const heldBack = this.heldBack();
    if (heldBack !== null) {
      throw heldBack;
    }
    let model: GuardModel;
    try {
      model = await this.ensureLoaded();
    } catch (cause) {
      if (cause instanceof GuardNotInstalledError) {
        this.failed = cause.message;
        throw cause;
      }
      throw cause instanceof GuardUnavailableError
        ? cause
        : new GuardUnavailableError(String(cause));
    }
    this.active += 1;
    this.cancelIdle();
    try {
      const out: GuardFound[][] = [];
      for (const text of texts) {
        const spans: GuardSpan[] = await model.find(text);
        out.push(
          spans.map((span) => ({
            start: span.start,
            end: span.end,
            label: span.label,
            kind: GUARD_LABEL_KINDS[span.label] ?? span.label,
            score: span.score,
          })),
        );
      }
      this.recordSuccess();
      return out;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.recordFailure(error);
      throw new GuardUnavailableError(
        `the local masking model failed reading this request (${error.message})`,
      );
    } finally {
      this.active -= 1;
      this.scheduleIdle();
    }
  }

  /** Releases the model at once; a read under way finishes with it. */
  public async unload(): Promise<void> {
    this.cancelIdle();
    const model = this.model;
    this.model = null;
    this.running = false;
    this.loadMs = undefined;
    if (model !== null) {
      await model.close().catch((cause: unknown) => {
        this.logger.warn({ err: cause }, "Cannot release the local masking model");
      });
    }
  }

  /** Why a request that needs the model is held back now, myna's guardHeldBack. */
  private heldBack(): GuardUnavailableError | null {
    if (this.lastError === null || Date.now() >= this.retryAt) {
      return null;
    }
    const seconds = Math.max(1, Math.round((this.retryAt - Date.now()) / 1000));
    return new GuardUnavailableError(
      `${this.lastError.message}; it is tried again in ${seconds}s, and until then a request it hasn't read is held back at once. To send requests masked by the rules alone, turn the local model off in Settings → Model gateway → Masking`,
    );
  }

  private recordSuccess(): void {
    this.lastError = null;
    this.failures = 0;
    this.retryAt = 0;
    this.failed = undefined;
  }

  private recordFailure(error: Error): void {
    this.lastError = error;
    this.failures += 1;
    this.retryAt = Date.now() + guardRetryAfter(this.failures);
    this.failed = error.message;
    this.logger.warn(
      { err: error, failures: this.failures },
      "The local masking model failed; requests are held back until it is tried again",
    );
  }

  private scheduleIdle(): void {
    if (this.model === null || this.idle !== null) {
      return;
    }
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.active > 0) {
        this.scheduleIdle();
        return;
      }
      void this.unload();
    }, IDLE_AFTER_MS);
    this.idle.unref?.();
  }

  private cancelIdle(): void {
    if (this.idle !== null) {
      clearTimeout(this.idle);
      this.idle = null;
    }
  }
}

/** ONNX Runtime missing a binary for this platform is not a model failure. */
function isUnsupportedRuntime(error: Error): boolean {
  const message = error.message;
  return (
    message.includes("Cannot find module") ||
    message.includes("onnxruntime") ||
    message.includes("not a valid Win32 application") ||
    message.includes("wrong ELF class") ||
    message.includes("cannot open shared object file") ||
    message.includes("mach-o file")
  );
}

/** The GuardService as masking's local model, narrowed to what it needs. */
export interface LocalMaskingModel {
  installed(): Promise<boolean>;
  find(texts: readonly string[]): Promise<GuardFound[][]>;
}

export function localModelOf(service: GuardService): LocalMaskingModel {
  return {
    installed: () => service.installed(),
    find: (texts) => service.find(texts),
  };
}
