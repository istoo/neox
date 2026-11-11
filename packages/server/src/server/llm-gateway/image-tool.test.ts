import { describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import {
  imageToolRefusedBefore,
  markImageToolRefused,
  mayDropImageTool,
  withoutImageToolRequest,
} from "./image-tool.js";

function provider(protocol: GatewayProvider["protocol"], baseUrl: string): GatewayProvider {
  return {
    id: "probe",
    protocol,
    baseUrl,
    accounts: [],
    countFree: false,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    models: [],
  };
}

const namespaced = {
  model: "m",
  tools: [
    {
      type: "namespace",
      name: "image_gen",
      tools: [{ type: "function", name: "imagegen", parameters: { type: "object" } }],
    },
    { type: "function", name: "read_file", parameters: { type: "object" } },
  ],
};

describe("Codex's image tool", () => {
  it("may be dropped only from a third-party Responses API", () => {
    expect(mayDropImageTool(provider("openai-responses", "https://api.example.com/v1"))).toBe(true);
    expect(mayDropImageTool(provider("openai-responses", "https://api.openai.com/v1"))).toBe(false);
    expect(mayDropImageTool(provider("openai", "https://api.example.com/v1"))).toBe(false);
    expect(mayDropImageTool(provider("anthropic", "https://api.example.com/v1"))).toBe(false);
  });

  it("takes the namespace out and keeps the other tools", () => {
    const { body, had } = withoutImageToolRequest(namespaced);
    expect(had).toBe(true);
    expect(body.tools).toEqual([
      { type: "function", name: "read_file", parameters: { type: "object" } },
    ]);
    expect(body.tool_choice).toBeUndefined();
  });

  it("takes Codex's flat spelling out too", () => {
    const { body, had } = withoutImageToolRequest({
      model: "m",
      tools: [
        { type: "function", name: "image_gen__imagegen", parameters: { type: "object" } },
        { type: "function", name: "read_file", parameters: { type: "object" } },
      ],
      tool_choice: "auto",
    });
    expect(had).toBe(true);
    expect(body.tools).toEqual([
      { type: "function", name: "read_file", parameters: { type: "object" } },
    ]);
    expect(body.tool_choice).toBe("auto");
  });

  it("leaves a body without the tool as it was, and remembers a refusal", () => {
    const body = { model: "m", tools: [{ type: "function", name: "read_file" }] };
    expect(withoutImageToolRequest(body)).toEqual({ body, had: false });
    expect(imageToolRefusedBefore("probe")).toBe(false);
    markImageToolRefused("probe");
    expect(imageToolRefusedBefore("probe")).toBe(true);
  });
});
