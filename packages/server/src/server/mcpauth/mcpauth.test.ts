import { mkdtempSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpauthError, McpauthService, readChallenge } from "./mcpauth.js";

const SERVER_URL = "https://mcp.example/mcp";
const METADATA_URL = "https://auth.example/.well-known/oauth-protected-resource";
const AS_METADATA_URL = "https://auth.example/.well-known/oauth-authorization-server";

function home(): string {
  return mkdtempSync(path.join(os.tmpdir(), "neolix-mcpauth-"));
}

interface FakeAuth {
  calls: { url: string; method: string; body?: string }[];
  grants: string[];
  expiresIn: number;
  refusedRefresh: boolean;
}

function fakeAuth(): FakeAuth {
  return { calls: [], grants: [], expiresIn: 3600, refusedRefresh: false };
}

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function fakeFetch(state: FakeAuth): typeof fetch {
  return async (input, init) => {
    const url = fetchUrl(input);
    const method = init?.method ?? "GET";
    state.calls.push({
      url,
      method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url === SERVER_URL) {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${METADATA_URL}", scope="read write"`,
        },
      });
    }
    if (url === METADATA_URL) {
      return jsonResponse({
        resource: SERVER_URL,
        authorization_servers: ["https://auth.example"],
        scopes_supported: ["read", "write"],
      });
    }
    if (url === AS_METADATA_URL) {
      return jsonResponse({
        issuer: "https://auth.example",
        authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token",
        registration_endpoint: "https://auth.example/register",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["read", "write", "offline_access"],
      });
    }
    if (url === "https://auth.example/register") {
      return jsonResponse({ client_id: "client-1" });
    }
    if (url === "https://auth.example/token") {
      const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      const grant = form.get("grant_type") ?? "";
      state.grants.push(grant);
      if (grant === "refresh_token" && state.refusedRefresh) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      return jsonResponse({
        access_token: grant === "refresh_token" ? "access-2" : "access-1",
        refresh_token: grant === "refresh_token" ? "refresh-2" : "refresh-1",
        expires_in: state.expiresIn,
      });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Plays the browser: opens the authorization URL's callback with a code. */
async function finishSignIn(authorizeURL: string, code = "the-code"): Promise<string> {
  const url = new URL(authorizeURL);
  const redirect = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  if (redirect === null || state === null) {
    throw new Error("the authorization URL has no redirect or state");
  }
  const answer = await fetch(`${redirect}?code=${encodeURIComponent(code)}&state=${state}`);
  return answer.text();
}

async function signedIn(): Promise<{
  service: McpauthService;
  auth: FakeAuth;
  name: string;
}> {
  const auth = fakeAuth();
  const service = new McpauthService({ neolixHome: home(), fetch: fakeFetch(auth) });
  const state = await service.start("neon", SERVER_URL);
  expect(state.state).toBe("waiting");
  expect(state.url).toBeDefined();
  const page = await finishSignIn(state.url ?? "");
  expect(page).toContain("signed in to neon");
  return { service, auth, name: "neon" };
}

describe("mcpauth", () => {
  it("signs in through the MCP spec's discovery, registration and PKCE", async () => {
    const { service, auth } = await signedIn();

    // The authorization URL carries PKCE and the resource (RFC 8707).
    const start = auth.calls.find((call) => call.url === SERVER_URL);
    expect(start?.body).toContain('"method":"initialize"');
    expect(auth.grants).toEqual(["authorization_code"]);

    const status = await service.statusOf("neon", SERVER_URL);
    expect(status.signedIn).toBe(true);
    expect(status.dead).toBeUndefined();
    expect(await service.token("neon")).toBe("access-1");
  });

  it("writes the sign-ins privately", async () => {
    const auth = fakeAuth();
    const neolixHome = home();
    const service = new McpauthService({ neolixHome, fetch: fakeFetch(auth) });
    const state = await service.start("neon", SERVER_URL);
    await finishSignIn(state.url ?? "");

    const file = path.join(neolixHome, "mcp-signins.json");
    // Windows cannot express POSIX permissions; the file is private by location there.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(file, "utf8")).neon.access).toBe("access-1");
  });

  it("renews a token that is about to run out", async () => {
    const auth = fakeAuth();
    auth.expiresIn = 60; // inside the renewal lead
    let now = Date.now();
    const service = new McpauthService({
      neolixHome: home(),
      fetch: fakeFetch(auth),
      now: () => now,
    });
    const state = await service.start("neon", SERVER_URL);
    await finishSignIn(state.url ?? "");

    now += 1_000;
    expect(await service.token("neon")).toBe("access-2");
    expect(auth.grants).toEqual(["authorization_code", "refresh_token"]);
  });

  it("marks a sign-in dead when the refresh token is refused", async () => {
    const auth = fakeAuth();
    auth.expiresIn = 60;
    auth.refusedRefresh = true;
    const service = new McpauthService({ neolixHome: home(), fetch: fakeFetch(auth) });
    const state = await service.start("neon", SERVER_URL);
    await finishSignIn(state.url ?? "");

    await expect(service.token("neon")).rejects.toMatchObject({ code: "expired" });
    expect((await service.statusOf("neon", SERVER_URL)).dead).toBe(true);
  });

  it("forgets a sign-in on sign out and moves it on rename", async () => {
    const { service } = await signedIn();

    await service.rename("neon", "neon-two");
    expect((await service.statusOf("neon", SERVER_URL)).signedIn).toBe(false);
    expect((await service.statusOf("neon-two", SERVER_URL)).signedIn).toBe(true);

    await service.signOut("neon-two");
    expect((await service.statusOf("neon-two", SERVER_URL)).signedIn).toBe(false);
    await expect(service.token("neon-two")).rejects.toMatchObject({ code: "not_signed_in" });
  });

  it("says there is nothing to sign in to when the server already answers", async () => {
    const service = new McpauthService({
      neolixHome: home(),
      fetch: async () => jsonResponse({ jsonrpc: "2.0", id: 0, result: {} }),
    });
    await expect(service.start("neon", SERVER_URL)).rejects.toMatchObject({ code: "no_signin" });
  });

  it("keeps a late callback from saving a sign-in the user ended", async () => {
    const auth = fakeAuth();
    const service = new McpauthService({ neolixHome: home(), fetch: fakeFetch(auth) });
    const state = await service.start("neon", SERVER_URL);
    service.cancel(state.id);
    expect(service.progress(state.id)?.state).toBe("canceled");

    const page = await finishSignIn(state.url ?? "");
    expect(page).toContain("already");
    expect((await service.statusOf("neon", SERVER_URL)).signedIn).toBe(false);
  });

  it("reads a bearer challenge's resource metadata and scope", () => {
    const headers = new Headers({
      "www-authenticate": 'Bearer resource_metadata="https://a.example/meta", scope="read write"',
    });
    expect(readChallenge(headers)).toEqual({
      metadata: "https://a.example/meta",
      scope: "read write",
    });
  });

  it("words a refused registration as the page shows it", async () => {
    const service = new McpauthService({
      neolixHome: home(),
      fetch: async (input) => {
        const url = fetchUrl(input);
        if (url === SERVER_URL) {
          return new Response("", {
            status: 401,
            headers: { "www-authenticate": `Bearer resource_metadata="${METADATA_URL}"` },
          });
        }
        if (url === METADATA_URL) {
          return jsonResponse({ authorization_servers: ["https://auth.example"] });
        }
        if (url === AS_METADATA_URL) {
          return jsonResponse({
            authorization_endpoint: "https://auth.example/authorize",
            token_endpoint: "https://auth.example/token",
            registration_endpoint: "https://auth.example/register",
          });
        }
        return jsonResponse({ error: "forbidden" }, 403);
      },
    });
    await expect(service.start("figma", SERVER_URL)).rejects.toBeInstanceOf(McpauthError);
    await expect(service.start("figma", SERVER_URL)).rejects.toMatchObject({
      code: "client_refused",
    });
  });
});
