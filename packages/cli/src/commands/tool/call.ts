import { mkdir, open, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getFromGatewayPath, type GatewayTarget } from "../mcp/gateway.js";
import {
  FILES_META,
  GENERATION_RESULT_TOOL,
  type ListedTool,
  PENDING_META,
  paramKind,
  paramList,
  paramShape,
  type ToolParam,
  TOOL_AGENT,
  wordsParam,
  rpc,
} from "./catalog.js";

/** `neolix tool`: what myna's tool_cli.go does from line 430 on. */

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".m4v"]);

const WAIT_MOST_MS = 30 * 60_000;
const POLL_MS = 1_000;

export interface ToolCall {
  args: Record<string, unknown>;
  output: string;
  json: boolean;
}

interface ContentItem {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

export interface ToolAnswer {
  content: ContentItem[];
  isError: boolean;
  meta: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A parameter's name, - and _ alike; "" for none. */
function paramKey(properties: Record<string, ToolParam>, name: string): string {
  if (properties[name] !== undefined) {
    return name;
  }
  const normalize = (value: string): string => value.replaceAll("-", "_");
  return Object.keys(properties).find((key) => normalize(key) === normalize(name)) ?? "";
}

/** val as the Go CLI reads a boolean: 1/t/T/TRUE/true/True and the false
 * spellings, nothing else. */
function parseBoolean(value: string): boolean | null {
  if (["1", "t", "T", "TRUE", "true", "True"].includes(value)) {
    return true;
  }
  if (["0", "f", "F", "FALSE", "false", "False"].includes(value)) {
    return false;
  }
  return null;
}

/** val made absolute when the parameter takes a file and val names one
 * here, relative to this folder: the gateway doesn't know it. */
async function localFile(param: ToolParam, value: string): Promise<string> {
  const description = (param.description ?? "").toLowerCase();
  if (
    !description.includes("file") ||
    !description.includes("path") ||
    value === "" ||
    path.isAbsolute(value) ||
    value.includes("://") ||
    value.toLowerCase().startsWith("data:")
  ) {
    return value;
  }
  try {
    const info = await stat(value);
    return info.isDirectory() ? value : path.resolve(value);
  } catch {
    return value;
  }
}

async function paramValue(name: string, param: ToolParam, raw: string): Promise<unknown> {
  const kind = paramKind(param);
  let value: unknown;
  switch (kind) {
    case "integer": {
      const number = Number.parseInt(raw.trim(), 10);
      if (!/^[+-]?\d+$/.test(raw.trim()) || !Number.isSafeInteger(number)) {
        throw new Error(`--${name} takes a whole number, not "${raw}": nothing was called`);
      }
      value = number;
      break;
    }
    case "number": {
      const number = Number(raw.trim());
      if (raw.trim() === "" || !Number.isFinite(number)) {
        throw new Error(`--${name} takes a number, not "${raw}": nothing was called`);
      }
      value = number;
      break;
    }
    case "boolean": {
      const parsed = parseBoolean(raw.trim());
      if (parsed === null) {
        throw new Error(`--${name} takes true or false, not "${raw}": nothing was called`);
      }
      value = parsed;
      break;
    }
    case "object":
    case "array":
      try {
        value = JSON.parse(raw);
      } catch {
        throw new Error(`--${name} takes JSON, not "${raw}": nothing was called`);
      }
      break;
    default:
      value = await localFile(param, raw);
  }
  if (
    param.enum !== undefined &&
    param.enum.length > 0 &&
    !param.enum.some((entry) => String(entry) === String(value))
  ) {
    throw new Error(
      `--${name} takes ${paramShape({ enum: param.enum })}, not "${raw}": nothing was called`,
    );
  }
  return value;
}

function valueAfter(input: string[], at: number, name: string): string {
  const value = input[at + 1];
  if (value === undefined) {
    throw new Error(`--${name} needs a value: nothing was called`);
  }
  return value;
}

async function setParam(call: ToolCall, key: string, param: ToolParam, raw: string): Promise<void> {
  if (paramKind(param) === "array") {
    const item = param.items ?? { type: "string" };
    const value = await paramValue(key, item, raw);
    const list = Array.isArray(call.args[key]) ? (call.args[key] as unknown[]) : [];
    call.args[key] = [...list, value];
    return;
  }
  if (call.args[key] !== undefined) {
    throw new Error(`--${key} is given twice: nothing was called`);
  }
  call.args[key] = await paramValue(key, param, raw);
}

async function setWords(call: ToolCall, tool: ListedTool, words: string[]): Promise<void> {
  const target = wordsParam(tool);
  if (target === "") {
    throw new Error(
      `${tool.name} takes no words, only --<param> <value>: nothing was called; it takes ${paramList(tool)}`,
    );
  }
  if (call.args[target] !== undefined) {
    throw new Error(
      `--${target} is given, and the words "${words.join(" ")}" too: nothing was called`,
    );
  }
  const param = tool.inputSchema.properties[target];
  if (param !== undefined) {
    call.args[target] = await paramValue(target, param, words.join(" "));
  }
}

/** Reads -o/--output: the index after its value, or null when this isn't
 * the output option. */
function outputArgument(
  argument: string,
  input: string[],
  index: number,
  call: ToolCall,
): number | null {
  if (argument === "-o" || argument === "--output") {
    call.output = valueAfter(input, index, argument);
    return index + 1;
  }
  if (!argument.startsWith("--output=")) {
    return null;
  }
  const value = argument.slice("--output=".length);
  if (value === "") {
    throw new Error("--output needs a file or a folder: nothing was called");
  }
  call.output = value;
  return index;
}

/** Reads one --<param> [value] token: the index after the value it took. */
async function parameterArgument(
  tool: ListedTool,
  argument: string,
  input: string[],
  index: number,
  call: ToolCall,
): Promise<number> {
  const properties = tool.inputSchema.properties;
  const body = argument.slice(2);
  const equals = body.indexOf("=");
  const name = equals < 0 ? body : body.slice(0, equals);
  const key = paramKey(properties, name);
  if (key === "") {
    throw new Error(
      `${tool.name} takes no --${name}: nothing was called; it takes ${paramList(tool)} (neox tools ${tool.name})`,
    );
  }
  const param = properties[key] ?? {};
  if (equals >= 0) {
    await setParam(call, key, param, body.slice(equals + 1));
    return index;
  }
  if (paramKind(param) === "boolean") {
    const next = input[index + 1];
    const taken = next === "true" || next === "false" ? next : "true";
    await setParam(call, key, param, taken);
    return next === "true" || next === "false" ? index + 1 : index;
  }
  await setParam(call, key, param, valueAfter(input, index, name));
  return index + 1;
}

/** Reads what follows `neolix tool <name>` against the tool's parameters:
 * nothing is called on an error. */
export async function parseToolArgs(tool: ListedTool, input: string[]): Promise<ToolCall> {
  const call: ToolCall = { args: {}, output: "", json: false };
  const words: string[] = [];
  for (let index = 0; index < input.length; index++) {
    const argument = input[index] ?? "";
    if (argument === "--") {
      words.push(...input.slice(index + 1));
      break;
    }
    if (argument === "--json") {
      call.json = true;
      continue;
    }
    const outputAt = outputArgument(argument, input, index, call);
    if (outputAt !== null) {
      index = outputAt;
      continue;
    }
    if (!argument.startsWith("--")) {
      if (argument.length > 1 && argument.startsWith("-")) {
        throw new Error(
          `unknown flag ${argument}: nothing was called (words that begin with - go after --)`,
        );
      }
      words.push(argument);
      continue;
    }
    index = await parameterArgument(tool, argument, input, index, call);
  }
  if (words.length > 0) {
    await setWords(call, tool, words);
  }
  const missing = (tool.inputSchema.required ?? []).filter((name) => call.args[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `${tool.name} needs ${missing.map((name) => `--${name}`).join(" and ")}: nothing was called (neox tools ${tool.name})`,
    );
  }
  return call;
}

function answerOf(result: unknown): ToolAnswer {
  const answer = record(result) ? result : {};
  const content = Array.isArray(answer.content) ? (answer.content as ContentItem[]) : [];
  return {
    content,
    isError: answer.isError === true,
    meta: record(answer._meta) ? answer._meta : {},
  };
}

function pendingId(answer: ToolAnswer): string {
  const value = answer.meta[PENDING_META];
  if (typeof value === "string") {
    return value;
  }
  if (answer.isError) {
    return "";
  }
  const match = /generation_result with id "([^"]+)"/.exec(answerText(answer));
  return match?.[1] ?? "";
}

