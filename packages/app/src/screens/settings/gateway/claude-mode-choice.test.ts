import { describe, expect, it } from "vitest";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { claudeModeChoicesDisabled, withClaudeMode } from "./claude-mode-choice";

const config: GatewayConfigWire = {
  version: 1,
  providers: [],
  groups: [],
  keys: [],
};

describe("claudeModeChoicesDisabled", () => {
  it("disables only where the page serves as the gateway", () => {
    expect(claudeModeChoicesDisabled(true)).toBe(true);
    expect(claudeModeChoicesDisabled(false)).toBe(false);
  });
});

describe("withClaudeMode", () => {
  it("writes claude -p as the print mode, and the interactive mode as off", () => {
    expect(withClaudeMode(config, "p").claudePrintMode).toBe(true);
    expect(withClaudeMode(config, "tui").claudePrintMode).toBe(false);
    expect(config.claudePrintMode).toBeUndefined();
  });

  it("keeps everything else the config holds", () => {
    const saved = withClaudeMode({ ...config, claudeWarmup: "week" }, "p");
    expect(saved.claudeWarmup).toBe("week");
    expect(saved.providers).toEqual([]);
  });
});
