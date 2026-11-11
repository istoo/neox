// FILE: protocol.ts
// Purpose: Host side of the sandboxed plugin-view postMessage protocol: trust checks, request
//          parsing, and permission enforcement. Pure functions so every security rule is unit
//          testable without a browser.
// Layer: Web plugin host
// Exports: message shapes, trust checks, parsers, and capability predicates.

import type { NeolixPluginWebView } from "@synara/contracts";

/**
 * A sandboxed iframe with `allow-scripts` and no `allow-same-origin` has an opaque origin, which
 * serializes to the string "null". Anything else means the sender is not our sandbox.
 */
export const PLUGIN_IFRAME_ORIGIN = "null";

export interface PluginMessageEventLike {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

export interface PluginHostContext {
  readonly theme: "light" | "dark";
  readonly locale: string;
  readonly params: Readonly<Record<string, string>>;
  readonly pluginId: string;
  readonly viewId: string;
  readonly permissions: readonly string[];
  /** Timeline item data for a view used as a custom timeline renderer. */
  readonly data?: unknown;
}

export interface PluginInitMessage {
  readonly __neolix: true;
  readonly session: string;
  readonly type: "init";
  readonly context: PluginHostContext;
}

export interface PluginThemeMessage {
  readonly __neolix: true;
  readonly session: string;
  readonly type: "theme";
  readonly theme: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

export interface PluginResponseMessage {
  readonly __neolix: true;
  readonly session: string;
  readonly type: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export type PluginHostMessage = PluginInitMessage | PluginThemeMessage | PluginResponseMessage;

export interface PluginReadyMessage {
  readonly __neolix: true;
  readonly session: string;
  readonly type: "ready";
}

export interface PluginRequestMessage {
  readonly __neolix: true;
  readonly session: string;
  readonly type: "request";
  readonly id: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface PluginResizeMessage {
  readonly __neolix: true;
  readonly session: string;
  readonly type: "resize";
  readonly height: number;
}

export type PluginFrameMessage = PluginReadyMessage | PluginRequestMessage | PluginResizeMessage;

export type PluginRequestMethod = "rpc.invoke" | "navigate.openView" | "context.get";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Trust check for every inbound message. Both the source window and the opaque origin must match
 * the iframe we created, and the per-frame session token must match the one injected into its HTML.
 * Checking all three makes a sibling frame or a same-page script unable to impersonate the plugin.
 */
export function isTrustedPluginMessage(
  event: PluginMessageEventLike,
  expectedSource: unknown,
  session: string,
): boolean {
  if (event.source !== expectedSource) return false;
  if (event.origin !== PLUGIN_IFRAME_ORIGIN) return false;
  if (!isRecord(event.data)) return false;
  if (event.data.__neolix !== true) return false;
  return event.data.session === session;
}

export function parsePluginFrameMessage(data: unknown): PluginFrameMessage | null {
  if (!isRecord(data) || data.__neolix !== true || typeof data.session !== "string") return null;
  if (data.type === "ready") return data as unknown as PluginReadyMessage;
  if (data.type === "resize") {
    if (typeof data.height !== "number" || !Number.isFinite(data.height)) return null;
    return data as unknown as PluginResizeMessage;
  }
  if (data.type === "request") {
    if (typeof data.id !== "string" || !data.id) return null;
    if (typeof data.method !== "string" || !data.method) return null;
    return data as unknown as PluginRequestMessage;
  }
  return null;
}

/** `rpc.invoke` requires both the manifest permission and an explicit method allowlist. */
export function isAllowedPluginRequest(
  view: NeolixPluginWebView,
  request: PluginRequestMessage,
  availableViewIds: ReadonlySet<string>,
): boolean {
  if (request.method === "context.get") return true;
  if (request.method === "rpc.invoke") {
    if (!view.permissions?.includes("rpc")) return false;
    const params = request.params;
    if (!isRecord(params) || typeof params.method !== "string") return false;
    return (view.rpcs ?? []).includes(params.method);
  }
  if (request.method === "navigate.openView") {
    if (!view.permissions?.includes("navigate")) return false;
    const params = request.params;
    if (!isRecord(params) || typeof params.view !== "string") return false;
    return availableViewIds.has(params.view);
  }
  return false;
}

export function canResizePluginView(view: NeolixPluginWebView): boolean {
  return view.permissions?.includes("resize") === true;
}

export function createPluginViewSession(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  // Non-cryptographic fallback for environments without Web Crypto; the token is an extra check
  // layered on source/origin validation, not the only one.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export function requestTimeoutError(method: string, timeoutMs: number): string {
  return `Plugin request "${method}" timed out after ${timeoutMs}ms`;
}
