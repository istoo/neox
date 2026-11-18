/**
 * Shapes a request or reply for one vendor whose API differs from the
 * client's wire: Cline's {success, data} envelope and upstream pin, ZCode's
 * trial-entry refusals, xAI's own Messages/Responses rules, and OpenCode
 * Zen's free tier, which serves only what looks like OpenCode (myna's
 * cline_envelope.go, cline_pin.go, zcode_trial.go, xai_body.go and
 * zenfree.go + provider/opencode_client.go).
 */

// eslint-disable-next-line neolix/no-sync-io -- a request body is shaped while it is built, and a repository is a few small files.
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { IrEvent, IrPart, IrRequest, IrResponse } from "./ir.js";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function parseRecord(text: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

// ---- Cline -----------------------------------------------------------------

export interface ClineBody {
  body: string;
  status: number;
  changed: boolean;
}

/**
 * A Cline reply with its {success, data} envelope taken off: the data as
 * the completion, or an error object with a 502 when success is false. A
 * body that isn't the envelope goes as it came.
 */
export function clineUnwrapped(body: string, status: number): ClineBody {
  const reply = parseRecord(body);
  if (reply === null || typeof reply.success !== "boolean") {
    return { body, status, changed: false };
  }
  if (reply.success) {
    const data = asRecord(reply.data);
    return data === null
      ? { body, status, changed: false }
      : { body: JSON.stringify(data), status, changed: true };
  }
  return {
    body: JSON.stringify({ error: { message: clineError(reply) } }),
    status: status < 400 ? 502 : status,
    changed: true,
  };
}

function clineError(reply: Json): string {
  const error = reply.error;
  if (typeof error === "string" && error !== "") {
    return error;
  }
  const said = asRecord(error)?.message;
  if (typeof said === "string" && said !== "") {
    return said;
  }
  return typeof reply.message === "string" && reply.message !== ""
    ? reply.message
    : "Cline request failed";
}

export interface ClinePin {
  /** The host alone to serve the model from. */
  upstream: string;
  /** OpenRouter's own field rather than Vercel's providerOptions. */
  openRouter: boolean;
  /** ClinePass's has filter beside only. */
  has?: string[];
}

/**
 * A Chat body with the model pinned to its maker's own API; a body naming
 * provider or providerOptions itself is left as the client sent it. The
 * field goes at the end, so a cache's prefix doesn't change.
 */
export function clinePin(body: Json, pin: ClinePin): Json {
  if (body.providerOptions !== undefined || body.provider !== undefined) {
    return body;
  }
  if (pin.openRouter) {
    return { ...body, provider: { only: [pin.upstream] } };
  }
  const gateway: Json = { only: [pin.upstream] };
  if (pin.has !== undefined) {
    gateway.has = pin.has;
  }
  return { ...body, providerOptions: { gateway } };
}

// ---- Cline pin resolution (myna's provider/cline.go ClinePin/ClinePassHas) --

const CLINE_FREE_PREFIX = "cline-free/";

/** A maker's own upstream on the router Cline sends a model through. */
const CLINE_MAKERS: readonly {
  name: string;
  exact: boolean;
  upstream: string;
  openRouter: boolean;
}[] = [
  { name: "glm-5.3-flash", exact: true, upstream: "z-ai", openRouter: true },
  { name: "deepseek", exact: false, upstream: "deepseek", openRouter: false },
  // sdytman on Discord: GLM only through Z.ai
  { name: "glm", exact: false, upstream: "zai", openRouter: false },
];

/** Whether a provider is the Cline API: the ClinePass preset, or Cline's host. */
export function clineProvider(provider: {
  preset?: string;
  plugin?: { pluginId: string; providerId: string } | null;
  baseUrl: string;
}): boolean {
  if (provider.preset === "clinepass") {
    return true;
  }
  try {
    const host = new URL(provider.baseUrl).host;
    return host === "cline.bot" || host.endsWith(".cline.bot");
  } catch {
    return false;
  }
}

function clinePassDeepSeek(model: string): boolean {
  return model.toLowerCase().startsWith("cline-pass/deepseek");
}

/**
 * The upstream a request for model is pinned to on a Cline provider with
 * pinUpstream, null when it pins none: Cline's free models are served where
 * Cline puts them, and the Cline plugin's provider pins its own DeepSeek
 * models itself (myna's ClinePin, clines.go:206).
 */
export function clinePinFor(input: {
  provider: {
    pinUpstream?: boolean;
    preset?: string;
    plugin?: { pluginId: string; providerId: string } | null;
    baseUrl: string;
  };
  model: string;
}): ClinePin | null {
  if (input.provider.pinUpstream !== true) {
    return null;
  }
  if (!clineProvider(input.provider)) {
    return null;
  }
  if (input.model.startsWith(CLINE_FREE_PREFIX)) {
    return null;
  }
  if (input.provider.plugin?.providerId === "cline" && clinePassDeepSeek(input.model)) {
    return null;
  }
  const name = input.model.slice(input.model.lastIndexOf("/") + 1).toLowerCase();
  const maker = CLINE_MAKERS.find(
    (entry) => entry.name === name || (!entry.exact && name.startsWith(entry.name)),
  );
  if (maker === undefined) {
    return null;
  }
  return { upstream: maker.upstream, openRouter: maker.openRouter };
}

/**
 * The capability filter (providerOptions.gateway.has) a pinned ClinePass
 * request carries beside only, null for none: the upstream must cache a
 * repeated prefix, and take images when the request carries one (myna's
 * ClinePassHas, clines.go:259).
 */
export function clinePassHas(input: { model: string; images: boolean }): string[] | null {
  if (!clinePassDeepSeek(input.model)) {
    return null;
  }
  return input.images ? ["vision", "implicit-caching"] : ["implicit-caching"];
}

/**
 * A Chat body with the model pinned when the provider says so: myna's
 * forwardOnce does this after the tool-shape chain (gateway.go:5209).
 */
export function clinePinBody(input: {
  provider: {
    pinUpstream?: boolean;
    preset?: string;
    plugin?: { pluginId: string; providerId: string } | null;
    baseUrl: string;
  };
  protocol: string;
  body: Json;
}): Json {
  if (input.protocol !== "openai") {
    return input.body;
  }
  const model = typeof input.body.model === "string" ? input.body.model : "";
  const pin = clinePinFor({ provider: input.provider, model });
  if (pin === null) {
    return input.body;
  }
  const has = clinePassHas({ model, images: chatImages(input.body) });
  return clinePin(input.body, has === null ? pin : { ...pin, has });
}

/** Whether a Chat body carries an image part. */
export function chatImages(body: Json): boolean {
  for (const message of asArray(body.messages) ?? []) {
    const content = asRecord(message)?.content;
    for (const part of asArray(content) ?? []) {
      const type = asRecord(part)?.type;
      if (type === "image_url" || type === "image" || type === "input_image") {
        return true;
      }
    }
  }
  return false;
}

// ---- ZCode -----------------------------------------------------------------

const ZCODE_ENDED = /(?:^|: )ZCode has no active limited quota for (\S+)$/;
const ZCODE_SPENT =
  /(?:^|: )ZCode's limited quota for (\S+) is exhausted or temporarily unavailable$/;
const EDGE_BLOCKED =
  /request has been blocked|errors\.aliyun\.com|you have been blocked|used cloudflare to restrict access|error code: 10(0[5-9]|1[0-2]|20)\b/i;
const BLOCKED_HINT =
  "the provider's network firewall blocked requests from this IP; wait a while, or switch to another network or proxy";

function vendorMessage(body: string): string {
  const reply = parseRecord(body);
  const message =
    asRecord(reply?.error)?.message ?? reply?.message ?? reply?.error ?? reply?.detail;
  return typeof message === "string" ? message.trim() : body.trim();
}

/** Whether a ZCode trial entry was refused for its own quota. */
export function zcodeTrialRefused(input: {
  pluginProvider: string;
  model: string;
  status: number;
  body: string;
}): boolean {
  if (input.pluginProvider !== "zcode" || !input.model.toLowerCase().endsWith("-trial")) {
    return false;
  }
  const said = vendorMessage(input.body);
  if (input.status === 400) {
    const match = ZCODE_ENDED.exec(said);
    return match !== null && (match[1] ?? "").toLowerCase() === input.model.toLowerCase();
  }
  if (input.status === 429) {
    const match = ZCODE_SPENT.exec(said);
    return match !== null && `${match[1] ?? ""}-trial`.toLowerCase() === input.model.toLowerCase();
  }
  return false;
}

/** Whether a ZCode trial entry met the edge firewall's block page. */
export function zcodeTrialBlocked(input: {
  pluginProvider: string;
  model: string;
  status: number;
  body: string;
}): boolean {
  if (
    input.status < 400 ||
    input.pluginProvider !== "zcode" ||
    !input.model.toLowerCase().endsWith("-trial")
  ) {
    return false;
  }
  return EDGE_BLOCKED.test(input.body) || input.body.includes(BLOCKED_HINT);
}

// ---- xAI -------------------------------------------------------------------

/**
 * xAI's own API takes none of: a reasoning item's null content, a system
 * turn mid-conversation, a tool schema's null required. The caller gates
 * on the host (api.x.ai).
 */
export function xaiBody(protocol: string, body: Json): Json {
  let next = withoutNullToolRequired(body);
  if (protocol === "openai-responses") {
    next = withoutNullReasoningContent(next);
  } else if (protocol === "anthropic") {
    next = systemTurnsFolded(next);
  }
  return next;
}

function withoutNullReasoningContent(body: Json): Json {
  const input = asArray(body.input);
  if (input === null) {
    return body;
  }
  for (const entry of input) {
    const item = asRecord(entry);
    if (item?.type === "reasoning" && "content" in item && item.content === null) {
      delete item.content;
    }
  }
  return body;
}

function withoutNullToolRequired(body: Json): Json {
  const tools = asArray(body.tools);
  if (tools === null) {
    return body;
  }
  for (const entry of tools) {
    const tool = asRecord(entry);
    if (tool === null) {
      continue;
    }
    for (const key of ["parameters", "input_schema"]) {
      dropNullRequired(tool[key]);
    }
    dropNullRequired(asRecord(tool.function)?.parameters);
  }
  return body;
}

/** Deletes every "required": null in a schema, recursively. */
export function dropNullRequired(value: unknown): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const child of value) {
      changed = dropNullRequired(child) || changed;
    }
    return changed;
  }
  const record = asRecord(value);
  if (record === null) {
    return false;
  }
  let changed = false;
  if ("required" in record && record.required === null) {
    delete record.required;
    changed = true;
  }
  for (const child of Object.values(record)) {
    changed = dropNullRequired(child) || changed;
  }
  return changed;
}

