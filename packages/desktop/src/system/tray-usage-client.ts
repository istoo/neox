import { DaemonClient } from "@neolix/client/internal/daemon-client";
import type {
  WebSocketFactory,
  WebSocketLike,
} from "@neolix/client/internal/daemon-client-transport-types";
import { WebSocket } from "ws";
import type { TrayUsageClient, TrayUsageDaemonTarget } from "./tray-usage-poller.js";

/**
 * `ws` accepts the Unix-socket URLs the daemon listens on (`ws+unix://…`),
 * which Electron's global WebSocket does not; the menu bar poller runs in the
 * main process, not a renderer, so it brings its own implementation. Windows
 * named pipes cannot be expressed in the URL, so they arrive as `socketPath`.
 */
function webSocketFactory(target: TrayUsageDaemonTarget): WebSocketFactory {
  return (url, options) =>
    new WebSocket(url, options?.protocols, {
      headers: options?.headers,
      ...(target.socketPath ? { socketPath: target.socketPath } : {}),
    }) as unknown as WebSocketLike;
}

/** A one-shot client's view of DaemonClient: quota, two usage reports, close. */
export function createDaemonTrayUsageClient(target: TrayUsageDaemonTarget): TrayUsageClient {
  const client = new DaemonClient({
    url: target.url,
    clientId: `neolix-desktop-tray-${process.pid}`,
    clientType: "browser",
    localCredential: () => target.credential ?? undefined,
    suppressSendErrors: true,
    reconnect: { enabled: false },
    connectTimeoutMs: 8_000,
    webSocketFactory: webSocketFactory(target),
  });
  return {
    getGatewayQuota: () => client.getGatewayQuota({}),
    getGatewayUsage: (query) => client.getGatewayUsage(query),
    close: () => client.close(),
  };
}
