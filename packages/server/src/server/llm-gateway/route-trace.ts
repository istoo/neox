/**
 * In-memory trace of the requests the gateway routes, newest first. The
 * Routing settings page plays it back: the seats routing weighed, what each
 * try answered, and what the request's prompt was made of. Nothing here is
 * persisted; a restart starts the trace empty, as myna's own recent routing
 * view does.
 */

export interface RouteSeat {
  /** `provider/account`, or `provider` when the provider has no accounts. */
  id: string;
  provider: string;
  providerLabel: string;
  account: string | null;
  accountLabel: string;
  model: string;
  /** Position in the order routing planned, 0 first. */
  rank: number;
  /** When a failed seat is back, or null while it is awake. */
  restingUntil: number | null;
  /** Requests this seat served lately, for `least-used`. */
  served: number;
}

export interface RouteTry {
  provider: string;
  account: string | null;
  model: string;
  start: number;
  done: boolean;
  status: number | null;
  millis: number | null;
  error: string | null;
  /** Milliseconds the members were asked to wait before another round
   * (myna's Try.Again, gateway.go:4496). */
  again?: number;
  /** How many members the next round asked (myna's Try.Replan). */
  replan?: number;
  /** The patience the round was budgeted, in seconds (myna's Try.Patience). */
  patience?: number;
}

export type RoutePromptKind = "system" | "tools" | "messages" | "other";

export interface RoutePromptItem {
  name: string;
  tokens: number;
  /** What the item is: `system`, `tool`, `user`, `assistant`, `memory`. */
  tag: string;
}

export interface RoutePromptPart {
  kind: RoutePromptKind;
  tokens: number;
  items: RoutePromptItem[];
}

/**
 * A prompt in the parts the usage report's Context page draws: myna's own
 * slices where this gateway can tell them apart. `skills`, `memory` and
 * `files` are not here: the gateway receives them inside the system prompt
 * and the messages, and cannot split them without reading the agent's own
 * instructions. The usage page says so rather than inventing them.
 */
export type PromptSliceKind = "system" | "tools" | "results" | "chat" | "other";

export interface PromptSlice {
  kind: PromptSliceKind;
  tokens: number;
}

export interface RoutePrompt {
  tokens: number;
  /** The served model's context window, when the config names one. */
  window: number | null;
  parts: RoutePromptPart[];
  /** The same prompt cut the way the usage report's Context page reads it. */
  slices?: PromptSlice[];
}

export interface RouteRecord {
  id: number;
  time: number;
  /** What the client's User-Agent names, as `clientOfUserAgent` reads it. */
  agent: string;
  /** The gateway key's masked name, or null for loopback without keys. */
  key: string | null;
  /** The model the client asked for. */
  model: string;
  /** `model` after the alias middleware, when an alias moved it. */
  routedModel: string;
  alias: string | null;
  group: string | null;
  strategy: string;
  provider: string | null;
  providerLabel: string | null;
  seats: RouteSeat[];
  tries: RouteTry[];
  done: boolean;
  status: number | null;
  error: string | null;
  millis: number | null;
  prompt: RoutePrompt | null;
  masked: boolean;
  /** The client call this route belongs to, for its masking records. */
  gatewayCallId?: string;
  /** The held-request report saved for this one, in `$NEOLIX_HOME/held`. */
  held?: string;
  /** The agent conversation the request names, if any (myna's Route.Session). */
  session?: string;
  /** Codex's hidden turn this is: thread_title and its siblings. */
  kind?: string;
  /** Prompt and title fingerprints tying a title turn to its conversation. */
  titleLink?: { scope: string; prompt: string; reply: string };
  /** The conversation a title turn is drawn under, once resolved. */
  parentSession?: string;
  /** The parent was inferred from the title, not named by the client. */
  parentMatched?: boolean;
}

export interface RouteTraceStats {
  /** Requests routed since the gateway started. */
  requests: number;
  /** Requests that needed more than one try. */
  rerouted: number;
  /** Requests whose client never got an answer. */
  errors: number;
  /** Requests going right now. */
  active: number;
}

export interface RouteTraceSnapshot {
  routes: RouteRecord[];
  stats: RouteTraceStats;
}

const ROUTE_KEEP = 60;
const PROMPT_ITEMS = 24;

export class RouteTrace {
  /** Newest first. */
  private readonly routes: RouteRecord[] = [];
  private nextId = 1;
  private requests = 0;
  private rerouted = 0;
  private errors = 0;

