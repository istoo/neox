import { createHash, randomBytes } from "node:crypto";

/**
 * Google Code Assist, which serves Gemini CLI's and Antigravity's
 * subscriptions (`internal/gateway/codeassist.go:22-28`). It is not
 * Gemini's API: a request is wrapped in `{model, project, request}` and
 * posted to `/v1internal:generateContent` (or
 * `/v1internal:streamGenerateContent?alt=sse`), and a reply is wrapped in
 * `{response}`. This module does only that wrapping, so the gateway's
 * Gemini codec sees the shapes it already knows.
 */

export type CodeAssistAgent = "gemini" | "antigravity";

export function isCodeAssistAgent(agent: string): agent is CodeAssistAgent {
  return agent === "gemini" || agent === "antigravity";
}

/** Where a request goes under the account's Code Assist base. */
export function codeAssistUrl(baseUrl: string, streaming: boolean): string {
  const base = baseUrl.replace(/\/+$/, "");
  return streaming
    ? `${base}/v1internal:streamGenerateContent?alt=sse`
    : `${base}/v1internal:generateContent`;
}

export interface CodeAssistEnvelopeInput {
  /** The vendor's name for the model, asked as the app asks it. */
  model: string;
  /** The Google Cloud project the account bills; absent until Code Assist gives one. */
  project?: string | null;
  /** The Gemini request, already shaped as a Gemini API body. */
  request: Record<string, unknown>;
  /** The app the account is signed in to; the ids it sends along differ. */
  agent?: CodeAssistAgent;
}

/**
 * The envelope Code Assist takes (`internal/gateway/codeassist.go:288-...`),
 * finished with the ids its app sends (`internal/provider/google.go:1527-1556`):
 * Gemini CLI names the prompt with `user_prompt_id`; Antigravity says what
 * an agent request is, names it with `requestId`, and names the
 * conversation in the request's `sessionId`.
 */
export function codeAssistEnvelope(input: CodeAssistEnvelopeInput): Record<string, unknown> {
  const envelope: Record<string, unknown> = { model: input.model, request: input.request };
  if (input.project !== undefined && input.project !== null && input.project !== "") {
    envelope.project = input.project;
  }
  if (input.agent === "antigravity") {
    envelope.userAgent = "antigravity";
    envelope.requestType = "agent";
    envelope.requestId = `agent-${randomToken(12)}`;
    envelope.request = { ...input.request, sessionId: antigravitySession(input.request) };
  } else if (input.agent === "gemini") {
    envelope.user_prompt_id = randomToken(12);
  }
  return envelope;
}

/** A URL-safe token of `bytes` random bytes, as myna's randomToken makes one. */
function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * The conversation's name as Antigravity makes it: the hash of its first
 * user message, so every turn of one conversation keeps the same id, or of
 * a random token when the conversation has no user text
 * (`internal/provider/google.go:1558-1588`).
 */
function antigravitySession(request: Record<string, unknown>): string {
  let first = "";
  const contents = Array.isArray(request.contents) ? request.contents : [];
  for (const content of contents) {
    if (!isRecord(content) || content.role !== "user") {
      continue;
    }
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const part of parts) {
      if (isRecord(part) && typeof part.text === "string" && part.text !== "") {
        first = part.text;
        break;
      }
    }
    break;
  }
  if (first === "") {
    first = randomToken(16);
  }
  const sum = createHash("sha256").update(first).digest();
  return `-${(sum.readBigUInt64BE(0) & 0x7fffffffffffffffn).toString()}`;
}

export type CodeAssistAnswer =
  | { chunk: Record<string, unknown> }
  | { error: string }
  | { empty: true };

/**
 * One reply's body: Code Assist wraps the Gemini chunk as `{response}`, and
 * an error as `{error: {message}}` (`internal/gateway/codeassist.go:1345-1360`).
 * A chunk written at the top level is taken as it is.
 */
export function codeAssistAnswer(value: unknown): CodeAssistAnswer {
  if (!isRecord(value)) {
    return { empty: true };
  }
  if (isRecord(value.error)) {
    const message = typeof value.error.message === "string" ? value.error.message : "";
    return { error: message !== "" ? message : "Code Assist refused the request" };
  }
  if (isRecord(value.response)) {
    return { chunk: value.response };
  }
  return Object.keys(value).length === 0 ? { empty: true } : { chunk: value };
}

/** One `data:` frame of a Code Assist stream, unwrapped. */
export function codeAssistStreamFrame(data: string): string {
  const text = data.trim();
  if (text === "" || text === "[DONE]") {
    return data;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return data;
  }
  const answer = codeAssistAnswer(value);
  if ("error" in answer) {
    return JSON.stringify({ error: { message: answer.error } });
  }
  if ("empty" in answer) {
    return data;
  }
  return JSON.stringify(answer.chunk);
}

