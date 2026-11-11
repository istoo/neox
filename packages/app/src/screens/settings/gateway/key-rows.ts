import { useMemo, useRef } from "react";
import type { GatewayKeyWire } from "@neolix/protocol/gateway";
import { reconcileRowKeys, type RowKeySlot } from "./row-identity";

function keyValue(entry: GatewayKeyWire): string {
  return typeof entry === "string" ? entry : entry.key;
}

/**
 * The Keys list's row identities. A key's value is editable, so it cannot
 * key the row: every keystroke would change the key, remount the card, and
 * drop the input's focus. Reconciliation keeps a row's key while its value is
 * typed, follows it across a reorder, and keeps the remaining rows' keys when
 * one is removed.
 */
export function gatewayKeyRowKeys(
  previous: readonly RowKeySlot[],
  entries: readonly GatewayKeyWire[],
  makeKey: () => string,
): string[] {
  return reconcileRowKeys(
    previous,
    entries.map((entry) => ({ id: keyValue(entry) })),
    makeKey,
  );
}

export function useGatewayKeyRowKeys(entries: readonly GatewayKeyWire[]): string[] {
  const previous = useRef<RowKeySlot[]>([]);
  const seed = useRef(0);
  return useMemo(() => {
    const ids = entries.map(keyValue);
    const keys = gatewayKeyRowKeys(
      previous.current,
      entries,
      () => `gateway-key-row-${seed.current++}`,
    );
    previous.current = ids.map((id, index) => ({ id, key: keys[index] ?? id }));
    return keys;
  }, [entries]);
}
