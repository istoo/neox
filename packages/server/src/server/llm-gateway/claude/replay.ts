import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ClaudePromptMessage, historyEnd, renderClaudePrompt } from "./prompt.js";

export interface ReplayInput {
  /** Claude Code's project folders for this run's working directory. */
  dirs: readonly string[];
  work: string;
  model: string;
  messages: readonly ClaudePromptMessage[];
  /** Where the turn to answer begins; defaults to historyEnd(messages). */
  split?: number;
}

export interface ReplaySession {
  session: string;
  dirs: readonly string[];
  /** The messages since the reply the transcript ends with. */
  since: readonly ClaudePromptMessage[];
}

/**
 * A transcript Claude Code's interactive history reader can resume, written
 * for a conversation no run has: two lines, the user's (the conversation
 * before the reply, as the run would have been told it) and the assistant's
 * (the reply's words). A run started with `--resume` on it is then typed only
 * the turn after the reply. Told whole instead, a long conversation was one
 * pasted message that Claude Code refused.
 *
 * Returns null when there is no whole reply to end it with, or the file
 * cannot be written; the caller then tells the run the conversation whole.
 */
export async function writeReplaySession(input: ReplayInput): Promise<ReplaySession | null> {
  const split = input.split ?? historyEnd(input.messages);
  if (split < 2 || input.dirs.length === 0) {
    return null;
  }
  const reply = replyWords(input.messages[split - 1]);
  if (reply === "") {
    return null;
  }
  const before = input.messages.slice(0, split - 1);
  const blocks = renderClaudePrompt({ messages: before }).map((block) => ({
    type: "text",
    text: block.text,
  }));
  const session = randomUUID();
  const user = randomUUID();
  const assistant = randomUUID();
  const at = Date.now();
  const line = (
    parent: string | null,
    uuid: string,
    type: string,
    message: unknown,
    when: number,
  ) =>
    `${JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      cwd: input.work,
      sessionId: session,
      type,
      message,
      uuid,
      timestamp: new Date(when).toISOString(),
    })}\n`;
  const content = line(null, user, "user", { role: "user", content: blocks }, at);
  const answer = line(
    user,
    assistant,
    "assistant",
    {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model: input.model,
      content: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    at + 1,
  );
  const dir = input.dirs[input.dirs.length - 1];
  if (dir === undefined) {
    return null;
  }
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, `${session}.jsonl`), content + answer, { mode: 0o600 });
  } catch {
    return null;
  }
  return { session, dirs: input.dirs, since: input.messages.slice(split) };
}

/** What a reply says, its thinking left out. */
export function replyWords(message: ClaudePromptMessage | undefined): string {
  if (message === undefined) {
    return "";
  }
  return message.parts
    .filter((part) => part.kind === "text" && part.text.trim() !== "")
    .map((part) => (part.kind === "text" ? part.text : ""))
    .join("\n\n");
}
