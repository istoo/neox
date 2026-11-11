/**
 * What a reply's model name says: the model the agent asked for when the
 * request went out under another name (a group's member, an alias, a
 * provider/model id), the member's id, or the vendor's own text — Settings
 * › Models › Replies › A reply's model (myna's member.go and
 * settings.ReplyModel).
 */

import type { StreamFilter } from "./text-calls.js";

export type ReplyNaming = "asked" | "member" | "vendor";

/**
 * The request's X-Neolix-Response-Model (X-Magpie-Response-Model read the
 * same), which says what that request alone has the reply's model say
 * (myna's member.go responseModelHeader).
 */
export function requestResponseModel(headers: {
  [name: string]: unknown;
}): "asked" | "member" | "vendor" | undefined {
  const header = headers["x-neolix-response-model"] ?? headers["x-magpie-response-model"];
  if (Array.isArray(header)) {
    return undefined;
  }
  if (typeof header !== "string") {
    return undefined;
  }
  const asked = header.trim().toLowerCase();
  if (asked === "asked" || asked === "member" || asked === "vendor") {
    return asked;
  }
  return undefined;
}

type RelayProtocol = "anthropic" | "openai" | "openai-responses" | "gemini";

/** Where each API's reply names its model. */
const MODEL_PATHS: Record<RelayProtocol, string[]> = {
  openai: ["model"],
  "openai-responses": ["model", "response.model"],
  anthropic: ["model", "message.model"],
  gemini: ["modelVersion"],
};

/** The setting, read with the older `memberModel` beside it. */
export function replyNamingOf(config: {
  replyModel?: "asked" | "member" | "vendor";
  memberModel?: boolean;
}): ReplyNaming {
  if (config.replyModel !== undefined) {
    return config.replyModel;
  }
  return config.memberModel === true ? "member" : "asked";
}

/**
 * What the reply to a request says its model is: the request's own
 * X-Neolix-Response-Model (X-Magpie-Response-Model read the same) says, else
 * Settings' ReplyModel (myna's replyNamingOf on member.go:76 — the request's
 * own ask first, for every agent; the user's pick for the rest).
 */
export function replyNamingFor(input: {
  requestHeader: string | undefined;
  config: { replyModel?: "asked" | "member" | "vendor"; memberModel?: boolean };
}): ReplyNaming {
  const asked = (input.requestHeader ?? "").trim().toLowerCase();
  if (asked === "asked" || asked === "member" || asked === "vendor") {
    return asked;
  }
  return replyNamingOf(input.config);
} /**
 * The name a reply should say, null for the vendor's own text (which only
 * a relayed reply can still say).
 */
export function replyNameFor(input: {
  naming: ReplyNaming;
  asked: string;
  wire: string;
  providerId: string;
}): string | null {
  if (input.naming === "vendor") {
    return null;
  }
  if (input.naming === "member") {
    return `${input.providerId}/${input.wire}`;
  }
  // A request that went out under the very name it asked for keeps the
  // vendor's text, a dated name included.
  return input.wire === input.asked ? null : input.asked;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Puts name at one path, cloning what it changes. */
function namedAt(
  body: Record<string, unknown>,
  path: string[],
  name: string,
): { value: Record<string, unknown>; changed: boolean } {
  const key = path[0];
  if (key === undefined) {
    return { value: body, changed: false };
  }
  const current = body[key];
  if (path.length === 1) {
    if (typeof current !== "string" || current === name) {
      return { value: body, changed: false };
    }
    return { value: { ...body, [key]: name }, changed: true };
  }
  const child = asRecord(current);
  if (child === null) {
    return { value: body, changed: false };
  }
  const nested = namedAt(child, path.slice(1), name);
  if (!nested.changed) {
    return { value: body, changed: false };
  }
  return { value: { ...body, [key]: nested.value }, changed: true };
}

/** A whole reply with name for the model it says, unchanged when it says none. */
export function namedModelResponse<T>(body: T, name: string | null, protocol: RelayProtocol): T {
  if (name === null) {
    return body;
  }
  const record = asRecord(body);
  if (record === null) {
    return body;
  }
  let value = record;
  let changed = false;
  for (const path of MODEL_PATHS[protocol] ?? []) {
    const named = namedAt(value, path.split("."), name);
    value = named.value;
    changed = changed || named.changed;
  }
  return changed ? (value as T) : body;
}

/** A relayed event stream whose data lines say name for their model. */
export class ReplyNamingTidy implements StreamFilter {
  private readonly name: string | null;
  private readonly protocol: RelayProtocol;
  private buffer = "";

  public constructor(name: string | null, protocol: RelayProtocol) {
    this.name = name;
    this.protocol = protocol;
  }

  public write(piece: string): string {
    this.buffer += piece;
    const end = this.buffer.lastIndexOf("\n");
    if (end < 0) {
      return "";
    }
    const ready = this.buffer.slice(0, end + 1);
    this.buffer = this.buffer.slice(end + 1);
    return this.rewrite(ready);
  }

  public flush(): string {
    const tail = this.rewrite(this.buffer);
    this.buffer = "";
    return tail;
  }

  private rewrite(region: string): string {
    if (this.name === null || !region.includes('"model')) {
      return region;
    }
    let out = "";
    let rest = region;
    while (rest.length > 0) {
      const end = rest.indexOf("\n");
      const line = end < 0 ? rest : rest.slice(0, end + 1);
      rest = end < 0 ? "" : rest.slice(end + 1);
      out += this.line(line);
    }
    return out;
  }

  private line(line: string): string {
    if (!line.includes('"model')) {
      return line;
    }
    const body = line.replace(/[\r\n]+$/, "");
    if (!body.startsWith("data:")) {
      return line;
    }
    const data = body.slice("data:".length).trim();
    if (!data.startsWith("{")) {
      return line;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return line;
    }
    const named = namedModelResponse(parsed, this.name, this.protocol);
    if (named === parsed) {
      return line;
    }
    return `data: ${JSON.stringify(named)}${line.slice(body.length)}`;
  }
}
