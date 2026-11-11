import type { GatewayTarget } from "../mcp/gateway.js";
import { postToGatewayPath } from "../mcp/gateway.js";

/**
 * The tools Neolix's own MCP servers give agents, listed and called as an
 * agent's MCP client does (myna internal/cli/tool_cli.go:1, gateway
 * internal/gateway/search_mcp.go:35).
 */

/** The User-Agent the calls go with, as myna's own tool CLI sends its
 * (myna tool_cli.go:54). */
export const TOOL_AGENT = "neolix-tool/1";

/** The generation tool an answer names while a drawing is still being made. */
export const GENERATION_RESULT_TOOL = "generation_result";
export const PENDING_META = "github.com/istoo/myna/pending";
export const FILES_META = "github.com/istoo/myna/files";

/** Neolix's own servers, in the order a tool name two of them share is
 * looked for (myna gateway/search_mcp.go:35). The browser server is not
 * one: myna lists it separately while its extension is connected. */
export const OWN_SERVERS = [
  { name: "image", path: "/mcp/myna/image" },
  { name: "vision", path: "/mcp/myna/vision" },
  { name: "web-search", path: "/mcp/myna/web-search" },
  { name: "tools", path: "/mcp/myna/tools" },
] as const;

export interface ToolParam {
  type?: unknown;
  description?: string;
  items?: ToolParam;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
}

export interface ListedTool {
  server: string;
  path: string;
  name: string;
  description: string;
  inputSchema: {
    properties: Record<string, ToolParam>;
    required?: string[];
  };
}

interface GatewayFailure {
  code?: unknown;
  message?: unknown;
}

/** A gateway that doesn't answer at all, as opposed to one answering an
 * error. Listing stops on this and continues past the other. */
export class GatewayUnreachable extends Error {}

export function gatewayPlace(target: GatewayTarget): string {
  return target.base ?? `the daemon socket ${target.socketPath ?? ""}`;
}

interface RpcAnswer {
  result?: unknown;
  error?: GatewayFailure;
}

/** Posts one JSON-RPC request to the MCP server at path: its result, or
 * what went wrong. */
