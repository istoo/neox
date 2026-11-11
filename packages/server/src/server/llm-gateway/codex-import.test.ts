import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexAccounts } from "./codex-accounts.js";
import { importCodexAccounts, importCodexAccountsFromText } from "./codex-import.js";
import { codexHomePath } from "./codex-user-data.js";

// Tests never reach the network.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("tests never reach the network");
  });
});

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-codex-import-"));
  dirs.push(dir);
  return dir;
}

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function jsonAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("importCodexAccounts", () => {
  it("imports Codex CLI's own auth.json", async () => {
    const dir = tempDir();
    const auth = join(dir, "auth.json");
    writeFileSync(
      auth,
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwt({ exp: 9_999_999_999 }),
          refresh_token: "rt-codex",
          id_token: jwt({
            email: "me@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct-1",
              chatgpt_plan_type: "pro",
            },
          }),
        },
      }),
    );
    const store = join(dir, "codex-accounts.json");
    const result = await importCodexAccounts([auth], store, { refresh: false });
    expect(result).toEqual({ added: 1, updated: 0, failed: [] });
    const saved = await loadCodexAccounts(store);
    expect(saved[0]).toMatchObject({
      id: "neolix:acct-1",
      label: "me@example.com",
      plan: "pro",
      refreshToken: "rt-codex",
    });
  });

  it("imports a CLIProxyAPI auth file, flat tokens", async () => {
    const dir = tempDir();
    const file = join(dir, "codex-user.json");
    writeFileSync(
      file,
      JSON.stringify({
        type: "codex",
        email: "other@example.com",
        access_token: jwt({ exp: 9_999_999_999 }),
        refresh_token: "rt-cliproxy",
        account_id: "acct-2",
      }),
    );
    const store = join(dir, "codex-accounts.json");
    await importCodexAccounts([file], store, { refresh: false });
    const saved = await loadCodexAccounts(store);
    expect(saved[0]).toMatchObject({
      id: "neolix:acct-2",
      label: "other@example.com",
      refreshToken: "rt-cliproxy",
    });
  });

  it("re-importing the same account updates it instead of adding another", async () => {
    const dir = tempDir();
    const file = join(dir, "auth.json");
    const write = (refresh: string): void =>
      writeFileSync(
        file,
        JSON.stringify({
          tokens: {
            access_token: jwt({ exp: 9_999_999_999 }),
            refresh_token: refresh,
            account_id: "acct-1",
          },
        }),
      );
    const store = join(dir, "codex-accounts.json");
    write("first");
    await importCodexAccounts([file], store, { refresh: false });
    write("second");
    const result = await importCodexAccounts([file], store, { refresh: false });
    expect(result).toEqual({ added: 0, updated: 1, failed: [] });
    expect((await loadCodexAccounts(store))[0]?.refreshToken).toBe("second");
  });

  it("says which file held no sign-in", async () => {
    const dir = tempDir();
    const empty = join(dir, "empty.json");
    writeFileSync(empty, JSON.stringify({ hello: "world" }));
    const result = await importCodexAccounts([empty], join(dir, "accounts.json"), {
      refresh: false,
    });
    expect(result).toEqual({
      added: 0,
      updated: 0,
      failed: [{ file: empty, error: "no ChatGPT sign-in in it" }],
    });
  });

  it("imports pasted JSON, as the import box takes it", async () => {
    const dir = tempDir();
    const store = join(dir, "codex-accounts.json");
    const result = await importCodexAccountsFromText(
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: 9_999_999_999 }),
          refresh_token: "rt-pasted",
          account_id: "acct-3",
        },
      }),
      store,
      { refresh: false },
    );
    expect(result).toEqual({ added: 1, updated: 0, failed: [] });
    expect((await loadCodexAccounts(store))[0]?.id).toBe("neolix:acct-3");
  });

  it("says pasted text held no sign-in", async () => {
    const dir = tempDir();
    const result = await importCodexAccountsFromText("{", join(dir, "accounts.json"), {
      refresh: false,
    });
    expect(result).toEqual({
      added: 0,
      updated: 0,
      failed: [{ file: "pasted", error: "no ChatGPT sign-in in it" }],
    });
  });

  it("spends the file's refresh token and keeps the rotated one, as myna does", async () => {
    const dir = tempDir();
    const auth = join(dir, "auth.json");
    const original = JSON.stringify({
      tokens: {
        access_token: jwt({ exp: 9_999_999_999 }),
        refresh_token: "rt-from-file",
        account_id: "acct-1",
      },
    });
    writeFileSync(auth, original);
    const store = join(dir, "codex-accounts.json");
    let asked = 0;
    const result = await importCodexAccounts([auth], store, {
      fetchImpl: (_input, init) => {
        asked += 1;
        const form = new URLSearchParams(String(init?.body ?? ""));
        expect(form.get("refresh_token")).toBe("rt-from-file");
        return Promise.resolve(
          jsonAnswer({ access_token: jwt({ exp: 9_999_999_999 }), refresh_token: "rt-rotated" }),
        );
      },
    });
    expect(result).toEqual({ added: 1, updated: 0, failed: [] });
    expect(asked).toBe(1);
    expect((await loadCodexAccounts(store))[0]?.refreshToken).toBe("rt-rotated");
    // The file it came from is only read, as myna reads it.
    expect(readFileSync(auth, "utf8")).toBe(original);
  });

  it("reads the sign-in fromCodex names under CODEX_HOME, never the real home", async () => {
    const home = tempDir();
    writeFileSync(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: 9_999_999_999 }),
          refresh_token: "rt",
          account_id: "acct-home",
        },
      }),
    );
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(codexHomePath()).toBe(home);
      const store = join(tempDir(), "codex-accounts.json");
      const result = await importCodexAccounts([join(codexHomePath(), "auth.json")], store, {
        refresh: false,
      });
      expect(result).toEqual({ added: 1, updated: 0, failed: [] });
      expect((await loadCodexAccounts(store))[0]?.id).toBe("neolix:acct-home");
    } finally {
      if (previous === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previous;
      }
    }
  });

  it("turns down a refresh token another tool has spent", async () => {
    const dir = tempDir();
    const auth = join(dir, "auth.json");
    writeFileSync(
      auth,
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: 9_999_999_999 }),
          refresh_token: "rt-spent",
          account_id: "acct-1",
        },
      }),
    );
    const store = join(dir, "codex-accounts.json");
    const result = await importCodexAccounts([auth], store, {
      fetchImpl: () => Promise.resolve(jsonAnswer({ error: "invalid_grant" }, 400)),
    });
    expect(result.added).toBe(0);
    expect(result.failed[0]?.error).toContain("didn't take the refresh token");
    expect(await loadCodexAccounts(store)).toEqual([]);
  });
});
