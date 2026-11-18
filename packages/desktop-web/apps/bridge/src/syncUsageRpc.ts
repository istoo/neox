// The daemon's shared-usage report (`sync.usage.get`) as the web Usage page reads it.
// Every computer's days, calls and merged quota history arrive in one answer; the bridge
// forwards the shape the contract describes and turns the daemon's soft error into a
// rejection so the page can show it instead of an empty list.
import type { NeolixSyncUsage } from "@synara/contracts";

import type { DaemonClient } from "./neolix.ts";

export async function getSyncUsage(client: DaemonClient): Promise<NeolixSyncUsage> {
  const payload = await client.getSyncUsage();
  if (payload.error !== undefined && payload.error !== "") {
    throw new Error(payload.error);
  }
  return payload;
}
