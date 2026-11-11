import type { GatewayProtocol } from "./upstream.js";

/** The name a client uses for a web search tool, by protocol. */
function isWebSearchTool(protocol: GatewayProtocol, tool: unknown): boolean {
  if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
    return false;
  }
  const entry = tool as Record<string, unknown>;
  if (protocol === "gemini") {
    return "googleSearch" in entry || "google_search" in entry;
  }
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
  return type.startsWith("web_search");
}

/** Whether a request asks its model to search the web (myna's Request.WebSearch). */
export function wantsWebSearch(protocol: GatewayProtocol, body: Record<string, unknown>): boolean {
  if (
    protocol === "openai" &&
    body.web_search_options !== undefined &&
    body.web_search_options !== null
  ) {
    return true;
  }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.some((tool) => isWebSearchTool(protocol, tool));
}

/** The last thing the user said, which is what a self-search asks for. */
export function lastUserText(protocol: GatewayProtocol, body: Record<string, unknown>): string {
  switch (protocol) {
    case "gemini":
      return lastPartText(body.contents, "parts");
    case "openai-responses":
      return lastResponseInput(body);
    default:
      return lastPartText(body.messages, "content");
  }
}

function lastPartText(items: unknown, field: "parts" | "content"): string {
  if (!Array.isArray(items)) {
    return "";
  }
  for (const item of items.toReversed()) {
    const entry = recordOf(item);
    if (entry?.role !== "user") {
      continue;
    }
    const text = field === "parts" ? partsText(entry.parts) : contentText(entry.content);
    if (text.length > 0) {
      return text;
    }
  }
  return "";
}

function lastResponseInput(body: Record<string, unknown>): string {
  const input = body.input;
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    for (const item of input.toReversed()) {
      const entry = recordOf(item);
      if (entry === null || (entry.role !== undefined && entry.role !== "user")) {
        continue;
      }
      const text = entry.content === undefined ? "" : contentText(entry.content);
      if (text.length > 0) {
        return text;
      }
    }
  }
  return "";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const entry = recordOf(value);
  return entry !== null && typeof entry.text === "string" ? entry.text : "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => textOf(part))
    .filter((text) => text.length > 0)
    .join("\n");
}

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => textOf(part))
    .filter((text) => text.length > 0)
    .join("\n");
}

/** The body without its web search tools: the search is ours now. */
function withoutWebSearchTools(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  if (Array.isArray(body.tools)) {
    next.tools = body.tools.filter((tool) => !isWebSearchTool(protocol, tool));
  }
  if (protocol === "openai" && body.web_search_options !== undefined) {
    delete next.web_search_options;
  }
  return next;
}

/**
 * A request whose web search myna answered itself: the search tools are
 * gone and what the search found goes to the model beside its system
 * prompt (myna's searchReply gives the model the pages; Neolix has no
 * synthesized search events yet).
 */
export function withSearchResults(
  protocol: GatewayProtocol,
  body: Record<string, unknown>,
  said: string,
): Record<string, unknown> {
  const next = withoutWebSearchTools(protocol, body);
  const note = `Web search results:\n\n${said}`;
  switch (protocol) {
    case "openai": {
      const messages = Array.isArray(body.messages) ? [...body.messages] : [];
      const first = recordOf(messages[0]);
      if (first?.role === "system") {
        messages[0] = {
          ...first,
          content: `${contentText(first.content)}\n\n${note}`,
        };
      } else {
        messages.unshift({ role: "system", content: note });
      }
      next.messages = messages;
      return next;
    }
    case "anthropic": {
      const system = body.system;
      if (typeof system === "string") {
        next.system = `${system}\n\n${note}`;
      } else if (Array.isArray(system)) {
        next.system = [...system, { type: "text", text: note }];
      } else {
        next.system = note;
      }
      return next;
    }
    case "openai-responses": {
      const instructions = typeof body.instructions === "string" ? body.instructions : "";
      next.instructions = instructions.length === 0 ? note : `${instructions}\n\n${note}`;
      return next;
    }
    case "gemini": {
      const instruction = recordOf(body.systemInstruction);
      const parts = Array.isArray(instruction?.parts) ? instruction.parts : [];
      next.systemInstruction = {
        ...instruction,
        parts: [...parts, { text: note }],
      };
      return next;
    }
    default:
      return next;
  }
}
