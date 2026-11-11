/**
 * Claude Code asks Anthropic's API for what its newest models take and a
 * relay may not know yet: `thinking.display` values beyond summarized and
 * omitted, a turn's `output_config` inside messages (or a `system` message
 * there at all), auto mode's `safeguards`, and its deferred-tool blocks.
 * A provider that refuses one is asked again at once without it, and is
 * not sent it again while the daemon runs (myna's anthropic_shapes.go).
 *
 * The refusal is remembered per provider: the shapes are Anthropic's, not
 * the model's, and a provider takes or turns away the same ones for every
 * Claude model it serves.
 */
export type AnthropicShape =
  | "display"
  | "displayNew"
  | "turnEffort"
  | "turnSystem"
  | "safeguards"
  | "deferred"
  | "refsOnly";

const DISPLAY_REFUSED =
  /thinking\.(?:adaptive|enabled)\.display:?\s*Extra inputs are not permitted/i;
const DISPLAY_VALUE_REFUSED = /thinking\.(?:adaptive|enabled)\.display:?\s*Input should be/i;
const TURN_EFFORT_REFUSED =
  /messages\.\d+\.output_config:?\s*Extra inputs are not permitted|Mid-conversation reasoning effort \(configuration_update\) is not supported/i;
const TURN_ROLE_REFUSED = /messages\.(\d+)\.role\b/;
const SAFEGUARDS_REFUSED = /\bsafeguards:?\s*Extra inputs are not permitted/i;
const DEFERRED_REFUSED =
  /messages\[\d+\]\.content: unknown variant `(?:tool_addition|tool_removal|tool_definition|tool_reference)`/;
const REFS_ONLY_REFUSED = /missing field `content`/;

type Json = Record<string, unknown>;

const refused = new Map<string, Set<AnthropicShape>>();

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shapesRefusedFor(providerId: string): Set<AnthropicShape> {
  return refused.get(providerId) ?? new Set<AnthropicShape>();
}

/** The shapes this provider has turned away before. */
export function refusedShapes(providerId: string): ReadonlySet<AnthropicShape> {
  return shapesRefusedFor(providerId);
}

export function resetAnthropicShapes(): void {
  refused.clear();
}

/** Whether a thinking.display value every Anthropic endpoint has taken. */
function knownDisplay(value: string): boolean {
  return value === "summarized" || value === "omitted";
}

function displayOf(body: Json): string | null {
  return isRecord(body.thinking) && typeof body.thinking.display === "string"
    ? body.thinking.display
    : null;
}

/** Whether a request puts an output_config on one of its messages. */
function hasTurnEffort(body: Json): boolean {
  return messagesOf(body).some((message) => message.output_config !== undefined);
}