export function answerText(answer: ToolAnswer): string {
  return answer.content
    .filter((item) => item.type === "text" && typeof item.text === "string" && item.text !== "")
    .map((item) => `${String(item.text).replace(/\n+$/, "")}\n`)
    .join("");
}

/** Calls the tool and waits for what it makes (myna tool_cli.go:660). */
export async function callTool(
  target: GatewayTarget,
  tool: ListedTool,
  args: Record<string, unknown>,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    say?: (text: string) => void;
  } = {},
): Promise<ToolAnswer> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const say = options.say ?? ((text: string) => process.stderr.write(`${text}\n`));
  const deadline = now() + WAIT_MOST_MS;
  let id = 1;
  let result = await rpc(target, tool.path, "tools/call", { name: tool.name, arguments: args }, id);
  for (;;) {
    const answer = answerOf(result);
    const pending = pendingId(answer);
    if (pending === "" || now() > deadline) {
      return answer;
    }
    say(`still being made (${pending}), waiting…`);
    await sleep(POLL_MS);
    id += 1;
    result = await rpc(
      target,
      tool.path,
      "tools/call",
      { name: GENERATION_RESULT_TOOL, arguments: { id: pending } },
      id,
    );
  }
}

interface MadeFileMeta {
  url: string;
  inline?: boolean;
}

interface Made {
  data?: Buffer;
  url?: string;
}

