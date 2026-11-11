export interface ClaudeCallbackBody {
  toolCallId: string;
  name: string;
  arguments: string;
}

/**
 * The MCP helper's callback body: `{tool_call_id, name, arguments}`. Claude
 * Code names the call it makes; an agent that does not gets an id from the
 * helper.
 */
export function parseClaudeCallbackBody(value: unknown): ClaudeCallbackBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const toolCallId = body.tool_call_id;
  const name = body.name;
  if (typeof toolCallId !== "string" || toolCallId === "" || typeof name !== "string") {
    return null;
  }
  const args = body.arguments;
  return {
    toolCallId,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
}
