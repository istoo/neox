import { describe, expect, it } from "vitest";
import { isHeaderRowHovered } from "@/components/sidebar/sidebar-header-row";

describe("isHeaderRowHovered", () => {
  it("keeps the row lit while the pointer crosses from the button to its trailing slot", () => {
    expect(isHeaderRowHovered(true, true)).toBe(true);
  });

  it("stays lit while either surface holds the pointer", () => {
    expect(isHeaderRowHovered(true, false)).toBe(true);
    expect(isHeaderRowHovered(false, true)).toBe(true);
  });

  it("goes dark only when both surfaces have lost the pointer", () => {
    expect(isHeaderRowHovered(false, false)).toBe(false);
  });
});
