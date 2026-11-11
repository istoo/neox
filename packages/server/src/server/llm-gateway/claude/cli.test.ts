import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asSandboxEnv,
  CLAUDE_DEEP_LINK_SETTINGS,
  claudeCliArgs,
  cleanClaudeEnv,
  claudeRunEnv,
  claudeWarmArgs,
  findClaudeBinary,
} from "./cli.js";

const cleanup: string[] = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("claudeCliArgs", () => {
  it("passes the headless stream-json contract", () => {
    const args = claudeCliArgs({ model: "claude-sonnet-5", mcpConfig: '{"mcpServers":{}}' });
    expect(args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--model",
      "claude-sonnet-5",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--setting-sources",
      "",
      "--settings",
      CLAUDE_DEEP_LINK_SETTINGS,
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ]);
  });

  it("offers WebSearch when the caller asked for it", () => {
    const args = claudeCliArgs({ model: "m", mcpConfig: "{}", webSearch: true });
    expect(args[args.indexOf("--tools") + 1]).toBe("WebSearch");
  });

  it("adds effort, thinking, schema, system prompt and resume only when asked", () => {
    const args = claudeCliArgs({
      model: "m",
      mcpConfig: "{}",
      effort: "xhigh",
      thinkingOff: true,
      jsonSchema: '{"type":"object"}',
      systemPromptFile: "/tmp/system.md",
      resumeSession: "session-1",
      persistSession: true,
    });
    expect(args).toContain("--effort");
    expect(args).toContain("xhigh");
    expect(args).toContain("--thinking-display");
    expect(args).toContain("summarized");
    expect(args).toContain("--thinking");
    expect(args).toContain("disabled");
    expect(args).toContain("--json-schema");
    expect(args).toContain('{"type":"object"}');
    expect(args).toContain("--system-prompt-file");
    expect(args).toContain("/tmp/system.md");
    expect(args).toContain("--resume");
    expect(args).toContain("session-1");
    expect(args).not.toContain("--no-session-persistence");
  });

  it("keeps xhigh as Claude Code's own level", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const args = claudeCliArgs({ model: "m", mcpConfig: "{}", effort: level });
      expect(args[args.indexOf("--effort") + 1]).toBe(level);
    }
  });

  it("warms up with one JSON answer and nothing kept", () => {
    expect(claudeWarmArgs("haiku")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "haiku",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--settings",
      CLAUDE_DEEP_LINK_SETTINGS,
      "--no-session-persistence",
    ]);
  });
});

describe("cleanClaudeEnv", () => {
  it("drops anything that points at another gateway or account", () => {
    const env = cleanClaudeEnv({
      PATH: "/bin",
      HOME: "/home/u",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3425",
      ANTHROPIC_API_KEY: "x",
      ANTHROPIC_AUTH_TOKEN: "y",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "9999",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "5m",
      KEEP: "yes",
    });
    expect(env).not.toHaveProperty("ANTHROPIC_BASE_URL");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(env).not.toHaveProperty("CLAUDECODE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ENTRYPOINT");
    expect(env).not.toHaveProperty("CLAUDE_CODE_SSE_PORT");
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe("1h");
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/u");
    expect(env.KEEP).toBe("yes");
    expect(env).toMatchObject({
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    });
  });

  it("keeps the default account's own config directory", () => {
    const env = claudeRunEnv({ env: { CLAUDE_CONFIG_DIR: "/home/u/.claude" } });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.claude");
  });

  it("points a saved account at its own config directory", () => {
    const env = claudeRunEnv({
      env: { CLAUDE_CONFIG_DIR: "/home/u/.claude", CLAUDE_CODE_OAUTH_TOKEN: "old" },
      configDir: "/neolix/claude-accounts/abc",
      oauthToken: "setup-token",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/neolix/claude-accounts/abc");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("setup-token");
  });
});

describe("asSandboxEnv", () => {
  it("only tells a root run it is sandboxed", () => {
    expect(asSandboxEnv({ PATH: "/bin" }, false)).toEqual({ PATH: "/bin" });
    expect(asSandboxEnv({ PATH: "/bin" }, true)).toEqual({ PATH: "/bin", IS_SANDBOX: "1" });
    expect(asSandboxEnv({ IS_SANDBOX: "1" }, true)).toEqual({ IS_SANDBOX: "1" });
    expect(asSandboxEnv({ CLAUDE_CODE_BUBBLEWRAP: "1" }, true)).toEqual({
      CLAUDE_CODE_BUBBLEWRAP: "1",
    });
  });
});

describe("findClaudeBinary", () => {
  it("finds an executable named claude on PATH", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-claude-path-"));
    cleanup.push(dir);
    const binary = path.join(dir, "claude");
    await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
    await chmod(binary, 0o755);
    await expect(
      findClaudeBinary({ env: { PATH: `/nowhere${path.delimiter}${dir}` }, platform: "linux" }),
    ).resolves.toBe(binary);
  });

  it("answers empty when nothing is installed", async () => {
    await expect(findClaudeBinary({ env: { PATH: "/nowhere" }, platform: "linux" })).resolves.toBe(
      "",
    );
  });
});