/** A message's content with nothing in it. */
function emptyContent(content: unknown): boolean {
  if (content === undefined || content === null || content === "") {
    return true;
  }
  if (typeof content === "string") {
    return false;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((block) => isRecord(block) && block.type === "text" && block.text === "");
}

function messagesOf(body: Json): Json[] {
  return Array.isArray(body.messages) ? body.messages.filter(isRecord) : [];
}

function blocksOf(content: unknown): Json[] {
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function deferredBlock(type: unknown): boolean {
  return type === "tool_addition" || type === "tool_removal" || type === "tool_reference";
}

/** A request with a deferred-tool block in a message's content. */
function hasDeferredTools(body: Json): boolean {
  return messagesOf(body).some((message) =>
    blocksOf(message.content).some((block) => deferredBlock(block.type)),
  );
}

function refsOnly(content: unknown): boolean {
  const blocks = blocksOf(content);
  return blocks.length > 0 && blocks.every((block) => block.type === "tool_reference");
}

/** A request with a tool_result holding only tool_reference blocks. */
function hasRefsOnlyResult(body: Json): boolean {
  return messagesOf(body).some((message) =>
    blocksOf(message.content).some(
      (block) => block.type === "tool_result" && refsOnly(block.content),
    ),
  );
}

/**
 * Notes the shapes provider turned away in a refusal body, and answers
 * which ones are new. `body` is what was sent.
 */
export function refuseAnthropicShapes(input: {
  providerId: string;
  message: string;
  body: Json;
}): AnthropicShape[] {
  const fresh: AnthropicShape[] = [];
  const mark = (shape: AnthropicShape) => {
    const set = shapesRefusedFor(input.providerId);
    if (!set.has(shape)) {
      set.add(shape);
      refused.set(input.providerId, set);
      fresh.push(shape);
    }
  };
  const display = displayOf(input.body);
  if (display !== null) {
    if (DISPLAY_REFUSED.test(input.message)) {
      mark("display");
    } else if (DISPLAY_VALUE_REFUSED.test(input.message) && !knownDisplay(display)) {
      mark("displayNew");
    }
  }
  if (TURN_EFFORT_REFUSED.test(input.message) && hasTurnEffort(input.body)) {
    mark("turnEffort");
  }
  if (SAFEGUARDS_REFUSED.test(input.message) && input.body.safeguards !== undefined) {
    mark("safeguards");
  }
  if (DEFERRED_REFUSED.test(input.message) && hasDeferredTools(input.body)) {
    mark("deferred");
  }
  if (REFS_ONLY_REFUSED.test(input.message) && hasRefsOnlyResult(input.body)) {
    mark("refsOnly");
  }
  // A role refused at a system message inside messages is over that
  // message; one naming a user or assistant turn is over something else.
  const role = TURN_ROLE_REFUSED.exec(input.message);
  if (role !== null) {
    const sent = withoutRefusedShapes(input.providerId, input.body);
    if (messagesOf(sent)[Number(role[1])]?.role === "system") {
      mark("turnSystem");
    }
  }
  return fresh;
}

/** The body without the shapes provider has refused before. */
export function withoutRefusedShapes(providerId: string, body: Json): Json {
  const refusedHere = shapesRefusedFor(providerId);
  let next = body;
  if (refusedHere.has("deferred")) {
    next = withoutDeferredTools(next);
  }
  if (refusedHere.has("refsOnly")) {
    next = withRefsSaid(next);
  }
  if (refusedHere.has("turnSystem")) {
    next = withSystemOnTop(next);
  }
  if (refusedHere.has("safeguards") && next.safeguards !== undefined) {
    const stripped = { ...next };
    delete stripped.safeguards;
    next = stripped;
  }
  if (displayOf(next) !== null) {
    const all = refusedHere.has("display");
    const beyondKnown = !knownDisplay(String(displayOf(next))) && refusedHere.has("displayNew");
    if (all || beyondKnown) {
      next = withDisplay(next, all);
    }
  }
  if (refusedHere.has("turnEffort")) {
    next = withoutTurnEffort(next);
  }
  return next;
}

/**
 * The body without thinking.display, or with only a value beyond
 * summarized and omitted mended: "highlights" reads as "summarized",
 * anything else is left out.
 */
function withDisplay(body: Json, all: boolean): Json {
  const thinking = isRecord(body.thinking) ? { ...body.thinking } : null;
  if (thinking === null) {
    return body;
  }
  const display = typeof thinking.display === "string" ? thinking.display : "";
  if (all) {
    delete thinking.display;
  } else if (knownDisplay(display)) {
    return body;
  } else if (display === "highlights") {
    thinking.display = "summarized";
  } else {
    delete thinking.display;
  }
  return { ...body, thinking };
}

/**
 * The body without the per-turn effort on its messages, as Claude Code
 * sends it once refused: a system message that carried nothing else goes
 * with it.
 */
function withoutTurnEffort(body: Json): Json {
  if (!hasTurnEffort(body)) {
    return body;
  }
  const messages: unknown[] = [];
  for (const entry of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(entry) || entry.output_config === undefined) {
      messages.push(entry);
      continue;
    }
    const next = { ...entry };
    delete next.output_config;
    if (next.role === "system" && emptyContent(next.content)) {
      continue;
    }
    messages.push(next);
  }
  return { ...body, messages };
}

/** The text blocks of a system message inside messages. */
function systemTextBlocks(content: unknown): Json[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }];
  }
  return blocksOf(content).filter(
    (block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0,
  );
}

