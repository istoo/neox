import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { createAccountsCommand } from "./index.js";

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return {
    ...actual,
    connectToDaemon: vi.fn(async () => ({
      getLastServerInfoMessage: () => ({ features: { gatewaySignin: true } }),
      startGatewaySignIn: vi.fn(async () => ({ state: { state: "done", user: "me" } })),
      close: async () => undefined,
    })),
  };
});
import {
  addFactoryAccount,
  aliasAccount,
  formatAccountRow,
  getDiscovery,
  importClaudeAccounts,
  importClaudeSignIn,
  listAccounts,
  refreshAccounts,
  removeAccount,
  setAccountProject,
  setDiscovery,
  switchAccount,
} from "./accounts.js";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-cli-accounts-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("accounts add", () => {
  it("takes --host as the Copilot enterprise host, not the daemon endpoint", async () => {
    const home = tempHome();
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createAccountsCommand().parseAsync(
        ["add", "copilot", "--host", "acme.ghe.com", "--home", home],
        { from: "user" },
      );
    } finally {
      stdoutWrite.mockRestore();
    }
    expect(connectToDaemon).toHaveBeenCalledWith({
      target: { kind: "instance", home: resolveNeolixHome({ NEOLIX_HOME: home }) },
    });
    const client = (await vi.mocked(connectToDaemon).mock.results[0]!.value) as {
      startGatewaySignIn: ReturnType<typeof vi.fn>;
    };
    expect(client.startGatewaySignIn).toHaveBeenCalledWith({
      agent: "copilot",
      site: "acme.ghe.com",
    });
  });
});

const NOW = 1_700_000_000_000;

