import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSubscriptionAccount,
  loadSubscriptionAccounts,
  redactedSubscriptionAccounts,
  removeSubscriptionAccount,
  saveSubscriptionAccounts,
  subscriptionAccountId,
  subscriptionAccountUsable,
  subscriptionAccountsFile,
  switchSubscriptionAccount,
  updateSubscriptionAccount,
  type ChatGptApiAccount,
  type CopilotAccount,
  type GoogleSubscriptionAccount,
  type SubscriptionAccount,
} from "./subscription-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-subscriptions-"));
  dirs.push(dir);
  return dir;
}

function chatgpt(overrides: Partial<ChatGptApiAccount> = {}): ChatGptApiAccount {
  return {
    agent: "chatgpt-api",
    id: subscriptionAccountId("chatgpt-api", "me@example.com"),
    user: "me@example.com",
    plan: "plus",
    addedAt: 1,
    lapsed: null,
    clientId: "client-1",
    hostId: "host-1",
    idToken: null,
    accessToken: "CHATGPT-ACCESS",
    refreshToken: "CHATGPT-REFRESH",
    expiresAt: 4_102_444_800_000,
    scopes: ["openid"],
    ...overrides,
  };
}

function copilot(overrides: Partial<CopilotAccount> = {}): CopilotAccount {
  return {
    agent: "copilot",
    id: subscriptionAccountId("copilot", "octocat"),
    user: "octocat",
    plan: "pro",
    addedAt: 2,
    lapsed: null,
    githubToken: "GITHUB-TOKEN",
    host: "",
    ...overrides,
  };
}

function google(
  agent: "gemini" | "antigravity",
  overrides: Partial<GoogleSubscriptionAccount> = {},
): GoogleSubscriptionAccount {
  return {
    agent,
    id: subscriptionAccountId(agent, "me@example.com"),
    user: "me@example.com",
    plan: "free",
    addedAt: 3,
    lapsed: null,
    accessToken: "GOOGLE-ACCESS",
    refreshToken: "GOOGLE-REFRESH",
    expiresAt: 4_102_444_800_000,
    project: "proj-1",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("subscription account store", () => {
  it("names each agent's file under the gateway directory", () => {
    expect(subscriptionAccountsFile("/home/x/gateway", "chatgpt-api")).toBe(
      join("/home/x/gateway", "chatgpt-api-accounts.json"),
    );
    expect(subscriptionAccountsFile("/home/x/gateway", "copilot")).toBe(
      join("/home/x/gateway", "copilot-accounts.json"),
    );
    expect(subscriptionAccountsFile("/home/x/gateway", "gemini")).toBe(
      join("/home/x/gateway", "google-accounts.json"),
    );
    expect(subscriptionAccountsFile("/home/x/gateway", "antigravity")).toBe(
      join("/home/x/gateway", "google-accounts.json"),
    );
  });

  it("keeps the same id for the same vendor account", () => {
    expect(subscriptionAccountId("copilot", "Octocat")).toBe(
      subscriptionAccountId("copilot", "octocat"),
    );
    expect(subscriptionAccountId("copilot", "octocat", "acme.ghe.com")).not.toBe(
      subscriptionAccountId("copilot", "octocat"),
    );
  });

  it("reads an empty store as no accounts", async () => {
    expect(
      await loadSubscriptionAccounts(join(tempDir(), "copilot-accounts.json"), "copilot"),
    ).toEqual([]);
  });

  it("writes 0600 and reads the accounts back", async () => {
    const file = join(tempDir(), "copilot-accounts.json");
    const saved = copilot();
    await saveSubscriptionAccounts(file, [saved]);
    // Windows cannot express POSIX permissions; the file is private by location there.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(await loadSubscriptionAccounts(file, "copilot")).toEqual([saved]);
  });

  it("leaves out an entry of another agent kept in the same file", async () => {
    const file = join(tempDir(), "google-accounts.json");
    await saveSubscriptionAccounts(file, [google("gemini"), google("antigravity")]);
    expect(await loadSubscriptionAccounts(file, "gemini")).toEqual([google("gemini")]);
    expect(await loadSubscriptionAccounts(file, "antigravity")).toEqual([google("antigravity")]);
  });

  it("drops a half-written or foreign entry", async () => {
    const file = join(tempDir(), "copilot-accounts.json");
    await saveSubscriptionAccounts(file, [
      copilot(),
      { id: "x", agent: "copilot", user: "x" } as unknown as SubscriptionAccount,
      { id: "y", agent: "gemini", user: "y" } as unknown as SubscriptionAccount,
    ]);
    expect(await loadSubscriptionAccounts(file, "copilot")).toEqual([copilot()]);
  });

  it("replaces an account signed in again rather than adding a second", () => {
    const before = [copilot()];
    const after = addSubscriptionAccount(before, copilot({ plan: "business" }));
    expect(after).toHaveLength(1);
    expect(after[0]?.plan).toBe("business");
  });

  it("removes and updates by id", () => {
    const accounts = [copilot(), copilot({ id: "other", user: "hubot" })];
    expect(removeSubscriptionAccount(accounts, "other")).toEqual([copilot()]);
    expect(
      updateSubscriptionAccount(accounts, "other", (a) => ({ ...a, lapsed: "gone" }))[1],
    ).toEqual(copilot({ id: "other", user: "hubot", lapsed: "gone" }));
  });

  it("never shows a token", () => {
    const statuses = redactedSubscriptionAccounts([
      chatgpt(),
      copilot(),
      google("gemini"),
      google("antigravity"),
    ]);
    const text = JSON.stringify(statuses);
    expect(text).not.toContain("CHATGPT-ACCESS");
    expect(text).not.toContain("CHATGPT-REFRESH");
    expect(text).not.toContain("GITHUB-TOKEN");
    expect(text).not.toContain("GOOGLE-ACCESS");
    expect(text).not.toContain("GOOGLE-REFRESH");
    expect(statuses[1]).toMatchObject({ agent: "copilot", host: "" });
    expect(statuses[2]).toMatchObject({
      agent: "gemini",
      project: "proj-1",
      expiresAt: expect.any(Number),
    });
  });

  it("makes a chosen account first among its agent's, keeping the other agent's", () => {
    const geminiA = google("gemini", { id: "g-a", user: "a@example.com" });
    const antigravity = google("antigravity", { id: "a-1", user: "ag@example.com" });
    const geminiB = google("gemini", { id: "g-b", user: "b@example.com" });

    expect(
      switchSubscriptionAccount([geminiA, antigravity, geminiB], "gemini", "g-b").map(
        (account) => account.id,
      ),
    ).toEqual(["g-b", "g-a", "a-1"]);
    expect(
      switchSubscriptionAccount([geminiA], "gemini", "missing").map((account) => account.id),
    ).toEqual(["g-a"]);
  });

  it("treats a lapsed account as unusable, and an expired one too", () => {
    expect(subscriptionAccountUsable(chatgpt(), Date.now())).toBe(true);
    expect(subscriptionAccountUsable(chatgpt({ lapsed: "revoked" }), Date.now())).toBe(false);
    expect(subscriptionAccountUsable(chatgpt({ expiresAt: 1 }), Date.now())).toBe(false);
    expect(subscriptionAccountUsable(copilot({ githubToken: "" }), Date.now())).toBe(false);
  });
});
