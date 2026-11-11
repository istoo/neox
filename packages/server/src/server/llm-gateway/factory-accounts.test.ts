import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FACTORY_MODELS,
  addFactoryKey,
  factoryAuthHeaders,
  factoryBase,
  factoryGatewayModels,
  factoryKeysIn,
  factoryModelProtocols,
  factoryWhoami,
} from "./factory-accounts.js";
import {
  loadSubscriptionAccounts,
  saveSubscriptionAccounts,
  subscriptionAccountsFile,
  addSubscriptionAccount,
} from "./subscription-store.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "neolix-factory-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const KEY = "fk-abcdefgh12345678";

function whoamiAnswer(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("factoryKeysIn", () => {
  it("finds a key in a line, a .env line and JSON, each once", () => {
    expect(factoryKeysIn([`FACTORY_API_KEY=${KEY}`, `{"key":"${KEY}"}`, "nothing"])).toEqual([KEY]);
  });
});

describe("factoryWhoami", () => {
  it("sends droid's headers and reads whoami's own names", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers) };
      return Promise.resolve(
        whoamiAnswer({
          userId: "user-1",
          orgId: "org-1",
          email: "one@example.test",
          region: "eu",
          premBaseHostV2: "https://prem.example.test",
        }),
      );
    }) as typeof fetch;

    const who = await factoryWhoami({ key: KEY }, { fetchImpl, apiBase: "https://api.test" });

    expect(who).toEqual({
      userId: "user-1",
      orgId: "org-1",
      email: "one@example.test",
      region: "eu",
      prem: "https://prem.example.test",
    });
    expect(seen?.url).toBe("https://api.test/api/cli/whoami");
    expect(seen?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen?.headers.get("x-factory-whoami-extended")).toBe("true");
  });

  it("says what Factory answered when it refuses the key", async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response("invalid-api-key", { status: 401 }))) as typeof fetch;
    const who = await factoryWhoami({ key: KEY }, { fetchImpl });

    expect("error" in who && who.error).toContain("401");
  });
});

describe("addFactoryKey", () => {
  it("keeps the key with the org whoami named", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        whoamiAnswer({ userId: "user-1", orgId: "org-1", email: "one@x.test" }),
      )) as typeof fetch;

    const added = await addFactoryKey(KEY, { fetchImpl, now: () => 7 });

    if ("error" in added) {
      throw new Error(added.error);
    }
    expect(added.account).toMatchObject({
      agent: "factory",
      user: "one@x.test",
      key: KEY,
      orgId: "org-1",
      region: null,
      prem: null,
      addedAt: 7,
      lapsed: null,
    });
  });

  it("refuses text that is not a Factory key", async () => {
    const added = await addFactoryKey("sk-nope", {
      fetchImpl: (() => Promise.reject(new Error("should not be called"))) as typeof fetch,
    });
    expect("error" in added && added.error).toContain("not a Factory API key");
  });

  it("keeps a key in the factory store the CLI and gateway share", async () => {
    const dir = await tempDir();
    const fetchImpl = (() =>
      Promise.resolve(
        whoamiAnswer({ userId: "user-1", orgId: null, email: "one@x.test" }),
      )) as typeof fetch;
    const added = await addFactoryKey(KEY, { fetchImpl });
    if ("error" in added) {
      throw new Error(added.error);
    }
    const file = subscriptionAccountsFile(dir, "factory");
    await saveSubscriptionAccounts(file, [added.account]);

    expect(await loadSubscriptionAccounts(file, "factory")).toEqual([added.account]);
    expect(addSubscriptionAccount([added.account], added.account)).toHaveLength(1);
  });
});

describe("factory auth and models", () => {
  it("sends the org whoami named, and nothing when it named none", () => {
    expect(factoryAuthHeaders({ key: KEY, orgId: "org-1" })).toEqual({
      authorization: `Bearer ${KEY}`,
      "x-factory-org-id": "org-1",
    });
    expect(factoryAuthHeaders({ key: KEY, orgId: null })).toEqual({
      authorization: `Bearer ${KEY}`,
    });
  });

  it("serves an EU org from Factory's EU host, a prem host over both", () => {
    expect(factoryBase({ region: "eu", prem: null })).toBe("https://api.eu.factory.ai");
    expect(factoryBase({ region: null, prem: null })).toBe("https://api.factory.ai");
    expect(factoryBase({ region: "eu", prem: "https://own.test" })).toBe("https://own.test");
  });

  it("ports droid's picker and each model's wire", () => {
    expect(FACTORY_MODELS.some((model) => model.id === "claude-opus-5-5")).toBe(true);
    expect(factoryModelProtocols("claude-opus-5-5")).toEqual(["anthropic"]);
    expect(factoryModelProtocols("gpt-5.5")).toEqual(["openai-responses"]);
    expect(factoryModelProtocols("not-in-droid")).toEqual([
      "anthropic",
      "openai-responses",
      "openai",
    ]);
    expect(factoryGatewayModels()[0]).not.toHaveProperty("protocol");
  });
});
