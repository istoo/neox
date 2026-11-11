import { describe, expect, it } from "vitest";
import { claudeSignInFailure, isClaudeSignIn, replaceApiKey, rewriteErrorFrame } from "./signin.js";

describe("isClaudeSignIn", () => {
  it("is true for a Claude Code sign-in and false for a key", () => {
    expect(isClaudeSignIn("Bearer sk-ant-oat01-abc")).toBe(true);
    expect(isClaudeSignIn("  bearer sk-ant-oat01-abc  ")).toBe(true);
    expect(isClaudeSignIn("Bearer sk-ant-api03-abc")).toBe(false);
    expect(isClaudeSignIn("Basic abc")).toBe(false);
    expect(isClaudeSignIn(undefined)).toBe(false);
  });
});

describe("claudeSignInFailure", () => {
  it("tells a 401 as a 502 refusing the gateway's credential", () => {
    const failure = claudeSignInFailure({
      status: 401,
      body: JSON.stringify({ error: { message: "Anthropic: invalid x-api-key" } }),
    });
    expect(failure?.status).toBe(502);
    expect(JSON.parse(failure?.body ?? "{}")).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Anthropic refused Neox's credential (HTTP 401): invalid API key",
      },
    });
  });

  it("keeps a 400 as it was", () => {
    expect(claudeSignInFailure({ status: 400, body: "bad" })).toBeNull();
  });

  it("tells a 403 saying the OAuth token was revoked as a 502", () => {
    const failure = claudeSignInFailure({
      status: 403,
      body: JSON.stringify({ error: { message: "OAuth token has been revoked" } }),
    });
    expect(failure?.status).toBe(502);
    expect(failure?.body).toContain("refused Neox's credential (HTTP 403)");
  });

  it("keeps any other 403", () => {
    expect(claudeSignInFailure({ status: 403, body: "not allowed" })).toBeNull();
  });

  it("names the provider its caller knows when the error does not", () => {
    const failure = claudeSignInFailure({
      status: 401,
      body: JSON.stringify({ error: { message: "quota" } }),
      provider: "Z.AI",
    });
    expect(failure?.body).toContain("Z.AI refused Neox's credential (HTTP 401): quota");
  });
});

describe("replaceApiKey", () => {
  it("says x-api-key as API key", () => {
    expect(replaceApiKey("invalid X-API-KEY header")).toBe("invalid API key header");
    expect(rewriteErrorFrame('event: error\ndata: {"message":"x-api-key"}\n')).toContain("API key");
    expect(rewriteErrorFrame("event: message_start\ndata: {}\n")).toBe(
      "event: message_start\ndata: {}\n",
    );
  });
});
