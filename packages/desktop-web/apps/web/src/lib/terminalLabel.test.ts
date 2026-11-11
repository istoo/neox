import { afterEach, describe, expect, it } from "vitest";

import { setLanguagePreference } from "../i18n";
import { displayTerminalLabel } from "./terminalLabel";

afterEach(() => {
  setLanguagePreference("system");
});

describe("displayTerminalLabel", () => {
  it("translates generated names and keeps names the user chose", () => {
    setLanguagePreference("zh-CN");
    expect(displayTerminalLabel("Terminal 1")).toBe("终端 1");
    expect(displayTerminalLabel("Terminal")).toBe("终端");
    expect(displayTerminalLabel("Terminal server")).toBe("Terminal server");
    expect(displayTerminalLabel("构建")).toBe("构建");
    setLanguagePreference("en");
    expect(displayTerminalLabel("Terminal 2")).toBe("Terminal 2");
  });
});
