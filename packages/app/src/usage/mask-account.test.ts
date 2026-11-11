import { describe, expect, it } from "vitest";
import { maskAccount } from "./mask-account";

describe("maskAccount", () => {
  it("keeps an email's first letter and domain", () => {
    expect(maskAccount("dee@example.com")).toBe("d••@example.com");
    expect(maskAccount("a.very.long.name@example.com")).toBe("a••••••@example.com");
  });

  it("keeps the first and last two characters of any other name", () => {
    expect(maskAccount("Cursor Pro Team")).toBe("Cu••••••am");
    expect(maskAccount("wavesand")).toBe("wa••••nd");
  });

  it("hides a name too short to keep a slice of", () => {
    expect(maskAccount("ab")).toBe("••");
    expect(maskAccount("")).toBe("••");
  });
});
