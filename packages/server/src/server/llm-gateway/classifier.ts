/**
 * A group's rules that name an intent need the message judged. myna asks a
 * model the group names as its classifier through its own gateway, so the
 * call inherits the classifier model's keys, account rotation and failover.
 * Neolix does the same: the transport posts the question to this daemon's own
 * gateway, marked as the router's call so the routing it goes through asks no
 * classifier in turn. A failed or slow answer means no intent matches, as
 * myna's rule when its classifier cannot say. Answers are kept for ten
 * minutes, as myna keeps them, so a conversation's turns ask once.
 */
const CLASSIFY_TIMEOUT_MS = 8000;
const CLASSIFY_KEEP_MS = 10 * 60_000;
const CLASSIFY_CACHE_MAX = 200;
const PROMPT_TEXT_MAX = 4000;

interface CachedTurn {
  at: number;
  intent: string | null;
  effort: ClassifiedEffort | null;
}

const cache = new Map<string, CachedTurn>();

/** Sends the classifier's chat request through the gateway, as its JSON answer. */
export type ClassifierTransport = (input: {
  body: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<unknown>;

/** What the classifier said of a turn: the kind of request, and how hard it is. */
export interface TurnClassification {
  intent: string | null;
  effort: ClassifiedEffort | null;
}

const NOTHING: TurnClassification = { intent: null, effort: null };

export async function classifyIntent(input: {
  model: string;
  intents: string[];
  text: string;
  transport: ClassifierTransport;
  timeoutMs?: number;
}): Promise<string | null> {
  return (await classifyTurn({ ...input, effort: false })).intent;
}

/** The efforts myna's classifier chooses among, lowest first (internal/gateway/decide.go). */
export const CLASSIFIED_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type ClassifiedEffort = (typeof CLASSIFIED_EFFORTS)[number];

const EFFORT_LEVELS: ReadonlyArray<{ effort: ClassifiedEffort; what: string }> = [
  {
    effort: "low",
    what: "Little to think about: a greeting, a question answered from what is already known, a mechanical or one-line change, running a command",
  },
  {
    effort: "medium",
    what: "Some thought: an ordinary bug fix or a small feature in code already understood",
  },
  {
    effort: "high",
    what: "Careful thought: a change across several files, a bug whose cause is not known yet, a design choice with trade-offs",
  },
  {
    effort: "xhigh",
    what: "Deep thought: a subtle bug (concurrency, performance, security), an architecture or algorithm to design, a long multi-step plan",
  },
];

const EFFORT_PROMPT =
  "You judge how much reasoning a coding assistant needs to handle a user's message well. " +
  "Given numbered levels and the user's message, answer with the number of the level it needs. " +
  "Answer with the number only.";

/**
 * The reasoning a turn wants, as myna's classifier rates it (EffortAuto):
 * asked once per message, kept for ten minutes. Null when it can't say.
 */
export async function classifyEffort(input: {
  model: string;
  text: string;
  transport: ClassifierTransport;
  timeoutMs?: number;
}): Promise<ClassifiedEffort | null> {
  return (await classifyTurn({ ...input, intents: [], effort: true })).effort;
}

/**
 * Asks the classifier once for everything the turn needs, as myna's
 * jevBody does: the kind of request when the rules name intents, and how
 * hard it is when the group picks effort itself. Both in one request, so a
 * group with rules and `effort=auto` pays the classifier once.
 */
export async function classifyTurn(input: {
  model: string;
  intents: string[];
  /** Whether the group's effort is the classifier's to pick. */
  effort: boolean;
  text: string;
  transport: ClassifierTransport;
  timeoutMs?: number;
}): Promise<TurnClassification> {
  const intents = [...new Set(input.intents)];
  const asksIntent = intents.length > 0;
  const text = input.text.trim();
  if ((!asksIntent && !input.effort) || text.length === 0) {
    return NOTHING;
  }
  const key = `${input.model}\u0000${intents.join("\u0001")}\u0000${input.effort ? "effort" : ""}\u0000${text}`;
  const cached = cache.get(key);
  if (cached !== undefined && Date.now() - cached.at < CLASSIFY_KEEP_MS) {
    return { intent: cached.intent, effort: cached.effort };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? CLASSIFY_TIMEOUT_MS);
  let body: Record<string, unknown>;
  if (asksIntent && input.effort) {
    body = turnBody(input.model, intents, text);
  } else if (asksIntent) {
    body = classifierBody(input.model, promptFor(intents, text));
  } else {
    body = effortBody(input.model, text);
  }
  try {
    const json = await input.transport({ body, signal: controller.signal });
    const answer = answerText(json);
    const said =
      asksIntent && input.effort
        ? combinedOf(answer, intents)
        : {
            intent: asksIntent ? matchIntent(answer, intents) : null,
            effort: input.effort ? effortOf(answer) : null,
          };
    remember(key, said);
    return said;
  } catch {
    return NOTHING;
  } finally {
    clearTimeout(timer);
  }
}

const TURN_PROMPT =
  "You judge a coding agent's request. Answer with one JSON object and nothing else, " +
  'as {"intent": <number>, "effort": <number>}.';

/**
 * One request asking both, as myna's jevBody does: numbered kinds, and a
 * reasoning level for the message, answered together as JSON.
 */
function turnBody(model: string, intents: string[], text: string): Record<string, unknown> {
  const kinds = intents.map((intent, index) => `${index + 1}. ${intent}`).join("\n");
  const levels = EFFORT_LEVELS.map(
    (level, index) => `${index + 1}. ${level.effort}: ${level.what}`,
  ).join("\n");
  const prompt = [
    "Which kind of request fits the user's message? Answer with its number, or 0 for none of them.",
    kinds,
    "0. none of these",
    "",
    "How much reasoning does handling it well need? Answer with the level's number.",
    levels,
    "",
    "The user's message:",
    "<message>",
    text.slice(0, PROMPT_TEXT_MAX),
    "</message>",
    "",
    'Answer as {"intent": <number>, "effort": <number>}:',
  ].join("\n");
  return {
    model,
    messages: [
      { role: "system", content: TURN_PROMPT },
      { role: "user", content: prompt },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 2048,
  };
}

/** The combined answer: the kind's number and the effort's, from one JSON object. */
function combinedOf(answer: string, intents: string[]): TurnClassification {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return NOTHING;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return NOTHING;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return NOTHING;
  }
  const record = parsed as Record<string, unknown>;
  const intent = levelChoice(record.intent);
  const effort = levelChoice(record.effort);
  return {
    intent:
      intent === null || intent < 1 || intent > intents.length
        ? null
        : (intents[intent - 1] ?? null),
    effort: effort === null ? null : (CLASSIFIED_EFFORTS[effort - 1] ?? null),
  };
}

/** A number the classifier answered, given as a JSON number or a string of digits. */
function levelChoice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const match = /\d+/.exec(value);
    return match === null ? null : Number(match[0]);
  }
  return null;
}

