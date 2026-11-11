import { describe, expect, it } from "vitest";
import {
  searchAsFunction,
  TOOL_SEARCH,
  ToolSearchTidy,
  toolSearchResponse,
  toolSearchEvent,
} from "./toolsearch.js";

/** A Codex turn with its tool search (#258), as Codex sends it. */
function request(input: unknown = []): Record<string, unknown> {
  return {
    model: "m",
    tools: [
      { type: "function", name: "exec_command", parameters: { type: "object" } },
      {
        type: "tool_search",
        execution: "client",
        description: "# Tool discovery\nSearches over deferred tool metadata.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" }, limit: { type: "number" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ],
    input,
  };
}

function found(id: string, name: string): unknown[] {
  return [
    {
      type: "tool_search_call",
      call_id: id,
      execution: "client",
      arguments: { query: "calendar create", limit: 2 },
    },
    {
      type: "tool_search_output",
      call_id: id,
      status: "completed",
      execution: "client",
      tools: [
        {
          type: "namespace",
          name: "mcp__cal",
          description: "Calendar",
          tools: [
            {
              type: "function",
              name,
              description: "Create a calendar event.",
              defer_loading: true,
              parameters: { type: "object", properties: { title: { type: "string" } } },
            },
          ],
        },
      ],
    },
  ];
}

describe("tool search relayed to a Responses API", () => {
  it("offers the search as a function, its history as a function's, and the tools found", () => {
    const { body, changed, search } = searchAsFunction(request(found("s1", "create_event")));
    expect(changed).toBe(true);
    expect(search).toBe(true);
    const tools = body.tools as Record<string, unknown>[];
    expect(tools.map((tool) => tool.name ?? tool.type)).toEqual([
      "exec_command",
      TOOL_SEARCH,
      "mcp__cal",
    ]);
    expect(tools[1]).toMatchObject({
      type: "function",
      name: TOOL_SEARCH,
      parameters: { type: "object" },
    });
    expect(String(tools[1]?.description)).toContain("Tool discovery");
    expect(tools[2]).toMatchObject({ type: "namespace", name: "mcp__cal" });
    const namespaceTools = tools[2]?.tools;
    const nested = Array.isArray(namespaceTools)
      ? ((namespaceTools as Record<string, unknown>[])[0] ?? {})
      : {};
    expect(nested.defer_loading).toBeUndefined();

    const input = body.input as Record<string, unknown>[];
    expect(input[0]).toMatchObject({
      type: "function_call",
      call_id: "s1",
      name: TOOL_SEARCH,
    });
    expect(JSON.parse(String(input[0]?.arguments))).toEqual({ query: "calendar create", limit: 2 });
    expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "s1" });
    expect(String(input[1]?.output)).toContain("mcp__cal__create_event");
  });

  it("merges a namespace found again instead of adding it twice", () => {
    const { body } = searchAsFunction(
      request([...found("s1", "create_event"), ...found("s2", "list_events")]),
    );
    const tools = body.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(3);
    const namespace = tools[2]?.tools as Record<string, unknown>[];
    expect(namespace.map((tool) => tool.name)).toEqual(["create_event", "list_events"]);
  });

  it("rewrites the history of a request that offers no search (a compaction)", () => {
    const body = request(found("s1", "create_event"));
    delete body.tools;
    const result = searchAsFunction(body);
    expect(result.changed).toBe(true);
    expect(result.search).toBe(false);
    expect(result.body.tools).toBeUndefined();
    const input = result.body.input as Record<string, unknown>[];
    expect(input[0]?.type).toBe("function_call");
    expect(input[1]?.type).toBe("function_call_output");
  });

  it("leaves a request with no tool search as it came", () => {
    const plain = { model: "m", tools: [{ type: "function", name: "a" }], input: "hi" };
    const result = searchAsFunction(plain);
    expect(result.changed).toBe(false);
    expect(result.body).toBe(plain);
  });

  it("leaves a search another party runs alone", () => {
    const body = {
      model: "m",
      tools: [{ type: "tool_search", execution: "server" }],
      input: [],
    };
    expect(searchAsFunction(body).changed).toBe(false);
  });
});

describe("tool search calls coming back", () => {
  it("turns an event's function call into a tool_search_call", () => {
    const event = {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "s9",
        name: TOOL_SEARCH,
        arguments: '{"query":"mail"}',
      },
    };
    const rewritten = toolSearchEvent(event);
    expect(rewritten?.item).toMatchObject({
      type: "tool_search_call",
      execution: "client",
      call_id: "s9",
      arguments: { query: "mail" },
    });
    const item = (rewritten as { item: Record<string, unknown> }).item;
    expect(item.name).toBeUndefined();
  });

  it("rewrites a completed response's output", () => {
    const event = {
      type: "response.completed",
      response: {
        id: "r1",
        output: [
          { type: "function_call", call_id: "s9", name: TOOL_SEARCH, arguments: "{}" },
          { type: "function_call", call_id: "c2", name: "exec_command", arguments: "{}" },
        ],
      },
    };
    const rewritten = toolSearchEvent(event) as {
      response: { output: Record<string, unknown>[] };
    };
    expect(rewritten.response.output[0]?.type).toBe("tool_search_call");
    expect(rewritten.response.output[1]?.type).toBe("function_call");
  });

  it("rewrites a whole reply", () => {
    const result = toolSearchResponse({
      output: [{ type: "function_call", call_id: "s3", name: TOOL_SEARCH, arguments: '{"q":1}' }],
    });
    expect(result.changed).toBe(true);
    expect(result.body.output).toEqual([
      {
        type: "tool_search_call",
        execution: "client",
        call_id: "s3",
        arguments: { q: 1 },
      },
    ]);
  });

  it("keeps every stream line whole, split anywhere", () => {
    const input = [
      "event: response.output_item.done",
      "",
      `data: ${JSON.stringify({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "s1",
          name: TOOL_SEARCH,
          arguments: '{"query":"x"}',
        },
      })}`,
      "",
      `data: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: "tool_search <b>",
      })}`,
      "",
      "",
    ].join("\n");

    for (let cut = 1; cut < input.length; cut += 7) {
      const tidy = new ToolSearchTidy();
      const got = tidy.write(input.slice(0, cut)) + tidy.write(input.slice(cut)) + tidy.flush();
      expect(got).toContain('"type":"tool_search_call"');
      expect(got).not.toContain('"function_call"');
      expect(got).toContain('"delta":"tool_search <b>"');
      expect(got.startsWith("event: response.output_item.done\n\n")).toBe(true);
    }
  });
});
