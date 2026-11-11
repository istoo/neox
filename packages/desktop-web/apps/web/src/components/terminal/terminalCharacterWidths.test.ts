import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_CHARACTER_WIDTHS,
  unicodeVersionForCharacterWidths,
} from "./terminalCharacterWidths";

describe("terminal character widths", () => {
  it("uses the grapheme table when the daemon advertises it", () => {
    expect(unicodeVersionForCharacterWidths("graphemes")).toBe("15-graphemes");
  });

  it("keeps Unicode 11 for a daemon without the feature", () => {
    expect(unicodeVersionForCharacterWidths("unicode11")).toBe("11");
  });

  it("defaults to Unicode 11 until a snapshot names a table", () => {
    expect(DEFAULT_TERMINAL_CHARACTER_WIDTHS).toBe("unicode11");
    expect(unicodeVersionForCharacterWidths(undefined)).toBe("11");
  });
});
