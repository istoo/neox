import { randomUUID } from "node:crypto";
import type { GatewayConfigStore, GatewayKey } from "./config.js";

/**
 * The key the MCP hub's agent entry sends. Neolix's gateway accepts loopback
 * without a key only while it has no keys at all; once it has some, the
 * hub gets a key of its own, labelled for the agent, as myna does.
 */
export async function ensureHubGatewayKey(
  store: GatewayConfigStore,
  agent: string,
): Promise<string | null> {
  const config = store.get();
  if (config.keys.length === 0) {
    return null;
  }
  const label = `Neox MCP hub · ${agent}`;
  for (const entry of config.keys) {
    if (typeof entry !== "string" && entry.label === label) {
      return entry.key;
    }
  }
  const key = `neolix-hub-${agent.replace(/[^a-z0-9_-]+/gi, "-")}-${randomUUID()}`;
  const entry: GatewayKey = { key, label, models: [], readOnly: false, issues: false };
  await store.write({ ...config, keys: [...config.keys, entry] });
  return key;
}
