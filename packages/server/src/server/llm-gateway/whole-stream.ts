/**
 * A reply a vendor gave whole, written as its protocol's stream (myna's
 * whole_stream.go): the client asked for a stream and already has the
 * stream's headers from the keepalives, so the whole reply can no longer
 * go to it as one. Every item, block and part goes in the events that
 * stream it, with the vendor's own values.
 */

export interface WholeEvent {
  /** The SSE event name; empty for a Chat data line or [DONE]. */
  name: string;
  /** The event's data, already serialized. */
  data: string;
}

function parseRecord(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function str(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? (record[key] as string) : "";
}

/** A value as the JSON an event carries. */
function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Chat: each choice's message a delta, its finish and usage, then [DONE]. */
function chatEvents(body: string): WholeEvent[] | null {
  const reply = parseRecord(body);
  if (reply === null) {
    return null;
  }
  const choices = asArray(reply.choices);
  if (choices === null || choices.length === 0) {
    return null;
  }
  const deltas: Record<string, unknown>[] = [];
  const ends: Record<string, unknown>[] = [];
  for (const [position, entry] of choices.entries()) {
    const choice = asRecord(entry);
    const message = choice === null ? null : asRecord(choice.message);
    if (choice === null || message === null) {
      return null;
    }
    const index = choice.index ?? position;
    const delta: Record<string, unknown> = { ...message };
    let finish = choice.finish_reason ?? null;
    const calls = asArray(delta.tool_calls);
    if (calls !== null && calls.length > 0) {
      const kept: Record<string, unknown>[] = [];
      for (const callEntry of calls) {
        const call = asRecord(callEntry);
        const fn = call === null ? null : asRecord(call.function);
        if (call === null || fn === null || typeof fn.name !== "string") {
          continue;
        }
        kept.push(call);
      }
      const dropped = kept.length < calls.length;
      kept.forEach((call, at) => {
        if (!("index" in call) || dropped) {
          call.index = at;
        }
      });
      if (kept.length === 0) {
        delete delta.tool_calls;
        if (finish === "tool_calls") {
          finish = "stop";
        }
      } else {
        delta.tool_calls = kept;
      }
    }
    const out: Record<string, unknown> = { index, delta, finish_reason: null };
    if (choice.logprobs !== undefined) {
      out.logprobs = choice.logprobs;
    }
    deltas.push(out);
    ends.push({ index, delta: {}, finish_reason: finish });
  }
  const chunk = (part: unknown[], usage?: unknown): WholeEvent => {
    const out: Record<string, unknown> = { object: "chat.completion.chunk", choices: part };
    for (const key of ["id", "created", "model", "system_fingerprint", "service_tier"]) {
      if (key in reply) {
        out[key] = reply[key];
      }
    }
    if (usage !== undefined) {
      out.usage = usage;
    }
    return { name: "", data: json(out) };
  };
  return [chunk(deltas), chunk(ends, reply.usage), { name: "", data: "[DONE]" }];
}

/** Whether an annotation lacks the offsets OpenAI's schema wants. */
function annotationLacksOffsets(annotation: unknown): boolean {
  const note = asRecord(annotation);
  if (note === null || (note.type !== "url_citation" && note.type !== "container_file_citation")) {
    return false;
  }
  const missing = (value: unknown): boolean => value === undefined || value === null;
  return missing(note.start_index) || missing(note.end_index);
}

/** Drops a whole reply's citations that cannot be sent again. */
function dropOffsetlessCitations(output: unknown[]): boolean {
  let dropped = false;
  for (const entry of output) {
    const item = asRecord(entry);
    if (item === null || item.type !== "message") {
      continue;
    }
    const parts = asArray(item.content);
    if (parts === null) {
      continue;
    }
    let itemChanged = false;
    for (const partEntry of parts) {
      const part = asRecord(partEntry);
      if (part === null || part.type !== "output_text") {
        continue;
      }
      const notes = asArray(part.annotations);
      if (notes === null || notes.length === 0) {
        continue;
      }
      const kept = notes.filter((note) => !annotationLacksOffsets(note));
      if (kept.length !== notes.length) {
        part.annotations = kept;
        itemChanged = true;
      }
    }
    if (itemChanged) {
      item.content = parts;
      dropped = true;
    }
  }
  return dropped;
}

/** Responses: created, each item's added/deltas/done, then its end. */
function responsesEvents(body: string): WholeEvent[] | null {
  const reply = parseRecord(body);
  if (reply === null || reply.object !== "response") {
    return null;
  }
  const output = asArray(reply.output);
  if (output === null) {
    return null;
  }
  dropOffsetlessCitations(output);
  const events: WholeEvent[] = [];
  let sequence = 0;
  const send = (type: string, fields: Record<string, unknown>): void => {
    fields.type = type;
    fields.sequence_number = sequence;
    sequence += 1;
    events.push({ name: type, data: json(fields) });
  };
  const begun: Record<string, unknown> = { ...reply, status: "in_progress", output: [] };
  for (const key of ["usage", "incomplete_details", "error", "completed_at"]) {
    delete begun[key];
  }
  send("response.created", { response: begun });
  send("response.in_progress", { response: begun });
  output.forEach((entry, index) => {
    const item = asRecord(entry);
    if (item === null) {
      return;
    }
    const id = item.id;
    const added: Record<string, unknown> = { ...item };
    if ("status" in added) {
      added.status = "in_progress";
    }
    if (item.type === "message") {
      const parts = asArray(item.content) ?? [];
      added.content = [];
      send("response.output_item.added", { output_index: index, item: added });
      parts.forEach((partEntry, partIndex) => {
        const part = asRecord(partEntry);
        if (part === null) {
          return;
        }
        const ids = (fields: Record<string, unknown>): Record<string, unknown> => ({
          ...fields,
          item_id: id,
          output_index: index,
          content_index: partIndex,
        });
        if (part.type === "output_text") {
          const text = str(part, "text");
          send(
            "response.content_part.added",
            ids({ part: { type: "output_text", text: "", annotations: [] } }),
          );
          send("response.output_text.delta", ids({ delta: text, logprobs: [] }));
          (asArray(part.annotations) ?? []).forEach((annotation, noteIndex) => {
            send(
              "response.output_text.annotation.added",
              ids({ annotation_index: noteIndex, annotation }),
            );
          });
          send("response.output_text.done", ids({ text, logprobs: [] }));
        } else if (part.type === "refusal") {
          const refusal = str(part, "refusal");
          send("response.content_part.added", ids({ part: { type: "refusal", refusal: "" } }));
          send("response.refusal.delta", ids({ delta: refusal }));
          send("response.refusal.done", ids({ refusal }));
        } else {
          send("response.content_part.added", ids({ part }));
        }
        send("response.content_part.done", ids({ part }));
      });
    } else if (item.type === "reasoning") {
      const parts = asArray(item.summary) ?? [];
      added.summary = [];
      send("response.output_item.added", { output_index: index, item: added });
      parts.forEach((partEntry, partIndex) => {
        const part = asRecord(partEntry);
        if (part === null) {
          return;
        }
        const text = str(part, "text");
        const ids = (fields: Record<string, unknown>): Record<string, unknown> => ({
          ...fields,
          item_id: id,
          output_index: index,
          summary_index: partIndex,
        });
        send(
          "response.reasoning_summary_part.added",
          ids({ part: { type: "summary_text", text: "" } }),
        );
        send("response.reasoning_summary_text.delta", ids({ delta: text }));
        send("response.reasoning_summary_text.done", ids({ text }));
        send("response.reasoning_summary_part.done", ids({ part }));
      });
    } else if (item.type === "function_call") {
      if (str(item, "id") === "") {
        send("response.output_item.added", { output_index: index, item });
        send("response.output_item.done", { output_index: index, item });
        return;
      }
      const args = str(item, "arguments");
      added.arguments = "";
      send("response.output_item.added", { output_index: index, item: added });
      send("response.function_call_arguments.delta", {
        item_id: id,
        output_index: index,
        delta: args,
      });
      send("response.function_call_arguments.done", {
        item_id: id,
        output_index: index,
        arguments: args,
      });
    } else {
      send("response.output_item.added", { output_index: index, item });
    }
    send("response.output_item.done", { output_index: index, item });
  });
  let end = "response.completed";
  if (reply.status === "incomplete") {
    end = "response.incomplete";
  } else if (reply.status === "failed") {
    end = "response.failed";
  }
  send(end, { response: reply });
  return events;
}

/** Anthropic: message_start, each block's start and deltas, message_delta. */
function anthropicEvents(body: string): WholeEvent[] | null {
  const message = parseRecord(body);
  if (message === null || message.type !== "message") {
    return null;
  }
  const content = asArray(message.content);
  if (content === null) {
    return null;
  }
  const events: WholeEvent[] = [];
  const send = (type: string, fields: Record<string, unknown>): void => {
    fields.type = type;
    events.push({ name: type, data: json(fields) });
  };
  const start: Record<string, unknown> = {
    ...message,
    content: [],
    stop_reason: null,
    stop_sequence: null,
  };
  delete start.safeguard_results;
  const usage = asRecord(message.usage);
  if (usage !== null) {
    start.usage = { ...usage, output_tokens: 0 };
  }
  send("message_start", { message: start });
  content.forEach((entry, index) => {
    const block = asRecord(entry);
    if (block === null) {
      return;
    }
    const delta = (fields: Record<string, unknown>): void => {
      send("content_block_delta", { index, delta: fields });
    };
    const empty: Record<string, unknown> = { ...block };
    if (block.type === "text") {
      const citations = asArray(block.citations) ?? [];
      empty.text = "";
      if ("citations" in block) {
        empty.citations = [];
      }
      send("content_block_start", { index, content_block: empty });
      for (const citation of citations) {
        delta({ type: "citations_delta", citation });
      }
      delta({ type: "text_delta", text: str(block, "text") });
    } else if (block.type === "thinking") {
      empty.thinking = "";
      empty.signature = "";
      send("content_block_start", { index, content_block: empty });
      delta({ type: "thinking_delta", thinking: str(block, "thinking") });
      const signature = str(block, "signature");
      if (signature !== "") {
        delta({ type: "signature_delta", signature });
      }
    } else if (
      block.type === "tool_use" ||
      block.type === "server_tool_use" ||
      block.type === "mcp_tool_use"
    ) {
      const input = block.input ?? {};
      empty.input = {};
      send("content_block_start", { index, content_block: empty });
      delta({ type: "input_json_delta", partial_json: json(input) });
    } else {
      send("content_block_start", { index, content_block: block });
    }
    send("content_block_stop", { index });
  });
  const stop: Record<string, unknown> = {
    stop_reason: message.stop_reason ?? null,
    stop_sequence: message.stop_sequence ?? null,
    stop_details: message.stop_details ?? null,
  };
  if (message.container !== undefined) {
    stop.container = message.container;
  }
  if (message.safeguard_results !== undefined) {
    stop.safeguard_results = message.safeguard_results;
  }
  const end: Record<string, unknown> = { delta: stop };
  if (usage !== null) {
    end.usage = message.usage;
  }
  send("message_delta", end);
  send("message_stop", {});
  return events;
}

/** The events of a protocol's stream that say this whole reply, or null. */
export function wholeEvents(protocol: string, body: string): WholeEvent[] | null {
  if (protocol === "openai") {
    return chatEvents(body);
  }
  if (protocol === "openai-responses") {
    return responsesEvents(body);
  }
  if (protocol === "anthropic") {
    return anthropicEvents(body);
  }
  return null;
}

/** A whole reply as its protocol's SSE text, or null when it isn't one. */
export function wholeAsStream(protocol: string, body: string): string | null {
  const events = wholeEvents(protocol, body);
  if (events === null) {
    return null;
  }
  let out = "";
  for (const event of events) {
    if (event.name !== "") {
      out += `event: ${event.name}\n`;
    }
    out += `data: ${event.data}\n\n`;
  }
  return out;
}
