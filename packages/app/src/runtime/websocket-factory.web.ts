import { defaultWebSocketFactory } from "@neolix/client/internal/daemon-client-websocket-transport";
import type { WebSocketFactory } from "@neolix/client/internal/daemon-client-transport-types";

export function createAppWebSocketFactory(): WebSocketFactory {
  return defaultWebSocketFactory;
}
