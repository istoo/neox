import { describe, expect, it } from "vitest";

import { maskAccount } from "./maskAccount";

describe("maskAccount", () => {
  it("keeps an email's first letter and domain", () => {
    expect(maskAccount("dee@example.com")).toBe("d••@example.com");
    expect(maskAccount("a.very.long.name@example.com")).toBe("a••••••@example.com");
  });

  it("keeps the first two and last two characters of other names", () => {
    expect(maskAccount("Cursor Pro Team")).toBe("Cu••••••am");
    expect(maskAccount("wavesand")).toBe("wa••••nd");
  });

  it("hides short names and the empty string completely", () => {
    expect(maskAccount("ab")).toBe("••");
    expect(maskAccount("")).toBe("••");
  });
});
