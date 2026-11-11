/**
 * Claude Code's own request shapes, as myna handles them: the billing
 * line cut from a prompt another vendor would read, a conversation that
 * ends with the assistant's message given a user turn where the model
 * refuses a prefill, and Message Threads refused before routing.
 */

/** A system block that is Claude Code's billing line and nothing else. */
const BILLING_LINE = /^x-anthropic-billing-header:(?:\s*[A-Za-z_]+=[^;\s]*;)*\s*$/;

/** The user turn put after a conversation ending with the assistant's message. */
export const CONTINUE_TEXT = "Continue.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The line cut from the start of a system string: Claude Code writes it
 * first, and another vendor's model reads it as the prompt's first words,
 * missing its prefix cache on every turn (myna's billing_line.go).
 */
export function withoutBillingHeader(text: string): string {
  const newline = text.indexOf("\n");
  const first = newline < 0 ? text : text.slice(0, newline);
  if (!BILLING_LINE.test(first.trim())) {
    return text;
  }
  return text.slice(first.length).replace(/^\n+/, "");
}

/** Whether a request names a Message Thread (create or continue). */
export function namesThread(body: Record<string, unknown>): boolean {
  return body.thread !== undefined && body.thread !== null;
}

/** Anthropic's refusal of a request a thread can't serve. */
export function threadRefusal(): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Message Threads are not supported by this gateway; send the full conversation without thread.",
      details: { error_code: "thread_unsupported_request" },
    },
  };
}

type Body = Record<string, unknown>;

function textParts(value: unknown): Array<Record<string, unknown>> | null {
  return Array.isArray(value) ? value.filter(isRecord) : null;
}

/** A target body with Claude Code's billing line cut from its system prompt. */
export function dropBillingLine(protocol: string, body: Body): Body {
  if (protocol === "anthropic" || !JSON.stringify(body).includes("x-anthropic-billing-header:")) {
    return body;
  }
  switch (protocol) {
    case "openai":
      return dropChatBilling(body);
    case "openai-responses":
      return dropResponsesBilling(body);
    case "gemini":
      return dropGeminiBilling(body);
    default:
      return body;
  }
}

function dropChatBilling(body: Body): Body {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const first = messages.findIndex((entry) => {
    const record = isRecord(entry) ? entry : null;
    return record?.role === "system" || record?.role === "developer";
  });
  const message = first < 0 ? null : messages[first];
  if (message === null || !isRecord(message)) {
    return body;
  }
  const next = withoutSystem(message, "content");
  if (next === null) {
    messages.splice(first, 1);
  } else {
    messages[first] = next;
  }
  return { ...body, messages };
}

function dropResponsesBilling(body: Body): Body {
  if (typeof body.instructions !== "string") {
    return body;
  }
  const instructions = withoutBillingHeader(body.instructions);
  if (instructions === body.instructions) {
    return body;
  }
  return instructions.length === 0 ? without(body, "instructions") : { ...body, instructions };
}

function dropGeminiBilling(body: Body): Body {
  const instruction = isRecord(body.systemInstruction) ? body.systemInstruction : null;
  const parts = textParts(instruction?.parts);
  if (instruction === null || parts === null) {
    return body;
  }
  const kept: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (typeof part.text !== "string") {
      kept.push(part);
      continue;
    }
    if (BILLING_LINE.test(part.text.trim())) {
      continue;
    }
    const text = withoutBillingHeader(part.text);
    kept.push(text === part.text ? part : { ...part, text });
  }
  if (kept.length === parts.length && kept.every((part, at) => part === parts[at])) {
    return body;
  }
  return kept.length === 0
    ? without(body, "systemInstruction")
    : { ...body, systemInstruction: { ...instruction, parts: kept } };
}

function withoutSystem(
  message: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const content = message[field];
  if (typeof content === "string") {
    const text = withoutBillingHeader(content);
    return text.length === 0 ? null : { ...message, [field]: text };
  }
  const parts = textParts(content);
  if (parts === null) {
    return message;
  }
  const kept: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (typeof part.text !== "string") {
      kept.push(part);
      continue;
    }
    if (BILLING_LINE.test(part.text.trim())) {
      continue;
    }
    const text = withoutBillingHeader(part.text);
    kept.push(text === part.text ? part : { ...part, text });
  }
  return kept.length === 0 ? null : { ...message, [field]: kept };
}

function without(body: Body, field: string): Body {
  const next = { ...body };
  delete next[field];
  return next;
}

/**
 * A Chat or Responses body with a user turn after a conversation ending
 * with the assistant's message: the model it goes to refuses a prefill
 * (myna's prefill.go). The body itself when it ends otherwise.
 */
