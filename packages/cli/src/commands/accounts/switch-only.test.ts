import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "@neolix/server/gateway-config";
import { createAccountsCommand } from "./index.js";
import { parseSwitchOnlyAgent, setSwitchOnly, switchOnlyOf } from "./switch-only.js";

let home: string;
let out: string[];

function config(): GatewayConfig {
  return GatewayConfigSchema.parse({
    providers: [
      {
        id: "claude",
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.test",
        accounts: [{ id: "one", agent: "claude-code", subscriptionUser: "a@b.c" }],
      },
      { id: "relay", protocol: "openai", baseUrl: "https://relay.test", apiKey: "k" },
    ],
  });
}

function writeConfig(value: GatewayConfig): void {
  writeFileSync(join(home, "gateway.json"), JSON.stringify(value));
}

function stored(): Array<Record<string, unknown>> {
  return (
    JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as {
      providers: Array<Record<string, unknown>>;
    }
  ).providers;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "neolix-switch-only-"));
  process.env.NEOLIX_HOME = home;
  writeConfig(config());
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEOLIX_HOME;
});

describe("switch-only", () => {
  it("sets the flag on the agent's provider and clears it", () => {
    const on = setSwitchOnly(config(), "claude", true);
    expect(switchOnlyOf(on, "claude")).toBe(true);
    const off = setSwitchOnly(on, "claude", false);
    expect(switchOnlyOf(off, "claude")).toBe(false);
    expect(off.providers[0]?.switchOnly).toBeUndefined();
  });

  it("refuses a provider without the agent's own sign-ins", () => {
    expect(() => setSwitchOnly(config(), "codex", true)).toThrow("no codex provider");
    const noSignIn = GatewayConfigSchema.parse({
      providers: [{ id: "claude", protocol: "anthropic", baseUrl: "https://a.test", apiKey: "k" }],
    });
    expect(() => setSwitchOnly(noSignIn, "claude", true)).toThrow(
      "doesn't route claude's own requests",
    );
  });

  it("accepts only codex and claude", () => {
    expect(parseSwitchOnlyAgent("Codex")).toBe("codex");
    expect(() => parseSwitchOnlyAgent("gemini")).toThrow("switch-only <codex|claude>");
  });

  it("writes through `neox accounts switch-only` and prints the state", async () => {
    await createAccountsCommand().parseAsync(["switch-only", "claude", "on"], { from: "user" });
    expect(stored()[0]?.switchOnly).toBe(true);
    expect(out.join("")).toContain("only switches Claude Code's sign-in");
    out = [];
    await createAccountsCommand().parseAsync(["switch-only", "claude"], { from: "user" });
    expect(out.join("")).toContain("on · Neox only switches Claude Code's sign-in");
  });
});
