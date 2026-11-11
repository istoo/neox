import type { StreamFilter } from "./text-calls.js";

/**
 * Codex's tool search relayed to a Responses API other than the ChatGPT
 * backend's, ported from myna `internal/gateway/toolsearch.go`.
 *
 * Few Responses APIs know a `tool_search` tool, a `tool_search_call` or a
 * `tool_search_output`, or the `defer_loading` of the tools a search found;
 * an OpenAI API model before the ones that search turns them away as well.
 * So the request goes with the search as a function, its calls and results
 * as a function's, and the tools found in the tools; and a call the model
 * makes to it comes back to Codex as the `tool_search_call` Codex runs.
 *
 * The ChatGPT backend (a `chatgpt-api` provider) runs the search as Codex
 * sends it, so it is never given this shape.
 */

export const TOOL_SEARCH = "tool_search";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SearchAsFunctionResult {
  body: Record<string, unknown>;
  /** Whether the request was rewritten at all. */
  changed: boolean;
  /**
   * Whether a search tool was offered: the reply's calls to it must go back
   * as `tool_search_call` (a request with only history has no such calls).
   */
  search: boolean;
}

function toolKey(tool: Record<string, unknown>): string {
  if (typeof tool.name === "string" && tool.name !== "") {
    return tool.name;
  }
  return `#${typeof tool.type === "string" ? tool.type : ""}`;
}

function toolsByName(tools: unknown[]): Map<string, Record<string, unknown>> {
  const have = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    if (isRecord(tool)) {
      have.set(toolKey(tool), tool);
    }
  }
  return have;
}

function containsNamed(tools: unknown[], name: unknown): boolean {
  return tools.some((entry) => isRecord(entry) && entry.name === name);
}

/** A tool added once; a namespace given again adds the tools it didn't have. */
function addTool(
  tools: unknown[],
  have: Map<string, Record<string, unknown>>,
  tool: Record<string, unknown>,
): unknown[] {
  const key = toolKey(tool);
  const old = have.get(key);
  if (old === undefined) {
    have.set(key, tool);
    return [...tools, tool];
  }
  if (old.type !== "namespace" || tool.type !== "namespace") {
    return tools;
  }
  let nested = Array.isArray(old.tools) ? [...old.tools] : [];
  const more = Array.isArray(tool.tools) ? tool.tools : [];
  for (const entry of more) {
    if (isRecord(entry) && !containsNamed(nested, entry.name)) {
      nested.push(entry);
    }
  }
  old.tools = nested;
  return tools;
}

/** Drops `defer_loading` from a tool a search found, and its nested tools. */
function undefer(tool: Record<string, unknown>): void {
  delete tool.defer_loading;
  if (Array.isArray(tool.tools)) {
    for (const nested of tool.tools) {
      if (isRecord(nested)) {
        delete nested.defer_loading;
      }
    }
  }
}

/** What a model reads of a search's result: the tools it may call now. */
export function searchFound(tools: Record<string, unknown>[]): string {
  const names: string[] = [];
  for (const tool of tools) {
    if (tool.type === "function") {
      if (typeof tool.name === "string") {
        names.push(tool.name);
      }
    } else if (tool.type === "namespace") {
      const namespace = typeof tool.name === "string" ? tool.name : "";
      for (const nested of Array.isArray(tool.tools) ? tool.tools : []) {
        if (isRecord(nested) && nested.type === "function" && typeof nested.name === "string") {
          names.push(`${namespace}__${nested.name}`);
        }
      }
    }
  }
  if (names.length === 0) {
    return "No tools matched the search.";
  }
  return `These tools are now available to call: ${names.join(", ")}`;
}

/** The arguments a function call wrote, as the object a search call takes. */
export function parseToolSearchArguments(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // not JSON: a custom tool's free text
  }
  return { input: text };
}

/** Rewrites a model's `function_call` to `tool_search` as the
 * `tool_search_call` Codex runs; null when it was another call. */
export function toolSearchCall(item: unknown): Record<string, unknown> | null {
  if (
    !isRecord(item) ||
    item.type !== "function_call" ||
    item.name !== TOOL_SEARCH ||
    (item.namespace !== undefined && item.namespace !== null)
  ) {
    return null;
  }
  const raw = typeof item.arguments === "string" ? item.arguments : "";
  const next: Record<string, unknown> = { ...item };
  delete next.name;
  next.type = "tool_search_call";
  next.execution = "client";
  next.arguments = parseToolSearchArguments(raw);
  return next;
}

/** One streamed event with its `item`, or its `response.output`, rewritten;
 * null when nothing in it was a search call. */
export function toolSearchEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  let changed = false;
  const next: Record<string, unknown> = { ...event };
  const item = toolSearchCall(event.item);
  if (item !== null) {
    next.item = item;
    changed = true;
  }
  if (isRecord(event.response) && Array.isArray(event.response.output)) {
    const output = event.response.output.map((entry) => {
      const rewritten = toolSearchCall(entry);
      if (rewritten !== null) {
        changed = true;
        return rewritten;
      }
      return entry;
    });
    if (changed) {
      next.response = { ...event.response, output };
    }
  }
  return changed ? next : null;
}

