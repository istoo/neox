import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import type { GatewayConfigStore } from "./config.js";
import { clientOfUserAgent } from "./usage.js";

export const GATEWAY_CONVERSATIONS_DIR = "gateway-conversations";

const RETENTION_MS = 7 * 24 * 60 * 60_000;
const STORE_MAX_BYTES = 256 * 1024 * 1024;
const DIRECTION_MAX_BYTES = 64 * 1024;
const RESPONSE_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;
const HIDDEN_FILENAME = "gateway-sessions-hidden.json";

export interface GatewayConversationPart {
  role: string;
  text: string;
}

export interface GatewayConversationTurn {
  time: string;
  agent: string;
  session: string;
  model: string;
  status: number;
  input: GatewayConversationPart[];
  output: GatewayConversationPart[];
  cut?: boolean;
}

interface HiddenSessions {
  /** `agent\0session` → the session's last activity when it was deleted. */
  [identity: string]: string;
}

/**
 * Opt-in local copies of what agents sent through the gateway and what came
 * back. Off unless gateway.json says otherwise; text stays on this computer,
 * expires after 7 days, and the whole store is capped at 256 MiB.
 */
export class GatewayConversations {
  public readonly directory: string;

  private readonly configStore: GatewayConfigStore;
  private readonly logger: Logger;
  private readonly hiddenPath: string;
  private readonly scrub: ((text: string) => string) | undefined;
  private lastPruneAt = 0;

  constructor(options: {
    neolixHome: string;
    configStore: GatewayConfigStore;
    logger: Logger;
    /** Replaces recognized secrets before text reaches the store. */
    scrub?: (text: string) => string;
  }) {
    this.directory = path.join(options.neolixHome, GATEWAY_CONVERSATIONS_DIR);
    this.hiddenPath = path.join(options.neolixHome, HIDDEN_FILENAME);
    this.configStore = options.configStore;
    this.logger = options.logger;
    this.scrub = options.scrub;
  }

  public isEnabled(): boolean {
    return this.configStore.get().recording?.enabled === true;
  }

  public async setEnabled(on: boolean): Promise<void> {
    const config = this.configStore.get();
    await this.configStore.write({ ...config, recording: { enabled: on } });
  }

  /** Deletes every recorded conversation; hidden sessions stay hidden. */
  public async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  public async hasContent(): Promise<boolean> {
    try {
      const dates = await readdir(this.directory);
      return dates.length > 0;
    } catch {
      return false;
    }
  }

  /** Bytes of the conversations recorded for one session. */
  public async sizeOf(agent: string, session: string): Promise<number> {
    if (session.length === 0) {
      return 0;
    }
    const identity = hashIdentity(agent, session);
    let total = 0;
    for (const date of await this.dateDirs()) {
      try {
        total += (await stat(path.join(this.directory, date, identity, "turns.jsonl"))).size;
      } catch {
        // No conversation of this session on that day.
      }
    }
    return total;
  }