/**
 * A whole Code Assist stream, every `data:` frame unwrapped. Other lines
 * (event names, blank separators) pass through untouched.
 */
export function codeAssistStream(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const match = /^data:[ \t]?/.exec(line);
      if (match === null) {
        return line;
      }
      const prefix = match[0];
      return `${prefix}${codeAssistStreamFrame(line.slice(prefix.length))}`;
    })
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------- Antigravity ---- */

/**
 * The system-prompt lines Antigravity turns away with a 429 whatever
 * quota is left (`internal/gateway/codeassist.go:69-105`): Claude Code's
 * billing line, the Claude Agent SDK's identity line, Codex's GPT-5
 * prompts, and Hermes Agent's earlier persona.
 */
export const ANTIGRAVITY_TURNED_AWAY: readonly string[] = [
  "x-anthropic-billing-header:",
  "built on anthropic's claude agent sdk",
  "you are codex, an agent based on gpt-5",
  "you are codex, a coding agent based on gpt-5",
  "hermes agent, an intelligent ai assistant created by nous research",
];

/** Whether Antigravity turns a system instruction away as it is. */
export function antigravityTurnsAway(system: string): boolean {
  const low = system.toLowerCase();
  return ANTIGRAVITY_TURNED_AWAY.some((line) => low.includes(line));
}

/** Whether the system prompt carries Codex's GPT-5 identity line. */
export function antigravityTurnsCodexAway(system: string): boolean {
  const low = system.toLowerCase();
  return (
    low.includes("you are codex, an agent based on gpt-5") ||
    low.includes("you are codex, a coding agent based on gpt-5")
  );
}

/** Whether the system prompt carries Hermes Agent's earlier default persona. */
export function antigravityTurnsHermesAway(system: string): boolean {
  return system
    .toLowerCase()
    .includes("hermes agent, an intelligent ai assistant created by nous research");
}

/** What to tell the user when Claude Code's or Claude Desktop's prompt is turned away (`codeassist.go:227`). */
export const ANTIGRAVITY_TURNED_AWAY_HINT =
  "Antigravity answers this 429 to the system prompt of Claude Code and the Claude Agent SDK (Claude Desktop's chats) whatever quota is left, so it is not a quota and waiting won't help; use another provider for these chats, or put one after Antigravity in a routing group";

/** What to tell the user when a Codex thread hits Antigravity's 429 (`codeassist.go:232`). */
export const ANTIGRAVITY_CODEX_HINT =
  "Antigravity answers this 429 to Codex's own system prompt for GPT-5 models whatever quota is left, so it is not a quota and waiting won't help; a Codex chat begun on a GPT model keeps that prompt after a model switch or a fork, so start a new chat on this model";

/** What to tell the user when Hermes Agent's earlier persona is turned away (`codeassist.go:235`). */
export const ANTIGRAVITY_HERMES_HINT =
  "Antigravity answers this 429 to Hermes Agent's earlier default persona (its SOUL.md) whatever quota is left, so it is not a quota and waiting won't help; Hermes' current default persona goes through, so put it in SOUL.md, or use another provider for these chats";

/** The hint for what Antigravity turned away with system as its instruction (`codeassist.go:240-248`). */
export function antigravityHint(system: string): string {
  if (antigravityTurnsCodexAway(system)) {
    return ANTIGRAVITY_CODEX_HINT;
  }
  if (antigravityTurnsHermesAway(system)) {
    return ANTIGRAVITY_HERMES_HINT;
  }
  return ANTIGRAVITY_TURNED_AWAY_HINT;
}

/**
 * Whether what Antigravity said is its refusal, "Resource has been
 * exhausted", and not the plan's own allowance used up (`codeassist.go:179-181`).
 */
export function antigravityRefuses(said: string): boolean {
  return said.toLowerCase().includes("resource has been exhausted");
}

/**
 * What the gateway answers when nobody is left to serve a request
 * Antigravity turned away: a 400, since the Anthropic and OpenAI SDKs
 * retry a 429 ten times over (`codeassist.go:250-255`).
 */
export const ANTIGRAVITY_TURNED_AWAY_STATUS = 400;

/** The usage log's error type for that refusal (`codeassist.go:258`). */
export const ANTIGRAVITY_TURNED_AWAY_ERR_TYPE = "prompt_turned_away";

/** How long a group foresees the refusal for a prompt, in ms (`codeassist.go:195`). */
export const ANTIGRAVITY_FORESEEN_MS = 6 * 60 * 60_000;

/**
 * The system instruction as an Antigravity account is sent it lives in
 * `provider-shaping.ts` (`antigravityCloak`), one implementation for the
 * whole gateway.
 */

