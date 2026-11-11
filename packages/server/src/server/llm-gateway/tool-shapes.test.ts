import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingHttpHeaders, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigStore, type GatewayConfig } from "./config.js";
import { Masker } from "./masking.js";
import { createGatewayRouter } from "./routes.js";
import { shapeTools } from "./tool-shapes.js";
import { UsageLedger } from "./usage.js";

const logger = pino({ level: "silent" });

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("tool shapes", () => {
  it("puts a Chat tool from another API's shape in a function object", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.openai.com/v1" },
      body: {
        tools: [
          { name: "read", description: "read a file", inputSchema: { type: "object" } },
          { type: "custom", name: "exec" },
          { type: "function", function: { name: "kept" } },
        ],
      },
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: { name: "read", description: "read a file", parameters: { type: "object" } },
      },
      { type: "custom", name: "exec" },
      { type: "function", function: { name: "kept" } },
    ]);
  });

  it("folds a union at a tool's root to an object root", () => {
    const body = shapeTools({
      protocol: "anthropic",
      provider: { baseUrl: "https://api.anthropic.com/v1" },
      body: {
        tools: [
          {
            name: "update",
            input_schema: {
              oneOf: [
                { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
                { type: "object", properties: { b: { type: "number" } }, required: ["a"] },
              ],
            },
          },
        ],
      },
    });
    const schema = (body.tools as { input_schema: Record<string, unknown> }[])[0]?.input_schema;
    expect(schema).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    });
  });

  it("names oneOf anyOf where the router's grammar refuses it", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://openrouter.ai/api/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: { type: "object", properties: { x: { oneOf: [{ type: "string" }] } } },
            },
          },
        ],
      },
    });
    const tools = body.tools as { function: { parameters: Record<string, unknown> } }[];
    expect(JSON.stringify(tools[0]?.function.parameters)).toContain('"anyOf"');
    expect(JSON.stringify(tools[0]?.function.parameters)).not.toContain('"oneOf"');
  });

  it("escapes a Rust regex's nested class for Grok", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.x.ai/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: { type: "object", properties: { x: { pattern: "^[^\\s[\\]]+$" } } },
            },
          },
        ],
      },
    });
    const tools = body.tools as {
      function: { parameters: { properties: { x: { pattern: string } } } };
    }[];
    expect(tools[0]?.function.parameters.properties.x.pattern).toBe("^[^\\s\\[\\]]+$");
  });

  it("types a Gemini tool schema where Vertex needs it", () => {
    const body = shapeTools({
      protocol: "gemini",
      provider: { baseUrl: "https://example.test/v1beta" },
      body: {
        model: "google/gemini-3.8-flash",
        tools: [
          {
            functionDeclarations: [
              {
                name: "drag",
                parameters: {
                  properties: {
                    target: { properties: { x: { type: "number" } } },
                    mode: { enum: ["a", "b"] },
                    note: {},
                  },
                },
              },
            ],
          },
        ],
      },
    });
    const parameters = (
      body.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[]
    )[0]?.functionDeclarations[0]?.parameters;
    expect(parameters).toMatchObject({
      type: "object",
      properties: {
        target: { type: "object" },
        mode: { type: "string" },
        note: { type: "string" },
      },
    });
  });

  it("writes DeepSeek's null escape as a Unicode escape", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.deepseek.com/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: { type: "object", properties: { x: { pattern: "a\\0b" } } },
            },
          },
        ],
      },
    });
    const tools = body.tools as {
      function: { parameters: { properties: { x: { pattern: string } } } };
    }[];
    expect(tools[0]?.function.parameters.properties.x.pattern).toBe("a\\u0000b");
  });

  it("keeps the root's and allOf's own required fields when folding", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.x.ai/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                allOf: [{ properties: { kind: { type: "string" } }, required: ["kind"] }],
                anyOf: [
                  {
                    type: "object",
                    properties: { a: { type: "string" }, n: { type: "integer" } },
                    required: ["a", "n"],
                  },
                  {
                    type: "object",
                    properties: { b: { type: "string" } },
                    required: ["b", "n", "id"],
                  },
                ],
              },
            },
          },
        ],
      },
    });
    const parameters = (body.tools as { function: { parameters: Record<string, unknown> } }[])[0]
      ?.function.parameters;
    expect(parameters?.required).toEqual(["id", "kind", "n"]);
    expect(Object.keys(parameters?.properties as Record<string, unknown>)).toHaveLength(5);
  });

  it("resolves a $ref branch from the schema's $defs", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.x.ai/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "automation_update",
              parameters: {
                anyOf: [
                  {
                    type: "object",
                    properties: { id: { type: "string" }, prompt: { type: "string" } },
                    required: ["id", "prompt"],
                  },
                  { $ref: "#/$defs/pause" },
                  { type: "null" },
                ],
                $defs: {
                  pause: {
                    type: "object",
                    properties: { id: { type: "string" }, paused: { type: "boolean" } },
                    required: ["id"],
                  },
                },
              },
            },
          },
        ],
      },
    });
    const parameters = (body.tools as { function: { parameters: Record<string, unknown> } }[])[0]
      ?.function.parameters;
    expect(parameters?.type).toBe("object");
    expect(parameters?.anyOf).toBeUndefined();
    expect(parameters?.required).toEqual(["id"]);
    expect(Object.keys(parameters?.properties as Record<string, unknown>).sort()).toEqual([
      "id",
      "paused",
      "prompt",
    ]);
  });

  it("folds a union inside a union, keeping each branch's fields", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("./testdata/codex_automation_update_schema.json", import.meta.url),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.x.ai/v1" },
      body: {
        tools: [{ type: "function", function: { name: "automation_update", parameters: schema } }],
      },
    });
    const parameters = (body.tools as { function: { parameters: Record<string, unknown> } }[])[0]
      ?.function.parameters;
    expect(parameters?.type).toBe("object");
    expect(parameters?.anyOf).toBeUndefined();
    const properties = parameters?.properties as Record<string, unknown>;
    for (const key of [
      "mode",
      "id",
      "name",
      "prompt",
      "rrule",
      "status",
      "kind",
      "projectId",
      "model",
      "targetThreadId",
      "executionEnvironment",
    ]) {
      expect(properties[key]).toBeDefined();
    }
    expect(parameters?.required).toEqual(["mode"]);
    expect(JSON.stringify(properties.mode)).toContain("view");
    expect(JSON.stringify(properties.mode)).toContain("delete");
    expect(JSON.stringify(properties.kind)).toContain("__schema7");
    expect(JSON.stringify(properties.kind)).toContain("__schema12");
  });

  it("types an untyped enum for Kimi", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.moonshot.cn/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "parse",
              parameters: {
                type: "object",
                properties: {
                  kind: { enum: ["text", "icon"] },
                  maybe: { enum: ["a", null] },
                  mode: { const: "x" },
                },
              },
            },
          },
        ],
      },
    });
    const properties = (
      body.tools as {
        function: { parameters: { properties: Record<string, { type?: unknown }> } };
      }[]
    )[0]?.function.parameters.properties;
    expect(properties?.kind?.type).toBe("string");
    expect(properties?.maybe?.type).toEqual(["string", "null"]);
    expect(properties?.mode?.type).toBe("string");
  });

  it("types the target of a Kimi tool's $ref", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://api.moonshot.ai/v1" },
      body: {
        tools: [
          {
            type: "function",
            function: {
              name: "f",
              parameters: {
                type: "object",
                properties: {
                  a: { $ref: "#/$defs/box" },
                  b: { $ref: "#/$defs/anything" },
                },
                $defs: {
                  box: { properties: { y: { type: "string" } } },
                  anything: { description: "any value" },
                },
              },
            },
          },
        ],
      },
    });
    const parameters = (
      body.tools as {
        function: {
          parameters: { $defs: Record<string, { type?: unknown }> };
        };
      }[]
    )[0]?.function.parameters;
    expect(parameters?.$defs.box?.type).toBe("object");
    expect(parameters?.$defs.anything?.type).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "object",
      "array",
      "null",
    ]);
  });

  it("cleans boolean schemas and x- keys for Gemini", () => {
    const body = shapeTools({
      protocol: "openai",
      provider: { baseUrl: "https://example.test/v1" },
      body: {
        model: "google/gemini-3.8-flash",
        tools: [
          {
            type: "function",
            function: {
              name: "drag",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  a: true,
                  b: false,
                  c: { type: "string", "x-mcp-header": "C" },
                },
              },
            },
          },
        ],
      },
    });
    const parameters = (
      body.tools as {
        function: {
          parameters: {
            additionalProperties: unknown;
            properties: Record<string, Record<string, unknown>>;
          };
        };
      }[]
    )[0]?.function.parameters;
    expect(parameters?.additionalProperties).toBe(false);
    expect(parameters?.properties.a).toEqual({ type: "string" });
    expect(parameters?.properties.b).toBeUndefined();
    expect(parameters?.properties.c).toEqual({ type: "string" });
  });

  it("lifts Responses Lite's additional_tools into the tools", () => {
    const body = shapeTools({
      protocol: "openai-responses",
      provider: { baseUrl: "https://api.deepseek.com/v1" },
      body: {
        tools: [],
        reasoning: { effort: "high", context: "all_turns" },
        client_metadata: { ws_request_header_x_openai_internal_codex_responses_lite: "1" },
        input: [
          {
            type: "additional_tools",
            tools: [
              { type: "namespace", name: "functions", tools: [{ type: "function", name: "f" }] },
            ],
          },
          { type: "message", role: "developer", content: "prompt" },
        ],
      },
    });
    expect(body.tools).toEqual([{ type: "function", name: "f" }]);
    expect(body.input).toEqual([{ type: "message", role: "developer", content: "prompt" }]);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.client_metadata).toEqual({});
  });
});

