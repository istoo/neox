import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claudeAccountsFile,
  loadClaudeAccounts,
  parseClaudeImport,
  readClaudeSignIn,
  redactedClaudeAccounts,
  saveClaudeAccounts,
  upsertClaudeAccounts,
  writeClaudeSignIn,
} from "./claude-accounts.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neolix-claude-accounts-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const credentials = JSON.stringify({
  claudeAiOauth: {
    accessToken: "access-a",
    refreshToken: "refresh-a",
    expiresAt: 1_700_000_000_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
  },
  mcpOAuth: { server: { accessToken: "mcp" } },
});

describe("parseClaudeImport", () => {
  it("reads the credentials file's OAuth part and keeps the whole blob", () => {
    const [account] = parseClaudeImport(credentials, 1);
    expect(account).toMatchObject({
      user: "Claude max",
      plan: "max",
      accessToken: "access-a",
      refreshToken: "refresh-a",
      subscriptionType: "max",
      expiresAt: 1_700_000_000_000,
    });
    expect(JSON.parse(account?.credentials ?? "{}")).toMatchObject({
      mcpOAuth: { server: { accessToken: "mcp" } },
    });
  });

  it("takes an export's email for the account's name", () => {
    const [account] = parseClaudeImport(
      JSON.stringify({ email: "me@example.test", ...JSON.parse(credentials) }),
    );
    expect(account?.user).toBe("me@example.test");
  });

  it("reads nothing from a file without a Claude sign-in", () => {
    expect(parseClaudeImport(JSON.stringify({ models: [] }))).toEqual([]);
  });
});

describe("readClaudeSignIn", () => {
  it("reads the credentials file first", async () => {
    const home = await tempDir();
    const path = join(home, ".claude", ".credentials.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, credentials);
    const read = await readClaudeSignIn({ homeDir: home, readKeychain: unexpectedKeychain });
    expect(read).toEqual({ credentials, store: "file" });
  });

  it("falls back to the keychain item when there is no file", async () => {
    const home = await tempDir();
    const readKeychain = vi.fn(async () => credentials);
    const read = await readClaudeSignIn({ homeDir: home, readKeychain });
    expect(read).toEqual({ credentials, store: "keychain" });
    expect(readKeychain).toHaveBeenCalledWith("Claude Code-credentials");
  });

  it("says there is no sign-in when neither exists", async () => {
    const home = await tempDir();
    expect(await readClaudeSignIn({ homeDir: home, readKeychain: unexpectedKeychain })).toEqual({
      error: "Claude Code isn't signed in on this computer",
    });
  });
});

describe("writeClaudeSignIn", () => {
  it("writes the file it read, 0600, and leaves the keychain alone", async () => {
    const home = await tempDir();
    const written = await writeClaudeSignIn(credentials, "file", { homeDir: home });
    expect(written).toEqual({ store: "file" });
    const path = join(home, ".claude", ".credentials.json");
    expect(await readFile(path, "utf8")).toBe(credentials);
  });

  it("writes the keychain item when that is where it came from", async () => {
    const writeKeychain = vi.fn(async () => undefined);
    const written = await writeClaudeSignIn(credentials, "keychain", {
      writeKeychain,
    });
    expect(written).toEqual({ store: "keychain" });
    expect(writeKeychain).toHaveBeenCalledWith("Claude Code-credentials", credentials);
  });
});

describe("the Claude store", () => {
  it("round-trips accounts and never redacts a token in", async () => {
    const dir = await tempDir();
    const file = claudeAccountsFile(dir);
    const [account] = parseClaudeImport(credentials, 5);
    await saveClaudeAccounts(file, account === undefined ? [] : [account]);
    expect(await loadClaudeAccounts(file)).toEqual([account]);
    expect(redactedClaudeAccounts(await loadClaudeAccounts(file))[0]).not.toHaveProperty(
      "accessToken",
    );
  });

  it("updates the account the same refresh token names", () => {
    const [account] = parseClaudeImport(credentials, 5);
    const [newer] = parseClaudeImport(credentials.replace("access-a", "access-b"), 6);
    const merged = upsertClaudeAccounts(
      account === undefined ? [] : [account],
      newer === undefined ? [] : [newer],
    );
    expect(merged).toMatchObject({ added: 0, updated: 1 });
    expect(merged.accounts[0]?.accessToken).toBe("access-b");
  });

  it("adds an account it doesn't know", () => {
    const [account] = parseClaudeImport(credentials, 5);
    expect(upsertClaudeAccounts([], account === undefined ? [] : [account]).added).toBe(1);
  });
});

const unexpectedKeychain = async (): Promise<string | null> => {
  throw new Error("the keychain must not be read in this test");
};
