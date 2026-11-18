// Browser automation host bridge.
//
// The daemon owns the `browser.automation.execute` request/response exchange with a
// browser host. The desktop-web bridge is that host, but it cannot execute commands
// itself: the webviews live in the renderer. These RPCs let one renderer page enlist
// as the executor (a long-lived stream) and post each result back (a unary call).
import { Schema } from "effect";

/**
 * A page announces it can drive the browser by opening this stream. The stream
 * carries request payloads the page must execute; closing it is the page's
 * unregister signal, so the daemon host is only registered while at least one
 * page is subscribed.
 */
export const BrowserAutomationHostSubscribeInput = Schema.Struct({});
export type BrowserAutomationHostSubscribeInput = typeof BrowserAutomationHostSubscribeInput.Type;

/**
 * One daemon automation request forwarded to a page. `command` stays JSON rather
 * than a decoded union because the protocol's command schema lives in
 * `@neolix/protocol`, which this front end deliberately does not depend on; the
 * Electron main process validates it before executing.
 */
export const BrowserAutomationHostRequest = Schema.Struct({
  requestId: Schema.String,
  agentId: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  workspaceId: Schema.optionalKey(Schema.String),
  command: Schema.Json,
});
export type BrowserAutomationHostRequest = typeof BrowserAutomationHostRequest.Type;

/**
 * The page's answer, posted as a unary RPC. The bridge answers `true` when the
 * request id belongs to an in-flight request, so a page can discard stale sends
 * after a reconnect.
 */
export const BrowserAutomationHostResponseInput = Schema.Struct({
  payload: Schema.Json,
});
export type BrowserAutomationHostResponseInput = typeof BrowserAutomationHostResponseInput.Type;