interface Recorded {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function listen(app: express.Express): Promise<{ url: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      open.push(server);
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, requests });
    });
  });
}

async function gateway(config: GatewayConfig): Promise<string> {
  const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-tools-"));
  writeFileSync(path.join(neolixHome, "gateway.json"), JSON.stringify(config));
  const store = new GatewayConfigStore({ neolixHome, logger });
  await store.start();
  const ledger = new UsageLedger({ neolixHome, logger });
  await ledger.start();
  const app = express();
  app.use(
    createGatewayRouter({
      configStore: store,
      masker: new Masker({
        neolixHome,
        logger,
        allow: () => [],
        actions: () => ({}),
        shape: () => false,
      }),
      ledger,
      logger,
    }),
  );
  return (await listen(app)).url;
}

describe("tools on the wire", () => {
  it("shapes a Chat tool upstream as the vendor's function object", async () => {
    const requests: Recorded[] = [];
    const upstream = express();
    upstream.use(express.json());
    upstream.use((req, res) => {
      requests.push({ headers: req.headers, body: req.body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "r1", choices: [{ message: { content: "ok" } }] }));
    });
    const upstreamUrl = (await listen(upstream)).url;
    const url = await gateway({
      version: 1,
      enabled: true,
      keys: [],
      providers: [
        {
          id: "p",
          protocol: "openai",
          baseUrl: `${upstreamUrl}/v1`,
          models: [{ id: "m" }],
        },
      ],
      groups: [],
    });

    const response = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "p/m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read", inputSchema: { type: "object" } }],
      }),
    });

    expect(response.status).toBe(200);
    expect(requests[0]?.body.tools).toEqual([
      { type: "function", function: { name: "read", parameters: { type: "object" } } },
    ]);
  });
});
