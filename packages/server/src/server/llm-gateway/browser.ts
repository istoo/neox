import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Response as ExpressResponse } from "express";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { BROWSER_FILES_PATH, BrowserFileStore } from "./browser-files.js";
import {
  BrowserRecordings,
  RECORD_MOST,
  encodeRecordingGif,
  recordFrame,
  recordSay,
} from "./browser-record.js";

/**
 * The Myna Browser extension, ported from myna: an agent's browser calls act
 * in the user's own Chromium browser, signed in to whatever they are. The
 * extension holds a WebSocket to this daemon; each MCP call is handed to it,
 * carried out with the DevTools protocol, and answered with MCP content.
 *
 * Only this computer's extension may connect, and only this computer's
 * agents may call: the tools act as the user wherever they are signed in.
 */

export const BROWSER_EXTENSION_ID = "dmlhojidlfnkgamkekjhacgkpanbkeko";
const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_EXTENSION_ID}`;
const EXTENSION_PATH = "/v1/myna/browser/extension";
const CALL_WAIT_MS = 100_000;
const EXTENSION_DIR = fileURLToPath(new URL("./browser-extension/", import.meta.url));

interface BrowserConnection {
  ws: WebSocket;
  id: string;
  version: string;
  agent: string;
  since: number;
}

interface ToolResult {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
  [key: string]: unknown;
}

const BROWSER_ACTIONS: Record<string, { tool: string; set?: Record<string, unknown> }> = {
  tabs: { tool: "browser_tabs" },
  tab_new: { tool: "browser_tabs", set: { action: "new" } },
  tab_select: { tool: "browser_tabs", set: { action: "select" } },
  tab_close: { tool: "browser_tabs", set: { action: "close" } },
  browsers: { tool: "browser_tabs", set: { action: "browsers" } },
  use_browser: { tool: "browser_tabs", set: { action: "use" } },
  navigate: { tool: "browser_navigate" },
  back: { tool: "browser_navigate", set: { go: "back" } },
  forward: { tool: "browser_navigate", set: { go: "forward" } },
  reload: { tool: "browser_navigate", set: { go: "reload" } },
  snapshot: { tool: "browser_snapshot" },
  click: { tool: "browser_click" },
  type: { tool: "browser_type" },
  press: { tool: "browser_press" },
  hover: { tool: "browser_hover" },
  select: { tool: "browser_select" },
  scroll: { tool: "browser_scroll" },
  drag: { tool: "browser_drag" },
  upload: { tool: "browser_upload" },
  wait: { tool: "browser_wait" },
  screenshot: { tool: "browser_screenshot" },
  evaluate: { tool: "browser_evaluate" },
  text: { tool: "browser_text" },
  console: { tool: "browser_console" },
  dialog: { tool: "browser_dialog" },
  record_start: { tool: "record", set: { action: "start" } },
  record_stop: { tool: "record", set: { action: "stop" } },
};

const BROWSER_ACTION_ORDER = [
  "tabs",
  "tab_new",
  "tab_select",
  "tab_close",
  "browsers",
  "use_browser",
  "navigate",
  "back",
  "forward",
  "reload",
  "snapshot",
  "click",
  "type",
  "press",
  "hover",
  "select",
  "scroll",
  "drag",
  "upload",
  "wait",
  "screenshot",
  "evaluate",
  "text",
  "console",
  "dialog",
  "record_start",
  "record_stop",
];

const BROWSER_INSTRUCTIONS = `The browser tool uses the user's own browser (Chrome, Edge or another Chromium browser with the Neox browser extension installed): its real tabs, signed in to the sites the user is signed in to. Use it when a task needs the user's sessions or a real browser.
How to work:
- Start with action tabs or snapshot. Elements you can act on carry a ref (e12); pass it to click, type and the rest.
- snapshot shows the page as an accessibility tree. Every action answers with the page after it, so you rarely need another snapshot.
- A failure starts with its kind and says whether trying again can help: STALE_REF and AMBIGUOUS (take a snapshot, use a ref from it), UNACTIONABLE, BAD_ARGS, WAIT_TIMEOUT, SITE_REFUSED, LOAD_FAILED, PAGE_BLOCKED, USER_STOPPED, DIALOG_OPEN, SCRIPT_ERROR, OUTCOME_UNKNOWN.
- Prefer refs to evaluate. When the layout or an image matters, add screenshot: true to an action.
- This is the user's browser: don't close tabs you didn't open, don't change their settings, and ask before sending, buying, posting or deleting anything on their behalf.`;

function browserOneTool(): Record<string, unknown> {
  const str = (description: string): Record<string, unknown> => ({ type: "string", description });
  const boolean = (description: string): Record<string, unknown> => ({
    type: "boolean",
    description,
  });
  const num = (description: string): Record<string, unknown> => ({ type: "number", description });
  const strs = (description: string): Record<string, unknown> => ({
    type: "array",
    items: { type: "string" },
    description,
  });
  return {
    name: "browser",
    title: "Browser",
    description:
      "Act in the user's own browser. Actions, with the arguments each takes:\n" +
      "tabs: list them. tab_new [url, front]. tab_select [tab]. tab_close [tab]. browsers: the connected ones. use_browser [browser].\n" +
      "navigate [url]. back. forward. reload.\n" +
      "snapshot [interactive, ref, maxChars]: the page as an accessibility tree, a ref on each element you can act on.\n" +
      "click [ref, double, button, modifiers]. type [ref, text, clear, submit, slowly]. press [key, ref]. hover [ref]. select [ref, values]. scroll [direction, amount, ref]. drag [from, to]. upload [ref, paths].\n" +
      "wait [text, textGone, url, seconds, timeout]. screenshot [ref, fullPage, png]. evaluate [script, ref]. text [maxChars]. console [level, limit]. dialog [accept, promptText].\n" +
      "record_start: keep a picture of the window after each action that changes the page. record_stop: those pictures as a GIF, at a link to download, for the user to see what was done.\n" +
      "Every action takes tab, and screenshot: true to add a small picture of the window to its answer.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: BROWSER_ACTION_ORDER },
        tab: str("t123, from tabs."),
        ref: str("An element's ref from the latest snapshot (e12)."),
        url: str("navigate, tab_new: the address; wait: until the address contains this."),
        text: str("type: what to type; wait: until the page shows this."),
        front: boolean("tab_new: show it to the user, only when they asked to see it."),
        browser: str("use_browser: its id from browsers (b2) or name (Edge)."),
        interactive: boolean("snapshot: only what you can act on, and headings."),
        maxChars: num("snapshot, text: the most characters back."),
        double: boolean("click: double-click."),
        button: { type: "string", enum: ["left", "right", "middle"] },
        modifiers: {
          type: "array",
          items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] },
        },
        clear: boolean("type: replace what the field holds (default true)."),
        submit: boolean("type: press Enter after."),
        slowly: boolean("type: a key at a time, for an autocomplete."),
        key: str("press: a key or chord (Enter, Control+a)."),
        values: strs("select: the options, by value or label."),
        direction: { type: "string", enum: ["down", "up", "left", "right"] },
        amount: num("scroll: pixels."),
        from: str("drag: the ref to drag."),
        to: str("drag: the ref to drop on."),
        paths: strs("upload: full paths of files on this computer."),
        textGone: str("wait: until the page no longer shows this."),
        seconds: num("wait: just this long (at most 60)."),
        timeout: num("wait: give up after (default 10, at most 60)."),
        fullPage: boolean("screenshot: the whole page."),
        png: boolean("screenshot: PNG, not JPEG."),
        script: str("evaluate: an expression, or a function."),
        level: { type: "string", enum: ["all", "errors", "network"] },
        limit: num("console: the most recent messages."),
        accept: boolean("dialog: accept (default true) or dismiss."),
        promptText: str("dialog: a prompt's answer."),
        screenshot: boolean("Add a small picture of the window to the answer."),
      },
      required: ["action"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  };
}

function unfold(raw: unknown): { tool: string; args: Record<string, unknown>; shot: boolean } {
  const args = isRecord(raw) ? { ...raw } : {};
  const action = typeof args.action === "string" ? args.action : "";
  const mapped = BROWSER_ACTIONS[action];
  if (mapped === undefined) {
    throw new Error(`BAD_ARGS: action is one of ${BROWSER_ACTION_ORDER.join(", ")}`);
  }
  const shot = args.screenshot === true;
  delete args.action;
  delete args.screenshot;
  for (const [key, value] of Object.entries(mapped.set ?? {})) {
    args[key] = value;
  }
  return { tool: mapped.tool, args, shot };
}

/** The extension's own tools, still taken from a client that listed them before. */
const EXTENSION_TOOLS = new Set([
  "browser_tabs",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_hover",
  "browser_select",
  "browser_scroll",
  "browser_drag",
  "browser_upload",
  "browser_wait",
  "browser_screenshot",
  "browser_evaluate",
  "browser_text",
  "browser_console",
  "browser_dialog",
]);

const TOOL_NAME_PATTERN =
  /browser_(tabs|navigate|snapshot|click|type|press|hover|select|scroll|drag|upload|wait|screenshot|evaluate|text|console|dialog)\b/g;

function browserSay(text: string): string {
  return text.replace(TOOL_NAME_PATTERN, "the $1 action");
}

export class BrowserRelay {
  /** Recordings and the files they made; the bridge keeps them itself. */
  public readonly recordings = new BrowserRecordings();
  public readonly files = new BrowserFileStore();
  private readonly logger: Logger;
  private readonly wss: WebSocketServer;
  private readonly connections: BrowserConnection[] = [];
  private readonly chosen = new Map<string, BrowserConnection>();
  private readonly pending = new Map<string, (result: unknown) => void>();
  private nextId = 0;

  constructor(options: { logger: Logger }) {
    this.logger = options.logger;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 << 20 });
  }

  /** Takes the extension's upgrade; any other request is left to the daemon. */
  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let pathname = "";
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return;
    }
    if (pathname !== EXTENSION_PATH) {
      return;
    }
    if (!loopback(req.socket.remoteAddress ?? "") || !loopbackHost(req.headers.host ?? "")) {
      reject(socket, 403, "only a browser on this computer connects here");
      return;
    }
    if (req.headers.origin !== EXTENSION_ORIGIN) {
      reject(socket, 403, "only the browser extension connects here");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attach(ws);
    });
  }

  public status(): Record<string, unknown> {
    const current = this.current();
    const out: Record<string, unknown> = {
      connected: current !== null,
      version: extensionVersion(),
    };
    if (current !== null) {
      out.extension = current.version;
      out.browser = current.agent;
      out.since = new Date(current.since).toISOString();
    }
    return out;
  }

  public async call(session: string, tool: string, args: unknown): Promise<ToolResult> {
    const connection = this.forSession(session);
    if (connection === null) {
      throw new Error(awayMessage());
    }
    this.nextId += 1;
    const id = String(this.nextId);
    const answered = new Promise<unknown>((resolve) => {
      this.pending.set(id, resolve);
    });
    try {
      connection.ws.send(JSON.stringify({ id, session, tool, args: args ?? {} }), (error) => {
        if (error) {
          const resolve = this.pending.get(id);
          this.pending.delete(id);
          resolve?.(null);
        }
      });
      const timer = new Promise<unknown>((resolve) => {
        setTimeout(() => resolve(null), CALL_WAIT_MS).unref();
      });
      const result = await Promise.race([answered, timer]);
      if (result === null) {
        throw new Error(
          `the browser extension didn't answer in ${CALL_WAIT_MS / 1000}s: the page may be stuck; take a snapshot or a screenshot to see where it is`,
        );
      }
      if (!isRecord(result) || !Array.isArray(result.content)) {
        throw new Error(
          "the browser extension answered with something that isn't a tool result: update it",
        );
      }
      return result as ToolResult;
    } finally {
      this.pending.delete(id);
    }
  }

  public list(session: string): string {
    const all = this.connections;
    if (all.length === 0) {
      return awayMessage();
    }
    const mine = this.forSession(session);
    const lines = [
      `${all.length} browser${all.length === 1 ? "" : "s"} with the extension are connected (* is the one calls go to):`,
    ];
    for (const connection of all) {
      lines.push(
        `${connection === mine ? "*" : " "} ${connection.id} ${browserName(
          connection.agent,
        )}, extension ${connection.version}, connected ${new Date(
          connection.since,
        ).toLocaleTimeString("en-GB")}`,
      );
    }
    return lines.join("\n");
  }

  public choose(session: string, which: string): { text: string } | { error: string } {
    const wanted = which.trim().toLowerCase();
    if (this.connections.length === 0) {
      return { error: awayMessage() };
    }
    const matches = this.connections.filter(
      (connection) =>
        connection.id === wanted ||
        (wanted !== "" && browserName(connection.agent).toLowerCase().includes(wanted)),
    );
    if (matches.length === 0) {
      return { error: `no connected browser is ${JSON.stringify(which)}: browsers lists them` };
    }
    if (matches.length > 1) {
      return {
        error: `${matches.length} connected browsers are ${JSON.stringify(which)}: pick one by its id`,
      };
    }
    const picked = matches[0]!;
    this.chosen.set(session, picked);
    return { text: `Calls now go to ${picked.id} (${browserName(picked.agent)}).` };
  }

  public connectionCount(): number {
    return this.connections.length;
  }

  private attach(ws: WebSocket): void {
    const connection: BrowserConnection = {
      ws,
      id: "",
      version: "",
      agent: "",
      since: Date.now(),
    };
    ws.on("message", (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!isRecord(message)) {
        return;
      }
      if (message.type === "hello") {
        connection.version = typeof message.version === "string" ? message.version : "";
        connection.agent = typeof message.agent === "string" ? message.agent : "";
        if (connection.id === "") {
          connection.id = `b${this.connections.length + 1}`;
          this.connections.push(connection);
          this.logger.info(
            { version: connection.version, browser: connection.agent },
            "The browser extension connected",
          );
        }
        return;
      }
      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      const id = typeof message.id === "string" ? message.id : "";
      if (id !== "") {
        const resolve = this.pending.get(id);
        this.pending.delete(id);
        resolve?.(message.result ?? null);
      }
    });
    ws.on("close", () => {
      const index = this.connections.indexOf(connection);
      if (index >= 0) {
        this.connections.splice(index, 1);
        for (const [session, chosen] of this.chosen) {
          if (chosen === connection) {
            this.chosen.delete(session);
          }
        }
        this.logger.info("The browser extension disconnected");
      }
    });
    ws.on("error", (error) => {
      this.logger.warn({ err: error }, "Browser extension socket error");
    });
  }

  private current(): BrowserConnection | null {
    return this.connections.length === 0 ? null : this.connections[this.connections.length - 1]!;
  }

  private forSession(session: string): BrowserConnection | null {
    const chosen = session === "" ? undefined : this.chosen.get(session);
    return chosen ?? this.current();
  }
}