/**
 * The body with no system message inside messages: each one's text goes,
 * in order, at the end of the top-level system, and one with none (a
 * turn's effort alone) is left out.
 */
function withSystemOnTop(body: Json): Json {
  const entries = Array.isArray(body.messages) ? body.messages : [];
  if (!entries.some((entry) => isRecord(entry) && entry.role === "system")) {
    return body;
  }
  const moved: Json[] = [];
  const messages: unknown[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || entry.role !== "system") {
      messages.push(entry);
      continue;
    }
    moved.push(...systemTextBlocks(entry.content));
  }
  const fields: Json = { messages };
  if (moved.length > 0) {
    fields.system = [...topSystemBlocks(body.system), ...moved];
  }
  return { ...body, ...fields };
}

/** A top-level system prompt as blocks, for one that moves to it. */
function topSystemBlocks(system: unknown): unknown[] {
  if (typeof system === "string") {
    return system.length > 0 ? [{ type: "text", text: system }] : [];
  }
  return Array.isArray(system) ? system : [];
}

/**
 * The body without the deferred-tool blocks in its messages, and without
 * a message they leave empty. A definition carried inline joins the
 * request's own tools list; a tool_result's tool_reference stays.
 */
function withoutDeferredTools(body: Json): Json {
  if (!hasDeferredTools(body)) {
    return body;
  }
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  const have = new Set(
    tools.filter(isRecord).flatMap((tool) => (typeof tool.name === "string" ? [tool.name] : [])),
  );
  const messages: unknown[] = [];
  let changed = false;
  for (const entry of Array.isArray(body.messages) ? body.messages : []) {
    const message = isRecord(entry) ? entry : null;
    if (message === null || !Array.isArray(message.content)) {
      messages.push(entry);
      continue;
    }
    const kept: Json[] = [];
    for (const block of message.content.filter(isRecord)) {
      if (
        block.type === "tool_addition" &&
        isRecord(block.tool) &&
        block.tool.type === "tool_definition"
      ) {
        const definition = block.tool.definition;
        if (
          isRecord(definition) &&
          typeof definition.name === "string" &&
          definition.name.length > 0 &&
          !have.has(definition.name)
        ) {
          tools.push(definition);
          have.add(definition.name);
        }
      }
      if (!deferredBlock(block.type)) {
        kept.push(block);
      } else {
        changed = true;
      }
    }
    if (kept.length > 0) {
      messages.push({ ...message, content: kept });
    }
  }
  if (!changed) {
    return body;
  }
  return { ...body, messages, ...(tools.length === 0 ? {} : { tools }) };
}

/** What a model is told of a tool ToolSearch loaded. */
function toolLoadedText(name: string): string {
  return `Tool ${name} is loaded and can be called now.`;
}

/**
 * The body with a text block first in each tool_result that holds only
 * tool_reference blocks, naming the tools they load; the references stay.
 */
function withRefsSaid(body: Json): Json {
  if (!hasRefsOnlyResult(body)) {
    return body;
  }
  const messages = messagesOf(body);
  let changed = false;
  const next: Json[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      next.push(message);
      continue;
    }
    let said = false;
    const blocks = message.content.flatMap((block) => {
      if (!isRecord(block) || block.type !== "tool_result" || !refsOnly(block.content)) {
        return [block];
      }
      const names = blocksOf(block.content).map((reference) =>
        toolLoadedText(String(reference.tool_name ?? "")),
      );
      said = true;
      const text = { type: "text", text: names.join("\n") };
      return [{ ...block, content: [text, ...blocksOf(block.content)] }];
    });
    if (!said) {
      next.push(message);
      continue;
    }
    changed = true;
    next.push({ ...message, content: blocks });
  }
  return changed ? { ...body, messages: next } : body;
}
