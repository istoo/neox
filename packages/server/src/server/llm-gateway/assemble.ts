import type { IrEvent, IrPart, IrResponse, IrStopReason, IrUsage } from "./ir.js";

interface ToolCallBuilder {
  id: string;
  name: string;
  args: string;
  signature?: string;
}

export function responseFromEvents(events: IrEvent[]): IrResponse {
  let id: string | null = null;
  let text = "";
  let thinking = "";
  let stopReason: IrStopReason = "end_turn";
  let usage: IrUsage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: ToolCallBuilder[] = [];
  const extra: IrPart[] = [];

  for (const event of events) {
    const part = extraPartOf(event);
    if (part !== null) {
      extra.push(part);
      continue;
    }
    switch (event.type) {
      case "start":
        id = event.id;
        break;
      case "text_delta":
        text += event.text;
        break;
      case "thinking_delta":
        thinking += event.text;
        break;
      case "tool_call_start":
        toolCalls.push({
          id: event.id,
          name: event.name,
          args: "",
          ...(event.signature === undefined ? {} : { signature: event.signature }),
        });
        break;
      case "tool_args_delta": {
        const call = toolCalls.find((entry) => entry.id === event.id);
        if (call !== undefined) {
          call.args += event.args;
        }
        break;
      }
      case "usage":
        usage = {
          inputTokens: Math.max(usage.inputTokens, event.usage.inputTokens),
          outputTokens: Math.max(usage.outputTokens, event.usage.outputTokens),
        };
        break;
      case "stop":
        stopReason = event.reason;
        break;
    }
  }

  const parts: IrPart[] = [...extra];
  if (thinking.length > 0) {
    parts.push({ type: "thinking", text: thinking });
  }
  if (text.length > 0) {
    parts.push({ type: "text", text });
  }
  for (const call of toolCalls) {
    parts.push({
      type: "tool_call",
      id: call.id,
      name: call.name,
      arguments: call.args.length > 0 ? call.args : "{}",
      ...(call.signature === undefined ? {} : { signature: call.signature }),
    });
  }
  if (toolCalls.length > 0 && stopReason === "end_turn") {
    stopReason = "tool_use";
  }
  return { id, parts, stopReason, usage };
}

/** The part a reply-level event stands for, when it is one of its own. */
function extraPartOf(event: IrEvent): IrPart | null {
  switch (event.type) {
    case "search":
      return { type: "search", query: event.query, pages: event.pages };
    case "redacted_thinking":
      return { type: "thinking", text: "", redacted: event.data };
    case "reasoning_item":
      return { type: "reasoning_item", item: event.item };
    default:
      return null;
  }
}

export function eventsFromResponse(response: IrResponse): IrEvent[] {
  const events: IrEvent[] = [{ type: "start", id: response.id }];
  for (const part of response.parts) {
    switch (part.type) {
      case "text":
        events.push({
          type: "text_delta",
          text: part.text,
          ...(part.citations === undefined || part.citations.length === 0
            ? {}
            : { citations: part.citations }),
        });
        break;
      case "thinking":
        if (part.redacted !== undefined) {
          events.push({ type: "redacted_thinking", data: part.redacted });
        } else {
          events.push({ type: "thinking_delta", text: part.text });
        }
        break;
      case "tool_call":
        events.push({
          type: "tool_call_start",
          id: part.id,
          name: part.name,
          ...(part.signature === undefined ? {} : { signature: part.signature }),
        });
        if (part.arguments.length > 0) {
          events.push({ type: "tool_args_delta", id: part.id, args: part.arguments });
        }
        break;
      case "search":
        events.push({ type: "search", query: part.query, pages: part.pages });
        break;
      case "reasoning_item":
        events.push({ type: "reasoning_item", item: part.item });
        break;
      case "image":
      case "tool_result":
        break;
    }
  }
  events.push({ type: "usage", usage: response.usage });
  events.push({ type: "stop", reason: response.stopReason });
  return events;
}