function fileMeta(answer: ToolAnswer): MadeFileMeta[] {
  const value = answer.meta[FILES_META];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is MadeFileMeta => record(entry) && typeof entry.url === "string",
  );
}

function inlineFiles(answer: ToolAnswer): Buffer[] {
  const out: Buffer[] = [];
  for (const item of answer.content) {
    if ((item.type !== "image" && item.type !== "video") || typeof item.data !== "string") {
      continue;
    }
    out.push(Buffer.from(item.data, "base64"));
  }
  return out;
}

/** The extension of what data is (myna tool_cli.go:824). */
function madeExt(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return ".jpg";
  }
  if (
    data.length >= 12 &&
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  if (data.toString("ascii", 0, 4) === "GIF8") {
    return ".gif";
  }
  if (data.length >= 4 && data.toString("hex", 0, 4) === "1a45dfa3") {
    return ".webm";
  }
  if (data.length >= 12 && data.toString("ascii", 4, 8) === "ftyp") {
    return ".mp4";
  }
  return ".png";
}

function slug(prompt: string): string {
  const text = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return text === "" ? "image" : text;
}

function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function expand(pathText: string, cwd: string): string {
  if (pathText.startsWith("~/")) {
    return path.join(homedir(), pathText.slice(2));
  }
  return path.isAbsolute(pathText) ? pathText : path.join(cwd, pathText);
}

async function isFolder(target: string, original: string): Promise<boolean> {
  if (original.endsWith("/") || path.extname(target) === "") {
    return true;
  }
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

function folderFor(ext: string): string {
  return VIDEO_EXT.has(ext) ? "generated-videos" : "generated-images";
}

function namedExt(ext: string): string {
  return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext) ? ext : "";
}

/** Where the i-th of n files made from prompt goes (myna imagemcp
 * Imagemcp.go:717 `Target`). */
export async function targetPath(input: {
  cwd: string;
  output: string;
  prompt: string;
  ext: string;
  index: number;
  most: number;
  now?: Date;
}): Promise<string> {
  let dir = path.join(input.cwd, folderFor(input.ext));
  let name = "";
  if (input.output !== "") {
    const at = expand(input.output, input.cwd);
    if (await isFolder(at, input.output)) {
      dir = at;
    } else {
      dir = path.dirname(at);
      name = path.basename(at);
    }
  }
  if (name === "") {
    name = `${slug(input.prompt)}-${stamp(input.now ?? new Date())}${input.ext}`;
  }
  let base = name.slice(0, name.length - path.extname(name).length);
  let ext = path.extname(name);
  const lower = ext.toLowerCase();
  if ((lower === ".jpeg" && input.ext === ".jpg") || lower === input.ext) {
    // the name already says what the file is
  } else if (namedExt(lower) !== "") {
    ext = input.ext;
  } else {
    base = name;
    ext = input.ext;
  }
  if (input.most > 1) {
    base = `${base}-${input.index + 1}`;
  }
  let out = path.join(dir, `${base}${ext}`);
  for (let number = 2; ; number++) {
    try {
      await stat(out);
    } catch {
      return out;
    }
    out = path.join(dir, `${base}-${number}${ext}`);
  }
}

function parseFileUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!parsed.pathname.startsWith("/")) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/** Saves the images and videos answer brings, at output (a file or folder)
 * or in this folder: the paths saved (myna tool_cli.go:744). */
export async function saveMade(input: {
  target: GatewayTarget;
  cwd: string;
  answer: ToolAnswer;
  output: string;
  prompt: string;
  now?: Date;
}): Promise<string[]> {
  const inline = inlineFiles(input.answer);
  const files = fileMeta(input.answer);
  const made: Made[] = [];
  if (files.length === 0) {
    made.push(...inline.map((data) => ({ data })));
  }
  for (const file of files) {
    if (file.inline === true && inline.length > 0) {
      made.push({ data: inline.shift() });
      continue;
    }
    made.push({ url: file.url });
  }
  const saved: string[] = [];
  for (const [index, item] of made.entries()) {
    if (item.data === undefined) {
      const pathAndQuery = parseFileUrl(item.url ?? "");
      if (pathAndQuery === null) {
        throw new Error(`"${item.url ?? ""}" isn't a file of Neox's`);
      }
      let answer;
      try {
        answer = await getFromGatewayPath(input.target, pathAndQuery, TOOL_AGENT);
      } catch (error) {
        throw new Error(
          `downloading ${pathAndQuery}: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
      item.data = answer.bytes;
    }
    const at = await targetPath({
      cwd: input.cwd,
      output: input.output,
      prompt: input.prompt,
      ext: madeExt(item.data),
      index,
      most: made.length,
      ...(input.now ? { now: input.now } : {}),
    });
    await mkdir(path.dirname(at), { recursive: true, mode: 0o755 });
    const handle = await open(at, "wx", 0o644);
    try {
      await handle.writeFile(item.data);
    } catch (error) {
      await handle.close();
      await unlink(at).catch(() => undefined);
      throw error;
    }
    await handle.close();
    saved.push(at);
  }
  return saved;
}
