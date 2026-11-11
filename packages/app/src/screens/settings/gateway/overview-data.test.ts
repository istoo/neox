import { describe, expect, it } from "vitest";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import {
  filterGatewayModels,
  formatContextWindow,
  gatewayKeyLabel,
  gatewayKeySecret,
  listGatewayModels,
  maskGatewayKey,
  parseGatewayListen,
} from "./overview-data";
import { buildGatewaySnippet, gatewayBaseUrl, gatewayEnvVars } from "./overview-snippets";

describe("parseGatewayListen", () => {
  it("names the loopback origin a daemon bound to this computer listens on", () => {
    expect(parseGatewayListen("127.0.0.1:6768")).toEqual({
      kind: "loopback",
      listen: "127.0.0.1:6768",
      port: 6768,
      thisComputerUrl: "http://127.0.0.1:6768",
      networkUrl: null,
    });
  });

  it("keeps the loopback origin when the daemon binds every interface", () => {
    expect(parseGatewayListen("0.0.0.0:6768")).toMatchObject({
      kind: "wildcard",
      thisComputerUrl: "http://127.0.0.1:6768",
      networkUrl: null,
      port: 6768,
    });
  });

  it("names the network origin when the daemon binds one network address", () => {
    expect(parseGatewayListen("192.168.1.20:3425")).toMatchObject({
      kind: "network",
      thisComputerUrl: null,
      networkUrl: "http://192.168.1.20:3425",
    });
  });

  it("brackets an IPv6 host", () => {
    expect(parseGatewayListen("[::1]:6768")).toMatchObject({
      kind: "loopback",
      thisComputerUrl: "http://[::1]:6768",
    });
    expect(parseGatewayListen("[::]:6768")).toMatchObject({
      kind: "wildcard",
      thisComputerUrl: "http://127.0.0.1:6768",
    });
  });

  it("reports a socket as unreachable from another computer", () => {
    expect(parseGatewayListen("/tmp/neolix.sock")).toMatchObject({
      kind: "socket",
      thisComputerUrl: null,
      networkUrl: null,
    });
    expect(parseGatewayListen("\\\\.\\pipe\\neolix")).toMatchObject({ kind: "socket" });
  });

  it("does not invent an address for an unknown value", () => {
    expect(parseGatewayListen(null).kind).toBe("unknown");
    expect(parseGatewayListen("").kind).toBe("unknown");
    expect(parseGatewayListen("nonsense").kind).toBe("unknown");
    expect(parseGatewayListen("127.0.0.1:99999").kind).toBe("unknown");
  });
});

const config: GatewayConfigWire = {
  version: 1,
  providers: [
    {
      id: "zai",
      label: "Z.AI",
      protocol: "anthropic",
      baseUrl: "https://api.z.ai",
      models: [{ id: "glm-5.3", label: "GLM 5.3", contextWindow: 1_000_000 }],
    },
    {
      id: "deepseek",
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      models: [{ id: "deepseek-v4-pro", contextWindow: 128_000 }],
    },
  ],
  groups: [{ id: "coding", label: "Coding", members: ["zai/glm-5.3", "deepseek/deepseek-v4-pro"] }],
};

