import { describe, expect, it } from "vitest";

import { getNeolixToolLeafName, isNeolixToolName } from "@neolix/protocol/tool-name-normalization";

describe("isNeolixToolName", () => {
  it("detects Claude Code format", () => {
    expect(isNeolixToolName("mcp__neox__create_agent")).toBe(true);
    expect(isNeolixToolName("mcp__neox__list_agents")).toBe(true);
  });

  it("detects neox_voice variant", () => {
    expect(isNeolixToolName("mcp__neox_voice__create_agent")).toBe(true);
    expect(isNeolixToolName("neox_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isNeolixToolName("mcp__neox_voice__speak")).toBe(false);
    expect(isNeolixToolName("mcp__neox__speak")).toBe(false);
    expect(isNeolixToolName("neox.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isNeolixToolName("neox.create_agent")).toBe(true);
  });

  it("rejects non-neolix tools", () => {
    expect(isNeolixToolName("Bash")).toBe(false);
    expect(isNeolixToolName("Read")).toBe(false);
    expect(isNeolixToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getNeolixToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getNeolixToolLeafName("mcp__neox__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getNeolixToolLeafName("neox.create_agent")).toBe("create_agent");
    expect(getNeolixToolLeafName("neox.list_agents")).toBe("list_agents");
  });

  it("returns null for non-neolix tools", () => {
    expect(getNeolixToolLeafName("Bash")).toBeNull();
  });
});
