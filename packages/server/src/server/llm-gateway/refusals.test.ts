import { beforeEach, describe, expect, it } from "vitest";
import {
  fixToolRefusals,
  rememberToolRefusal,
  resetToolRefusals,
  toolRefusalOf,
  toolRefusalsFor,
} from "./refusals.js";

beforeEach(() => resetToolRefusals());

describe("tool refusals", () => {
  it("reads the vendor's words", () => {
    expect(
      toolRefusalOf(
        400,
        '{"error":{"message":"Unsupported Chat Completions API field: tools[0].function.strict"}}',
      ),
    ).toBe("strict");
    expect(
      toolRefusalOf(
        422,
        '{"error":{"message":"Unsupported custom tool: exec. Only apply_patch is supported."}}',
      ),
    ).toBe("custom");
    expect(
      toolRefusalOf(
        400,
        '{"error":{"message":"Requests which include `tool_use` or `tool_result` blocks must define tools"}}',
      ),
    ).toBe("undeclared");
    expect(
      toolRefusalOf(
        400,
        '{"error":{"message":"input_schema does not support oneOf, allOf, or anyOf at the top level"}}',
      ),
    ).toBe("rootUnion");
    expect(toolRefusalOf(400, '{"error":{"message":"invalid request"}}')).toBeNull();
  });

  it("remembers a fault per model", () => {
    rememberToolRefusal("p/m", "strict");
    expect(toolRefusalsFor("p/m").has("strict")).toBe(true);
    expect(toolRefusalsFor("p/other").size).toBe(0);
  });

  it("drops strict from Chat tools", () => {
    const body = fixToolRefusals(
      {
        tools: [
          {
            type: "function",
            function: { name: "f", strict: true, parameters: { type: "object" } },
          },
        ],
      },
      "openai",
      new Set(["strict"]),
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "f", parameters: { type: "object" } } },
    ]);
  });

  it("offers a custom tool as a function taking its input", () => {
    const body = fixToolRefusals(
      { tools: [{ type: "custom", name: "exec", description: "run" }] },
      "openai-responses",
      new Set(["custom"]),
    );
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "exec",
          description: "run",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
          },
        },
      },
    ]);
  });

  it("declares a stub for a tool the history called", () => {
    const body = fixToolRefusals(
      {
        tools: [],
        input: [{ type: "function_call", name: "shell", call_id: "c1", arguments: "{}" }],
      },
      "anthropic",
      new Set(["undeclared"]),
    );
    expect(body.tools).toEqual([
      {
        name: "shell",
        description: "Called earlier in this conversation; not offered now.",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });
});