function effortBody(model: string, text: string): Record<string, unknown> {
  const levels = EFFORT_LEVELS.map(
    (level, index) => `${index + 1}. ${level.effort}: ${level.what}`,
  ).join("\n");
  const prompt = [
    "Levels:",
    levels,
    "",
    "The user's message:",
    "<message>",
    text.slice(0, PROMPT_TEXT_MAX),
    "</message>",
    "",
    "The number of the level it needs:",
  ].join("\n");
  return {
    model,
    messages: [
      { role: "system", content: EFFORT_PROMPT },
      { role: "user", content: prompt },
    ],
    stream: false,
    temperature: 0,
    max_tokens: 2048,
  };
}

function effortOf(answer: string | null): ClassifiedEffort | null {
  if (answer === null) {
    return null;
  }
  const match = /\d+/.exec(answer);
  if (match === null) {
    return null;
  }
  return CLASSIFIED_EFFORTS[Number(match[0]) - 1] ?? null;
}

function remember(key: string, said: TurnClassification): void {
  if (cache.size >= CLASSIFY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, { at: Date.now(), intent: said.intent, effort: said.effort });
}

function promptFor(intents: string[], text: string): string {
  const lines = intents.map((intent, index) => `${index + 1}. ${intent}`).join("\n");
  return [
    "You route a coding agent's request. Which of these describes the user's message?",
    "Answer with exactly one line, copied from the list, or the word none.",
    lines,
    "",
    "User message:",
    text.slice(0, PROMPT_TEXT_MAX),
  ].join("\n");
}

/** Chat, which the gateway translates for whichever protocol the model is. */
function classifierBody(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 64,
    temperature: 0,
    stream: false,
  };
}

function answerText(json: unknown): string {
  if (typeof json !== "object" || json === null) {
    return "";
  }
  const record = json as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => textOfPart(part))
      .filter((part) => part.length > 0)
      .join("\n");
  }
  const outputText = record.output_text;
  if (typeof outputText === "string") {
    return outputText;
  }
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const message = (choices[0] as Record<string, unknown>).message;
    const text = textOfMessage(message);
    if (text.length > 0) {
      return text;
    }
  }
  const output = record.output;
  if (Array.isArray(output)) {
    return output.map((entry) => textOfMessage(entry)).join("\n");
  }
  const candidates = record.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    return textOfMessage((candidates[0] as Record<string, unknown>).content);
  }
  return "";
}

function textOfMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const record = value as Record<string, unknown>;
  const parts = record.parts;
  if (Array.isArray(parts)) {
    return parts.map((part) => textOfPart(part)).join("\n");
  }
  const content = record.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => textOfPart(part)).join("\n");
  }
  const text = record.text;
  return typeof text === "string" ? text : "";
}

function textOfPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  if (typeof part !== "object" || part === null) {
    return "";
  }
  const record = part as Record<string, unknown>;
  const text = record.text;
  if (typeof text === "string") {
    return text;
  }
  return textOfMessage(record);
}

function matchIntent(answer: string, intents: string[]): string | null {
  const said = answer.trim().toLowerCase();
  if (said.length === 0 || said.startsWith("none")) {
    return null;
  }
  const numbered = /^(\d+)\b/.exec(said);
  if (numbered !== null) {
    const index = Number(numbered[1]) - 1;
    if (index >= 0 && index < intents.length) {
      return intents[index] ?? null;
    }
  }
  for (const intent of intents) {
    if (said.includes(intent.toLowerCase())) {
      return intent;
    }
  }
  return null;
}
