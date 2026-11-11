import { withoutBillingHeader } from "../claude-compat.js";
import type { ClientCacheMarks } from "./cache.js";
import {
  bridgeName,
  bridgeToolAliases,
  CLAUDE_MCP_TOOL_PREFIX,
  type ClaudeToolSpec,
  declaredToolName,
  offeredToolNames,
} from "./tools.js";

export type ClaudePromptPart =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id: string; name: string; arguments: string }
  | { kind: "toolResult"; callId: string; text: string; isError?: boolean };

export interface ClaudePromptMessage {
  role: "user" | "assistant";
  parts: readonly ClaudePromptPart[];
}

export interface ClaudeTurnRequest {
  system?: string;
  messages: readonly ClaudePromptMessage[];
  tools?: readonly ClaudeToolSpec[];
}

export interface ClaudePromptBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: string };
}

const CACHE_1H = { type: "ephemeral", ttl: "1h" } as const;

/** How many messages of a history one rendered block holds. */
const HISTORY_CHUNK = 16;

const HISTORY_OPEN =
  "<conversation_history>\nThe conversation so far, each turn of it answered already. " +
  "Images and files in it were sent with those earlier messages: none of them is new, and none needs answering again.\n\n";
const HISTORY_CLOSE = "</conversation_history>\n\n<current_turn>\nThe turn to answer now:\n\n";

const PAST_CALLS_NOTE =
  '(The "[tool call …]" and "[tool result …]" lines above record calls made earlier. ' +
  "Writing such a line calls nothing: call a tool only with the tool itself.)";

/** Whether a message carries a tool call, whose reply is not a complete turn. */
export function callsTool(message: ClaudePromptMessage): boolean {
  return message.parts.some((part) => part.kind === "toolCall");
}

/**
 * Where the turn to answer now begins: after the last reply that calls no
 * tool. 0 when there is no such reply, so the whole conversation is the turn.
 */
export function historyEnd(messages: readonly ClaudePromptMessage[]): number {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    if (messages[at]?.role === "assistant" && !callsTool(messages[at])) {
      return at === messages.length - 1 ? 0 : at + 1;
    }
  }
  return 0;
}

/**
 * A conversation no run had, told whole: the caller's instructions in a block
 * of their own, then the answered turns as text, then the turn to answer.
 * Claude Code's own system prompt is kept (the subscription checks it), so
 * the caller's instructions are content, not `--system-prompt`.
 */
export function renderClaudePrompt(
  request: ClaudeTurnRequest,
  cache?: ClientCacheMarks,
): ClaudePromptBlock[] {
  const blocks: ClaudePromptBlock[] = [];
  let text = "";
  const system = withoutBillingHeader(request.system ?? "");
  if (system !== "") {
    text += `<external_system_instructions>\n${system}\n</external_system_instructions>\n\n`;
    blocks.push({ type: "text", text, cache_control: { ...CACHE_1H } });
    text = "";
  }
  const instructions = blocks.length - 1;
  const systemPrefix = system === "" ? 0 : "<external_system_instructions>\n".length;
  const billingCut = (request.system ?? "").length - system.length;
  const messageStarts: number[] = [];
  const offered = offeredToolNames(request.tools ?? []);
  const split = historyEnd(request.messages);
  const chunked = split === 0 ? Math.max(request.messages.length - 1, 0) : split;
  let chunk = -1;
  request.messages.forEach((message, index) => {
    if (split > 0 && index === 0) {
      text += HISTORY_OPEN;
    }
    if (split > 0 && index === split) {
      text += HISTORY_CLOSE;
    }
    text += `${message.role === "assistant" ? "Assistant" : "Human"}: `;
    messageStarts[index] = renderedLength(blocks, text);
    text += renderParts(message.parts, offered);
    text += "\n\n";
    if (index + 1 <= chunked && (index + 1) % HISTORY_CHUNK === 0) {
      blocks.push({ type: "text", text });
      text = "";
      chunk = blocks.length - 1;
    }
  });
  if (request.messages.some(callsTool)) {
    text += `${PAST_CALLS_NOTE}\n\n`;
  }
  if (split > 0) {
    text += "</current_turn>";
  }
  const closed = closeBlocks(blocks, text);
  if (chunk >= 0) {
    const instructionsBlock = instructions >= 0 ? blocks[instructions] : undefined;
    if (instructionsBlock !== undefined) {
      delete instructionsBlock.cache_control;
    }
    blocks[chunk] = {
      type: "text",
      text: blocks[chunk]?.text ?? "",
      cache_control: { ...CACHE_1H },
    };
  }
  return cache === undefined
    ? closed
    : applyClientMarks(closed, cache, messageStarts, systemPrefix, billingCut);
}