export async function rpc(
  target: GatewayTarget,
  path: string,
  method: string,
  params: unknown,
  id: number,
): Promise<unknown> {
  let answer;
  try {
    answer = await postToGatewayPath(
      target,
      path,
      JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      TOOL_AGENT,
    );
  } catch (error) {
    throw new GatewayUnreachable(
      `Neox isn't running at ${gatewayPlace(target)}: start it (neox daemon start), then try again (${errorMessage(error)})`,
    );
  }
  if (answer.status === 404) {
    throw new Error(
      `the Neox at ${gatewayPlace(target)} has no ${path}: it is older than this one, update it`,
    );
  }
  if (answer.status !== 200) {
    throw new Error(
      `the Neox at ${gatewayPlace(target)} answered ${answer.status}${
        answer.statusText === "" ? "" : ` ${answer.statusText}`
      }: ${answer.body.trim()}`,
    );
  }
  let message: RpcAnswer;
  try {
    message = JSON.parse(answer.body) as RpcAnswer;
  } catch (error) {
    throw new Error(
      `what ${gatewayPlace(target)} answered isn't JSON-RPC: is it Neox? (${errorMessage(error)})`,
      { cause: error },
    );
  }
  if (message.error !== undefined) {
    throw new Error(textOf(message.error.message) || "the gateway refused the call");
  }
  return message.result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listedTools(result: unknown): ListedTool[] {
  if (!record(result) || !Array.isArray(result.tools)) {
    return [];
  }
  return result.tools.filter(
    (tool): tool is ListedTool =>
      record(tool) &&
      typeof tool.name === "string" &&
      typeof tool.description === "string" &&
      record(tool.inputSchema),
  );
}

/** Asks each of Neolix's own servers for its tools; a server that can't say
 * is noted, a gateway that doesn't answer is the error. */
export async function listTools(
  target: GatewayTarget,
): Promise<{ tools: ListedTool[]; notes: string[] }> {
  const tools: ListedTool[] = [];
  const notes: string[] = [];
  let id = 0;
  for (const server of OWN_SERVERS) {
    let result: unknown;
    try {
      id += 1;
      result = await rpc(target, server.path, "tools/list", {}, id);
    } catch (error) {
      if (error instanceof GatewayUnreachable) {
        throw error;
      }
      notes.push(`${server.name}: ${errorMessage(error)}`);
      continue;
    }
    if (!record(result) || !Array.isArray(result.tools)) {
      notes.push(`${server.name}: its tool list isn't one`);
      continue;
    }
    for (const tool of listedTools(result)) {
      tools.push({ ...tool, server: server.name, path: server.path });
    }
  }
  return { tools, notes };
}

export function findTool(tools: ListedTool[], name: string): ListedTool | undefined {
  return tools.find((tool) => tool.name === name);
}

/** A parameter's type: the first of a list that isn't null. */
export function paramKind(param: ToolParam): string {
  if (typeof param.type === "string") {
    return param.type;
  }
  if (Array.isArray(param.type)) {
    for (const value of param.type) {
      if (typeof value === "string" && value !== "null") {
        return value;
      }
    }
  }
  return "";
}

export function isRequired(tool: ListedTool, name: string): boolean {
  return (tool.inputSchema.required ?? []).includes(name);
}

/** The tool's parameter names, the required first, each part in name order. */
export function paramNames(tool: ListedTool): string[] {
  return Object.keys(tool.inputSchema.properties).sort((a, b) => {
    const required = isRequired(tool, a);
    if (required !== isRequired(tool, b)) {
      return required ? -1 : 1;
    }
    return a.localeCompare(b);
  });
}

/** The parameter the words left over are: the one required text, else
 * prompt; "" when the tool has neither. */
export function wordsParam(tool: ListedTool): string {
  const required = (tool.inputSchema.required ?? []).filter((name) => {
    const param = tool.inputSchema.properties[name];
    return param !== undefined && paramKind(param) === "string";
  });
  if (required.length === 1) {
    return required[0] ?? "";
  }
  const prompt = tool.inputSchema.properties.prompt;
  return prompt !== undefined && paramKind(prompt) === "string" ? "prompt" : "";
}

/** A description's first sentence, on one line (myna tool_cli.go:337). */
export function firstSentence(text: string): string {
  let line = text.split(/\s+/).filter(Boolean).join(" ");
  const end = line.indexOf(". ");
  if (end >= 0) {
    line = line.slice(0, end + 1);
  }
  const chars = [...line];
  return chars.length > 140 ? `${chars.slice(0, 139).join("")}…` : line;
}

/** How a parameter's value is written: <text>, <1-4>, … */
export function paramShape(param: ToolParam): string {
  let shape: string;
  switch (paramKind(param)) {
    case "integer":
    case "number":
      shape = paramKind(param) === "integer" ? "whole number" : "number";
      if (param.minimum !== undefined && param.maximum !== undefined) {
        shape = `${param.minimum}-${param.maximum}`;
      }
      break;
    case "boolean":
      shape = "true|false";
      break;
    case "array": {
      const item = param.items ?? { type: "string" };
      return `${paramShape(item)}…`;
    }
    case "object":
      shape = "json";
      break;
    default:
      shape = "text";
  }
  if (param.enum !== undefined && param.enum.length > 0) {
    shape = param.enum.map((value) => String(value)).join("|");
  }
  return `<${shape}>`;
}

export function paramList(tool: ListedTool): string {
  const names = paramNames(tool).map((name) => `--${name}`);
  return names.length === 0 ? "nothing" : names.join(", ");
}

export function unknownTool(name: string, tools: ListedTool[], notes: string[]): Error {
  const names = tools.map((tool) => tool.name);
  let message =
    names.length === 0
      ? `no tool called "${name}": the Neox running has no tools on`
      : `no tool called "${name}": nothing was called; there is ${names.join(", ")} (neox tools)`;
  if (notes.length > 0) {
    message += ` (${notes.join("; ")})`;
  }
  return new Error(message);
}