/** A whole (non-streamed) Responses reply with its calls rewritten. */
export function toolSearchResponse(body: Record<string, unknown>): {
  body: Record<string, unknown>;
  changed: boolean;
} {
  if (!Array.isArray(body.output)) {
    return { body, changed: false };
  }
  let changed = false;
  const output = body.output.map((entry) => {
    const rewritten = toolSearchCall(entry);
    if (rewritten !== null) {
      changed = true;
      return rewritten;
    }
    return entry;
  });
  return changed ? { body: { ...body, output }, changed: true } : { body, changed: false };
}

/**
 * The request as a Responses API without tool search can take it: the search
 * offered as a function, a search call and result as a function's, and the
 * tools they found among the tools. A request with only the history (Codex
 * leaves the tool out once nothing deferred is left, and its compaction
 * sends no tools) has the history rewritten and no tools added.
 */
export function searchAsFunction(body: Record<string, unknown>): SearchAsFunctionResult {
  let tools = Array.isArray(body.tools) ? body.tools : undefined;
  let search = false;
  if (tools !== undefined) {
    tools = [...tools];
    for (const [index, entry] of tools.entries()) {
      if (isRecord(entry) && entry.type === TOOL_SEARCH && entry.execution === "client") {
        tools[index] = {
          type: "function",
          name: TOOL_SEARCH,
          description: entry.description,
          parameters: entry.parameters,
        };
        search = true;
      }
    }
  }
  const have = toolsByName(tools ?? []);
  const add = (tool: Record<string, unknown>): void => {
    if (search && tools !== undefined) {
      tools = addTool(tools, have, tool);
    }
  };

  const items: unknown[] | null = Array.isArray(body.input) ? [...body.input] : null;
  const history = items !== null && rewriteSearchHistory(items, add);
  if (!search && !history) {
    return { body, changed: false, search: false };
  }
  const next: Record<string, unknown> = { ...body };
  if (search && tools !== undefined) {
    next.tools = tools;
  }
  if (history && items !== null) {
    next.input = items;
  }
  return { body: next, changed: true, search };
}

/** Rewrites a search's calls and results in the conversation as a
 * function's; whether there were any. */
function rewriteSearchHistory(
  items: unknown[],
  add: (tool: Record<string, unknown>) => void,
): boolean {
  let history = false;
  for (const [index, entry] of items.entries()) {
    if (!isRecord(entry)) {
      continue;
    }
    if (entry.type === "tool_search_call") {
      history = true;
      items[index] = {
        type: "function_call",
        call_id: entry.call_id,
        name: TOOL_SEARCH,
        arguments: JSON.stringify(isRecord(entry.arguments) ? entry.arguments : {}),
      };
    } else if (entry.type === "tool_search_output") {
      history = true;
      items[index] = searchOutputAsFunction(entry, add);
    }
  }
  return history;
}

function searchOutputAsFunction(
  entry: Record<string, unknown>,
  add: (tool: Record<string, unknown>) => void,
): Record<string, unknown> {
  const named: Record<string, unknown>[] = [];
  for (const found of Array.isArray(entry.tools) ? entry.tools : []) {
    if (!isRecord(found)) {
      continue;
    }
    const tool = structuredClone(found);
    undefer(tool);
    named.push(tool);
    add(tool);
  }
  return {
    type: "function_call_output",
    call_id: entry.call_id,
    output: searchFound(named),
  };
}

/**
 * Relayed Responses streams: the model's calls to the search function go
 * back to Codex as the `tool_search_call` it runs. Lines pass as they came
 * unless one carries such a call.
 */
export class ToolSearchTidy implements StreamFilter {
  private buffer = "";

  write(piece: string): string {
    this.buffer += piece;
    const end = this.buffer.lastIndexOf("\n");
    if (end < 0) {
      return "";
    }
    const ready = this.buffer.slice(0, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    return searchLines(ready);
  }

  flush(): string {
    const rest = this.buffer;
    this.buffer = "";
    return searchLines(rest);
  }
}

function searchLines(text: string): string {
  if (!text.includes(`"${TOOL_SEARCH}"`)) {
    return text;
  }
  let out = "";
  let rest = text;
  while (rest.length > 0) {
    const at = rest.indexOf("\n");
    if (at < 0) {
      out += searchLine(rest);
      break;
    }
    out += searchLine(rest.slice(0, at + 1));
    rest = rest.slice(at + 1);
  }
  return out;
}

function searchLine(line: string): string {
  if (!line.includes(`"${TOOL_SEARCH}"`)) {
    return line;
  }
  const body = line.replace(/[\r\n]+$/, "");
  const end = line.slice(body.length);
  if (!body.startsWith("data:")) {
    return line;
  }
  let event: unknown;
  try {
    event = JSON.parse(body.slice("data:".length));
  } catch {
    return line;
  }
  if (!isRecord(event)) {
    return line;
  }
  const rewritten = toolSearchEvent(event);
  if (rewritten === null) {
    return line;
  }
  return `data: ${JSON.stringify(rewritten)}${end}`;
}
