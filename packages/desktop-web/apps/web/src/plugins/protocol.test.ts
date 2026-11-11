import { describe, expect, it } from "vitest";

import type { NeolixPluginWebView } from "@synara/contracts";

import {
  PLUGIN_IFRAME_ORIGIN,
  canResizePluginView,
  createPluginViewSession,
  isAllowedPluginRequest,
  isTrustedPluginMessage,
  parsePluginFrameMessage,
  type PluginMessageEventLike,
} from "./protocol";

const SESSION = "session-1";
const FRAME = { marker: "frame" };
const OTHER_FRAME = { marker: "other" };

function event(overrides: Partial<PluginMessageEventLike> = {}): PluginMessageEventLike {
  return {
    source: FRAME,
    origin: PLUGIN_IFRAME_ORIGIN,
    data: { __neolix: true, session: SESSION, type: "ready" },
    ...overrides,
  };
}

const view: NeolixPluginWebView = {
  id: "main",
  title: "Main",
  entry: "web/main.html",
  permissions: ["rpc", "navigate", "resize"],
  rpcs: ["greet"],
};

describe("plugin view message trust", () => {
  it("accepts only the created frame, the opaque origin, and the injected session", () => {
    expect(isTrustedPluginMessage(event(), FRAME, SESSION)).toBe(true);
  });

  it("rejects a sibling frame with the same message", () => {
    expect(isTrustedPluginMessage(event({ source: OTHER_FRAME }), FRAME, SESSION)).toBe(false);
  });

  it("rejects a same-page script that guesses the session but keeps the host origin", () => {
    expect(isTrustedPluginMessage(event({ origin: "https://app.example" }), FRAME, SESSION)).toBe(
      false,
    );
  });

  it("rejects a frame that does not know the session token", () => {
    expect(
      isTrustedPluginMessage(
        event({ data: { __neolix: true, session: "guess", type: "ready" } }),
        FRAME,
        SESSION,
      ),
    ).toBe(false);
  });

  it("rejects messages without the protocol marker", () => {
    expect(isTrustedPluginMessage(event({ data: { type: "ready" } }), FRAME, SESSION)).toBe(false);
    expect(isTrustedPluginMessage(event({ data: null }), FRAME, SESSION)).toBe(false);
  });
});

describe("plugin frame message parsing", () => {
  it("parses ready, resize, and request messages", () => {
    expect(
      parsePluginFrameMessage({ __neolix: true, session: SESSION, type: "ready" }),
    ).toMatchObject({
      type: "ready",
    });
    expect(
      parsePluginFrameMessage({ __neolix: true, session: SESSION, type: "resize", height: 240 }),
    ).toMatchObject({ type: "resize", height: 240 });
    expect(
      parsePluginFrameMessage({
        __neolix: true,
        session: SESSION,
        type: "request",
        id: "r1",
        method: "rpc.invoke",
        params: { method: "greet" },
      }),
    ).toMatchObject({ type: "request", id: "r1", method: "rpc.invoke" });
  });

  it("rejects requests without an id or method and non-finite heights", () => {
    expect(
      parsePluginFrameMessage({
        __neolix: true,
        session: SESSION,
        type: "request",
        id: "",
        method: "x",
      }),
    ).toBeNull();
    expect(
      parsePluginFrameMessage({
        __neolix: true,
        session: SESSION,
        type: "request",
        id: "r1",
        method: "",
      }),
    ).toBeNull();
    expect(
      parsePluginFrameMessage({
        __neolix: true,
        session: SESSION,
        type: "resize",
        height: Number.NaN,
      }),
    ).toBeNull();
  });
});

describe("plugin view permissions", () => {
  const viewIds = new Set(["main", "secondary"]);

  it("allows context.get without a permission", () => {
    expect(
      isAllowedPluginRequest(
        { id: "main", title: "Main", entry: "web/main.html" },
        { __neolix: true, session: SESSION, type: "request", id: "r1", method: "context.get" },
        viewIds,
      ),
    ).toBe(true);
  });

  it("requires the rpc permission and an explicit method allowlist", () => {
    expect(
      isAllowedPluginRequest(
        view,
        {
          __neolix: true,
          session: SESSION,
          type: "request",
          id: "r1",
          method: "rpc.invoke",
          params: { method: "greet" },
        },
        viewIds,
      ),
    ).toBe(true);
    expect(
      isAllowedPluginRequest(
        view,
        {
          __neolix: true,
          session: SESSION,
          type: "request",
          id: "r1",
          method: "rpc.invoke",
          params: { method: "deleteEverything" },
        },
        viewIds,
      ),
    ).toBe(false);
    expect(
      isAllowedPluginRequest(
        { ...view, permissions: [] },
        {
          __neolix: true,
          session: SESSION,
          type: "request",
          id: "r1",
          method: "rpc.invoke",
          params: { method: "greet" },
        },
        viewIds,
      ),
    ).toBe(false);
  });

  it("limits navigation to views declared by the same plugin", () => {
    expect(
      isAllowedPluginRequest(
        view,
        {
          __neolix: true,
          session: SESSION,
          type: "request",
          id: "r1",
          method: "navigate.openView",
          params: { view: "secondary" },
        },
        viewIds,
      ),
    ).toBe(true);
    expect(
      isAllowedPluginRequest(
        view,
        {
          __neolix: true,
          session: SESSION,
          type: "request",
          id: "r1",
          method: "navigate.openView",
          params: { view: "other-plugin" },
        },
        viewIds,
      ),
    ).toBe(false);
    expect(
      isAllowedPluginRequest(
        { ...view, permissions: ["rpc"] },
        {
          __neolix: true,
          session: SESSION,
          type: "request",
          id: "r1",
          method: "navigate.openView",
          params: { view: "secondary" },
        },
        viewIds,
      ),
    ).toBe(false);
  });

  it("rejects unknown methods and requires the resize permission", () => {
    expect(
      isAllowedPluginRequest(
        view,
        { __neolix: true, session: SESSION, type: "request", id: "r1", method: "window.open" },
        viewIds,
      ),
    ).toBe(false);
    expect(canResizePluginView(view)).toBe(true);
    expect(canResizePluginView({ ...view, permissions: [] })).toBe(false);
  });
});

describe("plugin view sessions", () => {
  it("generates a fresh session per view", () => {
    expect(createPluginViewSession()).not.toBe(createPluginViewSession());
  });
});