function googleAccount(
  agent: "gemini" | "antigravity",
  user: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${agent}-${user}`,
    agent,
    user,
    plan: "Standard",
    addedAt: 1,
    lapsed: null,
    accessToken: "old-access",
    refreshToken: `refresh-${user}`,
    expiresAt: NOW + 3_600_000,
    project: null,
    ...extra,
  };
}

function codexAccount(suffix: string, label: string): Record<string, unknown> {
  return {
    id: `codex-${suffix}`,
    label,
    plan: "Pro",
    accountId: `acct-${suffix}`,
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    idToken: `id-${suffix}`,
    expiresAt: NOW + 3_600_000,
    addedAt: 1,
  };
}

describe("listAccounts", () => {
  it("lists each agent's accounts in myna's order, with alias and project", async () => {
    const home = tempHome();
    write(join(home, "gateway", "google-accounts.json"), [
      googleAccount("antigravity", "ag-one", { project: "my-proj-123" }),
      googleAccount("gemini", "gem-one", { alias: "Work" }),
    ]);
    write(join(home, "gateway", "copilot-accounts.json"), [
      {
        id: "copilot-one",
        agent: "copilot",
        user: "dev1@ghe.example",
        plan: null,
        addedAt: 2,
        lapsed: null,
        githubToken: "gh",
        host: "acme.ghe.com",
      },
    ]);
    const rows = await listAccounts({ home });
    expect(rows.map((row) => `${row.agent}:${row.user}`)).toEqual([
      "copilot:dev1@ghe.example",
      "gemini:gem-one",
      "antigravity:ag-one",
    ]);
    expect(rows[1]).toMatchObject({ alias: "Work", plan: "Standard" });
    expect(formatAccountRow(rows[1] as never)).toContain("Work · gem-one");
    expect(rows[2]).toMatchObject({ project: "my-proj-123" });
    expect(formatAccountRow(rows[2] as never)).toContain("project my-proj-123");
  });

  it("says nothing for a home with no stores", async () => {
    expect(await listAccounts({ home: tempHome() })).toEqual([]);
  });
});

describe("aliasAccount", () => {
  it("names an account by its user or id, and clears the name", async () => {
    const home = tempHome();
    const file = join(home, "gateway", "google-accounts.json");
    write(file, [googleAccount("gemini", "gem-one")]);

    expect(await aliasAccount({ home }, "gemini", "gem-one", "Work")).toEqual({
      user: "gem-one",
      alias: "Work",
    });
    expect(await aliasAccount({ home }, "gemini", "Work", "--clear")).toEqual({
      user: "gem-one",
      alias: "",
    });
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
    expect(stored[0]?.alias).toBeUndefined();
  });
});

describe("setAccountProject", () => {
  it("binds one account and keeps the other agent's entries", async () => {
    const home = tempHome();
    const file = join(home, "gateway", "google-accounts.json");
    write(file, [googleAccount("gemini", "gem-one"), googleAccount("antigravity", "ag-one")]);
    expect(await setAccountProject({ home }, "antigravity", "ag-one", "my-proj-123")).toEqual({
      user: "ag-one",
      project: "my-proj-123",
    });
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
    expect(stored[0]).toMatchObject({ agent: "gemini", project: null });
    expect(stored[1]).toMatchObject({ agent: "antigravity", project: "my-proj-123" });

    expect(await setAccountProject({ home }, "antigravity", "ag-one", "")).toEqual({
      user: "ag-one",
      project: "",
    });
    expect(
      (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[])[1]?.project,
    ).toBeNull();
  });

  it("refuses an agent whose accounts name no project", async () => {
    await expect(
      setAccountProject({ home: tempHome() }, "copilot", "someone", "my-proj-123"),
    ).rejects.toThrow("only Gemini CLI and Antigravity");
  });
});

describe("refreshAccounts", () => {
  it("leaves a token that isn't near expiring alone", async () => {
    const home = tempHome();
    write(join(home, "gateway", "google-accounts.json"), [googleAccount("gemini", "gem-one")]);
    const fetchImpl = (() => {
      throw new Error("nothing should be asked");
    }) as unknown as typeof fetch;
    expect(await refreshAccounts({ home, fetchImpl, now: () => NOW })).toEqual([
      { agent: "gemini", user: "gem-one", refreshed: false },
    ]);
  });

  it("trades a near-expiring Google token and keeps the new one", async () => {
    const home = tempHome();
    const file = join(home, "gateway", "google-accounts.json");
    write(file, [googleAccount("gemini", "gem-one", { expiresAt: NOW })]);
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const rows = await refreshAccounts({
      home,
      fetchImpl,
      now: () => NOW,
      googleTokenUrl: "https://token.example/token",
    });
    expect(rows).toEqual([{ agent: "gemini", user: "gem-one", refreshed: true }]);
    expect(calls).toEqual(["https://token.example/token"]);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
    expect(stored[0]).toMatchObject({ accessToken: "new-access", expiresAt: NOW + 3_600_000 });
  });

  it("leaves a Copilot account's GitHub sign-in alone", async () => {
    const home = tempHome();
    write(join(home, "gateway", "copilot-accounts.json"), [
      {
        id: "copilot-one",
        agent: "copilot",
        user: "dev1",
        plan: null,
        addedAt: 2,
        lapsed: null,
        githubToken: "gh",
        host: "",
      },
    ]);
    expect(await refreshAccounts({ home, now: () => NOW })).toEqual([
      { agent: "copilot", user: "dev1", refreshed: false },
    ]);
  });
});

describe("accounts discovery", () => {
  it("reads on by default and writes the general key", async () => {
    const home = tempHome();
    expect(await getDiscovery({ home })).toBe(true);
    expect(await setDiscovery({ home }, false)).toBe(false);
    expect(await getDiscovery({ home })).toBe(false);
    const config = JSON.parse(readFileSync(join(home, "gateway.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config.accountDiscovery).toBe(false);
  });

  it("still reads a config written with the Codex-only key", async () => {
    const home = tempHome();
    write(join(home, "gateway.json"), { codexAccountDiscovery: false });
    expect(await getDiscovery({ home })).toBe(false);
    expect(await setDiscovery({ home }, true)).toBe(true);
    expect(await getDiscovery({ home })).toBe(true);
  });
});

describe("switchAccount", () => {
  it("moves the chosen subscription account to the front of its store", async () => {
    const home = tempHome();
    const file = join(home, "gateway", "google-accounts.json");
    write(file, [
      googleAccount("gemini", "gem-two"),
      googleAccount("gemini", "gem-one", { alias: "Work" }),
    ]);
    expect(await switchAccount({ home }, "gemini", "Work")).toEqual({
      agent: "gemini",
      user: "gem-one",
    });
    let stored = JSON.parse(readFileSync(file, "utf8")) as { user: string }[];
    expect(stored.map((account) => account.user)).toEqual(["gem-one", "gem-two"]);

    expect(await switchAccount({ home }, "gemini", "next")).toEqual({
      agent: "gemini",
      user: "gem-two",
    });
    stored = JSON.parse(readFileSync(file, "utf8")) as { user: string }[];
    expect(stored.map((account) => account.user)).toEqual(["gem-two", "gem-one"]);
  });

  it("says so when no account is stored for the agent", async () => {
    await expect(switchAccount({ home: tempHome() }, "gemini", "gem-one")).rejects.toThrow(
      "no gemini accounts yet",
    );
  });

  it("refuses while account discovery is off", async () => {
    const home = tempHome();
    write(join(home, "gateway.json"), { codexAccountDiscovery: false });
    await expect(switchAccount({ home }, "gemini", "gem-one")).rejects.toThrow(
      "Subscription accounts",
    );
  });

  it("writes the chosen ChatGPT account into Codex's own auth.json", async () => {
    const home = tempHome();
    const codexHome = join(home, "codex");
    write(join(home, "gateway", "codex-accounts.json"), [
      codexAccount("one", "first@example.com"),
      codexAccount("two", "second@example.com"),
    ]);
    expect(
      await switchAccount(
        { home, homeDir: home, codexHome, env: {} },
        "codex",
        "second@example.com",
      ),
    ).toEqual({ agent: "codex", user: "second@example.com", store: "file" });
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(auth).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id-two",
        access_token: "access-two",
        refresh_token: "refresh-two",
        account_id: "acct-two",
      },
    });
  });

  it("switches next to the first account after it with room", async () => {
    const home = tempHome();
    const codexHome = join(home, "codex");
    write(join(home, "gateway", "codex-accounts.json"), [
      codexAccount("one", "first@example.com"),
      codexAccount("two", "second@example.com"),
      codexAccount("three", "third@example.com"),
    ]);
    write(join(codexHome, "auth.json"), {
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id-two",
        access_token: "access-two",
        refresh_token: "refresh-two",
        account_id: "acct-two",
      },
    });
    const used = new Map([
      ["codex-two", 100],
      ["codex-three", 100],
      ["codex-one", 10],
    ]);
    const result = await switchAccount(
      {
        home,
        homeDir: home,
        codexHome,
        env: {},
        usageWindows: async (_agent, account) => [
          { usedPercent: used.get(account.id) ?? 0, resetAt: null },
        ],
      },
      "codex",
      "next",
    );
    expect(result).toEqual({
      agent: "codex",
      user: "first@example.com",
      store: "file",
      over: false,
    });
  });

  it("switches next to the account with the most room left when every one is spent", async () => {
    const home = tempHome();
    const codexHome = join(home, "codex");
    write(join(home, "gateway", "codex-accounts.json"), [
      codexAccount("one", "first@example.com"),
      codexAccount("two", "second@example.com"),
    ]);
    write(join(codexHome, "auth.json"), {
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id-two",
        access_token: "access-two",
        refresh_token: "refresh-two",
        account_id: "acct-two",
      },
    });
    const result = await switchAccount(
      {
        home,
        homeDir: home,
        codexHome,
        env: {},
        usageWindows: async (_agent, account) => [
          { usedPercent: account.id === "codex-one" ? 99 : 100, resetAt: null },
        ],
      },
      "codex",
      "next",
    );
    expect(result).toMatchObject({ agent: "codex", user: "first@example.com", over: true });
  });

  it("asks for the account by name when no allowance is known", async () => {
    const home = tempHome();
    const codexHome = join(home, "codex");
    write(join(home, "gateway", "codex-accounts.json"), [
      codexAccount("one", "first@example.com"),
      codexAccount("two", "second@example.com"),
    ]);
    write(join(codexHome, "auth.json"), {
      auth_mode: "chatgpt",
      tokens: {
        id_token: "id-two",
        access_token: "access-two",
        refresh_token: "refresh-two",
        account_id: "acct-two",
      },
    });
    await expect(
      switchAccount({ home, homeDir: home, codexHome, env: {} }, "codex", "next"),
    ).rejects.toThrow("no reading of codex's other accounts' usage");
  });

  it("refuses an account another Codex folder still holds", async () => {
    const home = tempHome();
    const other = join(home, "other-codex");
    write(join(home, "gateway", "codex-accounts.json"), [
      { ...codexAccount("one", "first@example.com"), home: other },
    ]);
    write(join(other, "auth.json"), {
      auth_mode: "chatgpt",
      tokens: { refresh_token: "refresh-one" },
    });
    await expect(
      switchAccount(
        { home, homeDir: home, codexHome: join(home, "codex"), env: {} },
        "codex",
        "first@example.com",
      ),
    ).rejects.toThrow("is signed in to Codex in");
  });

  it("switches an account the folder no longer holds", async () => {
    const home = tempHome();
    const other = join(home, "other-codex");
    write(join(home, "gateway", "codex-accounts.json"), [
      { ...codexAccount("one", "first@example.com"), home: other },
    ]);
    write(join(other, "auth.json"), {
      auth_mode: "chatgpt",
      tokens: { refresh_token: "somebody-else" },
    });
    expect(
      await switchAccount(
        { home, homeDir: home, codexHome: join(home, "codex"), env: {} },
        "codex",
        "first@example.com",
      ),
    ).toEqual({ agent: "codex", user: "first@example.com", store: "file" });
  });

  it("writes nothing when Codex write-back is off", async () => {
    const home = tempHome();
    const codexHome = join(home, "codex");
    write(join(home, "gateway", "codex-accounts.json"), [codexAccount("one", "first@example.com")]);
    write(join(home, "gateway.json"), { codexSignInWriteBack: false });
    await expect(
      switchAccount({ home, homeDir: home, codexHome, env: {} }, "codex", "first@example.com"),
    ).rejects.toThrow("writing Codex's own sign-in back is off");
    expect(() => readFileSync(join(codexHome, "auth.json"), "utf8")).toThrow();
  });
});

describe("Claude accounts", () => {
  const credentials = JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-a",
      refreshToken: "refresh-a",
      expiresAt: 1_700_000_000_000,
      subscriptionType: "max",
    },
  });

  it("imports a credentials file into the store, read-only", async () => {
    const home = tempHome();
    expect(await importClaudeAccounts({ home }, [credentials])).toEqual([
      { file: 1, user: "Claude max", status: "added" },
    ]);
    expect(await listAccounts({ home }, "claude")).toEqual([
      expect.objectContaining({ agent: "claude", user: "Claude max", plan: "max" }),
    ]);
  });

  it("imports the sign-in Claude Code keeps here, read-only", async () => {
    const home = tempHome();
    const credentialsPath = join(home, ".claude", ".credentials.json");
    write(credentialsPath, JSON.parse(credentials));

    expect(
      await importClaudeSignIn({
        home,
        homeDir: home,
        env: {},
        credentialsPath,
        readClaudeKeychain: async () => null,
      }),
    ).toEqual({ file: 0, user: "Claude max", status: "added" });
    expect(readFileSync(credentialsPath, "utf8")).toBe(credentials);
    expect(await listAccounts({ home }, "claude")).toEqual([
      expect.objectContaining({ agent: "claude", user: "Claude max" }),
    ]);
  });

  it("refuses to switch while Claude write-back is off", async () => {
    const home = tempHome();
    await importClaudeAccounts({ home }, [credentials]);
    await expect(
      switchAccount(
        {
          home,
          homeDir: home,
          env: {},
          credentialsPath: join(home, ".claude", ".credentials.json"),
          readClaudeKeychain: async () => null,
        },
        "claude",
        "Claude max",
      ),
    ).rejects.toThrow("bridge is off by default");
  });

  it("writes the chosen sign-in into Claude Code's file when write-back is on", async () => {
    const home = tempHome();
    await importClaudeAccounts({ home }, [credentials]);
    write(join(home, "gateway.json"), { claudeSignInWriteBack: true });
    const credentialsPath = join(home, ".claude", ".credentials.json");
    expect(
      await switchAccount(
        {
          home,
          homeDir: home,
          env: {},
          credentialsPath,
          readClaudeKeychain: async () => null,
        },
        "claude",
        "Claude max",
      ),
    ).toEqual({ agent: "claude", user: "Claude max", store: "file" });
    expect(readFileSync(credentialsPath, "utf8")).toBe(credentials);
  });
});

describe("Factory accounts", () => {
  const key = "fk-abcdefgh12345678";
  const whoami = (body: Record<string, unknown>) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as Promise<Response>;

  it("adds an account by its API key, as whoami names it", async () => {
    const home = tempHome();
    const fetchImpl = (() =>
      whoami({ userId: "user-1", orgId: "org-1", email: "one@example.test" })) as typeof fetch;

    expect(await addFactoryAccount({ home, fetchImpl }, key)).toEqual({
      user: "one@example.test",
    });
    const stored = JSON.parse(
      readFileSync(join(home, "gateway", "factory-accounts.json"), "utf8"),
    ) as Record<string, unknown>[];
    expect(stored[0]).toMatchObject({
      agent: "factory",
      user: "one@example.test",
      key,
      orgId: "org-1",
    });
    expect(await listAccounts({ home }, "factory")).toEqual([
      expect.objectContaining({ agent: "factory", user: "one@example.test" }),
    ]);
  });

  it("refuses a key Factory does not take", async () => {
    const home = tempHome();
    const fetchImpl = (() =>
      Promise.resolve(new Response("invalid-api-key", { status: 401 }))) as typeof fetch;
    await expect(addFactoryAccount({ home, fetchImpl }, key)).rejects.toThrow("401");
    expect(() => readFileSync(join(home, "gateway", "factory-accounts.json"), "utf8")).toThrow();
  });

  it("moves the chosen account to the front, like the other subscriptions", async () => {
    const home = tempHome();
    write(join(home, "gateway", "factory-accounts.json"), [
      {
        agent: "factory",
        id: "factory-one",
        user: "one@example.test",
        plan: null,
        addedAt: 1,
        lapsed: null,
        key,
        orgId: null,
        region: null,
        prem: null,
      },
      {
        agent: "factory",
        id: "factory-two",
        user: "two@example.test",
        plan: null,
        addedAt: 2,
        lapsed: null,
        key: "fk-brenzdeh57422095",
        orgId: null,
        region: null,
        prem: null,
      },
    ]);

    expect(await switchAccount({ home }, "factory", "two@example.test")).toEqual({
      agent: "factory",
      user: "two@example.test",
    });
    const stored = JSON.parse(
      readFileSync(join(home, "gateway", "factory-accounts.json"), "utf8"),
    ) as { user: string }[];
    expect(stored.map((account) => account.user)).toEqual(["two@example.test", "one@example.test"]);
  });
});

describe("removeAccount", () => {
  it("drops one account and leaves the other agent's entries", async () => {
    const home = tempHome();
    const file = join(home, "gateway", "google-accounts.json");
    write(file, [googleAccount("gemini", "gem-one"), googleAccount("antigravity", "ag-one")]);
    expect(await removeAccount({ home }, "gemini", "gem-one")).toEqual({ user: "gem-one" });
    const stored = JSON.parse(readFileSync(file, "utf8")) as { agent: string }[];
    expect(stored.map((account) => account.agent)).toEqual(["antigravity"]);
  });

  it("refuses a name no account has", async () => {
    await expect(removeAccount({ home: tempHome() }, "gemini", "nobody")).rejects.toThrow(
      'no account "nobody"',
    );
  });
});
