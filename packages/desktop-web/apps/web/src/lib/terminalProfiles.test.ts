import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_PROFILES,
  resolveTerminalProfileLaunch,
  resolveTerminalProfileList,
} from "./terminalProfiles";

describe("terminalProfiles", () => {
  it("drops prompt-only args when the dock has no prompt to type", () => {
    expect(
      resolveTerminalProfileLaunch({
        id: "claude",
        name: "Claude",
        command: "claude",
        args: ["{{{prompt}}}"],
      }),
    ).toEqual({ name: "Claude", command: "claude", args: [] });
    expect(
      resolveTerminalProfileLaunch({
        id: "opencode",
        name: "OpenCode",
        command: "opencode",
        args: ["--prompt={{{prompt}}}", "--verbose"],
      }),
    ).toEqual({ name: "OpenCode", command: "opencode", args: ["--verbose"] });
  });

  it("keeps a profile's own arguments", () => {
    expect(
      resolveTerminalProfileLaunch({
        id: "custom",
        name: "Custom",
        command: "zsh",
        args: ["-l"],
      }),
    ).toEqual({ name: "Custom", command: "zsh", args: ["-l"] });
  });

  it("uses the daemon built-ins until the host saves its own list", () => {
    expect(resolveTerminalProfileList(undefined)).toBe(DEFAULT_TERMINAL_PROFILES);
    const saved = [{ id: "saved", name: "Saved", command: "bash" }];
    expect(resolveTerminalProfileList(saved)).toBe(saved);
  });
});
