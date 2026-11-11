import {
  defineAgentTool,
  type AgentToolDefinition,
  type AgentToolResult,
  type PluginServerContext,
} from "@neolix/plugin/server";
import { z } from "zod";
import { CalcTools } from "./server/calc/index.mjs";

interface CalcTool {
  description: string;
  args: unknown;
  execute(args: Record<string, unknown>): unknown | Promise<unknown>;
}

function toResult(value: unknown): AgentToolResult {
  if (typeof value === "string") return { text: value };
  if (value === undefined || value === null) return { text: "" };
  return { text: JSON.stringify(value), structuredContent: value };
}

function toolInput(schema: unknown): z.ZodType {
  return z.fromJSONSchema(schema as never);
}

async function loadCalcTools(): Promise<AgentToolDefinition[]> {
  const { tool } = await CalcTools();
  return Object.entries(tool).map(([name, raw]) => {
    const definition = raw as CalcTool;
    return defineAgentTool({
      name: `calc_${name}`,
      description: definition.description,
      input: toolInput(definition.args),
      async execute(args) {
        try {
          return toResult(await definition.execute(args as Record<string, unknown>));
        } catch (error) {
          return {
            text: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }
      },
    });
  });
}

let tools: Promise<AgentToolDefinition[]> | null = null;

function loadTools(): Promise<AgentToolDefinition[]> {
  tools ??= loadCalcTools();
  return tools;
}

export default function contribute(server: PluginServerContext) {
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history") return;
    return { ...request, tools: [...request.tools, ...(await loadTools())] };
  });
  return () => {};
}
