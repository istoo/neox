/**
 * Codex's Responses Lite, and the request shape another vendor takes, as
 * myna fits it (`internal/gateway/additional_tools.go` and
 * `codex_backend.go`'s forVendor).
 *
 * Codex's Lite models send no tools and no instructions: their tools go as
 * the first input item, an `additional_tools` one, and their prompt as a
 * developer message after it. Every plain function and freeform tool is
 * grouped in the namespace "functions". Only OpenAI knows the item — xAI's
 * backend turns the whole request away over it — so a request going anywhere
 * else has its tools in the tools and the namespace opened into them. It also
 * asks for reasoning context "all_turns" and marks itself Lite in
 * client_metadata; neither is in the Responses API anyone else serves.
 *
 * Neolix works on the parsed body, so these rewrite `Record<string, unknown>`
 * and answer `changed: false` with the same object when nothing was taken
 * out. The ChatGPT backend (Neolix's `chatgpt-api` account) and OpenAI's API
 * get the request as Codex sent it (`liteKept`).
 */

export type Json = Record<string, unknown>;

/** The namespace Responses Lite groups Codex's own functions in. */
export const LITE_NAMESPACE = "functions";

/** The Lite marker a Codex websocket turn repeats in client_metadata. */
export const LITE_MARKER = "ws_request_header_x_openai_internal_codex_responses_lite";

/** The include value that asks for OpenAI's encrypted reasoning to replay. */
const OUTPUT_REPLAY = "output.encrypted_content";

/** The input items whose encrypted_content Codex sends any provider. */
const KEEPS_SEAL = new Set(["reasoning", "compaction", "compaction_summary", "context_compaction"]);

