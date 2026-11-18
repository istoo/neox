import { describe, expect, it } from "vitest";

import { resolveTerminalFocusHeartbeat } from "./useTerminalFocusHeartbeat";

const base = {
  threadId: "thread-1",
  terminalId: "terminal-1",
  terminalFocused: true,
  terminalVisible: true,
  pageVisible: true,
  windowFocused: true,
} as const;

describe("resolveTerminalFocusHeartbeat", () => {
  it("names the terminal only when it has real focus in a visible focused window", () => {
    expect(resolveTerminalFocusHeartbeat(base)).toEqual({
      threadId: "thread-1",
      terminalId: "terminal-1",
      appVisible: true,
    });
  });

  it.each([
    ["the terminal lost focus", { terminalFocused: false }, true],
    ["the terminal pane is hidden", { terminalVisible: false }, true],
    ["the page is hidden", { pageVisible: false }, false],
    ["the window lost focus", { windowFocused: false }, false],
  ] as const)("clears the terminal id when %s", (_label, patch, appVisible) => {
    expect(resolveTerminalFocusHeartbeat({ ...base, ...patch })).toEqual({
      threadId: "thread-1",
      appVisible,
    });
  });
});