  public start(
    input: Omit<RouteRecord, "id" | "done" | "status" | "error" | "millis">,
  ): RouteRecord {
    const route: RouteRecord = {
      ...input,
      id: this.nextId,
      done: false,
      status: null,
      error: null,
      millis: null,
    };
    this.nextId += 1;
    this.requests += 1;
    this.routes.unshift(route);
    if (this.routes.length > ROUTE_KEEP) {
      this.routes.length = ROUTE_KEEP;
    }
    return route;
  }

  public update(id: number, mutate: (route: RouteRecord) => void): void {
    const route = this.routes.find((entry) => entry.id === id);
    if (route === undefined) {
      return;
    }
    mutate(route);
  }

  public finish(
    id: number,
    outcome: { status: number | null; error: string | null; now: number },
  ): void {
    this.update(id, (route) => {
      route.done = true;
      route.status = outcome.status;
      route.error = outcome.error;
      route.millis = Math.max(0, outcome.now - route.time);
      if (outcome.error !== null || (outcome.status !== null && outcome.status >= 400)) {
        this.errors += 1;
      }
      if (route.tries.length > 1) {
        this.rerouted += 1;
      }
    });
  }

  public snapshot(): RouteTraceSnapshot {
    return {
      routes: this.routes.map((route, index) => ({
        ...route,
        seats: route.seats.map((seat) => ({ ...seat })),
        tries: route.tries.map((entry) => ({ ...entry })),
        // The page reads the newest request's prompt; sending every kept
        // request's would multiply the poll's payload for nothing.
        prompt: index === 0 && route.prompt !== null ? clonePrompt(route.prompt) : null,
      })),
      stats: {
        requests: this.requests,
        rerouted: this.rerouted,
        errors: this.errors,
        active: this.routes.filter((route) => !route.done).length,
      },
    };
  }
}

function clonePrompt(prompt: RoutePrompt): RoutePrompt {
  return {
    tokens: prompt.tokens,
    window: prompt.window,
    parts: prompt.parts.map((part) => ({
      ...part,
      items: part.items.map((item) => ({ ...item })),
    })),
    ...(prompt.slices === undefined
      ? {}
      : { slices: prompt.slices.map((slice) => ({ ...slice })) }),
  };
}

interface PromptPiece {
  kind: RoutePromptKind;
  name: string;
  tag: string;
  tokens: number;
}

/**
 * Reads a chat body into the parts of its prompt, by the protocol shapes the
 * gateway accepts. Sizes are estimated at about four characters a token, the
 * same rule myna uses before the vendor counts the prompt.
 */
export function summarizePrompt(body: unknown, window: number | null): RoutePrompt | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const pieces: PromptPiece[] = [];

  const system = record.system ?? record.instructions ?? record.systemInstruction;
  addSystem(pieces, system);
  addTools(pieces, record.tools);
  addMessages(pieces, record.messages);
  addMessages(pieces, record.contents);
  addMessages(pieces, record.input);
  addOther(pieces, record);

  if (pieces.length === 0) {
    return null;
  }
  const parts = new Map<RoutePromptKind, RoutePromptPart>();
  for (const piece of pieces) {
    const part = parts.get(piece.kind) ?? { kind: piece.kind, tokens: 0, items: [] };
    part.tokens += piece.tokens;
    part.items.push({ name: piece.name, tokens: piece.tokens, tag: piece.tag });
    parts.set(piece.kind, part);
  }
  const order: RoutePromptKind[] = ["system", "tools", "messages", "other"];
  const result: RoutePromptPart[] = [];
  let total = 0;
  for (const kind of order) {
    const part = parts.get(kind);
    if (part === undefined) {
      continue;
    }
    part.items.sort((left, right) => right.tokens - left.tokens);
    part.items = part.items.slice(0, PROMPT_ITEMS);
    result.push(part);
    total += part.tokens;
  }
  return { tokens: total, window, parts: result, slices: slicesOf(pieces) };
}

/**
 * The prompt cut into the usage report's slices, from every piece — before
 * the items a response carries are capped, so the sums are the whole prompt.
 * A tool result the protocol sends as a user turn (Anthropic's) reads as
 * chat here: the summarizer reads turns, not the parts inside them.
 */
function slicesOf(pieces: readonly PromptPiece[]): PromptSlice[] {
  const totals = new Map<PromptSliceKind, number>();
  for (const piece of pieces) {
    const kind = sliceOf(piece);
    totals.set(kind, (totals.get(kind) ?? 0) + piece.tokens);
  }
  const order: PromptSliceKind[] = ["system", "tools", "results", "chat", "other"];
  return order.flatMap((kind) => {
    const tokens = totals.get(kind);
    return tokens === undefined ? [] : [{ kind, tokens }];
  });
}