export interface BodyRewrite {
  body: Json;
  /** False when nothing was rewritten; `body` is then the one given. */
  changed: boolean;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Json | null {
  return isRecord(value) ? value : null;
}

function toolKey(tool: Json): string {
  if (typeof tool.name === "string" && tool.name !== "") {
    return tool.name;
  }
  return `#${typeof tool.type === "string" ? tool.type : ""}`;
}

function toolsByName(tools: unknown[]): Map<string, Json> {
  const have = new Map<string, Json>();
  for (const tool of tools) {
    if (isRecord(tool)) {
      have.set(toolKey(tool), tool);
    }
  }
  return have;
}

function containsNamed(tools: unknown[], name: unknown): boolean {
  return tools.some((entry) => isRecord(entry) && entry.name === name);
}

/**
 * A tool added once; a namespace given again adds the tools it didn't have
 * (myna's `addTool`).
 */
function addTool(tools: unknown[], have: Map<string, Json>, tool: Json): void {
  const key = toolKey(tool);
  const held = have.get(key);
  if (held === undefined) {
    have.set(key, tool);
    tools.push(tool);
    return;
  }
  if (held.type !== "namespace" || tool.type !== "namespace") {
    return;
  }
  const nested = Array.isArray(held.tools) ? held.tools : [];
  const more = Array.isArray(tool.tools) ? tool.tools : [];
  for (const entry of more) {
    if (isRecord(entry) && !containsNamed(nested, entry.name)) {
      nested.push(entry);
    }
  }
  held.tools = nested;
}

/** The tools an additional_tools item carries, its "functions" group opened. */
function addLiteTools(tools: unknown[], have: Map<string, Json>, more: unknown[]): void {
  for (const tool of more) {
    if (!isRecord(tool)) {
      continue;
    }
    if (tool.type === "namespace" && tool.name === LITE_NAMESPACE) {
      for (const nested of Array.isArray(tool.tools) ? tool.tools : []) {
        if (isRecord(nested)) {
          addTool(tools, have, nested);
        }
      }
      continue;
    }
    addTool(tools, have, tool);
  }
}

/**
 * A Responses request with its `additional_tools` items moved into its
 * tools, or the request as it was when it has none (myna's
 * `liftAdditionalTools`). A call made earlier under the "functions"
 * namespace loses it: it is the plain call it now is.
 */
export function liftAdditionalTools(body: Json): BodyRewrite {
  const input = body.input;
  if (!Array.isArray(input)) {
    return { body, changed: false };
  }
  // Responses Lite writes its tools as the first input item. An
  // additional_tools item further down is a tool a result loaded in place
  // (LoadedInPlace), which must stay where it was loaded.
  if (!isRecord(input[0]) || input[0].type !== "additional_tools") {
    return { body, changed: false };
  }
  const tools: unknown[] = Array.isArray(body.tools) ? [...body.tools] : [];
  const have = toolsByName(tools);
  const kept: unknown[] = [];
  let lifted = false;
  for (const item of input) {
    if (!isRecord(item) || item.type !== "additional_tools") {
      if (isRecord(item) && item.namespace === LITE_NAMESPACE) {
        const rest = { ...item };
        delete rest.namespace;
        kept.push(rest);
        continue;
      }
      kept.push(item);
      continue;
    }
    lifted = true;
    addLiteTools(tools, have, Array.isArray(item.tools) ? item.tools : []);
  }
  if (!lifted) {
    return { body, changed: false };
  }
  const next: Json = { ...body, input: kept };
  // an additional_tools with nothing in it just goes, and takes the tools
  // member with it when the request had none
  if (tools.length > 0) {
    next.tools = tools;
  } else {
    delete next.tools;
  }
  return { body: next, changed: true };
}

/** The request without `reasoning.context`, the rest of reasoning as it was. */
export function withoutReasoningContext(body: Json): BodyRewrite {
  const reasoning = asRecord(body.reasoning);
  if (reasoning === null || !("context" in reasoning)) {
    return { body, changed: false };
  }
  const rest = { ...reasoning };
  delete rest.context;
  return { body: { ...body, reasoning: rest }, changed: true };
}

/** The request without the Lite marker in client_metadata, the rest as it was. */
export function withoutLiteMetadata(body: Json): BodyRewrite {
  const metadata = asRecord(body.client_metadata);
  if (metadata === null || !(LITE_MARKER in metadata)) {
    return { body, changed: false };
  }
  const rest = { ...metadata };
  delete rest[LITE_MARKER];
  return { body: { ...body, client_metadata: rest }, changed: true };
}

/**
 * A request leaving Lite for a model that isn't one (myna's `fromLite`):
 * tools lifted, no reasoning context, no Lite marker.
 */
export function fromLite(body: Json): BodyRewrite {
  let current = body;
  let changed = false;
  for (const rewrite of [liftAdditionalTools, withoutReasoningContext, withoutLiteMetadata]) {
    const result = rewrite(current);
    current = result.body;
    changed = changed || result.changed;
  }
  return { body: current, changed };
}

/**
 * Whether a user's message is a developer message made a system one: only
 * myna's own compaction ask does that, and Codex's own turns keep the role
 * a relay may check them by (myna's `developerItemsAsSystem`).
 */
export function developerItemsAsSystem(body: Json): BodyRewrite {
  const input = body.input;
  if (!Array.isArray(input)) {
    return { body, changed: false };
  }
  let changed = false;
  const items: unknown[] = [];
  for (const item of input) {
    if (
      isRecord(item) &&
      (item.type === undefined || item.type === "message") &&
      item.role === "developer"
    ) {
      changed = true;
      items.push({ ...item, role: "system" });
      continue;
    }
    items.push(item);
  }
  return changed ? { body: { ...body, input: items }, changed: true } : { body, changed: false };
}

/** The effort a configuration_update item asks for, "" when it asks none. */
function updateEffort(item: Json): string {
  const reasoning = asRecord(item.reasoning);
  if (reasoning === null) {
    return "";
  }
  return typeof reasoning.effort === "string" ? reasoning.effort : "";
}

export interface VendorFit {
  /** The request goes to OpenAI's API or the ChatGPT backend: it as it came. */
  openAi: boolean;
  /** myna's own compaction ask, whose developer messages go as system ones. */
  compaction?: boolean;
}

/**
 * A Responses request as Codex sends it to a vendor that isn't OpenAI's
 * (myna's `forVendor`): without stream_options' reasoning_summary_delivery,
 * the `output.encrypted_content` include, configuration_update items (their
 * effort moved to the top), messages' internal metadata, a call's
 * encrypted_function_args, and the sealed output on an item that keeps none.
 * OpenAI's API and the ChatGPT backend get it as it came.
 */
export function forVendor(body: Json, fit: VendorFit): BodyRewrite {
  if (fit.openAi) {
    return { body, changed: false };
  }
  let current = body;
  let changed = false;
  if (fit.compaction === true) {
    const developer = developerItemsAsSystem(body);
    current = developer.body;
    changed = developer.changed;
  }
  const next: Json = { ...current };
  if (withoutStreamDelivery(next)) {
    changed = true;
  }
  if (withoutReplayInclude(next)) {
    changed = true;
  }
  if (Array.isArray(next.input)) {
    const fitted = fitInputItems(next.input);
    if (fitted.changed) {
      changed = true;
      next.input = fitted.items;
    }
    const reasoning = asRecord(next.reasoning);
    if (fitted.effort !== "" && reasoning !== null) {
      changed = true;
      next.reasoning = { ...reasoning, effort: fitted.effort };
    }
  }
  return changed ? { body: next, changed: true } : { body: current, changed: false };
}

/** Drops Codex's own reasoning_summary_delivery, keeping a client's options. */
function withoutStreamDelivery(body: Json): boolean {
  const streamOptions = asRecord(body.stream_options);
  if (streamOptions === null || !("reasoning_summary_delivery" in streamOptions)) {
    return false;
  }
  const rest = { ...streamOptions };
  delete rest.reasoning_summary_delivery;
  if (Object.keys(rest).length === 0) {
    delete body.stream_options;
  } else {
    body.stream_options = rest;
  }
  return true;
}

/** Drops the include value only OpenAI's API replays. */
function withoutReplayInclude(body: Json): boolean {
  if (!Array.isArray(body.include)) {
    return false;
  }
  const include = body.include.filter((value) => value !== OUTPUT_REPLAY);
  if (include.length === body.include.length) {
    return false;
  }
  if (include.length === 0) {
    delete body.include;
  } else {
    body.include = include;
  }
  return true;
}

interface FittedInput {
  items: unknown[];
  changed: boolean;
  /** The effort the last configuration_update asked for, "" when it asked none. */
  effort: string;
}

function fitInputItems(input: unknown[]): FittedInput {
  const items: unknown[] = [];
  let changed = false;
  let effort = "";
  for (const item of input) {
    if (!isRecord(item)) {
      items.push(item);
      continue;
    }
    if (item.type === "configuration_update") {
      changed = true;
      const asked = updateEffort(item);
      if (asked !== "") {
        effort = asked;
      }
      continue;
    }
    const fitted = fitInputItem(item);
    if (fitted !== item) {
      changed = true;
    }
    items.push(fitted);
  }
  return { items, changed, effort };
}

/** One input item without the metadata only OpenAI's API keeps, or itself. */
function fitInputItem(item: Json): Json {
  const meta = "internal_chat_message_metadata_passthrough" in item;
  const sealed = "encrypted_function_args" in item;
  const replay = "encrypted_content" in item && !KEEPS_SEAL.has(String(item.type));
  if (!meta && !sealed && !replay) {
    return item;
  }
  const rest = { ...item };
  delete rest.internal_chat_message_metadata_passthrough;
  delete rest.encrypted_function_args;
  if (replay) {
    delete rest.encrypted_content;
  }
  return rest;
}

/**
 * Whether a Responses request goes with its top-level access_programs
 * (myna's `keepsAccessPrograms`): to the ChatGPT backend, to OpenAI's API,
 * or to a relay the user set `codex=as-sent` on that Codex called.
 */
export function keepsAccessPrograms(provider: ProviderShape, fromCodex: boolean): boolean {
  return (
    chatGptAccount(provider) ||
    onOpenAiHost(provider) ||
    (provider.codexAsSent === true && !signedIn(provider) && fromCodex)
  );
}

/** The request without its top-level access_programs. */
export function withoutAccessPrograms(body: Json): BodyRewrite {
  if (!("access_programs" in body)) {
    return { body, changed: false };
  }
  const rest = { ...body };
  delete rest.access_programs;
  return { body: rest, changed: true };
}

/** What the request path knows of the provider, for the decisions here. */
export interface ProviderShape {
  baseUrl: string;
  codexAsSent?: boolean;
  accounts: readonly { agent?: string; enabled?: boolean; codexAccountId?: string }[];
}

/** Whether one of its accounts signs in as its own client (myna's Account != nil). */
function signedIn(provider: ProviderShape): boolean {
  return provider.accounts.some(
    (account) =>
      account.enabled !== false &&
      (account.agent !== undefined || account.codexAccountId !== undefined),
  );
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Whether one of its accounts signs in to ChatGPT's own backend. */
export function chatGptAccount(provider: ProviderShape): boolean {
  return provider.accounts.some(
    (account) => account.enabled !== false && account.agent === "chatgpt-api",
  );
}

/** Whether the provider is OpenAI's own API (myna's Host() suffix test). */
export function onOpenAiHost(provider: ProviderShape): boolean {
  return hostOf(provider.baseUrl).endsWith("openai.com");
}

/**
 * Whether a Responses request keeps Codex's Lite shape as it was sent
 * (myna's `liteKept`): to OpenAI, to a ChatGPT account, and to a relay set
 * `codex=as-sent` that Codex called. Another myna's codex model has no
 * Neolix counterpart.
 */
export function liteKept(provider: ProviderShape, options: { fromCodex: boolean }): boolean {
  if (chatGptAccount(provider) || onOpenAiHost(provider)) {
    return true;
  }
  return provider.codexAsSent === true && !signedIn(provider) && options.fromCodex;
}
