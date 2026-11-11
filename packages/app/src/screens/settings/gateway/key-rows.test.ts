import { describe, expect, it } from "vitest";
import { gatewayKeyRowKeys } from "./key-rows";

function makeKeys(): () => string {
  let next = 0;
  return () => `new-${next++}`;
}

describe("gatewayKeyRowKeys", () => {
  it("keeps a row's key while its editable value is typed", () => {
    const previous = [{ id: "alpha", key: "row-alpha" }];
    const after = [{ key: "alpha-typed", models: [] }];
    expect(gatewayKeyRowKeys(previous, after, makeKeys())).toEqual(["row-alpha"]);
  });

  it("keeps the remaining row's key when an earlier key is removed", () => {
    const previous = [
      { id: "alpha", key: "row-alpha" },
      { id: "beta", key: "row-beta" },
    ];
    expect(gatewayKeyRowKeys(previous, ["beta"], makeKeys())).toEqual(["row-beta"]);
  });

  it("gives every row its own key", () => {
    const keys = gatewayKeyRowKeys(
      [],
      [{ key: "first", models: [] }, "second", { key: "third", models: [] }],
      makeKeys(),
    );
    expect(new Set(keys).size).toBe(3);
  });
});