describe("gateway model catalog", () => {
  it("lists routing groups first, then provider models, with labels and context", () => {
    expect(listGatewayModels(config).map((model) => model.id)).toEqual([
      "group/coding",
      "zai/glm-5.3",
      "deepseek/deepseek-v4-pro",
    ]);
    const [group, zai, deepseek] = listGatewayModels(config);
    expect(group).toMatchObject({ label: "Coding", group: true, contextWindow: null });
    expect(zai).toMatchObject({
      label: "GLM 5.3",
      providerLabel: "Z.AI",
      contextWindow: 1_000_000,
    });
    expect(deepseek).toMatchObject({
      label: "deepseek-v4-pro",
      providerLabel: "deepseek",
      contextWindow: 128_000,
    });
  });

  it("matches words against ids, names, providers and group members", () => {
    const models = listGatewayModels(config);
    expect(filterGatewayModels(models, "coding").map((model) => model.id)).toEqual([
      "group/coding",
    ]);
    expect(filterGatewayModels(models, "zai glm").map((model) => model.id)).toEqual([
      "group/coding",
      "zai/glm-5.3",
    ]);
    expect(filterGatewayModels(models, "  ")).toHaveLength(3);
    expect(filterGatewayModels(models, "missing")).toEqual([]);
  });

  it("formats context windows as uppercase badges", () => {
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_048_576)).toBe("1M");
    expect(formatContextWindow(922_000)).toBe("922K");
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(8_000)).toBe("8K");
    expect(formatContextWindow(512)).toBe("512");
  });

  it("reads a key entry's secret and label from either shape", () => {
    expect(gatewayKeySecret("sk-plain")).toBe("sk-plain");
    expect(gatewayKeySecret({ key: "sk-object", label: "team" })).toBe("sk-object");
    expect(gatewayKeyLabel("sk-plain")).toBe("sk-p…in");
    expect(gatewayKeyLabel({ key: "sk-object", label: "team" })).toBe("team");
    expect(maskGatewayKey("abc")).toBe("abc");
  });
});

describe("gateway snippets", () => {
  it("uses /v1 for OpenAI and the origin for Anthropic and Gemini", () => {
    expect(gatewayBaseUrl("http://127.0.0.1:6768", "openai")).toBe("http://127.0.0.1:6768/v1");
    expect(gatewayBaseUrl("http://127.0.0.1:6768", "responses")).toBe("http://127.0.0.1:6768/v1");
    expect(gatewayBaseUrl("http://127.0.0.1:6768", "anthropic")).toBe("http://127.0.0.1:6768");
    expect(gatewayBaseUrl("http://127.0.0.1:6768", "gemini")).toBe("http://127.0.0.1:6768");
  });

  it("names the variables each CLI reads", () => {
    expect(gatewayEnvVars("openai", "http://h:1", "k")).toEqual([
      { name: "OPENAI_BASE_URL", value: "http://h:1/v1" },
      { name: "OPENAI_API_KEY", value: "k" },
    ]);
    expect(gatewayEnvVars("anthropic", "http://h:1", "k")).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://h:1" },
      { name: "ANTHROPIC_AUTH_TOKEN", value: "k" },
    ]);
  });

  it("builds a runnable curl command with the chosen model", () => {
    const snippet = buildGatewaySnippet({
      api: "openai",
      language: "curl",
      origin: "http://127.0.0.1:6768",
      model: "deepseek/deepseek-v4-pro",
      apiKey: "neolix",
    });
    expect(snippet).toContain("http://127.0.0.1:6768/v1/chat/completions");
    expect(snippet).toContain("Authorization: Bearer neolix");
    expect(snippet).toContain("deepseek/deepseek-v4-pro");
  });

  it("builds the Gemini path with the model in it", () => {
    const snippet = buildGatewaySnippet({
      api: "gemini",
      language: "curl",
      origin: "http://127.0.0.1:6768",
      model: "zai/glm-5.3",
      apiKey: "neolix",
    });
    expect(snippet).toContain("/v1beta/models/zai/glm-5.3:generateContent");
    expect(snippet).toContain("x-goog-api-key: neolix");
  });

  it("exports the variables in the shell snippet", () => {
    const snippet = buildGatewaySnippet({
      api: "anthropic",
      language: "shell",
      origin: "http://127.0.0.1:6768",
      model: "zai/glm-5.3",
      apiKey: "it's",
    });
    expect(snippet).toBe(
      "export ANTHROPIC_BASE_URL='http://127.0.0.1:6768'\nexport ANTHROPIC_AUTH_TOKEN='it'\\''s'",
    );
  });
});