  /** What was recorded of a session, in the order the turns arrived. */
  public async transcriptOf(
    agent: string,
    session: string,
  ): Promise<{
    parts: Array<{ role: string; kind: string; text: string; model?: string }>;
    cut: boolean;
    source: string;
  }> {
    const identity = hashIdentity(agent, session);
    const parts: Array<{ role: string; kind: string; text: string; model?: string }> = [];
    let cut = false;
    for (const date of await this.dateDirs()) {
      const file = path.join(this.directory, date, identity, "turns.jsonl");
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.startsWith("{")) {
          continue;
        }
        let turn: GatewayConversationTurn;
        try {
          turn = JSON.parse(line) as GatewayConversationTurn;
        } catch {
          continue;
        }
        cut = cut || turn.cut === true;
        for (const part of turn.input) {
          parts.push({ role: part.role, kind: "text", text: part.text });
        }
        for (const part of turn.output) {
          parts.push({
            role: part.role,
            kind: "text",
            text: part.text,
            ...(turn.model.length === 0 ? {} : { model: turn.model }),
          });
        }
      }
    }
    return { parts, cut, source: "gateway" };
  }

  /** The session's recorded files, for moving them into the trash. */
  public async pathsOf(agent: string, session: string): Promise<string[]> {
    const identity = hashIdentity(agent, session);
    const out: string[] = [];
    for (const date of await this.dateDirs()) {
      const dir = path.join(this.directory, date, identity);
      try {
        await stat(dir);
        out.push(dir);
      } catch {
        // Not recorded on that day.
      }
    }
    return out;
  }

  public async hiddenSince(agent: string, session: string): Promise<string | null> {
    const hidden = await this.readHidden();
    return hidden[`${agent}\u0000${session}`] ?? null;
  }

  public async hide(agent: string, session: string, last: string): Promise<void> {
    const hidden = await this.readHidden();
    hidden[`${agent}\u0000${session}`] = last;
    await this.writeHidden(hidden);
  }

  public async unhide(agent: string, session: string): Promise<void> {
    const hidden = await this.readHidden();
    delete hidden[`${agent}\u0000${session}`];
    await this.writeHidden(hidden);
  }

  /**
   * Captures the client-facing reply of one request. Called before the handler
   * runs so every delivery path is recorded, translated or passed through.
   */
  public capture(req: ExpressRequest, res: ExpressResponse, protocol: string): void {
    if (!this.isEnabled()) {
      return;
    }
    const session = sessionOf(req);
    if (session.length === 0) {
      return;
    }
    const agent = agentOf(req);
    const startedAt = new Date().toISOString();
    const model = typeof req.body?.model === "string" ? req.body.model : "";
    const input = requestParts(req.body, protocol);
    const chunks: Buffer[] = [];
    let captured = 0;
    const collect = (chunk: unknown): void => {
      if (captured >= RESPONSE_CAPTURE_MAX_BYTES) {
        return;
      }
      const buffer = toBuffer(chunk);
      if (buffer === null) {
        return;
      }
      chunks.push(buffer);
      captured += buffer.length;
    };
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      collect(chunk);
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof res.write;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      collect(chunk);
      return (originalEnd as (...args: unknown[]) => unknown)(chunk, ...rest);
    }) as typeof res.end;
    res.once("finish", () => {
      void this.saveTurn({
        agent,
        session,
        startedAt,
        model,
        status: res.statusCode,
        input,
        responseText: Buffer.concat(chunks).toString("utf8"),
        protocol,
      });
    });
  }

  private async saveTurn(input: {
    agent: string;
    session: string;
    startedAt: string;
    model: string;
    status: number;
    input: GatewayConversationPart[];
    responseText: string;
    protocol: string;
  }): Promise<void> {
    const turn: GatewayConversationTurn = {
      time: input.startedAt,
      agent: input.agent,
      session: input.session,
      model: input.model,
      status: input.status,
      input: boundParts(input.input, this.scrub),
      output: boundParts(responseParts(input.responseText, input.protocol), this.scrub),
    };
    if (turn.input.length === 0 && turn.output.length === 0) {
      return;
    }
    try {
      const date = input.startedAt.slice(0, 10);
      const dir = path.join(this.directory, date, hashIdentity(input.agent, input.session));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(path.join(dir, "turns.jsonl"), `${JSON.stringify(turn)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await this.prune();
    } catch (error) {
      this.logger.warn({ err: error }, "Cannot record a gateway conversation");
    }
  }

  /** Removes expired days, then oldest days until the store fits. */
  public async prune(now: number = Date.now()): Promise<void> {
    if (now - this.lastPruneAt < 60_000) {
      return;
    }
    this.lastPruneAt = now;
    const dates = await this.dateDirs();
    const live: string[] = [];
    for (const date of dates) {
      const at = Date.parse(`${date}T00:00:00.000Z`);
      if (Number.isNaN(at) || now - at > RETENTION_MS) {
        await rm(path.join(this.directory, date), { recursive: true, force: true });
      } else {
        live.push(date);
      }
    }
    let total = 0;
    const sizes = new Map<string, number>();
    for (const date of live) {
      const size = await directorySize(path.join(this.directory, date));
      sizes.set(date, size);
      total += size;
    }
    for (const date of live) {
      if (total <= STORE_MAX_BYTES) {
        break;
      }
      const size = sizes.get(date) ?? 0;
      await rm(path.join(this.directory, date), { recursive: true, force: true });
      total -= size;
    }
  }

  private async dateDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/u.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async readHidden(): Promise<HiddenSessions> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.hiddenPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as HiddenSessions;
    } catch {
      return {};
    }
  }

  private async writeHidden(hidden: HiddenSessions): Promise<void> {
    const tmp = `${this.hiddenPath}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(this.hiddenPath), { recursive: true });
    await appendFile(tmp, `${JSON.stringify(hidden, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmp, this.hiddenPath);
  }
}

function hashIdentity(agent: string, session: string): string {
  return createHash("sha256").update(`${agent}\u0000${session}`).digest("hex");
}

function sessionOf(req: ExpressRequest): string {
  const value = req.get("x-neolix-conversation") ?? req.get("x-magpie-session");
  return value === undefined ? "" : value.trim();
}

const AGENT_BY_CLIENT: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
  opencode: "opencode",
  neolix: "neolix",
};

function agentOf(req: ExpressRequest): string {
  const client = clientOfUserAgent(req.get("user-agent"));
  return AGENT_BY_CLIENT[client] ?? client;
}

function toBuffer(chunk: unknown): Buffer | null {
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  return null;
}

function boundParts(
  parts: GatewayConversationPart[],
  scrub: ((text: string) => string) | undefined,
): GatewayConversationPart[] {
  const out: GatewayConversationPart[] = [];
  let left = DIRECTION_MAX_BYTES;
  for (const part of parts) {
    if (left <= 0) {
      break;
    }
    const cleaned = scrub === undefined ? part.text : scrub(part.text);
    const text = cleaned.length > left ? cleaned.slice(0, left) : cleaned;
    left -= Buffer.byteLength(text, "utf8");
    out.push({ role: part.role, text });
  }
  return out;
}

/** The client-facing request text: what the agent showed the model. */
function requestParts(body: unknown, protocol: string): GatewayConversationPart[] {
  if (!isRecord(body)) {
    return [];
  }
  if (protocol === "anthropic") {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.flatMap((message) => partOfMessage(message, ["text"]));
  }
  if (protocol === "openai" || protocol === "openai-responses") {
    const messages = openAiMessages(body);
    return messages.flatMap((message) => partOfMessage(message, ["text", "input_text"]));
  }
  const contents = Array.isArray(body.contents) ? body.contents : [];
  return contents.flatMap((message) => partOfMessage(message, ["text"], "parts"));
}

function openAiMessages(body: Record<string, unknown>): unknown[] {
  if (Array.isArray(body.messages)) {
    return body.messages;
  }
  return Array.isArray(body.input) ? body.input : [];
}

function partOfMessage(
  message: unknown,
  kinds: readonly string[],
  contentKey = "content",
): GatewayConversationPart[] {
  if (!isRecord(message)) {
    return [];
  }
  const role = typeof message.role === "string" ? message.role : "user";
  const content = message[contentKey];
  if (typeof content === "string" && content.length > 0) {
    return [{ role, text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }
    const type = typeof part.type === "string" ? part.type : "";
    if (type.length > 0 && !kinds.includes(type)) {
      continue;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      texts.push(part.text);
    }
  }
  return texts.length === 0 ? [] : [{ role, text: texts.join("\n") }];
}

/** The reply as the client received it: JSON, or SSE deltas. */
function responseParts(text: string, protocol: string): GatewayConversationPart[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("{")) {
    try {
      return jsonResponseParts(JSON.parse(trimmed), protocol);
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") {
      continue;
    }
    try {
      const event: unknown = JSON.parse(data);
      out.push(...streamEventText(event, protocol));
    } catch {
      // A partial or non-JSON event line is not a reply.
    }
  }
  const joined = out.join("");
  return joined.length === 0 ? [] : [{ role: "assistant", text: joined }];
}

function jsonResponseParts(body: unknown, protocol: string): GatewayConversationPart[] {
  const texts = jsonTexts(body, protocol);
  return texts.length === 0 ? [] : [{ role: "assistant", text: texts.join("\n") }];
}

function jsonTexts(body: unknown, protocol: string): string[] {
  if (!isRecord(body)) {
    return [];
  }
  if (protocol === "anthropic") {
    return textFromParts(body.content, ["text"]);
  }
  if (protocol === "openai") {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    return choices.flatMap((choice) => {
      const message = isRecord(choice) ? choice.message : null;
      return isRecord(message) ? textFromParts(message.content, ["text"]) : [];
    });
  }
  if (protocol === "openai-responses") {
    const output = Array.isArray(body.output) ? body.output : [];
    const texts = output.flatMap((item) =>
      isRecord(item) ? textFromParts(item.content, ["output_text", "text"]) : [],
    );
    return typeof body.output_text === "string" ? [body.output_text, ...texts] : texts;
  }
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  return candidates.flatMap((candidate) => {
    const content = isRecord(candidate) ? candidate.content : null;
    return isRecord(content) ? textFromParts(content.parts, ["text"]) : [];
  });
}

function streamEventText(event: unknown, protocol: string): string[] {
  if (!isRecord(event)) {
    return [];
  }
  if (protocol === "anthropic") {
    if (event.type === "content_block_delta") {
      const delta = isRecord(event.delta) ? event.delta : null;
      return delta !== null && typeof delta.text === "string" ? [delta.text] : [];
    }
    return [];
  }
  if (protocol === "openai") {
    const choices = Array.isArray(event.choices) ? event.choices : [];
    return choices.flatMap((choice) => {
      const delta = isRecord(choice) ? choice.delta : null;
      return isRecord(delta) && typeof delta.content === "string" ? [delta.content] : [];
    });
  }
  if (protocol === "openai-responses") {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      return [event.delta];
    }
    return [];
  }
  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  return candidates.flatMap((candidate) => {
    const content = isRecord(candidate) ? candidate.content : null;
    return isRecord(content) ? textFromParts(content.parts, ["text"]) : [];
  });
}

function textFromParts(value: unknown, kinds: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const part of value) {
    if (!isRecord(part)) {
      continue;
    }
    const type = typeof part.type === "string" ? part.type : "";
    if (type.length > 0 && !kinds.includes(type)) {
      continue;
    }
    if (typeof part.text === "string" && part.text.length > 0) {
      out.push(part.text);
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directorySize(full);
    } else {
      total += (await stat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}
