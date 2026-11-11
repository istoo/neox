export interface RowKeySlot {
  id: string;
  key: string;
}

/**
 * Row identities for an editable list whose items have no stable id of their
 * own. Keys follow slots and ids:
 *
 * - the same id at the same place keeps its key;
 * - a reorder keeps each row's key by id;
 * - an id edited in place keeps its slot's key;
 * - a new id gets a new key.
 *
 * A key changes only when the row is genuinely new or its previous id was
 * claimed by another row, so inputs inside a row are not remounted mid-edit.
 */
export function reconcileRowKeys(
  previous: readonly RowKeySlot[],
  rows: readonly { id: string }[],
  makeKey: () => string,
): string[] {
  const keys: (string | undefined)[] = rows.map((row, index) => {
    const atIndex = previous[index];
    return atIndex !== undefined && atIndex.id === row.id ? atIndex.key : undefined;
  });
  const used = new Set(keys.filter((key): key is string => key !== undefined));
  const byId = new Map(previous.map((slot) => [slot.id, slot.key]));
  const nextIds = new Set(rows.map((row) => row.id));

  rows.forEach((row, index) => {
    if (keys[index] !== undefined) {
      return;
    }
    const key = byId.get(row.id);
    if (key !== undefined && !used.has(key)) {
      keys[index] = key;
      used.add(key);
    }
  });

  rows.forEach((row, index) => {
    if (keys[index] !== undefined) {
      return;
    }
    const atIndex = previous[index];
    if (atIndex !== undefined && !nextIds.has(atIndex.id) && !used.has(atIndex.key)) {
      keys[index] = atIndex.key;
      used.add(atIndex.key);
    }
  });

  rows.forEach((row, index) => {
    if (keys[index] === undefined) {
      keys[index] = makeKey();
    }
  });

  return keys as string[];
}
