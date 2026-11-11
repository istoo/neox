/**
 * A translated reply the upstream cut off mid-way is asked again, with
 * what the client already has sent back for the model to go on from
 * (myna's continuation.go), where the upstream can go on from a prefilled
 * assistant turn: Anthropic natively, Chat in DeepSeek's prefix or Kimi's
 * partial mode. The state machine, the pause/again decision and the
 * prefill itself are here; issuing the try stays in the attempt loop.
 */

/** How many times a cut reply is asked to go on. */
export const STREAM_RETRIES = 2;
/** How many times a reasoner stuck in a loop is asked again in place. */
export const LOOP_REASKS = 1;
/** How many times a plugin-ended call is asked again where it stood. */
export const CUT_REASKS = 1;

const AI_STUDIO_HOST = "generativelanguage.googleapis.com";
const COMMAND_CODE_HOST = "api.commandcode.ai";

export type PrefillMode = "" | "anthropic" | "prefix" | "partial";

function isPrivateV4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254)
  );
}

function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".local") || bare === "::1") {
    return true;
  }
  return isPrivateV4(bare);
}

function hostName(host: string): string {
  return host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

/** Gemini's own API, or one on this machine or the LAN serving gemini. */
function geminiCompatHost(host: string, model: string): boolean {
  const bare = hostName(host);
  if (bare === AI_STUDIO_HOST) {
    return true;
  }
  return model.toLowerCase().includes("gemini") && isLocalHost(bare);
}

/** Whether every whole reply of this API says it ended. */
export function saysItsEnd(protocol: string, host: string, model: string): boolean {
  if (protocol === "anthropic" || protocol === "openai-responses" || protocol === "gemini") {
    return true;
  }
  return (
    protocol === "openai" && (geminiCompatHost(host, model) || hostName(host) === COMMAND_CODE_HOST)
  );
}

/** How many times a reply that said nothing is asked again in its place. */
export function emptyRetries(input: {
  mayAskAgain: boolean;
  inGroup: boolean;
  thoughtOnly: boolean;
}): number {
  if (input.mayAskAgain || input.inGroup) {
    return 1;
  }
  return input.thoughtOnly ? STREAM_RETRIES + 1 : STREAM_RETRIES;
}

interface GeminiChunk {
  candidates?: { finishReason?: string }[];
  response?: GeminiChunk;
}

/** Whether a Gemini chunk ends the reply (no finishReason, no end). */
export function geminiEnds(data: string): boolean {
  if (!data.includes('"finishReason"') && data.includes('"candidates"')) {
    return false;
  }
  let chunk: GeminiChunk;
  try {
    chunk = JSON.parse(data) as GeminiChunk;
  } catch {
    return false;
  }
  const inner = chunk.response ?? chunk;
  const candidates = inner.candidates ?? [];
  if (candidates.length === 0) {
    return true;
  }
  return candidates.some((candidate) => (candidate.finishReason ?? "") !== "");
}

/** Whether a translated reply's end is said in its stream. */
export function replyEnded(protocol: string, data: string, stop: string): boolean {
  if (protocol === "gemini") {
    return geminiEnds(data);
  }
  if (protocol === "anthropic") {
    return data.includes('"message_stop"');
  }
  if (protocol === "openai-responses") {
    return data.includes('"response.completed"');
  }
  return data.includes("[DONE]") || stop !== "";
}

/** Follows a Chat stream to know whether its last chunk counted the usage. */
export class ChatTail {
  private usage = false;
  private calls = false;

  public see(data: string): void {
    let chunk: {
      choices?: { delta?: { tool_calls?: unknown[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      chunk = JSON.parse(data) as typeof chunk;
    } catch {
      return;
    }
    this.usage =
      chunk.usage !== undefined &&
      ((chunk.usage.prompt_tokens ?? 0) > 0 || (chunk.usage.completion_tokens ?? 0) > 0);
    this.calls =
      this.calls ||
      (chunk.choices ?? []).some((choice) => (choice.delta?.tool_calls ?? []).length > 0);
  }

  /** The finish_reason a reply that ended without one is given. */
  public finish(): string {
    if (!this.usage) {
      return "";
    }
    return this.calls ? "tool_calls" : "stop";
  }
}

/** The Chat chunk that ends a reply with this finish_reason. */
export function finishChunk(finish: string): string {
  return `{"choices":[{"delta":{},"finish_reason":"${finish}","index":0}],"object":"chat.completion.chunk"}`;
}

/** How the upstream goes on from a prefilled assistant turn, if it can. */
export function prefillMode(protocol: string, host: string, model: string): PrefillMode {
  if (protocol === "anthropic") {
    return "anthropic";
  }
  if (protocol !== "openai") {
    return "";
  }
  const bare = hostName(host);
  if (bare === "api.deepseek.com" || bare.endsWith(".deepseek.com")) {
    return "prefix";
  }
  if (bare.includes("moonshot") || bare.includes("kimi")) {
    return "partial";
  }
  if (!isLocalHost(bare)) {
    return "";
  }
  const name = model.toLowerCase();
  if (name.includes("deepseek")) {
    return "prefix";
  }
  return name.includes("kimi") ? "partial" : "";
}

/** What of the reply the client already has, and how to go on from it. */
export class Continuation {
  public readonly mode: PrefillMode;
  public resume = false;
  private think = "";
  private text = "";
  private tools = false;
  private echo = "";
  private seen = "";

  public constructor(mode: PrefillMode) {
    this.mode = mode;
  }

  /** Journals an event the client has. */
  public feed(kind: "think" | "text" | "tool_start" | "tool_args" | "other", text = ""): void {
    if (kind === "think") {
      this.think += text;
    } else if (kind === "text") {
      this.text += text;
    } else if (kind === "tool_start" || kind === "tool_args") {
      this.tools = true;
    }
  }

  /** Whether the reply can go on: a prefill mode, something said, no call. */
  public possible(): boolean {
    return this.mode !== "" && !this.tools && (this.think !== "" || this.text !== "");
  }

  /** The reply's text as the prefill carries it, trailing space cut. */
  public prefillText(): string {
    return this.text.replace(/\s+$/u, "");
  }

  public thinkText(): string {
    return this.think;
  }

  /**
   * Whether the cut reply goes on with another try, and readies it: not a
   * refusal or a request turned away, tries left, the client still there.
   */
  public again(status: number, code: string, tries: number, aborted: boolean): boolean {
    if (
      code !== "" ||
      status === 400 ||
      status === 422 ||
      status === 404 ||
      tries >= STREAM_RETRIES ||
      aborted ||
      !this.possible()
    ) {
      return false;
    }
    this.resume = true;
    this.echo = this.prefillText();
    this.seen = "";
    return true;
  }

  /**
   * A continuation's text less a full echo of what it was prefilled with,
   * holding what could still be one; what it says instead goes whole.
   */
  public unecho(text: string): string {
    if (this.echo === "") {
      return text;
    }
    this.seen += text;
    if (this.seen.length < this.echo.length && this.echo.startsWith(this.seen)) {
      return "";
    }
    let out: string;
    if (this.seen.startsWith(this.echo)) {
      out = this.seen.slice(this.echo.length);
    } else {
      out = this.seen;
    }
    this.seen = "";
    this.echo = "";
    return out;
  }

  /**
   * The body with what the client has of the reply appended as the last
   * assistant turn, marked with the upstream's prefilling mode.
   */
  public withPrefill(protocol: string, body: Record<string, unknown>): Record<string, unknown> {
    if (protocol === "anthropic") {
      const parts: Record<string, unknown>[] = [];
      if (this.think !== "") {
        parts.push({ type: "thinking", thinking: this.think });
      }
      const text = this.prefillText();
      if (text !== "") {
        parts.push({ type: "text", text });
      }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      return { ...body, messages: [...messages, { role: "assistant", content: parts }] };
    }
    if (protocol !== "openai") {
      return body;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const message: Record<string, unknown> = { role: "assistant", content: this.prefillText() };
    if (this.mode === "prefix") {
      message.prefix = true;
    } else if (this.mode === "partial") {
      message.partial = true;
    }
    if (this.think !== "") {
      message.reasoning_content = this.think;
    }
    return { ...body, messages: [...messages, message] };
  }
}
