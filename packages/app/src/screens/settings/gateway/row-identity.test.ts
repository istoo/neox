import { describe, expect, it } from "vitest";
import { reconcileRowKeys, type RowKeySlot } from "./row-identity";

function makeKeys(): () => string {
  let next = 0;
  return () => `new-${next++}`;
}

const row = (id: string) => ({ id });

describe("reconcileRowKeys", () => {
  it("keeps a row's key while its id is being typed", () => {
    const slots: RowKeySlot[] = [{ id: "main", key: "row-main" }];
    expect(reconcileRowKeys(slots, [row("main-typing")], makeKeys())).toEqual(["row-main"]);
  });

  it("follows each row across a reorder", () => {
    const slots: RowKeySlot[] = [
      { id: "main", key: "row-main" },
      { id: "backup", key: "row-backup" },
    ];
    expect(reconcileRowKeys(slots, [row("backup"), row("main")], makeKeys())).toEqual([
      "row-backup",
      "row-main",
    ]);
  });

  it("gives a newly added row a new key", () => {
    const slots: RowKeySlot[] = [{ id: "main", key: "row-main" }];
    expect(reconcileRowKeys(slots, [row("main"), row("extra")], makeKeys())).toEqual([
      "row-main",
      "new-0",
    ]);
  });

  it("keeps the remaining row's key when an earlier row is removed", () => {
    const slots: RowKeySlot[] = [
      { id: "main", key: "row-main" },
      { id: "backup", key: "row-backup" },
    ];
    expect(reconcileRowKeys(slots, [row("backup")], makeKeys())).toEqual(["row-backup"]);
  });
});
