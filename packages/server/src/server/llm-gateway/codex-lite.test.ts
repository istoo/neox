import { describe, expect, it } from "vitest";
import {
  chatGptAccount,
  forVendor,
  fromLite,
  keepsAccessPrograms,
  liftAdditionalTools,
  liteKept,
  withoutAccessPrograms,
  withoutLiteMetadata,
  withoutReasoningContext,
  type Json,
} from "./codex-lite.js";

/** A request as Codex's Responses Lite sends it (myna's `liteRequest`). */
function liteRequest(): Json {
  return {
    model: "fake/m1",
    instructions: "",
    stream: true,
    input: [
      {
        type: "additional_tools",
        id: "at_1",
        role: "developer",
        tools: [
          { type: "tool_search", execution: "client", description: "Search tools" },
          {
            type: "namespace",
            name: "functions",
            description: "Default tools",
            tools: [
              { type: "function", name: "shell", description: "Run a command" },
              { type: "custom", name: "apply_patch", description: "Patch files" },
            ],
          },
          {
            type: "namespace",
            name: "mcp__probe",
            description: "Probe",
            tools: [{ type: "function", name: "read" }],
          },
        ],
      },
      { type: "message", id: "msg_1", role: "developer", content: "You are Codex." },
      { type: "message", role: "user", content: "list the files" },
      { type: "function_call", call_id: "c1", name: "shell", namespace: "functions" },
      { type: "function_call_output", call_id: "c1", output: "a.txt" },
    ],
  };
}

function toolsOf(body: Json): Json[] {
  return Array.isArray(body.tools) ? (body.tools as Json[]) : [];
}

describe("liftAdditionalTools", () => {
  it("moves Codex's own tools out of the namespace and into the tools", () => {
    const { body, changed } = liftAdditionalTools(liteRequest());
    expect(changed).toBe(true);
    expect(toolsOf(body).map((tool) => `${String(tool.type)}:${String(tool.name)}`)).toEqual([
      "tool_search:undefined",
      "function:shell",
      "custom:apply_patch",
      "namespace:mcp__probe",
    ]);
    const input = body.input as Json[];
    expect(input.map((item) => item.role ?? item.type)).toEqual([
      "developer",
      "user",
      "function_call",
      "function_call_output",
    ]);
    // a call made earlier under the namespace is the plain call it now is
    expect(input[2]?.namespace).toBeUndefined();
  });

  it("adds a namespace again only the tools it did not have", () => {
    const input: Json = {
      model: "m",
      tools: [
        { type: "function", name: "shell" },
        { type: "namespace", name: "mcp__probe", tools: [{ type: "function", name: "write" }] },
      ],
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "function", name: "shell", description: "again" }],
            },
            {
              type: "namespace",
              name: "mcp__probe",
              tools: [
                { type: "function", name: "read" },
                { type: "function", name: "write" },
              ],
            },
          ],
        },
        { type: "message", role: "user", content: "hi" },
      ],
    };
    const { body } = liftAdditionalTools(input);
    const tools = toolsOf(body);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.description).toBeUndefined();
    const namespace = tools[1] ?? {};
    expect(
      (Array.isArray(namespace.tools) ? namespace.tools : []).map((tool) => (tool as Json).name),
    ).toEqual(["write", "read"]);
    expect((body.input as Json[]).map((item) => item.type)).toEqual(["message"]);
  });

  it("leaves a request without one as it was", () => {
    const plain: Json = { model: "m", input: "what are additional_tools?" };
    const result = liftAdditionalTools(plain);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(plain);
  });

  it("drops an empty additional_tools and the tools member it alone filled", () => {
    const { body } = liftAdditionalTools({
      model: "m",
      input: [
        { type: "additional_tools", tools: [] },
        { type: "message", role: "user", content: "hi" },
      ],
    });
    expect(body.tools).toBeUndefined();
    expect((body.input as Json[]).map((item) => item.type)).toEqual(["message"]);
  });

  it("is a no-op the second time", () => {
    const once = liftAdditionalTools(liteRequest()).body;
    const twice = liftAdditionalTools(once);
    expect(twice.changed).toBe(false);
    expect(twice.body).toBe(once);
  });
});

describe("fromLite", () => {
  it("takes the reasoning context off", () => {
    const result = withoutReasoningContext({
      reasoning: { effort: "xhigh", context: "all_turns" },
    });
    expect(result.body.reasoning).toEqual({ effort: "xhigh" });
  });

  it("takes the Lite marker out of client_metadata", () => {
    const result = withoutLiteMetadata({
      client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: "true" },
    });
    expect(result.body.client_metadata).toEqual({});
  });

  it("takes all three off even when there are no additional_tools", () => {
    const { body, changed } = fromLite({
      model: "m",
      reasoning: { effort: "high", context: "all_turns" },
      client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: "true" },
      input: [],
    });
    expect(changed).toBe(true);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.client_metadata).toEqual({});
  });

  it("leaves a request that was never Lite alone", () => {
    const plain: Json = { model: "m", input: [{ type: "message", role: "user" }] };
    const result = fromLite(plain);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(plain);
  });
});

