import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsStore } from "./github-token.js";
import {
  githubFetch,
  githubLimitedBy,
  githubRefused,
  githubSettingsRefused,
  resetGithubTokenStateForTests,
} from "./github-api.js";

const dirs: string[] = [];
const API = "https://api.github.com";

async function storeWith(token?: string): Promise<SecretsStore> {
  const home = await mkdtemp(path.join(tmpdir(), "neolix-ghtoken-"));
  dirs.push(home);
  const store = new SecretsStore(home);
  if (token !== undefined) {
    await store.setGithubToken(token);
  }
  return store;
}

/** GitHub's API answering 401 to every token but `good`, keeping each Authorization. */
function fakeApi(good = "") {
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    seen.push(auth);
    if (auth !== "" && auth !== `Bearer ${good}`) {
      return new Response('{"message":"Bad credentials"}', { status: 401 });
    }
    return new Response('{"ok":true}', { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, mock: fetchImpl };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  resetGithubTokenStateForTests();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("githubFetch", () => {
  it("asks again without an environment token GitHub refuses", async () => {
    const store = await storeWith();
    vi.stubEnv("GITHUB_TOKEN", "stale-env");
    vi.stubEnv("GH_TOKEN", "");
    const api = fakeApi();

    const { response, usedToken } = await githubFetch(
      `${API}/repos/o/r`,
      {},
      {
        store,
        fetchImpl: api.fetchImpl,
      },
    );

    expect(response.status).toBe(200);
    expect(usedToken).toBe(false);
    expect(api.seen).toEqual(["Bearer stale-env", ""]);
  });

  it("does not send a refused environment token again, but tries the next variable", async () => {
    const store = await storeWith();
    vi.stubEnv("GITHUB_TOKEN", "stale-once");
    vi.stubEnv("GH_TOKEN", "");
    const api = fakeApi();
    await githubFetch(`${API}/repos/o/r`, {}, { store, fetchImpl: api.fetchImpl });
    const after = api.seen.length;
    await githubFetch(`${API}/repos/o/r`, {}, { store, fetchImpl: api.fetchImpl });
    expect(api.seen.slice(after)).toEqual([""]);

    vi.stubEnv("GH_TOKEN", "good-gh");
    const second = fakeApi("good-gh");
    const { usedToken } = await githubFetch(
      `${API}/repos/o/r`,
      {},
      {
        store,
        fetchImpl: second.fetchImpl,
      },
    );
    expect(usedToken).toBe(true);
    expect(second.seen).toEqual(["Bearer good-gh"]);
  });

  it("says a Settings token was refused, and stops sending it", async () => {
    const store = await storeWith("ghp_settings_stale");
    const api = fakeApi();
    const { response, usedToken } = await githubFetch(
      `${API}/repos/o/r`,
      {},
      {
        store,
        fetchImpl: api.fetchImpl,
      },
    );
    expect(response.status).toBe(200);
    expect(usedToken).toBe(false);
    expect(api.seen).toEqual(["Bearer ghp_settings_stale", ""]);
    expect(githubSettingsRefused(await store.githubToken())).not.toBeNull();

    const after = api.seen.length;
    await githubFetch(`${API}/repos/o/r`, {}, { store, fetchImpl: api.fetchImpl });
    expect(api.seen.slice(after)).toEqual([""]);
    expect(githubRefused("settings", true).message).not.toContain("ghp_settings_stale");
  });

  it("sends a Settings token typed after a refusal", async () => {
    const store = await storeWith("ghp_old");
    const api = fakeApi();
    await githubFetch(`${API}/repos/o/r`, {}, { store, fetchImpl: api.fetchImpl });
    await store.setGithubToken("ghp_new");
    expect(githubSettingsRefused(await store.githubToken())).toBeNull();

    const second = fakeApi("ghp_new");
    const { usedToken } = await githubFetch(
      `${API}/repos/o/r`,
      {},
      {
        store,
        fetchImpl: second.fetchImpl,
      },
    );
    expect(usedToken).toBe(true);
    expect(second.seen).toEqual(["Bearer ghp_new"]);
  });

  it("never sends the token to another host, and leaves its 401 alone", async () => {
    const store = await storeWith("ghp_settings");
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_input: Request | URL | string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("nope", { status: 401 });
    });
    const { response, usedToken } = await githubFetch(
      "https://raw.githubusercontent.com/o/r",
      {},
      {
        store,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(response.status).toBe(401);
    expect(usedToken).toBe(false);
    expect(seen).toEqual([""]);
  });

  it("uses the Settings token over the environment's", async () => {
    const store = await storeWith("ghp_settings");
    vi.stubEnv("GITHUB_TOKEN", "env-token");
    const api = fakeApi("ghp_settings");
    await githubFetch(`${API}/repos/o/r`, {}, { store, fetchImpl: api.fetchImpl });
    expect(api.seen).toEqual(["Bearer ghp_settings"]);
  });
});

describe("githubLimitedBy", () => {
  it("says GitHub's limit and when it ends", () => {
    const response = new Response("", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893553440" },
    });
    const limited = githubLimitedBy(response, '{"message":"rate limit"}', false);
    expect(limited).not.toBeNull();
    expect(limited?.token).toBe(false);
    expect(limited?.message).toContain("60 an hour");
    expect(limited?.message).toContain("5,000");
  });

  it("leaves a 403 that is not a limit alone", () => {
    const response = new Response("", { status: 403 });
    expect(githubLimitedBy(response, '{"message":"Resource not accessible"}', true)).toBeNull();
  });

  it("reads Retry-After for a secondary limit", () => {
    const response = new Response("", { status: 429, headers: { "retry-after": "60" } });
    const limited = githubLimitedBy(response, "", true);
    expect(limited?.token).toBe(true);
    expect(limited?.until?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("githubRefused", () => {
  it("names where the token came from, never its value", () => {
    expect(githubRefused("GITHUB_TOKEN", false).message).toContain("GITHUB_TOKEN");
    expect(githubRefused("", false).message).toContain("no token");
    expect(githubRefused("settings", true).message).toContain("Settings");
  });
});
