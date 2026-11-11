import { isGatewayPath } from "./cors.js";

/**
 * The paths the gateway router answers, so its middleware can be kept off
 * the daemon's own routes.
 *
 * myna serves the gateway on a port of its own; Neolix mounts it beside the
 * daemon's routes on one port. Without this gate the gateway's allow list and
 * key check judge every request the daemon receives — the Neolix app's API,
 * its pairing and authentication chain — so LAN sharing would ask a gateway
 * key of the app itself. The gateway judges only gateway calls.
 */

const CLAUDE_MCP_PREFIX = "/_neolix/claude-mcp";

export function isGatewayRequestPath(pathname: string): boolean {
  if (pathname === CLAUDE_MCP_PREFIX || pathname.startsWith(`${CLAUDE_MCP_PREFIX}/`)) {
    return true;
  }
  return isGatewayPath(pathname);
}
