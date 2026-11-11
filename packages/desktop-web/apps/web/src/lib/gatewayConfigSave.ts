// The gateway config is one daemon document that several surfaces edit (Settings › Gateway,
// the host panels for network/privacy/observability, the quick panel window). Every save
// writes the whole document, so a save built from an older snapshot would silently revert
// what another surface saved in between. Saves therefore re-read the latest document and
// apply only the top-level fields this edit changed.
import type { GatewayConfig, GatewayConfigResult } from "./gatewayTypes";
import { neolixGatewayApi } from "./neolixGatewayApi";

/** The single query cache for the gateway config; every surface reads and writes it. */
export const GATEWAY_QUERY_KEY = ["neolix-gateway", "config"] as const;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Apply the top-level fields that differ between `base` (the snapshot the edit started
 * from) and `next` (the edited copy) onto `latest`. Fields the edit did not touch keep
 * their latest value.
 */
// debt: 顶层字段粒度——两处同时改同一个顶层字段（如 providers）时后保存者整体胜出；
// 需要更细时改成按 provider/group id 的结构化合并，或由 daemon 提供带版本号的 patch 接口。
export function rebaseGatewayConfig<T extends object>(base: T, next: T, latest: T): T {
  const before = base as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...(latest as Record<string, unknown>) };
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (sameValue(before[key], after[key])) continue;
    if (after[key] === undefined) delete merged[key];
    else merged[key] = after[key];
  }
  return merged as T;
}

export async function saveGatewayConfig(
  base: GatewayConfig,
  next: GatewayConfig,
): Promise<GatewayConfigResult> {
  const latest = await neolixGatewayApi.getConfig();
  return neolixGatewayApi.setConfig(rebaseGatewayConfig(base, next, latest.config));
}