function sliceOf(piece: PromptPiece): PromptSliceKind {
  if (piece.kind === "system") {
    return "system";
  }
  if (piece.kind === "tools") {
    return "tools";
  }
  if (piece.kind === "other") {
    return "other";
  }
  return piece.tag === "tool" ? "results" : "chat";
}

function addSystem(pieces: PromptPiece[], system: unknown): void {
  if (system === undefined || system === null) {
    return;
  }
  if (typeof system === "string") {
    pieces.push({ kind: "system", name: "System prompt", tag: "system", tokens: tokensOf(system) });
    return;
  }
  if (Array.isArray(system)) {
    for (const [index, block] of system.entries()) {
      const text = textOf(block);
      if (text.length === 0) {
        continue;
      }
      pieces.push({
        kind: "system",
        name: systemName(block, index),
        tag: "system",
        tokens: tokensOf(text),
      });
    }
    return;
  }
  const text = textOf(system);
  if (text.length > 0) {
    pieces.push({ kind: "system", name: "System prompt", tag: "system", tokens: tokensOf(text) });
  }
}

function systemName(block: unknown, index: number): string {
  if (typeof block === "object" && block !== null) {
    const record = block as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) {
      return record.name;
    }
    if (record.cache_control !== undefined) {
      return `System block ${index + 1} (cached)`;
    }
  }
  return index === 0 ? "System prompt" : `System block ${index + 1}`;
}

function addTools(pieces: PromptPiece[], tools: unknown): void {
  if (!Array.isArray(tools)) {
    return;
  }
  for (const tool of tools) {
    if (typeof tool !== "object" || tool === null) {
      continue;
    }
    const record = tool as Record<string, unknown>;
    let name = "tool";
    if (typeof record.name === "string") {
      name = record.name;
    } else if (typeof record.function === "object" && record.function !== null) {
      name = String((record.function as Record<string, unknown>).name ?? "tool");
    }
    const size = JSON.stringify(record).length;
    pieces.push({ kind: "tools", name, tag: "tool", tokens: Math.ceil(size / 4) });
  }
}

function addMessages(pieces: PromptPiece[], messages: unknown): void {
  if (!Array.isArray(messages)) {
    return;
  }
  let turn = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      continue;
    }
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : "";
    if (role === "system" || role === "developer") {
      const text = textOf(record);
      if (text.length > 0) {
        pieces.push({
          kind: "system",
          name: "System prompt",
          tag: "system",
          tokens: tokensOf(text),
        });
      }
      continue;
    }
    if (role === "user" || role === undefined) {
      turn += 1;
    }
    const text = textOf(record);
    if (text.length === 0) {
      continue;
    }
    pieces.push({
      kind: "messages",
      name: turn === 0 ? roleName(role) : `Turn ${turn}`,
      tag: roleName(role),
      tokens: tokensOf(text),
    });
  }
}

function addOther(pieces: PromptPiece[], record: Record<string, unknown>): void {
  const known = new Set([
    "model",
    "stream",
    "system",
    "instructions",
    "systemInstruction",
    "tools",
    "messages",
    "contents",
    "input",
    "temperature",
    "max_tokens",
    "max_output_tokens",
    "metadata",
    "top_p",
    "top_k",
    "stop",
    "stream_options",
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (known.has(key) || value === undefined || value === null) {
      continue;
    }
    const text = JSON.stringify(value) ?? "";
    if (text.length < 32) {
      continue;
    }
    pieces.push({
      kind: "other",
      name: key,
      tag: "other",
      tokens: Math.ceil(text.length / 4),
    });
  }
}

function roleName(role: string): string {
  if (role === "assistant" || role === "model") {
    return "assistant";
  }
  if (role === "tool" || role === "function") {
    return "tool";
  }
  return "user";
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("\n");
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    if (Array.isArray(record.content)) {
      return record.content.map(textOf).join("\n");
    }
    if (Array.isArray(record.parts)) {
      return record.parts.map(textOf).join("\n");
    }
    if (record.source !== undefined) {
      return JSON.stringify(record.source);
    }
    if (record.image_url !== undefined || record.inlineData !== undefined) {
      return "[image]";
    }
  }
  return "";
}

function tokensOf(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.charCodeAt(0) < 128) {
      ascii += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(ascii / 4) + other;
}