/** How much text the prompt holds so far, blocks and the open one together. */
function renderedLength(blocks: readonly ClaudePromptBlock[], text: string): number {
  let length = text.length;
  for (const block of blocks) {
    length += block.text.length;
  }
  return length;
}

/**
 * Puts the caller's own marks back, where its blocks ended. A mark splits the
 * block it ends, and the piece before it carries the mark's TTL. The bridge's
 * own marks give way: the caller's are the ones its cache relies on.
 */
function applyClientMarks(
  blocks: readonly ClaudePromptBlock[],
  cache: ClientCacheMarks,
  messageStarts: readonly number[],
  systemPrefix: number,
  billingCut: number,
): ClaudePromptBlock[] {
  const marks: Array<{ at: number; ttl: "5m" | "1h" }> = [];
  for (const mark of cache.system) {
    const at = systemPrefix + mark.end - billingCut;
    if (at > systemPrefix) {
      marks.push({ at, ttl: mark.ttl });
    }
  }
  for (const [index, list] of cache.messages) {
    const start = messageStarts[index];
    if (start === undefined) {
      continue;
    }
    for (const mark of list) {
      marks.push({ at: start + mark.end, ttl: mark.ttl });
    }
  }
  if (marks.length === 0) {
    return blocks.map(({ cache_control: _, ...block }) => block);
  }
  marks.sort((left, right) => left.at - right.at);
  const out: ClaudePromptBlock[] = [];
  let offset = 0;
  let next = 0;
  for (const block of blocks) {
    const end = offset + block.text.length;
    let cursor = 0;
    while (next < marks.length && (marks[next]?.at ?? 0) <= end) {
      const mark = marks[next];
      if (mark === undefined || mark.at <= offset) {
        next += 1;
        continue;
      }
      const cut = mark.at - offset;
      if (cut > cursor) {
        out.push({
          type: "text",
          text: block.text.slice(cursor, cut),
          cache_control: { type: "ephemeral", ttl: mark.ttl },
        });
      }
      cursor = cut;
      next += 1;
    }
    if (cursor < block.text.length) {
      out.push({ type: "text", text: block.text.slice(cursor) });
    }
    offset = end;
  }
  return out.length === 0 ? [{ type: "text", text: "[continue]" }] : out;
}

/**
 * The messages a run kept for its conversation's next turn is told: only what
 * the caller said since the reply it had, so Anthropic reads the prefix it
 * cached.
 */
export function renderClaudeTurn(
  messages: readonly ClaudePromptMessage[],
  tools: readonly ClaudeToolSpec[],
): ClaudePromptBlock[] {
  const offered = offeredToolNames(tools);
  let text = "";
  for (const message of messages) {
    text += `${message.role === "assistant" ? "Assistant" : "Human"}: `;
    text += renderParts(message.parts, offered);
    text += "\n\n";
  }
  if (messages.some(callsTool)) {
    text += `${PAST_CALLS_NOTE}\n\n`;
  }
  return [{ type: "text", text: text === "" ? "[continue]" : text }];
}

function renderParts(parts: readonly ClaudePromptPart[], offered: ReadonlySet<string>): string {
  let text = "";
  let open = "";
  for (const part of parts) {
    if (open !== "" && part.kind !== "toolResult") {
      text += `\n[end of tool result id=${open}]\n\n`;
      open = "";
    }
    switch (part.kind) {
      case "text":
        text += part.text;
        break;
      case "toolCall": {
        const name = offered.has(part.name) ? bridgeName(part.name) : part.name;
        const args = part.arguments === "" ? "{}" : part.arguments;
        text += `\n[tool call ${name} id=${part.id} args=${args}]`;
        break;
      }
      case "toolResult":
        text += `\n[tool result id=${part.callId}${part.isError === true ? " error" : ""}]\n${part.text}`;
        open = part.callId;
        break;
    }
  }
  return text;
}

function closeBlocks(blocks: ClaudePromptBlock[], text: string): ClaudePromptBlock[] {
  if (text !== "") {
    blocks.push({ type: "text", text });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[continue]" });
  }
  return blocks;
}

/** The caller's name of a tool the run called, by the aliases it was offered under. */
export function resolveCalledTool(tools: readonly ClaudeToolSpec[], name: string): string {
  const offered = name.startsWith(CLAUDE_MCP_TOOL_PREFIX)
    ? name.slice(CLAUDE_MCP_TOOL_PREFIX.length)
    : name;
  return declaredToolName(bridgeToolAliases(tools), offered);
}

/** The key a conversation's next turn is matched by: owner, model and the answered turns. */
export function turnKey(
  owner: string,
  model: string,
  messages: readonly ClaudePromptMessage[],
): string {
  return JSON.stringify({ owner, model, messages });
}
