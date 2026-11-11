import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearVertexTokens,
  normalizeVertex,
  vertexAccessToken,
  vertexAuth,
  vertexBase,
  vertexCheck,
  vertexClaude,
  vertexClaudeRequest,
  vertexCredentialsFile,
  vertexHost,
  vertexPartner,
  vertexPath,
  vertexWholePath,
} from "./vertex-auth.js";

const dirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "neolix-vertex-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, body: unknown | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });
}

beforeEach(() => {
  clearVertexTokens();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Call {
  url: string;
  init: RequestInit;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recorder(handler: (url: string, init: RequestInit) => Response): {
  calls: Call[];
  fetchImpl: typeof fetch;
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const request = init ?? {};
    calls.push({ url, init: request });
    return handler(url, request);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const SERVICE_ACCOUNT_EMAIL = ["sa", "proj.iam.gserviceaccount.com"].join("@");

describe("vertex settings", () => {
  it("keeps trimmed lower-case values at global when no location is given", () => {
    expect(normalizeVertex({ project: " My-Proj ", location: " US-Central1 " })).toEqual({
      project: "my-proj",
      location: "us-central1",
      credentials: "",
      impersonate: "",
    });
    expect(normalizeVertex({ project: "proj-1" })?.location).toBe("global");
    expect(normalizeVertex({})).toBeNull();
    expect(normalizeVertex(null)).toBeNull();
  });

  it("says why settings can't serve", () => {
    expect(vertexCheck({ project: "" })).toBe(
      "Google Vertex AI needs the id of your Google Cloud project",
    );
    expect(vertexCheck({ project: "Bad_Id" })).toContain("is no Google Cloud project id");
    expect(vertexCheck({ project: "proj-1", location: "us central" })).toContain(
      "is no Vertex AI location",
    );
    expect(vertexCheck({ project: "proj-1", credentials: "creds.json" })).toContain(
      "give the credentials file's full path",
    );
    expect(vertexCheck({ project: "proj-1", credentials: "~/creds.json" })).toBeNull();
    expect(vertexCheck({ project: "proj-1", impersonate: "no-email" })).toContain(
      "is no service account's email",
    );
    expect(vertexCheck({ project: "my-proj-123", location: "eu" })).toBeNull();
  });

  it("names the host by location", () => {
    expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexHost("us")).toBe("aiplatform.us.rep.googleapis.com");
    expect(vertexHost("eu")).toBe("aiplatform.eu.rep.googleapis.com");
    expect(vertexHost("us-central1")).toBe("us-central1-aiplatform.googleapis.com");
  });

  it("puts a project's base and a model's path together", () => {
    expect(vertexBase({ project: "my-proj", location: "us" })).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/my-proj/locations/us",
    );
    expect(vertexBase({ project: "bad_id" })).toBe("");
    expect(vertexPath("gemini-3.8-flash", true)).toBe(
      "/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    );
    expect(vertexPath("gemini-3.8-flash", false)).toBe(
      "/publishers/google/models/gemini-3.8-flash:generateContent",
    );
    expect(vertexWholePath("gemini-3.8-flash")).toBe(
      "/publishers/google/models/gemini-3.8-flash:generateContent",
    );
  });

  it("tells partner and Claude models from Gemini's own", () => {
    expect(vertexPartner("deepseek-ai/deepseek-v4.1-flash-maas")).toBe(true);
    expect(vertexPartner("gemini-3.8-flash")).toBe(false);
    expect(vertexClaude("claude-opus-5-5")).toBe(true);
    expect(vertexClaude("Claude-Sonnet-4-5@20250929")).toBe(true);
    expect(vertexClaude("deepseek-ai/claude-x")).toBe(false);
    expect(vertexClaude("gemini-3.8-flash")).toBe(false);
  });
});

describe("vertexClaudeRequest", () => {
  it("moves a streamed message's model into the path and names the version", () => {
    const out = vertexClaudeRequest(
      "/v1/messages?beta=true",
      JSON.stringify({
        model: "claude-sonnet-4-5@20250929",
        stream: true,
        max_tokens: 8,
      }),
    );
    expect(out?.path).toBe(
      "/publishers/anthropic/models/claude-sonnet-4-5@20250929:streamRawPredict",
    );
    const body = JSON.parse(out?.body ?? "{}") as Record<string, unknown>;
    expect(body.model).toBeUndefined();
    expect(body.anthropic_version).toBe("vertex-2023-10-16");
    expect(body.stream).toBe(true);
  });

  it("answers one message whole and keeps a count's model in the body", () => {
    const whole = vertexClaudeRequest("/v1/messages", JSON.stringify({ model: "claude-opus-5-5" }));
    expect(whole?.path).toBe("/publishers/anthropic/models/claude-opus-5-5:rawPredict");
    const count = vertexClaudeRequest(
      "/v1/messages/count_tokens",
      JSON.stringify({ model: "claude-opus-5-5" }),
    );
    expect(count?.path).toBe("/publishers/anthropic/models/count-tokens:rawPredict");
    expect((JSON.parse(count?.body ?? "{}") as Record<string, unknown>).model).toBe(
      "claude-opus-5-5",
    );
  });

  it("keeps a version the body names and refuses a body with no model", () => {
    const named = vertexClaudeRequest(
      "/v1/messages",
      JSON.stringify({ model: "claude-opus-5-5", anthropic_version: "vertex-2024-01-01" }),
    );
    expect((JSON.parse(named?.body ?? "{}") as Record<string, unknown>).anthropic_version).toBe(
      "vertex-2024-01-01",
    );
    expect(vertexClaudeRequest("/v1/messages", "{}")).toBeNull();
    expect(vertexClaudeRequest("/v1/messages", "not json")).toBeNull();
  });
});

describe("vertexCredentialsFile", () => {
  it("takes the file given, with ~ made the home folder", async () => {
    const home = tempHome();
    expect(await vertexCredentialsFile("~/gcp/creds.json", { home })).toBe(
      join(home, "gcp", "creds.json"),
    );
    expect(await vertexCredentialsFile("/abs/creds.json", { home })).toBe("/abs/creds.json");
  });

  it("finds Application Default Credentials in the environment, else gcloud's folder", async () => {
    const home = tempHome();
    expect(
      await vertexCredentialsFile("", {
        home,
        env: { GOOGLE_APPLICATION_CREDENTIALS: "~/adc.json" },
      }),
    ).toBe(join(home, "adc.json"));
    expect(await vertexCredentialsFile("", { home, env: {} })).toBe(
      join(home, ".config", "gcloud", "application_default_credentials.json"),
    );
    expect(await vertexCredentialsFile("", { home, env: { CLOUDSDK_CONFIG: "/gcloud" } })).toBe(
      "/gcloud/application_default_credentials.json",
    );
  });

  it("refuses a variable that is no full path", async () => {
    const home = tempHome();
    await expect(
      vertexCredentialsFile("", { home, env: { GOOGLE_APPLICATION_CREDENTIALS: "adc.json" } }),
    ).rejects.toThrow("not a full path");
  });
});

describe("vertexAccessToken", () => {
  it("mints from a person's credentials and keeps the token until it nearly lapses", async () => {
    const home = tempHome();
    const file = join(home, "adc.json");
    write(file, {
      type: "authorized_user",
      client_id: "client-1",
      client_secret: "secret-1",
      refresh_token: "refresh-1",
    });
    const { calls, fetchImpl } = recorder((_url, init) => {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("refresh-1");
      return jsonResponse({
        access_token: calls.length === 1 ? "tok-1" : "tok-2",
        expires_in: 3600,
      });
    });
    let clock = 1_700_000_000_000;
    const options = { home, env: {}, fetchImpl, now: () => clock };

    const first = await vertexAuth(
      { project: "my-proj", location: "us", credentials: file },
      options,
    );
    expect("error" in first).toBe(false);
    if ("error" in first) {
      throw new Error(first.error);
    }
    expect(first.headers.authorization).toBe("Bearer tok-1");
    expect(first.baseUrl).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1/projects/my-proj/locations/us",
    );

    const kept = await vertexAccessToken({ project: "my-proj", credentials: file }, options);
    expect(kept).toEqual({ token: "tok-1", expiresAt: clock + 3600_000 });
    expect(calls).toHaveLength(1);

    clock += 3600_000 - 299_000;
    const renewed = await vertexAccessToken({ project: "my-proj", credentials: file }, options);
    expect(renewed).toMatchObject({ token: "tok-2" });
    expect(calls).toHaveLength(2);
  });

  it("mints once for requests made together", async () => {
    const home = tempHome();
    const file = join(home, "adc.json");
    write(file, {
      type: "authorized_user",
      client_id: "client-1",
      client_secret: "secret-1",
      refresh_token: "refresh-1",
    });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse({ access_token: "tok", expires_in: 3600 }),
    );
    const options = { home, env: {}, fetchImpl };
    const minting = fetchImpl;
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await gate;
      return minting(input, init);
    }) as typeof fetch;
    const both = Promise.all([
      vertexAccessToken({ project: "proj-1", credentials: file }, { ...options, fetchImpl: slow }),
      vertexAccessToken({ project: "proj-1", credentials: file }, { ...options, fetchImpl: slow }),
    ]);
    release?.();
    const [a, b] = await both;
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
  });

  it("mints again when the file changed", async () => {
    const home = tempHome();
    const file = join(home, "adc.json");
    const creds = {
      type: "authorized_user",
      client_id: "client-1",
      client_secret: "secret-1",
      refresh_token: "refresh-1",
    };
    write(file, creds);
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse({ access_token: `tok-${calls.length}`, expires_in: 3600 }),
    );
    const options = { home, env: {}, fetchImpl };
    await vertexAccessToken({ project: "proj-1", credentials: file }, options);
    write(file, { ...creds, client_id: "client-1-changed-size" });
    const again = await vertexAccessToken({ project: "proj-1", credentials: file }, options);
    expect(again).toMatchObject({ token: "tok-2" });
    expect(calls).toHaveLength(2);
  });
});

