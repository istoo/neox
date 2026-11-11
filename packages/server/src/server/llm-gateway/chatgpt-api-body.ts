import { createHash } from "node:crypto";

/**
 * A Responses request made fit for Sign in with ChatGPT
 * (`provider/chatgpt_api.go:594-650`). Nothing is stored, so the whole
 * conversation goes each time; the fields and hosted tools OpenAI refuses
 * are left out, and a `system` message goes as the `developer` one it
 * takes. The agent's own instructions stay as they are.
 */

/** Fields a ChatGPT token's Responses request refuses (`chatgpt_api.go:597-599`). */
const DROPPED = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
];

/** Tools OpenAI runs itself, which it won't run for a ChatGPT token (`chatgpt_api.go:601-604`). */
const HOSTED_TOOLS = new Set([
  "image_generation",
  "file_search",
  "code_interpreter",
  "computer_use",
  "computer_use_preview",
  "computer",
  "mcp",
  "tool_search",
]);

/** The same request, as a ChatGPT token takes it. */
export function chatgptApiBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const field of DROPPED) {
    delete out[field];
  }
  out.store = false;
  out.stream = true;
  if (typeof out.input === "string") {
    out.input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: out.input }],
      },
    ];
  } else if (Array.isArray(out.input)) {
    out.input = out.input.map((item) => {
      if (!isRecord(item)) {
        return item;
      }
      const next: Record<string, unknown> = { ...item };
      if (next.role === "system") {
        next.role = "developer";
      }
      if (next.type === "additional_tools" && Array.isArray(next.tools)) {
        next.tools = ownTools(next.tools);
      }
      return next;
    });
  }
  if (typeof out.prompt_cache_key !== "string" || out.prompt_cache_key === "") {
    const instructions = typeof out.instructions === "string" ? out.instructions : "";
    const input = Array.isArray(out.input) ? out.input : [];
    const key = conversationKey(instructions, input);
    if (key !== "") {
      out.prompt_cache_key = key;
    }
  }
  if (Array.isArray(out.tools)) {
    const tools = ownTools(out.tools);
    if (tools.length === 0) {
      delete out.tools;
      delete out.tool_choice;
    } else {
      out.tools = tools;
    }
  }
  return out;
}

/**
 * The session headers a ChatGPT sign-in carries: the conversation's key,
 * which is what OpenAI keeps the cached prompt by (`chatgpt_api.go:654-668`).
 */
export function chatGptApiSessionHeaders(body: Record<string, unknown>): Record<string, string> {
  const key = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : "";
  return key === "" ? {} : { "session-id": key, "thread-id": key };
}

/**
 * Names the conversation a request belongs to, from how it starts — the
 * instructions and the input up to the first user message
 * (`provider/codex_request.go:370-393`).
 */
export function conversationKey(instructions: string, input: unknown[]): string {
  const hash = createHash("sha256");
  hash.update(instructions);
  let sawUser = false;
  for (const item of input) {
    hash.update(JSON.stringify(item) ?? "");
    if (isRecord(item) && item.role === "user") {
      sawUser = true;
      break;
    }
  }
  if (!sawUser) {
    return "";
  }
  const hex = hash.digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function ownTools(tools: unknown[]): unknown[] {
  return tools.filter((tool) => {
    if (!isRecord(tool)) {
      return true;
    }
    return typeof tool.type !== "string" || !HOSTED_TOOLS.has(tool.type);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
