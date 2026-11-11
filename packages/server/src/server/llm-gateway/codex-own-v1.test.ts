import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexOwnRedirect, type CodexOwnRequest } from "./codex-own-v1.js";

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function codexHome(): string {
  const home = mkdtempSync(join(tmpdir(), "neolix-codex-own-"));
  dirs.push(home);
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: jwt({ exp: 4_102_444_800 }),
        refresh_token: "rt",
        id_token: jwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
      },
    }),
  );
  return home;
}

function request(overrides: Partial<CodexOwnRequest> = {}): CodexOwnRequest {
  return {
    model: "gpt-6.1-sol",
    local: true,
    fromCodex: true,
    sideCall: false,
    served: false,
    switchedOff: false,
    keyHeld: false,
    accountHeld: false,
    ...overrides,
  };
}

describe("codexOwnRedirect", () => {
  it("puts Codex's own model on its ChatGPT sign-in", async () => {
    const redirect = await codexOwnRedirect(request(), {
      signIn: { codexHome: codexHome(), keychain: () => null },
    });
    expect(redirect).toEqual({
      path: "/backend-api/codex/responses",
      headers: { authorization: expect.stringMatching(/^Bearer /), "chatgpt-account-id": "acct-1" },
    });
  });

  it("leaves a model Neox serves where it is", async () => {
    expect(await codexOwnRedirect(request({ served: true }))).toBeNull();
    expect(await codexOwnRedirect(request({ model: "group/fast" }))).toBeNull();
  });

  it("says what to do when Codex is signed out", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-codex-own-empty-"));
    dirs.push(home);
    const redirect = await codexOwnRedirect(request(), {
      signIn: { codexHome: home, keychain: () => null },
    });
    expect("why" in redirect!).toBe(true);
    expect("why" in redirect! ? redirect!.why : "").toContain("Start a new thread in Codex");
  });
});
