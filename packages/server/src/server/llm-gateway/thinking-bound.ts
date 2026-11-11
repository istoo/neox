/**
 * Claude's thinking block is signed for the conversation and account that
 * made it. A block an upstream refuses as another conversation's fails
 * the whole request (myna's thinking_bound.go): the gateway leaves out the
 * block the refusal names and every thinking block after it, asks once
 * more, and remembers those signatures for that provider and account, so
 * later turns go without them the first time.
 *
 * A conversation that ran on DeepSeek's Anthropic endpoint first holds
 * thinking blocks signed with a UUID rather than Claude's base64; those
 * are left out of a request to an upstream serving Claude before it sees
 * them, whatever the refusal would say.
 */

import { createHash } from "node:crypto";

const BOUND_REFUSAL =
  /invalid `?signature`? in `?thinking`? block|bound to a different conversation|not created in this conversation|invalid data in `?redacted_thinking`? block/i;
const BOUND_AT = /messages\.(\d+)\.content\.(\d+)/;
const DEEPSEEK_SIGNATURE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Anthropic's own models, which think only when asked. */
const CLAUDE_MODEL = /(?:^|[/.:-])claude-/i;

/** The most signatures remembered before the memory starts again. */
const REFUSED_MOST = 1 << 14;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isThinkingBlock(block: Record<string, unknown> | null): boolean {
  return block?.type === "thinking" || block?.type === "redacted_thinking";
}

/** Names a thinking block by its signature, or its text where it has none. */
export function thinkingKey(block: Record<string, unknown>): string {
  const signature = typeof block.signature === "string" ? block.signature : "";
  const sealed = typeof block.data === "string" ? block.data : "";
  const text = typeof block.thinking === "string" ? block.thinking : "";
  const found = signature !== "" ? signature : sealed;
  const key = found !== "" ? found : text;
  return createHash("sha256")
    .update(`${String(block.type ?? "")}\u0000${key}`)
    .digest("hex")
    .slice(0, 32);
}

/** Whether an error is Claude refusing a thinking block's binding. */
export function refusedBoundThinking(errorText: string): boolean {
  return BOUND_REFUSAL.test(errorText);
}

/** The block a refusal names: messages.<m>.content.<b>. */
export function boundBlockAt(errorText: string): { message: number; block: number } | null {
  const match = BOUND_AT.exec(errorText);
  if (match === null) {
    return null;
  }
  return { message: Number(match[1]), block: Number(match[2]) };
}

/** Signatures refused per provider and account, as myna remembers them. */
export class BoundThinking {
  private readonly refused = new Set<string>();

  private static key(owner: string, key: string): string {
    return `${owner}\u0000${key}`;
  }

  public refusedBefore(owner: string, key: string): boolean {
    return this.refused.has(BoundThinking.key(owner, key));
  }

  public refuse(owner: string, keys: readonly string[]): void {
    if (this.refused.size + keys.length > REFUSED_MOST) {
      this.refused.clear();
    }
    for (const key of keys) {
      this.refused.add(BoundThinking.key(owner, key));
    }
  }

  public get size(): number {
    return this.refused.size;
  }

  public reset(): void {
    this.refused.clear();
  }
}

/**
 * A Messages body without each thinking block `drop` names, and without
 * an assistant message left holding nothing; the same body when none goes.
 */
export function withoutThinkingBlocks<T extends Record<string, unknown>>(
  body: T,
  drop: (message: number, blockIndex: number, block: Record<string, unknown>) => boolean,
): T {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (messages === null) {
    return body;
  }
  let changed = false;
  const kept: unknown[] = [];
  messages.forEach((entry, messageIndex) => {
    const message = asRecord(entry);
    const content = message === null ? null : message.content;
    if (message === null || !Array.isArray(content)) {
      kept.push(entry);
      return;
    }
    const blocks: unknown[] = [];
    let gone = false;
    content.forEach((entryBlock, blockIndex) => {
      const block = asRecord(entryBlock);
      if (isThinkingBlock(block) && block !== null && drop(messageIndex, blockIndex, block)) {
        gone = true;
        return;
      }
      blocks.push(entryBlock);
    });
    if (!gone) {
      kept.push(entry);
      return;
    }
    changed = true;
    if (blocks.length > 0) {
      kept.push({ ...message, content: blocks });
    }
  });
  return changed ? { ...body, messages: kept } : body;
}

/** A body without the thinking blocks this owner refused before. */
export function withoutRefusedThinking<T extends Record<string, unknown>>(
  owner: string,
  body: T,
  refused: BoundThinking,
): T {
  return withoutThinkingBlocks(body, (_message, _block, block) =>
    refused.refusedBefore(owner, thinkingKey(block)),
  );
}

/**
 * Reads a 400 from an Anthropic upstream: the block it names and every
 * thinking block after it in the body sent are remembered as refused by
 * owner. Returns whether any was new, so asking again can go otherwise.
 */
export function refuseBoundThinking(input: {
  owner: string;
  errorText: string;
  body: Record<string, unknown>;
  refused: BoundThinking;
}): boolean {
  if (!refusedBoundThinking(input.errorText)) {
    return false;
  }
  const sent = withoutRefusedThinking(input.owner, input.body, input.refused);
  const messages = Array.isArray(sent.messages) ? sent.messages : [];
  const named = boundBlockAt(input.errorText);
  let fromMessage = 0;
  let fromBlock = 0;
  if (named !== null && named.message < messages.length) {
    const message = asRecord(messages[named.message]);
    const blocks = message === null || !Array.isArray(message.content) ? [] : message.content;
    if (named.block < blocks.length && isThinkingBlock(asRecord(blocks[named.block]))) {
      fromMessage = named.message;
      fromBlock = named.block;
    }
  }
  const keys: string[] = [];
  messages.forEach((entry, messageIndex) => {
    if (messageIndex < fromMessage) {
      return;
    }
    const message = asRecord(entry);
    const blocks = message === null || !Array.isArray(message.content) ? [] : message.content;
    blocks.forEach((entryBlock, blockIndex) => {
      if (messageIndex === fromMessage && blockIndex < fromBlock) {
        return;
      }
      const block = asRecord(entryBlock);
      if (!isThinkingBlock(block) || block === null) {
        return;
      }
      const key = thinkingKey(block);
      if (!input.refused.refusedBefore(input.owner, key)) {
        keys.push(key);
      }
    });
  });
  if (keys.length === 0) {
    return false;
  }
  input.refused.refuse(input.owner, keys);
  return true;
}

function isDeepSeek(host: string, model: string): boolean {
  if (host === "api.anthropic.com" || CLAUDE_MODEL.test(model)) {
    return false;
  }
  return host.includes("deepseek") || model.toLowerCase().includes("deepseek");
}

/**
 * A Messages body to an upstream that serves Claude, without thinking
 * blocks signed by DeepSeek's endpoint (a UUID, never Claude's base64);
 * every other body goes as it was.
 */
export function withoutForeignThinking<T extends Record<string, unknown>>(
  host: string,
  model: string,
  body: T,
): T {
  if (isDeepSeek(host, model) || (host !== "api.anthropic.com" && !CLAUDE_MODEL.test(model))) {
    return body;
  }
  return withoutThinkingBlocks(
    body,
    (_message, _block, block) =>
      block.type === "thinking" &&
      typeof block.signature === "string" &&
      DEEPSEEK_SIGNATURE.test(block.signature),
  );
}
