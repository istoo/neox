import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectBaseFor,
  detectProviderProtocols,
  fetchProviderModels,
  testProviderModel,
  type ProbeNotice,
} from "./provider-probe.js";

let server: Server;
let origin = "";
const seen: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.method === "GET" && req.url === "/custom/models/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "custom-a" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-b" }, { id: "gpt-a" }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/gemini/v1beta/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "models/gemini-x" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "chatcmpl-1" }));
      return;
    }
    if (req.method === "POST" && req.url === "/denied/v1/chat/completions") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid key" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server did not bind a port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

describe("probe notices", () => {
  it("reports a model list refresh", async () => {
    const notices: ProbeNotice[] = [];
    await fetchProviderModels({ protocol: "openai", baseUrl: `${origin}/v1` }, (notice) =>
      notices.push(notice),
    );
    expect(notices).toEqual([
      expect.objectContaining({ kind: "list", protocol: "openai", status: 200, model: null }),
    ]);
  });

  it("reports a model test with the model it asked", async () => {
    const notices: ProbeNotice[] = [];
    const result = await testProviderModel(
      { protocol: "openai", baseUrl: `${origin}/v1` },
      "gpt-a",
      (notice) => notices.push(notice),
    );
    expect(result.ok).toBe(true);
    expect(notices).toEqual([
      expect.objectContaining({ kind: "test", model: "gpt-a", status: 200 }),
    ]);
  });

  it("reports each protocol a detection tried", async () => {
    const notices: ProbeNotice[] = [];
    const results = await detectProviderProtocols(
      { protocol: "openai", baseUrl: `${origin}/v1` },
      null,
      (notice) => notices.push(notice),
    );
    expect(notices).toHaveLength(results.length);
    expect(notices.every((notice) => notice.kind === "detect")).toBe(true);
    expect(new Set(notices.map((notice) => notice.protocol)).size).toBe(4);
  });
});

describe("fetchProviderModels", () => {
  it("reads an OpenAI model list and sorts it", async () => {
    const models = await fetchProviderModels({ protocol: "openai", baseUrl: `${origin}/v1` });
    expect(models).toEqual(["gpt-a", "gpt-b"]);
  });

  it("asks the provider's own model list URL when it names one", async () => {
    const models = await fetchProviderModels({
      protocol: "openai",
      baseUrl: `${origin}/v1`,
      modelsUrl: `${origin}/custom/models/list`,
    });
    expect(models).toEqual(["custom-a"]);
  });

  it("sends the key as a bearer token", async () => {
    seen.length = 0;
    await fetchProviderModels({ protocol: "openai", baseUrl: `${origin}/v1`, apiKey: "sk-test" });
    expect(seen[0]?.authorization).toBe("Bearer sk-test");
  });

  it("strips the models/ prefix Gemini returns", async () => {
    const models = await fetchProviderModels({
      protocol: "gemini",
      baseUrl: `${origin}/gemini/v1beta`,
    });
    expect(models).toEqual(["gemini-x"]);
  });

  it("sends the key as x-goog-api-key for Gemini", async () => {
    seen.length = 0;
    await fetchProviderModels({
      protocol: "gemini",
      baseUrl: `${origin}/gemini/v1beta`,
      apiKey: "gk-test",
    });
    expect(seen[0]?.["x-goog-api-key"]).toBe("gk-test");
  });

  it("rejects a URL that is not http or https", async () => {
    await expect(
      fetchProviderModels({ protocol: "openai", baseUrl: "file:///etc/passwd" }),
    ).rejects.toThrow(/http/);
  });
});

describe("testProviderModel", () => {
  it("reports a successful probe with the upstream status", async () => {
    const result = await testProviderModel(
      { protocol: "openai", baseUrl: `${origin}/v1` },
      "gpt-a",
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.error).toBeNull();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("carries the vendor's refusal back to the form", async () => {
    const result = await testProviderModel(
      { protocol: "openai", baseUrl: `${origin}/denied/v1` },
      "gpt-a",
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("invalid key");
  });
});

describe("detectBaseFor", () => {
  it("keeps /v1 for OpenAI's two APIs", () => {
    expect(detectBaseFor("openai", "https://relay.example.com")).toBe(
      "https://relay.example.com/v1",
    );
    expect(detectBaseFor("openai-responses", "https://relay.example.com/v1")).toBe(
      "https://relay.example.com/v1",
    );
  });

  it("cuts a full endpoint back to its base", () => {
    expect(detectBaseFor("openai", "https://relay.example.com/v1/chat/completions")).toBe(
      "https://relay.example.com/v1",
    );
  });

  it("gives Anthropic the root", () => {
    expect(detectBaseFor("anthropic", "https://relay.example.com/v1")).toBe(
      "https://relay.example.com",
    );
  });

  it("gives Gemini the /v1beta beside a /v1", () => {
    expect(detectBaseFor("gemini", "https://relay.example.com/v1")).toBe(
      "https://relay.example.com/v1beta",
    );
  });
});

describe("detectProviderProtocols", () => {
  it("asks every protocol and reports which answered", async () => {
    const results = await detectProviderProtocols(
      { protocol: "openai", baseUrl: `${origin}/v1` },
      "gpt-a",
    );
    const byProtocol = new Map(results.map((result) => [result.protocol, result]));
    expect(byProtocol.get("openai")?.ok).toBe(true);
    expect(byProtocol.get("openai-responses")?.ok).toBe(false);
    expect(byProtocol.get("anthropic")?.ok).toBe(false);
    expect(byProtocol.get("gemini")?.ok).toBe(false);
    expect(byProtocol.size).toBe(4);
  });
});
