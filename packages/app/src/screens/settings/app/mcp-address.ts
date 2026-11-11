import { parseGatewayListen } from "@/screens/settings/gateway/overview-data";

/**
 * The address an agent mounts one of the gateway's own MCP servers at, as
 * myna's `mcpAddress` builds it (myna app.js:21544): the public address when
 * there is one, else where this computer's daemon listens. "" when the
 * daemon hasn't said where it listens.
 */
export function mcpAddress(
  publicUrl: string | null | undefined,
  listen: string | null | undefined,
  path: string,
): string {
  const parsed = parseGatewayListen(listen ?? null);
  const base = (publicUrl ?? "") || parsed.thisComputerUrl || parsed.networkUrl || "";
  return base === "" ? "" : `${base.replace(/\/+$/, "")}${path}`;
}
