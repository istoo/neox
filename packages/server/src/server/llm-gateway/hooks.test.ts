import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "./config.js";
import { HookRuntime } from "./hooks.js";
import { setGatewayMiddlewareRunner, type GatewayMiddlewareRunner } from "./plugin-upstream.js";

const logger = pino({ level: "silent" });
const releases: Array<() => void> = [];

function config(event: string | undefined): GatewayConfig {
  return {
    version: 1,
    keys: [],
    providers: [],
    ...(event === undefined ? {} : { middleware: { hooks: { event } } }),
  } as unknown as GatewayConfig;
}

function runner(event: GatewayMiddlewareRunner["event"]): GatewayMiddlewareRunner {
  return {
    active: () => true,
    hasHook: () => true,
    request: async () => null,
    response: async () => null,
    provider: async () => null,
    account: async () => false,
    event,
  };
}

const context = { providerId: "qoder", model: "m1", accountId: "a1" };

afterEach(() => {
  for (const release of releases.splice(0)) release();
});

describe("event hooks", () => {
  it("rewrites an event with the configured hook", async () => {
    const hooks = new HookRuntime(
      config("return { event: { ...ctx.event, text: ctx.event.text + '!' } }"),
      logger,
    );
    await expect(
      hooks.runEvent({ type: "text_delta", text: "hi" } as never, context),
    ).resolves.toEqual({ type: "text_delta", text: "hi!" });
  });

  it("drops an event either hook says to", async () => {
    const configured = new HookRuntime(config("return { event: null }"), logger);
    await expect(
      configured.runEvent({ type: "text_delta", text: "hi" } as never, context),
    ).resolves.toBeNull();
    const marked = new HookRuntime(config("return { drop: true }"), logger);
    await expect(
      marked.runEvent({ type: "text_delta", text: "hi" } as never, context),
    ).resolves.toBeNull();
    releases.push(
      setGatewayMiddlewareRunner(
        runner(async () => {
          return "drop";
        }),
      ),
    );
    const plugin = new HookRuntime(config(undefined), logger);
    await expect(
      plugin.runEvent({ type: "text_delta", text: "hi" } as never, context),
    ).resolves.toBeNull();
  });

  it("gives the plugin hook the configured hook's event", async () => {
    const seen: unknown[] = [];
    releases.push(
      setGatewayMiddlewareRunner(
        runner(async (input) => {
          seen.push(input.event);
          return { event: { ...(input.event as object), hooked: true } };
        }),
      ),
    );
    const hooks = new HookRuntime(
      config("return { event: { ...ctx.event, text: ctx.event.text + '!' } }"),
      logger,
    );
    await expect(
      hooks.runEvent({ type: "text_delta", text: "hi" } as never, context),
    ).resolves.toEqual({ type: "text_delta", text: "hi!", hooked: true });
    expect(seen).toEqual([{ type: "text_delta", text: "hi!" }]);
  });
});
