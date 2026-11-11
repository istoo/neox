/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { terminalOptions, type TerminalLabels } from "./session-terminal-row";

const labels: TerminalLabels = {
  system: (name) => `system:${name}`,
  fixed: (name) => `fixed:${name}`,
  unavailable: (id) => `unavailable:${id}`,
};

describe("the Session terminal options", () => {
  it("names the system default after the app that opens .command files", () => {
    const options = terminalOptions(
      {
        apps: [
          { id: "com.googlecode.iterm2", name: "iTerm" },
          { id: "dev.warp.Warp-Stable", name: "Warp" },
        ],
        default: "dev.warp.Warp-Stable",
      },
      "system",
      labels,
    );
    expect(options).toEqual([
      { id: "system", name: "system:Warp" },
      { id: "com.apple.Terminal", name: "Terminal" },
      { id: "com.googlecode.iterm2", name: "iTerm" },
    ]);
  });

  it("marks the system default fixed when it is chosen", () => {
    const options = terminalOptions(
      {
        apps: [
          { id: "com.apple.Terminal", name: "Terminal" },
          { id: "dev.warp.Warp-Stable", name: "Warp" },
        ],
        default: "dev.warp.Warp-Stable",
      },
      "dev.warp.Warp-Stable",
      labels,
    );
    expect(options).toEqual([
      { id: "system", name: "system:Warp" },
      { id: "com.apple.Terminal", name: "Terminal" },
      { id: "dev.warp.Warp-Stable", name: "fixed:Warp" },
    ]);
  });

  it("keeps a terminal that is no longer installed visible as unavailable", () => {
    const options = terminalOptions(
      { apps: [{ id: "com.apple.Terminal", name: "Terminal" }], default: "com.apple.Terminal" },
      "dev.warp.Warp-Stable",
      labels,
    );
    expect(options.at(-1)).toEqual({
      id: "dev.warp.Warp-Stable",
      name: "unavailable:dev.warp.Warp-Stable",
    });
  });

  it("falls back to Terminal when the system has no default", () => {
    const options = terminalOptions({ apps: [] }, "system", labels);
    expect(options).toEqual([{ id: "system", name: "system:Terminal" }]);
  });
});