function systemTurnsFolded(body: Json): Json {
  const messages = asArray(body.messages);
  if (messages === null) {
    return body;
  }
  const kept: unknown[] = [];
  const folded: unknown[] = [];
  for (const entry of messages) {
    const message = asRecord(entry);
    if (message?.role !== "system") {
      kept.push(entry);
      continue;
    }
    if (typeof message.content === "string") {
      folded.push(message.content);
    } else if (Array.isArray(message.content)) {
      folded.push(...message.content);
    }
  }
  if (kept.length === messages.length) {
    return body;
  }
  const blocks: unknown[] = [];
  if (typeof body.system === "string" && body.system !== "") {
    blocks.push({ type: "text", text: body.system });
  } else if (Array.isArray(body.system)) {
    blocks.push(...body.system);
  }
  for (const part of folded) {
    if (typeof part === "string") {
      if (part !== "") {
        blocks.push({ type: "text", text: part });
      }
    } else {
      blocks.push(part);
    }
  }
  const next: Json = { ...body, messages: kept };
  if (blocks.length > 0) {
    next.system = blocks;
  } else {
    delete next.system;
  }
  return next;
}

// ---- OpenCode Zen's free tier ----------------------------------------------

/** OpenCode 2's core tools, which Zen's free tier wants offered. */
export const OPEN_CODE_TOOLS = ["edit", "glob", "grep", "read", "shell"] as const;

