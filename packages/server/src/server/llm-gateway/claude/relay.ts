import type { ClaudeMessageUsage, ClaudeStreamEvent } from "./stream.js";

export interface RelayOptions {
  model: string;
  messageId: string;
}

/**
 * Turns the bridge's events into Anthropic Messages SSE frames, as a Claude
 * Code client reads them: one text block for the reply's words, one tool_use
 * block for each call, then the stop and the usage.
 */
export async function* relayClaudeEvents(
  events: AsyncIterable<ClaudeStreamEvent>,
  options: RelayOptions,
): AsyncGenerator<string> {
  const state = new RelayState(options);
  for await (const event of events) {
    const frames = state.push(event);
    for (const frame of frames) {
      yield frame;
    }
  }
  for (const frame of state.end()) {
    yield frame;
  }
}

class RelayState {
  private readonly options: RelayOptions;
  private started = false;
  private index = 0;
  private openBlock: "text" | "tool" | null = null;
  private stop = "";
  private usage: ClaudeMessageUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  public constructor(options: RelayOptions) {
    this.options = options;
  }

  public push(event: ClaudeStreamEvent): string[] {
    switch (event.kind) {
      case "text":
        return this.text(event.text);
      case "toolCall":
        return this.toolCall(event);
      case "usage":
        this.usage = event.usage;
        return [];
      case "stop":
        this.stop = event.stop;
        return [];
      case "error":
        return [
          ...this.closeBlock(),
          sse("error", { type: "error", error: { type: "api_error", message: event.message } }),
        ];
    }
  }

  public end(): string[] {
    const frames = [...this.closeBlock()];
    if (!this.started) {
      frames.push(...this.start());
    }
    frames.push(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: this.stop === "" ? "end_turn" : this.stop, stop_sequence: null },
        usage: {
          output_tokens: this.usage.outputTokens,
          cache_creation_input_tokens: this.usage.cacheCreationInputTokens,
          cache_read_input_tokens: this.usage.cacheReadInputTokens,
        },
      }),
      sse("message_stop", { type: "message_stop" }),
    );
    return frames;
  }

  private text(text: string): string[] {
    if (text === "") {
      return [];
    }
    const frames = this.openText();
    frames.push(
      sse("content_block_delta", {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "text_delta", text },
      }),
    );
    return frames;
  }

  private toolCall(event: Extract<ClaudeStreamEvent, { kind: "toolCall" }>): string[] {
    const frames = [...this.closeBlock(), ...this.start()];
    this.openBlock = "tool";
    frames.push(
      sse("content_block_start", {
        type: "content_block_start",
        index: this.index,
        content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
      }),
      sse("content_block_delta", {
        type: "content_block_delta",
        index: this.index,
        delta: { type: "input_json_delta", partial_json: event.arguments },
      }),
    );
    return frames;
  }

  private openText(): string[] {
    if (this.openBlock === "text") {
      return [];
    }
    const frames = [...this.closeBlock(), ...this.start()];
    this.openBlock = "text";
    frames.push(
      sse("content_block_start", {
        type: "content_block_start",
        index: this.index,
        content_block: { type: "text", text: "" },
      }),
    );
    return frames;
  }

  private closeBlock(): string[] {
    if (this.openBlock === null) {
      return [];
    }
    this.openBlock = null;
    const frame = sse("content_block_stop", { type: "content_block_stop", index: this.index });
    this.index += 1;
    return [frame];
  }

  private start(): string[] {
    if (this.started) {
      return [];
    }
    this.started = true;
    return [
      sse("message_start", {
        type: "message_start",
        message: {
          id: this.options.messageId,
          type: "message",
          role: "assistant",
          model: this.options.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.usage.inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: this.usage.cacheCreationInputTokens,
            cache_read_input_tokens: this.usage.cacheReadInputTokens,
          },
        },
      }),
    ];
  }
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
