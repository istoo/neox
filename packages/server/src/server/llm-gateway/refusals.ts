/**
 * Tool faults an upstream names only when it sees the request, remembered
 * per model so the next turn is shaped before it goes (myna's unfit,
 * strict_refused.go, custom_tool.go and undeclared_tools.go).
 *
 * The detector reads the vendor's words; the fix rewrites the request body.
 * A model that refused once gets the fixed shape from then on.
 */
export type ToolRefusal = "strict" | "custom" | "undeclared" | "rootUnion";

const STRICT_REFUSAL =
  /(?:unsupported|unknown|unrecognized|not (?:supported|allowed|permitted)|extra (?:fields?|inputs?|parameters?)|forbidden)[^\n{}]{0,120}?\btools(?:\[\d+\]|\.\d+)(?:\.[^\s.'"`]+)?\.strict\b|\btools(?:\[\d+\]|\.\d+)(?:\.[^\s.'"`]+)?\.strict\b['"`]?[^\n{}]{0,40}?(?:unsupported|unknown|unrecognized|not (?:supported|allowed|permitted)|extra_forbidden|forbidden)/i;

const CUSTOM_REFUSAL =
  /unsupported custom tool|custom tools? (?:is |are )?not (?:supported|allowed)|(?:unsupported|unknown|invalid) tool type[^\n{}]{0,20}?['"`]custom['"`]|tool type ['"`]custom['"`] (?:is )?(?:not supported|unsupported)|unknown variant[^\n{}]{0,20}?['"`]custom['"`]/i;

const UNDECLARED_REFUSAL =
  /must define tools|toolConfig field must be defined|tool_use|tool_result|tool call[^\n{}]{0,40}?(?:not found|unknown|not declared|not defined)|(?:unknown|undeclared) tool/i;

const ROOT_UNION_REFUSAL =
  /tool parameter root must be an object type|does not support oneOf, allOf, or anyOf at the top level|schema must have type .object. and not have .oneOf.|schema must be a JSON Schema of .type: \\?"object\\?"./i;

/** The tool fault an upstream's refusal names, if any. */
export function toolRefusalOf(status: number, body: string): ToolRefusal | null {
  if (status !== 400 && status !== 422) {
    return null;
  }
  if (STRICT_REFUSAL.test(body)) {
    return "strict";
  }
  if (CUSTOM_REFUSAL.test(body)) {
    return "custom";
  }
  if (ROOT_UNION_REFUSAL.test(body)) {
    return "rootUnion";
  }
  if (UNDECLARED_REFUSAL.test(body)) {
    return "undeclared";
  }
  return null;
}

const refused = new Map<string, Set<ToolRefusal>>();

function key(model: string): string {
  return model;
}

/** Notes that model turned a tool fault away. */
export function rememberToolRefusal(model: string, refusal: ToolRefusal): void {
  const set = refused.get(key(model)) ?? new Set<ToolRefusal>();
  set.add(refusal);
  refused.set(key(model), set);
}

/** The faults model has refused before. */
export function toolRefusalsFor(model: string): Set<ToolRefusal> {
  return refused.get(key(model)) ?? new Set<ToolRefusal>();
}

export function resetToolRefusals(): void {
  refused.clear();
}

type Json = Record<string, unknown>;

/** Drops strict from a Chat or Responses function tool. */
function dropStrict(tool: unknown): unknown {
  if (!isRecord(tool)) {
    return tool;
  }
  const fn = isRecord(tool.function) ? tool.function : tool;
  if (!isRecord(fn) || fn.strict === undefined) {
    return tool;
  }
  const rest = { ...fn };
  delete rest.strict;
  return isRecord(tool.function) ? { ...tool, function: rest } : rest;
}

/** Each custom tool offered as a function taking its input. */
function customAsFunction(tool: unknown): unknown {
  if (!isRecord(tool) || tool.type !== "custom" || typeof tool.name !== "string") {
    return tool;
  }
  const fn: Json = {
    name: tool.name,
    parameters: {
      type: "object",
      properties: { input: { type: "string" } },
      required: ["input"],
    },
  };
  if (typeof tool.description === "string") {
    fn.description = tool.description;
  }
  return { type: "function", function: fn };
}

/** The names this request's history calls. */
function calledToolNames(body: Json): string[] {
  let input: unknown[] = [];
  if (Array.isArray(body.input)) {
    input = body.input;
  } else if (Array.isArray(body.messages)) {
    input = body.messages;
  }
  const names: string[] = [];
  for (const item of input) {
    if (!isRecord(item)) {
      continue;
    }
    let name: string | null = null;
    if (typeof item.name === "string") {
      name = item.name;
    } else if (isRecord(item.function) && typeof item.function.name === "string") {
      name = item.function.name;
    }
    if (name !== null && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** A stub tool for a call the history made but the request no longer offers. */
function stubTool(name: string, protocol: string): Json {
  const parameters = { type: "object", properties: {} };
  if (protocol === "anthropic") {
    return {
      name,
      description: "Called earlier in this conversation; not offered now.",
      input_schema: parameters,
    };
  }
  if (protocol === "openai") {
    return {
      type: "function",
      function: {
        name,
        description: "Called earlier in this conversation; not offered now.",
        parameters,
      },
    };
  }
  return {
    type: "function",
    name,
    description: "Called earlier in this conversation; not offered now.",
    parameters,
  };
}

/** The body with the faults the model refused fixed. */
export function fixToolRefusals(body: Json, protocol: string, faults: Set<ToolRefusal>): Json {
  if (faults.size === 0) {
    return body;
  }
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  let next = tools;
  if (faults.has("strict")) {
    next = next.map(dropStrict);
  }
  if (faults.has("custom")) {
    next = next.map(customAsFunction);
  }
  if (faults.has("undeclared")) {
    const declared = new Set(next.map(toolNameOf));
    for (const name of calledToolNames(body)) {
      if (!declared.has(name)) {
        next.push(stubTool(name, protocol));
      }
    }
  }
  return { ...body, tools: next };
}

function toolNameOf(tool: unknown): string {
  if (!isRecord(tool)) {
    return "";
  }
  const fn = isRecord(tool.function) ? tool.function : tool;
  return isRecord(fn) && typeof fn.name === "string" ? fn.name : "";
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