describe("forVendor", () => {
  it("leaves OpenAI's own request as it came", () => {
    const body: Json = { stream_options: { reasoning_summary_delivery: "sequential" } };
    const result = forVendor(body, { openAi: true });
    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
  });

  it("takes OpenAI's own fields out for another vendor", () => {
    const { body, changed } = forVendor(
      {
        model: "m",
        stream_options: { reasoning_summary_delivery: "sequential" },
        include: ["output.encrypted_content", "reasoning.encrypted_content"],
        reasoning: { effort: "low" },
        input: [
          { type: "message", role: "user", internal_chat_message_metadata_passthrough: {} },
          { type: "function_call", call_id: "c1", encrypted_function_args: "sealed" },
          { type: "message", role: "assistant", encrypted_content: "openai-only" },
          { type: "reasoning", encrypted_content: "kept" },
          { type: "configuration_update", reasoning: { effort: "xhigh" } },
        ],
      },
      { openAi: false },
    );
    expect(changed).toBe(true);
    expect(body.stream_options).toBeUndefined();
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.reasoning).toEqual({ effort: "xhigh" });
    const input = body.input as Json[];
    expect(input[0]?.internal_chat_message_metadata_passthrough).toBeUndefined();
    expect(input[1]?.encrypted_function_args).toBeUndefined();
    expect(input[2]?.encrypted_content).toBeUndefined();
    expect(input[3]?.encrypted_content).toBe("kept");
    expect(input.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "message",
      "reasoning",
    ]);
  });

  it("keeps the other stream options a client set", () => {
    const { body } = forVendor(
      { stream_options: { include_usage: true, reasoning_summary_delivery: "sequential" } },
      { openAi: false },
    );
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("turns developer messages into system ones for myna's own compaction", () => {
    const { body } = forVendor(
      {
        input: [
          { type: "message", role: "developer", content: "summarise" },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      { openAi: false, compaction: true },
    );
    expect((body.input as Json[]).map((item) => item.role)).toEqual(["system", "user"]);
  });

  it("leaves a request with none of them as it came", () => {
    const plain: Json = { model: "m", input: [{ type: "message", role: "user" }] };
    const result = forVendor(plain, { openAi: false });
    expect(result.changed).toBe(false);
    expect(result.body).toBe(plain);
  });
});

describe("access_programs", () => {
  it("goes to OpenAI and a ChatGPT account, and leaves the rest", () => {
    expect(keepsAccessPrograms({ baseUrl: "https://api.openai.com/v1", accounts: [] }, false)).toBe(
      true,
    );
    expect(
      keepsAccessPrograms(
        { baseUrl: "https://relay.test/v1", accounts: [{ agent: "chatgpt-api" }] },
        false,
      ),
    ).toBe(true);
    expect(
      keepsAccessPrograms(
        { baseUrl: "https://relay.test/v1", codexAsSent: true, accounts: [] },
        true,
      ),
    ).toBe(true);
    expect(
      keepsAccessPrograms(
        { baseUrl: "https://relay.test/v1", codexAsSent: true, accounts: [] },
        false,
      ),
    ).toBe(false);
  });

  it("takes the field off a request leaving OpenAI", () => {
    expect(
      withoutAccessPrograms({ access_programs: ["cyber"] }).body.access_programs,
    ).toBeUndefined();
    expect(withoutAccessPrograms({ model: "m" }).changed).toBe(false);
  });
});

describe("liteKept", () => {
  it("keeps the shape for OpenAI, a ChatGPT account, and a codex-as-sent relay", () => {
    expect(
      liteKept({ baseUrl: "https://api.openai.com/v1", accounts: [] }, { fromCodex: false }),
    ).toBe(true);
    expect(
      liteKept(
        { baseUrl: "https://relay.test/v1", accounts: [{ agent: "chatgpt-api" }] },
        { fromCodex: false },
      ),
    ).toBe(true);
    expect(
      liteKept(
        { baseUrl: "https://relay.test/v1", codexAsSent: true, accounts: [] },
        { fromCodex: true },
      ),
    ).toBe(true);
    expect(
      liteKept(
        { baseUrl: "https://relay.test/v1", codexAsSent: true, accounts: [] },
        { fromCodex: false },
      ),
    ).toBe(false);
  });

  it("does not take a key+URL provider for a ChatGPT account", () => {
    expect(
      chatGptAccount({ baseUrl: "https://relay.test/v1", accounts: [{ agent: "gemini" }] }),
    ).toBe(false);
    expect(
      chatGptAccount({ baseUrl: "https://relay.test/v1", accounts: [{ agent: "chatgpt-api" }] }),
    ).toBe(true);
  });
});