/* ------------------------------------------------------------------- MCP */

/** Where a call reached the gateway, and the key it used, for the links it
 * hands back. */
export interface BrowserCallContext {
  baseUrl: string;
  key: string | null;
}

export function serveBrowserMcp(
  relay: BrowserRelay,
  body: unknown,
  res: ExpressResponse,
  session: string,
  call: BrowserCallContext,
): void {
  const request = isRecord(body) ? body : {};
  const id = request.id ?? null;
  const method = typeof request.method === "string" ? request.method : "";
  if (method === "initialize") {
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: {
          name: "neolix-browser",
          title: "Neox Browser",
          version: extensionVersion(),
        },
        instructions: BROWSER_INSTRUCTIONS,
      },
    });
    return;
  }
  if (method === "ping") {
    res.json({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    res.json({ jsonrpc: "2.0", id, result: { tools: [browserOneTool()] } });
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    res.status(202).end();
    return;
  }
  if (method === "tools/call") {
    const params = isRecord(request.params) ? request.params : {};
    const name = typeof params.name === "string" ? params.name : "";
    const rawArgs = params.arguments;
    void (async () => {
      try {
        const result = await browserToolCall(relay, name, rawArgs, session, call);
        res.json({ jsonrpc: "2.0", id, result });
      } catch (error) {
        res.json({ jsonrpc: "2.0", id, result: toolResult(errorMessage(error), true) });
      }
    })();
    return;
  }
  res.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}

async function browserToolCall(
  relay: BrowserRelay,
  name: string,
  rawArgs: unknown,
  session: string,
  call: BrowserCallContext,
): Promise<ToolResult> {
  let tool = name;
  let args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
  let shot = false;
  const one = name === "browser";
  if (one) {
    const unfolded = unfold(rawArgs);
    tool = unfolded.tool;
    args = unfolded.args;
    shot = unfolded.shot;
  } else if (!EXTENSION_TOOLS.has(name)) {
    throw new Error(`unknown tool ${name}`);
  }
  if (tool === "record") {
    return recordCall(relay, session, args.action === "stop", call);
  }
  const tabsAction = typeof args.action === "string" ? args.action : "";
  const local = await localTabsCall(relay, tool, tabsAction, args, session);
  if (local !== null) {
    return local;
  }
  const result = await relay.call(session, tool, args);
  if (one) {
    replaceNames(result);
  }
  if (
    tool === "browser_tabs" &&
    (tabsAction === "" || tabsAction === "list") &&
    relay.connectionCount() > 1
  ) {
    result.content = [
      { type: "text", text: "These are the tabs of this session's browser." },
      ...(result.content ?? []),
    ];
  }
  await keepPicture(
    relay,
    session,
    tool,
    tabsAction,
    result,
    shot,
    one && isRecord(rawArgs) ? rawArgs : {},
  );
  return result;
}

/** The actions after which nothing on the page can have changed, or a picture
 * would open a tab (tab_close's tab is gone). */
const RECORD_SKIPS = new Set([
  "browser_snapshot",
  "browser_text",
  "browser_console",
  "browser_screenshot",
]);

function recordWorth(tool: string, tabsAction: string): boolean {
  if (tool === "browser_tabs") {
    return tabsAction === "new" || tabsAction === "select";
  }
  return !RECORD_SKIPS.has(tool);
}

/**
 * The picture an answer asked for, and a frame for a recording that is on:
 * one picture serves both.
 */
async function keepPicture(
  relay: BrowserRelay,
  session: string,
  tool: string,
  tabsAction: string,
  result: ToolResult,
  shot: boolean,
  rawArgs: Record<string, unknown>,
): Promise<void> {
  if (result.isError === true) {
    return;
  }
  const recording = relay.recordings.on(session) && recordWorth(tool, tabsAction);
  if (!shot && !recording) {
    return;
  }
  const picture = await pictureOf(relay, session);
  if (shot) {
    addPicture(result, picture);
  }
  if (!recording || picture === null || typeof picture.data !== "string") {
    return;
  }
  const action =
    typeof rawArgs.action === "string" && rawArgs.action !== ""
      ? rawArgs.action
      : tool.replace(/^browser_/, "");
  const label = recordSay(relay.recordings.count(session) + 1, action, rawArgs);
  try {
    relay.recordings.add(session, await recordFrame(picture.data, label));
  } catch {
    // A frame that can't be prepared is skipped, as myna skips it.
  }
}

async function recordCall(
  relay: BrowserRelay,
  session: string,
  stop: boolean,
  call: BrowserCallContext,
): Promise<ToolResult> {
  if (!stop) {
    relay.recordings.start(session);
    return toolResult(
      "Recording. After each action that can change the page a picture of the window is kept, with the action under it; record_stop makes them a GIF.",
      false,
    );
  }
  const recording = relay.recordings.stop(session);
  if (recording === undefined) {
    return toolResult("Nothing is being recorded: record_start begins.", true);
  }
  if (recording.frames.length === 0) {
    return toolResult(
      "The recording has no frames: no action that changes the page was taken after record_start.",
      true,
    );
  }
  let data: Buffer;
  try {
    data = await encodeRecordingGif(recording.frames);
  } catch (error) {
    return toolResult(`The GIF couldn't be made: ${errorMessage(error)}`, true);
  }
  const kept = relay.files.keep(data, "image/gif", call.key);
  const url = `${call.baseUrl}${BROWSER_FILES_PATH}${kept}`;
  const seconds = Math.round((Date.now() - recording.started) / 1000);
  let text = `Recorded ${recording.frames.length} frames over ${durationText(seconds)}, a ${Math.ceil(data.length / 1024)} KB GIF. Download it within the hour (the link opens without a header; whoever has it can open it), e.g. curl -o recording.gif '${url}'\n${url}\n`;
  if (recording.full) {
    text += `It holds the first ${RECORD_MOST} frames; later actions weren't kept.\n`;
  }
  return {
    content: [{ type: "text", text }],
    isError: false,
    _meta: { [FILES_META]: [{ url }] },
  };
}

/** Myna's key for the files a tool result names, which its clients save. */
const FILES_META = "github.com/istoo/myna/files";

function durationText(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

async function localTabsCall(
  relay: BrowserRelay,
  tool: string,
  action: string,
  args: Record<string, unknown>,
  session: string,
): Promise<ToolResult | null> {
  if (tool !== "browser_tabs") {
    return null;
  }
  if (action === "browsers") {
    return toolResult(relay.list(session), false);
  }
  if (action !== "use") {
    return null;
  }
  const which = typeof args.browser === "string" ? args.browser : "";
  const chosen = relay.choose(session, which);
  return "error" in chosen ? toolResult(chosen.error, true) : toolResult(chosen.text, false);
}

function addPicture(result: ToolResult, picture: Record<string, unknown> | null): void {
  result.content = [
    ...(result.content ?? []),
    picture ?? {
      type: "text",
      text: "(no screenshot: the extension didn't answer with a picture)",
    },
  ];
}

async function pictureOf(
  relay: BrowserRelay,
  session: string,
): Promise<Record<string, unknown> | null> {
  try {
    const shot = await relay.call(session, "browser_screenshot", {});
    if (shot.isError === true) {
      return null;
    }
    for (const item of shot.content ?? []) {
      if (item.type === "image" && typeof item.data === "string") {
        return item;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function replaceNames(result: ToolResult): void {
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      item.text = browserSay(item.text);
    }
  }
}

function toolResult(text: string, isError: boolean): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

/* --------------------------------------------------------------- extension */

let extensionVersionText = "";

void readFile(path.join(EXTENSION_DIR, "manifest.json"), "utf8")
  .then((text: string) => {
    const manifest: unknown = JSON.parse(text);
    if (isRecord(manifest) && typeof manifest.version === "string") {
      extensionVersionText = manifest.version;
    }
    return undefined;
  })
  .catch(() => undefined);

export function extensionVersion(): string {
  return extensionVersionText;
}

/**
 * Writes the bundled extension where the user can load it, pointed at this
 * daemon. A file is rewritten only when its bytes changed, so a browser that
 * already loaded the folder has nothing to reload.
 */
export async function writeBrowserExtension(
  directory: string,
  gatewayUrl: string,
): Promise<{ dir: string; files: number }> {
  const websocketUrl = gatewayUrl.replace(/^http/, "ws").replace(/\/+$/, "");
  const entries = await readdir(EXTENSION_DIR, { withFileTypes: true });
  await mkdir(directory, { recursive: true });
  let files = 0;
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    let data: Buffer | string = await readFile(path.join(EXTENSION_DIR, entry.name));
    if (entry.name === "config.js") {
      data = `// The gateway this extension talks to, written by Neox.\nexport const GATEWAY = ${JSON.stringify(
        websocketUrl,
      )};\n`;
    }
    const target = path.join(directory, entry.name);
    try {
      const old = await readFile(target);
      if (Buffer.from(old).equals(Buffer.from(data))) {
        files += 1;
        continue;
      }
    } catch {
      // Not written yet.
    }
    await writeFile(target, data, { mode: 0o644 });
    files += 1;
  }
  return { dir: directory, files };
}

export function defaultExtensionDirectory(): string {
  return path.join(os.homedir(), "Neolix Browser Extension");
}

/* ---------------------------------------------------------------- helpers */

function awayMessage(): string {
  return "The browser extension isn't connected, so there is no browser to use. Load the Neox browser extension in Chrome, Edge or another Chromium browser (Settings → LLM gateway → Browser, or POST /v1/myna/browser/setup), and it connects by itself while the browser and Neox are both running.";
}

function browserName(userAgent: string): string {
  for (const { token, name } of [
    { token: "Edg/", name: "Edge" },
    { token: "OPR/", name: "Opera" },
    { token: "Vivaldi/", name: "Vivaldi" },
    { token: "YaBrowser/", name: "Yandex" },
    { token: "Chrome/", name: "Chrome" },
  ]) {
    const at = userAgent.indexOf(token);
    if (at >= 0) {
      let version = userAgent.slice(at + token.length);
      const end = version.search(/[. ]/);
      if (end >= 0) {
        version = version.slice(0, end);
      }
      return `${name} ${version}`.trim();
    }
  }
  return "a Chromium browser";
}

function loopback(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

function loopbackHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : (host.split(":")[0] ?? "");
  return name === "127.0.0.1" || name === "::1" || name === "localhost" || name.startsWith("127.");
}

function reject(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} Forbidden\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(
      body,
    )}\r\nconnection: close\r\n\r\n${body}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