describe("vertexAccessToken with a service account key", () => {
  it("signs a JWT Google can verify", async () => {
    const home = tempHome();
    const file = join(home, "key.json");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    write(file, {
      type: "service_account",
      client_email: SERVICE_ACCOUNT_EMAIL,
      private_key_id: "key-1",
      private_key: privateKey,
    });
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse({ access_token: "tok", expires_in: 1800 }),
    );
    const now = 1_700_000_000_000;
    const result = await vertexAccessToken(
      { project: "proj-1", credentials: file },
      { home, env: {}, fetchImpl, now: () => now },
    );
    expect(result).toEqual({ token: "tok", expiresAt: now + 1800_000 });
    expect(calls).toHaveLength(1);

    const form = new URLSearchParams(String(calls[0]?.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion") ?? "";
    const [header, claims, signature] = assertion.split(".");
    expect(header && claims && signature).toBeTruthy();
    const head = JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")) as Record<
      string,
      string
    >;
    expect(head).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
    const body = JSON.parse(Buffer.from(claims ?? "", "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(body.iss).toBe(SERVICE_ACCOUNT_EMAIL);
    expect(body.scope).toBe("https://www.googleapis.com/auth/cloud-platform");
    expect(body.aud).toBe("https://oauth2.googleapis.com/token");
    expect(Number(body.exp) - Number(body.iat)).toBe(3600);
    expect(Number(body.iat)).toBe(Math.trunc(now / 1000) - 10);

    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${claims}`);
    expect(verify.verify(publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
  });
});

describe("vertexAccessToken with impersonation", () => {
  const source = {
    type: "authorized_user",
    client_id: "client-1",
    client_secret: "secret-1",
    refresh_token: "refresh-1",
  };

  it("trades an impersonated file's source token for the account's at IAM", async () => {
    const home = tempHome();
    const file = join(home, "impersonated.json");
    const account = ["writer", "proj.iam.gserviceaccount.com"].join("@");
    write(file, {
      type: "impersonated_service_account",
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
      delegates: ["chain", "proj.iam.gserviceaccount.com"],
      source_credentials: source,
    });
    const { calls, fetchImpl } = recorder((url) => {
      if (url.includes("iamcredentials")) {
        return jsonResponse({
          accessToken: "impersonated-token",
          expireTime: "2026-11-06T12:00:00Z",
        });
      }
      return jsonResponse({ access_token: "source-token", expires_in: 3600 });
    });
    const result = await vertexAccessToken(
      { project: "proj-1", credentials: file },
      { home, env: {}, fetchImpl },
    );
    expect(result).toEqual({
      token: "impersonated-token",
      expiresAt: Date.parse("2026-11-06T12:00:00Z"),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[1]?.url).toBe(
      `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateAccessToken`,
    );
    const traded = calls[1]?.init.headers as Record<string, string> | undefined;
    expect(traded?.authorization).toBe("Bearer source-token");
    const body = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(body.scope).toEqual(["https://www.googleapis.com/auth/cloud-platform"]);
    expect(body.lifetime).toBe("3600s");
    expect(body.delegates).toEqual([
      "projects/-/serviceAccounts/chain",
      "projects/-/serviceAccounts/proj.iam.gserviceaccount.com",
    ]);
  });

  it("trades a provider's own credentials for the email it names", async () => {
    const home = tempHome();
    const file = join(home, "adc.json");
    write(file, source);
    const { calls, fetchImpl } = recorder((url) =>
      url.includes("iamcredentials")
        ? jsonResponse({ accessToken: "traded" })
        : jsonResponse({ access_token: "own", expires_in: 3600 }),
    );
    const result = await vertexAccessToken(
      { project: "proj-1", credentials: file, impersonate: SERVICE_ACCOUNT_EMAIL },
      { home, env: {}, fetchImpl },
    );
    expect(result).toMatchObject({ token: "traded" });
    expect(calls[1]?.url).toContain(SERVICE_ACCOUNT_EMAIL);
  });
});

describe("vertexAccessToken failures", () => {
  it("says how to sign in again when a person's credentials are refused", async () => {
    const home = tempHome();
    const file = join(home, ".config", "gcloud", "application_default_credentials.json");
    write(file, {
      type: "authorized_user",
      client_id: "client-1",
      client_secret: "secret-1",
      refresh_token: "refresh-1",
    });
    const { fetchImpl } = recorder(() =>
      jsonResponse({ error: "invalid_grant", error_description: "Bad Request" }, 400),
    );
    const result = await vertexAccessToken({ project: "proj-1" }, { home, env: {}, fetchImpl });
    expect(result).toEqual({
      error:
        "the Google credentials in " +
        file +
        ": Bad Request; sign in again with `gcloud auth application-default login`",
    });
  });

  it("refuses a sovereign cloud's credentials and workload identity federation", async () => {
    const home = tempHome();
    const universe = join(home, "universe.json");
    write(universe, {
      type: "authorized_user",
      client_id: "c",
      refresh_token: "r",
      universe_domain: "example.com",
    });
    const { fetchImpl } = recorder(() => jsonResponse({}));
    const options = { home, env: {}, fetchImpl };
    await expect(
      vertexAccessToken({ project: "proj-1", credentials: universe }, options),
    ).resolves.toEqual({
      error: `the Google credentials in ${universe}: they are for example.com; Vertex AI is asked at googleapis.com`,
    });

    const federated = join(home, "federated.json");
    write(federated, { type: "external_account" });
    await expect(
      vertexAccessToken({ project: "proj-1", credentials: federated }, options),
    ).resolves.toEqual({
      error: `the Google credentials in ${federated}: workload identity federation (external_account) isn't read: use a person's credentials, a service account key, or impersonation`,
    });
  });

  it("says which file is missing and how to make one", async () => {
    const home = tempHome();
    const { fetchImpl } = recorder(() => jsonResponse({}));
    const given = join(home, "nope.json");
    await expect(
      vertexAccessToken({ project: "proj-1", credentials: given }, { home, env: {}, fetchImpl }),
    ).resolves.toEqual({
      error: `no Google credentials at ${given}: correct the provider's credentials file, or clear it to use Application Default Credentials`,
    });

    const fromEnv = await vertexAccessToken(
      { project: "proj-1" },
      { home, env: { GOOGLE_APPLICATION_CREDENTIALS: "~/nope.json" }, fetchImpl },
    );
    expect("error" in fromEnv && fromEnv.error).toContain("GOOGLE_APPLICATION_CREDENTIALS names");

    const adc = await vertexAccessToken({ project: "proj-1" }, { home, env: {}, fetchImpl });
    expect("error" in adc && adc.error).toContain(
      "sign in with `gcloud auth application-default login`",
    );
  });

  it("checks the project before reading any credentials", async () => {
    const result = await vertexAuth({ project: "" });
    expect(result).toEqual({ error: "Google Vertex AI needs the id of your Google Cloud project" });
  });
});
