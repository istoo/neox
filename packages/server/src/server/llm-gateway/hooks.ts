import vm from "node:vm";
import type { Logger } from "pino";
import type { GatewayConfig, GatewayHooks } from "./config.js";
import type { IrEvent } from "./ir.js";
import { runGatewayMiddlewareEvent } from "./plugin-upstream.js";

const TIMEOUT_MS = 250;

/** What an event hook is told about the reply it belongs to. */
export interface EventHookContext {
  /** The client call, shared with the request's other plugin hooks. */
  requestKey?: string;
  providerId: string;
  model: string;
  accountId: string;
}

/** Sources are stable across requests, so compiled scripts outlive a config revision. */
const compileCache = new Map<string, vm.Script | null>();

export interface HookRejection {
  status: number;
  message: string;
}

export interface RequestHookContext {
  body: Record<string, unknown>;
  model: string;
}

export interface ProviderHookContext {
  body: Record<string, unknown>;
  provider: string;
  account: string | null;
  model: string;
}

export interface AccountHookContext {
  provider: string;
  account: string;
  model: string;
}

interface HookResult {
  reject?: { status?: unknown; message?: unknown };
  skip?: unknown;
}

/**
 * Runs the JavaScript hooks from `middleware.hooks`. They are trusted local
 * code from gateway.json, the same trust level as a Neolix plugin: `node:vm`
 * bounds runtime, not capabilities. Every failure keeps the request as it was.
 */
export class HookRuntime {
  private readonly hooks: GatewayHooks | undefined;
  private readonly logger: Logger;

  constructor(config: GatewayConfig, logger: Logger) {
    this.hooks = config.middleware?.hooks;
    this.logger = logger;
  }

  public hasEventHook(): boolean {
    return this.hooks?.event !== undefined;
  }

  public runRequest(context: RequestHookContext): HookRejection | null {
    const result = this.run(this.hooks?.request, context);
    if (result === null || result.reject === undefined) {
      return null;
    }
    return {
      status: typeof result.reject.status === "number" ? result.reject.status : 403,
      message:
        typeof result.reject.message === "string"
          ? result.reject.message
          : "Rejected by gateway hook",
    };
  }

  public runProvider(context: ProviderHookContext): void {
    this.run(this.hooks?.provider, context);
  }

  /** Replaces a JSON response body; null keeps the original. */
  public runResponse(context: {
    body: Record<string, unknown>;
    status: number;
  }): Record<string, unknown> | null {
    const result = this.run(this.hooks?.response, context);
    if (result === null) {
      return null;
    }
    const candidate = (result as Record<string, unknown>).body;
    return isRecord(candidate) ? candidate : null;
  }

  /** Replaces one streamed event; null drops it, the event itself keeps it. */
  public async runEvent(event: IrEvent, context: EventHookContext): Promise<IrEvent | null> {
    const configured = this.run(this.hooks?.event, { event });
    if (configured !== null && (configured as Record<string, unknown>).drop === true) {
      return null;
    }
    let current = event;
    if (configured !== null) {
      const candidate = (configured as Record<string, unknown>).event;
      if (candidate === null) {
        return null;
      }
      if (isRecord(candidate) && typeof candidate.type === "string") {
        current = candidate as unknown as IrEvent;
      }
    }
    const hooked = await runGatewayMiddlewareEvent({ ...context, event: current });
    if (hooked === "drop") {
      return null;
    }
    if (hooked === null) {
      return current;
    }
    if (isRecord(hooked.event) && typeof hooked.event.type === "string") {
      return hooked.event as unknown as IrEvent;
    }
    return current;
  }

  /** True means "do not use this account for this attempt". */
  public runAccount(context: AccountHookContext): boolean {
    const result = this.run(this.hooks?.account, context);
    return result !== null && result.skip === true;
  }

  private run(source: string | undefined, context: object): HookResult | null {
    const script = this.compile(source);
    if (script === null) {
      return null;
    }
    try {
      const sandbox = { ctx: context };
      const value: unknown = script.runInNewContext(sandbox, { timeout: TIMEOUT_MS });
      if (typeof value === "object" && value !== null) {
        return value as HookResult;
      }
      return null;
    } catch (error) {
      this.logger.warn({ err: error }, "Gateway middleware hook failed; request kept as is");
      return null;
    }
  }

  private compile(source: string | undefined): vm.Script | null {
    if (source === undefined || source.trim().length === 0) {
      return null;
    }
    const cached = compileCache.get(source);
    if (cached !== undefined) {
      return cached;
    }
    let script: vm.Script | null = null;
    try {
      script = new vm.Script(`(function(ctx){${source}\n})(ctx)`);
    } catch (error) {
      this.logger.warn({ err: error }, "Gateway middleware hook does not compile; ignored");
    }
    compileCache.set(source, script);
    return script;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