/** The parameters OpenCode 2.2.5 gives its core tools. */
export const OPEN_CODE_TOOL_SCHEMAS: Record<string, Json> = {
  edit: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to edit" },
      oldString: { type: "string", description: "Exact text to find and replace" },
      newString: {
        type: "string",
        description: "Text to replace oldString with (must differ from oldString)",
      },
      replaceAll: {
        type: "boolean",
        description:
          "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
      },
    },
    required: ["path", "oldString", "newString"],
    additionalProperties: false,
  },
  glob: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match files against" },
      path: {
        type: "string",
        description: "Directory to search. Defaults to the current working directory.",
      },
      hidden: {
        type: "boolean",
        description: "Include hidden files and directories (default: false).",
      },
      limit: {
        type: "integer",
        exclusiveMinimum: 0,
        description: "Maximum number of matching files to return (default: 100)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  grep: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        minLength: 1,
        description: "Regular expression or literal text to match in file contents.",
      },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to the current working directory.",
      },
      include: {
        type: "string",
        description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
      },
      literal: {
        type: "boolean",
        description:
          "Treat `pattern` as exact text instead of a regular expression (default: false).",
      },
      caseSensitive: {
        type: "boolean",
        description: "Use case-sensitive matching (default: true).",
      },
      limit: {
        type: "integer",
        exclusiveMinimum: 0,
        description: "Maximum number of matching lines to return (default: 100)",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  read: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory to read" },
      offset: {
        type: "integer",
        minimum: 0,
        description: "The line or directory entry to start reading from (1-based)",
      },
      limit: {
        type: "integer",
        minimum: 0,
        description:
          "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  shell: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command string to execute" },
      workdir: {
        type: "string",
        description:
          "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",
      },
      timeout: {
        type: "integer",
        minimum: 0,
        description:
          "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",
      },
      background: {
        type: "boolean",
        description:
          "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

/** A tool offered only for Zen's free tier to see, which the client lacks. */
export const OPEN_CODE_STUB = "Not available in this session. Never call this tool.";

/** The reply to a turn that called nothing but a stub. */
export const ZEN_STUB_NOTE = "(The model asked for a tool this session doesn't have.)";

/** Whether a model is one of Zen's free ones. */
export function openCodeFree(model: string): boolean {
  return model.endsWith("-free") || model === "big-pickle" || model === "grok-code";
}

function openCodeHost(host: string): boolean {
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/**
 * Whether a provider is OpenCode Zen: at opencode.ai (myna's `IsOpenCode`,
 * provider.go:2091 — a user in the URL is stripped, as `openCodeAt` does).
 */
export function openCodeProvider(provider: { baseUrl: string; preset?: string }): boolean {
  // A provider added from OpenCode's preset is Zen even when a relay or a
  // custom domain hides its host.
  if (provider.preset === "opencode-zen" || provider.preset === "opencode-go") {
    return true;
  }
  try {
    return openCodeHost(new URL(provider.baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * Where a request to Zen's free tier goes: OpenCode 2's /inference paths.
 * Any other URL passes as it came.
 */
export function openCodeFreeUrl(raw: string, protocol: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw;
  }
  if (url.protocol === "" || !openCodeHost(url.hostname)) {
    return raw;
  }
  let rest: string;
  if (url.pathname.startsWith("/zen")) {
    rest = url.pathname.slice("/zen".length);
  } else if (url.pathname.startsWith("/inference")) {
    rest = url.pathname.slice("/inference".length);
  } else {
    return raw;
  }
  const under = (dir: string): boolean => rest === dir || rest.startsWith(`${dir}/`);
  if (rest !== "" && !rest.startsWith("/")) {
    return raw;
  }
  if (
    under("/go") ||
    under("/openai") ||
    under("/anthropic") ||
    under("/google") ||
    under("/systemone")
  ) {
    return raw;
  }
  if (protocol === "openai" || protocol === "openai-responses") {
    url.pathname = `/inference/openai${rest}`;
  } else if (protocol === "anthropic") {
    url.pathname = `/inference/anthropic${rest}`;
  } else {
    url.pathname = `/inference${rest}`;
  }
  return url.toString();
}

const OPEN_CODE_ENV = /<env>[\s\S]*Working directory:[\s\S]*<\/env>/;

/** Whether a prompt already carries OpenCode's environment block. */
export function openCodeHasEnvironment(text: string): boolean {
  return OPEN_CODE_ENV.test(text);
}

function localDir(dir: string, home: string): string {
  let local = dir;
  if (local === "~" || local.startsWith("~/")) {
    local = home + local.slice(1);
  }
  try {
    return realpathSync(local);
  } catch {
    return local;
  }
}

interface Repo {
  root: string;
  isRepo: boolean;
}

/** The git repository a folder is in, as OpenCode finds it. */
function openCodeRepository(dir: string): Repo {
  let current = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(current, ".git");
    let stats: ReturnType<typeof statSync> | null = null;
    try {
      stats = statSync(dotGit);
    } catch {
      stats = null;
    }
    if (stats !== null) {
      return { root: current, isRepo: true };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { root: dir, isRepo: false };
    }
    current = parent;
  }
}

/**
 * OpenCode 2.2.5's environment block, word for word, said for a folder
 * (the home folder when empty). Zen serves a free model as OpenCode's own
 * only when a system message carries one.
 */
export function openCodeEnvironment(
  dir: string,
  options: { home?: string; platform?: string; temp?: string } = {},
): string {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const temp = options.temp ?? tmpdir();
  const start = localDir(dir === "" ? home : dir, home);
  const repo = openCodeRepository(start);
  const workspace = repo.isRepo ? repo.root : start;
  const tempPath =
    platform === "win32" ? path.win32.join(temp, "opencode") : path.posix.join(temp, "opencode");
  return [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${start}`,
    `  Workspace root folder: ${workspace}`,
    `  Is directory a git repo: ${repo.isRepo ? "yes" : "no"}`,
    `  Platform: ${platform}`,
    `  Prefer ${tempPath} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n");
}

/** How a request's tools were offered to Zen's free tier. */
export interface ZenTools {
  /** Upstream name offered under → the client's own name. */
  back: Map<string, string>;
  /** Names offered as stubs. */
  stubs: Set<string>;
}

/** Offers a request's tools as Zen's free tier wants them, and adds its env. */
export function zenFreeTools(
  request: IrRequest,
  dir: string,
  toolSchemas: Record<string, Json> = OPEN_CODE_TOOL_SCHEMAS,
): { request: IrRequest; tools: ZenTools } {
  const back = new Map<string, string>();
  const stubs = new Set<string>();
  const tools = [...request.tools];
  for (const need of OPEN_CODE_TOOLS) {
    let at = tools.findIndex((tool) => tool.name === need);
    if (at < 0) {
      at = tools.findIndex((tool) => tool.name.toLowerCase() === need);
    }
    if (at >= 0) {
      const tool = tools[at];
      if (tool !== undefined && tool.name !== need) {
        back.set(need, tool.name);
        tools[at] = { ...tool, name: need };
      }
      continue;
    }
    const schema = toolSchemas[need];
    if (schema !== undefined) {
      tools.push({ name: need, description: OPEN_CODE_STUB, inputSchema: schema });
      stubs.add(need);
    }
  }
  const to = new Map<string, string>();
  for (const [upstream, own] of back) {
    to.set(own, upstream);
  }
  const messages = request.messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      part.type === "tool_call" && to.has(part.name)
        ? { ...part, name: to.get(part.name) as string }
        : part,
    ),
  }));
  const system = openCodeHasEnvironment(request.system ?? "")
    ? request.system
    : appendEnvironment(request.system, dir);
  const choice =
    typeof request.toolChoice === "object" && request.toolChoice !== null
      ? { name: to.get(request.toolChoice.name) ?? request.toolChoice.name }
      : request.toolChoice;
  return {
    request: { ...request, tools, messages, system, toolChoice: choice },
    tools: { back, stubs },
  };
}

function appendEnvironment(system: string | null, dir: string): string {
  const env = openCodeEnvironment(dir);
  return system === null || system === "" ? env : `${system}\n\n${env}`;
}

/** Turns a model's events back into the client's: names, and no stub calls. */
export class ZenReply {
  private readonly tools: ZenTools;
  private dropping = false;
  private stubbed = false;
  private calls = 0;
  private said = false;

  public constructor(tools: ZenTools) {
    this.tools = tools;
  }

  public see(event: IrEvent): IrEvent[] {
    if (event.type === "tool_call_start") {
      this.dropping = this.tools.stubs.has(event.name);
      if (this.dropping) {
        this.stubbed = true;
        return [];
      }
      const own = this.tools.back.get(event.name);
      this.calls += 1;
      return [own === undefined ? event : { ...event, name: own }];
    }
    if (event.type === "tool_args_delta") {
      return this.dropping ? [] : [event];
    }
    if (event.type === "text_delta") {
      this.dropping = false;
      this.said = this.said || event.text !== "";
      return [event];
    }
    if (
      event.type === "thinking_delta" ||
      event.type === "redacted_thinking" ||
      event.type === "search" ||
      event.type === "reasoning_item"
    ) {
      this.dropping = false;
      return [event];
    }
    if (event.type === "stop") {
      this.dropping = false;
      const out: IrEvent[] = [];
      if (this.stubbed && this.calls === 0 && !this.said) {
        out.push({ type: "text_delta", text: ZEN_STUB_NOTE });
        this.said = true;
      }
      out.push(
        event.reason === "tool_use" && this.stubbed && this.calls === 0
          ? { type: "stop", reason: "end_turn" }
          : event,
      );
      return out;
    }
    return [event];
  }

  /**
   * The same shaping for a reply that came whole: a stub's call is left
   * out, a core tool goes back under the client's name, and a turn that
   * called nothing but a stub ends with its note instead of a tool call.
   */
  public whole(response: IrResponse): IrResponse {
    const parts: IrPart[] = [];
    let calls = 0;
    let stubbed = false;
    let said = false;
    for (const part of response.parts) {
      if (part.type === "tool_call") {
        if (this.tools.stubs.has(part.name)) {
          stubbed = true;
          continue;
        }
        calls += 1;
        const own = this.tools.back.get(part.name);
        parts.push(own === undefined ? part : { ...part, name: own });
        continue;
      }
      if (part.type === "text" && part.text !== "") {
        said = true;
      }
      parts.push(part);
    }
    if (stubbed && calls === 0 && !said) {
      parts.push({ type: "text", text: ZEN_STUB_NOTE });
    }
    return {
      ...response,
      parts,
      stopReason:
        response.stopReason === "tool_use" && stubbed && calls === 0
          ? "end_turn"
          : response.stopReason,
    };
  }
}