/**
 * The hint for what Antigravity answered, or null: its 429, a system
 * instruction it turns away, and its own "Resource has been exhausted"
 * words. A 429 that says the plan's allowance is used up is the quota it
 * says (`codeassist.go:184-190`).
 */
export function antigravityRefusal(status: number, said: string, system: string): string | null {
  if (status !== 429 || !antigravityTurnsAway(system) || !antigravityRefuses(said)) {
    return null;
  }
  return antigravityHint(system);
}

/** A model in a pooled Antigravity list. */
export interface AntigravityModel {
  id: string;
  context?: number;
  output?: number;
  images?: boolean;
}

/**
 * Merges an account's model list into the pool: a model both have keeps
 * its place and what the least of them supports, and one only this
 * account has goes right where its own picker puts it
 * (`internal/provider/antigravity_pool.go:66-90`).
 */
export function mergeAntigravityModels(
  pooled: readonly AntigravityModel[],
  account: readonly AntigravityModel[],
): AntigravityModel[] {
  const out = pooled.map((model) => ({ ...model }));
  let next = 0;
  for (const model of account) {
    const index = out.findIndex((entry) => entry.id === model.id);
    if (index >= 0) {
      const shared = out[index] as AntigravityModel;
      if (model.images === false) {
        shared.images = false;
      } else if (shared.images === undefined) {
        shared.images = model.images;
      }
      if (model.context !== undefined && model.context > 0) {
        shared.context =
          shared.context === undefined || shared.context === 0
            ? model.context
            : Math.min(shared.context, model.context);
      }
      if (model.output !== undefined && model.output > 0) {
        shared.output =
          shared.output === undefined || shared.output === 0
            ? model.output
            : Math.min(shared.output, model.output);
      }
      next = Math.max(next, index + 1);
      continue;
    }
    out.splice(next, 0, { ...model });
    next += 1;
  }
  return out;
}

/** Models Antigravity lists that aren't for chat (`google.go:964-968`). */
const ANTIGRAVITY_HIDDEN = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
]);

/**
 * One Antigravity account's models from its `fetchAvailableModels` answer
 * (`google.go:985-1125`): its picker's order first, then whatever it lists
 * outside the picker, the ids that aren't for chat and the disabled ones
 * left out. Deterministic where its answer isn't: ties go by id.
 */
export function antigravityModelsOf(body: Record<string, unknown>): AntigravityModel[] {
  const listed = isRecord(body.models) ? body.models : {};
  const rank = antigravityPickerRanks(body.agentModelSorts);
  const found: { model: AntigravityModel; rank: number }[] = [];
  for (const [id, value] of Object.entries(listed)) {
    const model = antigravityModelOf(id, value);
    if (model !== null) {
      found.push({ model, rank: rank.get(id) ?? 0 });
    }
  }
  found.sort((a, b) => antigravityOrder(a, b));
  return found.map((entry) => entry.model);
}

/** The picker place of each model, from 1; one it doesn't show is 0. */
function antigravityPickerRanks(value: unknown): Map<string, number> {
  const rank = new Map<string, number>();
  const sorts = Array.isArray(value) ? value : [];
  for (const sort of sorts) {
    if (!isRecord(sort) || !Array.isArray(sort.groups)) {
      continue;
    }
    for (const group of sort.groups) {
      if (!isRecord(group) || !Array.isArray(group.modelIds)) {
        continue;
      }
      for (const id of group.modelIds) {
        if (typeof id === "string" && !rank.has(id)) {
          rank.set(id, rank.size + 1);
        }
      }
    }
  }
  return rank;
}

/** One model the answer lists, or null for the ids that aren't for chat. */
function antigravityModelOf(id: string, value: unknown): AntigravityModel | null {
  if (ANTIGRAVITY_HIDDEN.has(id) || id.startsWith("chat_") || id.startsWith("tab_")) {
    return null;
  }
  if (!isRecord(value) || value.disabled === true) {
    return null;
  }
  const model: AntigravityModel = { id };
  if (typeof value.maxTokens === "number" && value.maxTokens > 0) {
    model.context = value.maxTokens;
  }
  if (typeof value.maxOutputTokens === "number" && value.maxOutputTokens > 0) {
    model.output = value.maxOutputTokens;
  }
  if (typeof value.supportsImages === "boolean") {
    model.images = value.supportsImages;
  }
  return model;
}

/** Picker order first, the models outside it after, ties by id. */
function antigravityOrder(
  a: { model: AntigravityModel; rank: number },
  b: { model: AntigravityModel; rank: number },
): number {
  if (a.rank !== b.rank) {
    if (a.rank === 0) return 1;
    if (b.rank === 0) return -1;
    return a.rank - b.rank;
  }
  return a.model.id.localeCompare(b.model.id);
}
