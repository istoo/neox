import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexAccounts } from "./codex-accounts.js";
import {
  beginCodexLogin,
  clearCodexLogins,
  pollCodexLogin,
  removeOwnedCodexAccount,
} from "./codex-login.js";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-codex-login-"));
  dirs.push(dir);
  return join(dir, "codex-accounts.json");
}

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearCodexLogins();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function loginFetch(state: { entered: boolean; calls: string[] }) {
  return (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    state.calls.push(url);
    if (url.endsWith("/deviceauth/usercode")) {
      return Promise.resolve(
        jsonAnswer({ device_auth_id: "dev-1", user_code: "ABCD", interval: "1" }),
      );
    }
    if (url.endsWith("/deviceauth/token")) {
      return state.entered
        ? Promise.resolve(jsonAnswer({ authorization_code: "code", code_verifier: "verifier" }))
        : Promise.resolve(new Response("", { status: 403 }));
    }
    return Promise.resolve(
      jsonAnswer({
        access_token: jwt({ exp: 9_999_999_999 }),
        refresh_token: "rt",
        id_token: jwt({
          email: "me@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
        }),
      }),
    );
  };
}
// Tests never reach the network: every code path that would fetch takes an
// injected fetch, so the global one throws.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

describe("codex login", () => {
  it("shows a code, waits, then saves the account", async () => {
    const file = tempFile();
    const state = { entered: false, calls: [] as string[] };
    const fetchImpl = loginFetch(state) as unknown as typeof fetch;
    const started = await beginCodexLogin({ fetchImpl });
    expect("start" in started).toBe(true);
    if (!("start" in started)) {
      return;
    }
    expect(started.start.url).toBe("https://auth.openai.com/codex/device");
    expect(started.start.userCode).toBe("ABCD");

    const waiting = await pollCodexLogin(started.start.loginId, file, { fetchImpl });
    expect(waiting.state).toBe("waiting");
    expect(await loadCodexAccounts(file)).toEqual([]);

    state.entered = true;
    const done = await pollCodexLogin(started.start.loginId, file, { fetchImpl });
    expect(done.state).toBe("done");
    expect(done.account).toMatchObject({
      label: "me@example.com",
      plan: "pro",
      accountId: "acct-1",
    });
    const saved = await loadCodexAccounts(file);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.accessToken).not.toBe("");

    const again = await pollCodexLogin(started.start.loginId, file, { fetchImpl });
    expect(again.state).toBe("error");
  });

  it("removes an owned account", async () => {
    const file = tempFile();
    const state = { entered: true, calls: [] as string[] };
    const fetchImpl = loginFetch(state) as unknown as typeof fetch;
    const started = await beginCodexLogin({ fetchImpl });
    if (!("start" in started)) {
      throw new Error(started.error);
    }
    const done = await pollCodexLogin(started.start.loginId, file, { fetchImpl });
    const id = done.account?.id ?? "";
    await removeOwnedCodexAccount(file, id);
    expect(await loadCodexAccounts(file)).toEqual([]);
  });
});