export function continueIfAssistantLast(protocol: string, body: Body): Body {
  if (protocol === "openai") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = isRecord(messages.at(-1)) ? (messages.at(-1) as Record<string, unknown>) : null;
    if (
      last === null ||
      last.role !== "assistant" ||
      (Array.isArray(last.tool_calls) && last.tool_calls.length > 0)
    ) {
      return body;
    }
    return {
      ...body,
      messages: [...messages, { role: "user", content: CONTINUE_TEXT }],
    };
  }
  if (protocol === "openai-responses") {
    const input = body.input;
    if (!Array.isArray(input)) {
      return body;
    }
    const last = isRecord(input.at(-1)) ? (input.at(-1) as Record<string, unknown>) : null;
    if (
      last === null ||
      last.role !== "assistant" ||
      (last.type !== undefined && last.type !== "message") ||
      (Array.isArray(last.tool_calls) && last.tool_calls.length > 0)
    ) {
      return body;
    }
    return {
      ...body,
      input: [
        ...input,
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: CONTINUE_TEXT }],
        },
      ],
    };
  }
  return body;
}

/** Whether a model is one Claude Code's own server features are written for. */
export function isClaudeModel(model: string): boolean {
  return /claude/i.test(model);
}

interface AdvisorTool {
  type: string;
  name?: string;
  model?: string;
}

function advisorTools(body: Body): AdvisorTool[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.filter(
    (tool): tool is AdvisorTool =>
      isRecord(tool) && typeof tool.type === "string" && tool.type.startsWith("advisor_"),
  );
}

/**
 * Claude Code's advisor fitted to the upstream a Messages request goes to
 * (myna's advisor.go): an advisor model the upstream knows is written as
 * its own id; one it can't run, and every advisor for a model that isn't
 * Claude's, is left out with the conversation that used it.
 */
export function fitAdvisor(input: {
  body: Body;
  requestModel: string;
  providerId: string;
  models: readonly string[];
}): Body {
  const advisors = advisorTools(input.body);
  if (advisors.length === 0) {
    return input.body;
  }
  const claude = isClaudeModel(input.requestModel);
  const removed = new Set<string>();
  let changed = false;
  const tools = (Array.isArray(input.body.tools) ? input.body.tools : []).flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.type !== "string" || !tool.type.startsWith("advisor_")) {
      return [tool];
    }
    const wanted = resolveAdvisorModel(String(tool.model ?? ""), input.providerId, input.models);
    if (!claude || wanted === null) {
      changed = true;
      if (typeof tool.name === "string") {
        removed.add(tool.name);
      }
      return [];
    }
    if (wanted !== tool.model) {
      changed = true;
      return [{ ...tool, model: wanted }];
    }
    return [tool];
  });
  if (!changed) {
    return input.body;
  }
  const next: Body = { ...input.body };
  if (tools.length === 0) {
    delete next.tools;
    delete next.tool_choice;
  } else {
    next.tools = tools;
  }
  return withoutAdvisorTurns(next, removed);
}

/** The upstream's id for an advisor model its provider serves, or null. */
function resolveAdvisorModel(
  model: string,
  providerId: string,
  models: readonly string[],
): string | null {
  let id = model.trim().replace(/\[1m\]$/, "");
  if (id.length === 0) {
    return null;
  }
  const slash = id.indexOf("/");
  if (slash >= 0) {
    if (id.slice(0, slash) !== providerId) {
      return null;
    }
    id = id.slice(slash + 1);
  }
  if (!isClaudeModel(id) || (models.length > 0 && !models.includes(id))) {
    return null;
  }
  return id;
}

/** The conversation without the advisor calls and results a dropped tool left. */
function withoutAdvisorTurns(body: Body, removed: ReadonlySet<string>): Body {
  if (removed.size === 0 || !Array.isArray(body.messages)) {
    return body;
  }
  const droppedIds = new Set<string>();
  const messages: unknown[] = [];
  for (const entry of body.messages) {
    const message = isRecord(entry) ? entry : null;
    if (message === null || !Array.isArray(message.content)) {
      messages.push(entry);
      continue;
    }
    const blocks = message.content.filter(isRecord).flatMap((block) => {
      if (block.type === "tool_use" && typeof block.name === "string" && removed.has(block.name)) {
        if (typeof block.id === "string") {
          droppedIds.add(block.id);
        }
        return [];
      }
      return [block];
    });
    // A turn that only carried the advisor call is left out with it.
    if (blocks.length > 0 || message.content.length === 0) {
      messages.push({ ...message, content: blocks });
    }
  }
  for (const entry of messages) {
    const message = isRecord(entry) ? entry : null;
    if (message === null || !Array.isArray(message.content)) {
      continue;
    }
    message.content = message.content.filter((block) => {
      if (!isRecord(block) || block.type !== "tool_result") {
        return true;
      }
      return typeof block.tool_use_id !== "string" || !droppedIds.has(block.tool_use_id);
    });
  }
  return {
    ...body,
    messages: messages.filter(
      (entry) => !isRecord(entry) || !Array.isArray(entry.content) || entry.content.length > 0,
    ),
  };
}

/**
 * Claude Code's auto mode review kept only where a Claude model answers
 * it: another vendor's model behind an Anthropic API turns the
 * safeguards away (myna's automode.go).
 */
export function fitAutomode(body: Body, model: string): Body {
  if (isClaudeModel(model) || body.safeguards === undefined) {
    return body;
  }
  const next = { ...body };
  delete next.safeguards;
  return next;
}
