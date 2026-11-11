import { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";
import { resolvePrincipal, type GatewayRequest } from "./access.js";
import { allowVerdict, isLocalRequest } from "./allow.js";
import { authFailThrottle } from "./auth-throttle.js";
import type { GatewayConfigStore } from "./config.js";
import { corsAllowed, corsRefusal, isCorsPreflight } from "./cors.js";

/**
 * Responses over a WebSocket, as Codex speaks it to its own provider (myna's
 * responses_ws.go). Codex opens one socket for a session and sends each turn
 * as a text frame: the HTTP body with `"type":"response.create"` added. The
 * reply comes back as one text frame per event the HTTP route streams. On a
 * socket it has had a reply on, Codex names that reply
 * (`previous_response_id`) and sends only what came after it, where over HTTP
 * it sends the whole conversation every turn.
 *
 * Each `response.create` is served as the POST it stands for: the request the
 * socket was opened with is made again, with the frame as its body, and
 * dispatched through the daemon's own Express app — the allow list, the key
 * and its limits, the Origin checks, routing, failover and usage judge every
 * turn as they judge an HTTP one, and a key turned off ends the next turn,
 * not the socket.
 *
 * The conversation a turn continues is the socket's own: each reply's input
 * and output, kept for the socket's life. An id the socket doesn't hold is
 * answered `previous_response_not_found`, on which Codex opens a new socket
 * and sends the conversation whole.
 */

const SOCKET_KEEP = 2;
const SOCKET_ERR_MAX = 1 << 20;
const SOCKET_MAX_BYTES = 64 << 20;
const TURN_DONE = Symbol("turn-done");

const SOCKET_PATHS = new Set(["/v1/responses", "/responses", "/backend-api/codex/responses"]);

export type TurnDispatch = (req: IncomingMessage, res: ServerResponse) => void;

export interface ResponsesSocketOptions {
  configStore: GatewayConfigStore;
  logger: Logger;
  dispatch: TurnDispatch;
}

interface HeldTurn {
  id: string;
  items: unknown[];
}

export class ResponsesSockets {
  private readonly wss: WebSocketServer;
  private readonly openSockets = new Set<ResponsesSocket>();
  private closing = false;

  constructor(private readonly options: ResponsesSocketOptions) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: SOCKET_MAX_BYTES });
  }

  /** Takes a Responses route's upgrade; any other upgrade is left to the daemon. */
  public handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = pathnameOf(req.url ?? "/");
    if (!SOCKET_PATHS.has(pathname)) {
      return;
    }
    if (this.closing) {
      reject(socket, 503, "Neox is restarting");
      return;
    }
    const config = this.options.configStore.get();
    if (!config.enabled) {
      reject(socket, 404, "LLM gateway is disabled");
      return;
    }
    const allow = allowVerdict(config, req);
    if (!allow.allowed) {
      reject(socket, 403, allow.message);
      return;
    }
    const principal = resolvePrincipal(upgradeRequest(req), config);
    if (principal === null) {
      if (!isLocalRequest(req)) {
        const verdict = authFailThrottle.check();
        if (verdict.over) {
          reject(socket, 429, "too many failed authentications; slow down", {
            "Retry-After": String(Math.floor(verdict.retryAfterMs / 1000) + 1),
          });
          return;
        }
      }
      reject(socket, 401, "Invalid gateway key");
      return;
    }
    if (principal.readOnly) {
      reject(socket, 403, "This key is read-only");
      return;
    }
    const keyed = principal.key !== null;
    const refusal = isCorsPreflight(req) ? null : corsRefusal(req, config, keyed);
    if (refusal !== null) {
      reject(socket, refusal.status, refusal.message);
      return;
    }
    const origin = headerOf(req, "origin");
    if (origin.length > 0 && corsAllowed(origin, config) && !keyed) {
      reject(socket, 401, "a web page or browser extension calls Neox with a gateway key");
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const client: ResponsesSocket = new ResponsesSocket({
        ws,
        req,
        pathname,
        options: this.options,
        onClose: () => this.openSockets.delete(client),
      });
      if (this.closing) {
        ws.close(1001, "Neox is restarting");
        return;
      }
      this.openSockets.add(client);
      void client.serve();
    });
  }

  /** Ends every socket after its turn in flight, waiting until `timeoutMs`. */
  public async drain(timeoutMs = 10_000): Promise<void> {
    this.closing = true;
    const sockets = [...this.openSockets];
    for (const client of sockets) {
      client.goingAway();
    }
    const deadline = Date.now() + timeoutMs;
    while (this.openSockets.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const client of this.openSockets) {
      client.terminate();
    }
    this.openSockets.clear();
  }

  public size(): number {
    return this.openSockets.size;
  }
}

interface ResponsesSocketOptionsInternal {
  options: ResponsesSocketOptions;
  ws: WebSocket;
  req: IncomingMessage;
  pathname: string;
  onClose: () => void;
}

interface TurnRun {
  aborted: boolean;
  ids: string[];
  abort: (() => void) | null;
}

class MessageQueue {
  private readonly items: Array<string | typeof TURN_DONE | null> = [];
  private readonly waiters: Array<(value: string | typeof TURN_DONE | null) => void> = [];
  private closed = false;

  public push(value: string | typeof TURN_DONE): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }
    this.items.push(value);
  }

  public close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter(null);
    }
  }

  public next(): Promise<string | typeof TURN_DONE | null> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve(item);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

class ResponsesSocket {
  private readonly ws: WebSocket;
  private readonly origin: IncomingMessage;
  private readonly options: ResponsesSocketOptions;
  private readonly onClose: () => void;
  private readonly queue: MessageQueue;
  private turns: HeldTurn[] = [];
  private away = false;
  private turning = false;
  private readonly pending: string[] = [];

  constructor(input: ResponsesSocketOptionsInternal) {
    this.ws = input.ws;
    this.origin = input.req;
    this.options = input.options;
    this.onClose = input.onClose;
    this.queue = new MessageQueue();
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.ws.close(1003, "text frames only");
        this.queue.close();
        return;
      }
      this.queue.push(data.toString());
    });
    this.ws.on("close", () => {
      this.queue.close();
      this.onClose();
    });
    this.ws.on("error", () => {
      this.queue.close();
    });
  }

  public goingAway(): void {
    this.away = true;
    if (!this.turning) {
      this.ws.close(1001, "Neox is restarting");
    }
  }

  public terminate(): void {
    this.ws.terminate();
  }

  public async serve(): Promise<void> {
    try {
      for (;;) {
        const frame = this.pending.length > 0 ? this.pending.shift()! : await this.queue.next();
        if (frame === null) {
          return;
        }
        if (frame === TURN_DONE) {
          continue;
        }
        const kind = typeOf(frame);
        if (kind === "response.interrupt") {
          await this.write(
            interruptReply("response.interrupt.failed", stringField(frame, "response_id")),
          );
          continue;
        }
        if (kind !== "response.create") {
          await this.writeError(
            400,
            "invalid_request_error",
            "unsupported_message",
            `Neox serves response.create on this socket, not ${JSON.stringify(kind)}`,
            "type",
          );
          continue;
        }
        this.turning = true;
        const run: TurnRun = { aborted: false, ids: [], abort: null };
        const turn = this.turn(frame, run);
        const settled = turn.finally(() => this.queue.push(TURN_DONE));
        let interruptedId = "";
        for (;;) {
          const message = await this.queue.next();
          if (message === null) {
            run.abort?.();
            await settled;
            return;
          }
          if (message === TURN_DONE) {
            break;
          }
          const nextKind = typeOf(message);
          if (nextKind !== "response.interrupt") {
            this.pending.push(message);
            continue;
          }
          const id = stringField(message, "response_id");
          if (!run.ids.includes(id)) {
            await this.write(interruptReply("response.interrupt.failed", id));
            continue;
          }
          run.aborted = true;
          interruptedId = id;
          run.abort?.();
          await settled;
          break;
        }
        await settled;
        this.turning = false;
        if (interruptedId.length > 0) {
          await this.write(interruptReply("response.interrupt.accepted", interruptedId));
          await this.write(incompleteFrame(interruptedId));
        }
        if (this.away) {
          this.ws.close(1001, "Neox is restarting");
          return;
        }
      }
    } catch (error) {
      this.options.logger.error({ err: error }, "Responses socket failed");
      this.ws.close(1011, "internal error");
    } finally {
      this.queue.close();
    }
  }

  private held(id: string): unknown[] | null {
    for (let index = this.turns.length - 1; index >= 0; index -= 1) {
      if (this.turns[index]!.id === id) {
        return this.turns[index]!.items;
      }
    }
    return null;
  }

  private keep(id: string, prior: unknown[], fresh: unknown[], reply: unknown[]): void {
    this.turns.push({ id, items: [...prior, ...fresh.map(cloneValue), ...reply] });
    if (this.turns.length > SOCKET_KEEP) {
      this.turns = this.turns.slice(this.turns.length - SOCKET_KEEP);
    }
  }

  private async turn(frame: string, run: TurnRun): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      await this.writeError(
        400,
        "invalid_request_error",
        "invalid_json",
        "response.create is not a JSON object",
        "",
      );
      return;
    }
    if (!isRecord(parsed)) {
      await this.writeError(
        400,
        "invalid_request_error",
        "invalid_json",
        "response.create is not a JSON object",
        "",
      );
      return;
    }
    const body = { ...parsed };
    const fresh = prevInput(body.input);
    if (fresh === null) {
      await this.writeError(
        400,
        "invalid_request_error",
        "invalid_value",
        "input is neither text nor a list of items",
        "input",
      );
      return;
    }
    let input = fresh;
    let prior: unknown[] = [];
    const previous = body.previous_response_id;
    if (typeof previous === "string" && previous.length > 0) {
      const held = this.held(previous);
      if (held === null) {
        await this.writeError(
          400,
          "invalid_request_error",
          "previous_response_not_found",
          `Previous response with id '${previous}' not found.`,
          "previous_response_id",
        );
        return;
      }
      prior = held;
      input = [...held, ...fresh];
    }
    // A warmup (generate false) asks for no reply: Codex sends it with the
    // conversation ahead of its first turn, and that turn follows it.
    if (body.generate === false) {
      const id = `resp_${randomId()}`;
      run.ids.push(id);
      const response: Record<string, unknown> = {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "in_progress",
        output: [],
      };
      if (body.model !== undefined) {
        response.model = body.model;
      }
      if ((await this.write(JSON.stringify({ type: "response.created", response }))) === false) {
        return;
      }
      response.status = "completed";
      response.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
      if ((await this.write(JSON.stringify({ type: "response.completed", response }))) !== false) {
        this.keep(id, prior, fresh, []);
      }
      return;
    }
    delete body.type;
    delete body.previous_response_id;
    delete body.generate;
    body.input = input;
    const payload = Buffer.from(JSON.stringify(body));
    let writer: SocketTurnWriter | null = null;
    const exchange = createExchange(this.origin, payload, {
      write: (chunk) => writer?.write(chunk),
      end: (chunk) => writer?.end(chunk),
    });
    run.abort = () => exchange.abort();
    writer = new SocketTurnWriter(
      exchange.res,
      async (frameText) => this.write(frameText, run),
      run,
    );
    try {
      this.options.dispatch(exchange.req, exchange.res);
    } catch (error) {
      exchange.abort();
      await this.writeError(500, "server_error", "internal_error", errorMessage(error), "");
      return;
    }
    await exchange.done;
    writer.finish();
    if (run.aborted) {
      return;
    }
    if (!writer.ended) {
      this.ws.close(1011, "the reply ended before response.completed");
      return;
    }
    if (writer.id !== "" && writer.completed) {
      this.keep(writer.id, prior, fresh, writer.items);
    }
  }

  private async write(frame: string, run?: TurnRun): Promise<boolean> {
    if (run?.aborted === true || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    return new Promise((resolve) => {
      this.ws.send(frame, (error) => resolve(error === undefined || error === null));
    });
  }

  private async writeError(
    status: number,
    type: string,
    code: string,
    message: string,
    param: string,
  ): Promise<boolean> {
    const error: Record<string, unknown> = { type, code, message };
    if (param.length > 0) {
      error.param = param;
    }
    return this.write(JSON.stringify({ type: "error", status, error }));
  }
}

function createExchange(
  origin: IncomingMessage,
  body: Buffer,
  sink: { write: (chunk: unknown) => void; end: (chunk?: unknown) => void },
): { req: IncomingMessage; res: ServerResponse; done: Promise<void>; abort: () => void } {
  const headers = turnHeaders(origin, body);
  const req = new IncomingMessage(origin.socket);
  req.method = "POST";
  req.url = origin.url ?? "/v1/responses";
  req.httpVersion = origin.httpVersion;
  req.httpVersionMajor = origin.httpVersionMajor;
  req.httpVersionMinor = origin.httpVersionMinor;
  req.headers = headers;
  req.rawHeaders = flatHeaders(headers);
  // The message is whole: without this the stream's own end marks it aborted
  // and Node destroys the socket, which a socket we share with the client is
  // not ours to destroy.
  req.complete = true;
  req.push(body);
  req.push(null);
  const res = new ServerResponse(req);
  let settle: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let ended = false;
  const finish = (): void => {
    if (ended) {
      return;
    }
    ended = true;
    settle();
  };
  let started = false;
  Object.defineProperty(res, "headersSent", { get: () => started });
  res.write = ((chunk: unknown, _encoding?: unknown, callback?: unknown) => {
    started = true;
    if (chunk !== undefined && chunk !== null) {
      sink.write(chunk);
    }
    invokeCallback(_encoding, callback);
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: unknown, _encoding?: unknown, callback?: unknown) => {
    started = true;
    if (chunk !== undefined && chunk !== null) {
      sink.end(chunk);
    } else {
      sink.end();
    }
    invokeCallback(_encoding, callback);
    finish();
    return res;
  }) as typeof res.end;
  return {
    req,
    res,
    done,
    abort: () => {
      res.emit("close");
      req.emit("aborted");
      req.emit("close");
      finish();
    },
  };
}

function invokeCallback(first: unknown, second: unknown): void {
  if (typeof first === "function") {
    queueMicrotask(() => (first as () => void)());
    return;
  }
  if (typeof second === "function") {
    queueMicrotask(() => (second as () => void)());
  }
}

/** The POST a turn stands for: the upgrade's request, with the turn as its body. */
function turnHeaders(origin: IncomingMessage, body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(origin.headers)) {
    if (value === undefined) {
      continue;
    }
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower.startsWith("sec-websocket-")) {
      continue;
    }
    if (
      lower === "content-type" ||
      lower === "content-encoding" ||
      lower === "accept" ||
      lower === "accept-encoding" ||
      lower === "content-length"
    ) {
      continue;
    }
    if (lower === "openai-beta") {
      const kept = (Array.isArray(value) ? value : [value]).filter(
        (entry) => !entry.includes("responses_websockets"),
      );
      if (kept.length > 0) {
        out[lower] = kept.join(", ");
      }
      continue;
    }
    out[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  out["content-type"] = "application/json";
  out.accept = "text/event-stream";
  out["content-length"] = String(body.byteLength);
  const metadata = readClientMetadata(body);
  if (metadata["x-codex-turn-state"] !== undefined) {
    out["x-codex-turn-state"] = metadata["x-codex-turn-state"];
  }
  if (metadata["ws_request_header_x_openai_internal_codex_responses_lite"] === "true") {
    out["x-openai-internal-codex-responses-lite"] = "true";
  }
  return out;
}

function readClientMetadata(body: Buffer): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.client_metadata)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.client_metadata)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function flatHeaders(headers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    out.push(name, value);
  }
  return out;
}

/** Turns the HTTP reply a turn is given into the socket's frames. */
class SocketTurnWriter {
  public status = 0;
  public id = "";
  public items: unknown[] = [];
  public ended = false;
  public completed = false;

  private stream = false;
  private readonly buffer: Buffer[] = [];
  private buffered = 0;
  private sse = "";
  private started = false;
  private finished = false;

  constructor(
    private readonly res: ServerResponse,
    private readonly send: (frame: string) => Promise<boolean>,
    private readonly run: TurnRun,
  ) {}

  public write(chunk: unknown): void {
    if (this.run.aborted) {
      return;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (!this.started) {
      this.start();
    }
    if (this.stream) {
      this.feedSse(text);
      return;
    }
    if (this.buffered < SOCKET_ERR_MAX || this.res.statusCode < 300) {
      const bytes = Buffer.from(text, "utf8");
      this.buffer.push(bytes);
      this.buffered += bytes.byteLength;
    }
  }

  public end(chunk?: unknown): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (chunk !== undefined && chunk !== null) {
      this.write(chunk);
    }
    if (!this.started) {
      this.start();
    }
    if (this.stream) {
      this.flushSse();
      return;
    }
    if (this.run.aborted) {
      return;
    }
    if (this.res.statusCode < 200 || this.res.statusCode >= 300) {
      this.sendHttpError();
      return;
    }
    this.sendWholeReply();
  }

  /** The end of the handler's reply, for a handler that never called `end`. */
  public finish(): void {
    if (this.finished) {
      return;
    }
    this.end();
  }

  private start(): void {
    this.started = true;
    this.status = this.res.statusCode;
    const contentType = String(this.res.getHeader("content-type") ?? "");
    if (this.status >= 200 && this.status < 300 && contentType.includes("event-stream")) {
      this.stream = true;
      for (const frame of this.headerFrames()) {
        void this.send(frame);
      }
    }
  }

  private feedSse(text: string): void {
    this.sse += text;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.sse);
      if (match === null) {
        return;
      }
      const block = this.sse.slice(0, match.index);
      this.sse = this.sse.slice(match.index + match[0].length);
      this.dispatchSse(block);
    }
  }

  private flushSse(): void {
    if (this.sse.trim().length > 0) {
      this.dispatchSse(this.sse);
    }
    this.sse = "";
  }

  private dispatchSse(block: string): void {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data.length === 0 || data === "[DONE]") {
      return;
    }
    this.event(data);
  }

  private event(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    const response = parsed.response;
    switch (type) {
      case "response.created":
      case "response.in_progress":
        this.note(responseIdOf(response));
        break;
      case "response.output_item.done":
        if (parsed.item !== undefined) {
          this.items.push(parsed.item);
        }
        break;
      case "response.completed":
        this.note(responseIdOf(response));
        this.ended = true;
        this.completed = true;
        break;
      case "response.incomplete":
      case "response.failed":
      case "response.cancelled":
      case "error":
        this.ended = true;
        break;
      case "codex.response.metadata": {
        const etag = this.header("x-models-etag");
        if (etag.length > 0 && isRecord(parsed.headers) && "x-models-etag" in parsed.headers) {
          parsed.headers["x-models-etag"] = etag;
          void this.send(JSON.stringify(parsed));
          return;
        }
        break;
      }
      default:
        break;
    }
    void this.send(data);
  }

  private note(id: string): void {
    if (id.length === 0) {
      return;
    }
    this.id = id;
    if (!this.run.ids.includes(id)) {
      this.run.ids.push(id);
    }
  }

  private header(name: string): string {
    const value = this.res.getHeader(name);
    if (Array.isArray(value)) {
      return String(value[0] ?? "");
    }
    return value === undefined ? "" : String(value);
  }

  /**
   * What the HTTP route says in the reply's headers, as Codex reads it on a
   * socket: the turn state and the model in `response.metadata`, the model
   * list's tag in `codex.response.metadata`, and the account's windows in
   * `codex.rate_limits`.
   */
  private headerFrames(): string[] {
    const frames: string[] = [];
    const metadata: Record<string, string> = {};
    for (const name of ["x-codex-turn-state", "openai-model", "x-reasoning-included"]) {
      const value = this.header(name);
      if (value.length > 0) {
        metadata[name] = value;
      }
    }
    if (Object.keys(metadata).length > 0) {
      frames.push(JSON.stringify({ type: "response.metadata", headers: metadata }));
    }
    const etag = this.header("x-models-etag");
    if (etag.length > 0) {
      frames.push(
        JSON.stringify({ type: "codex.response.metadata", headers: { "x-models-etag": etag } }),
      );
    }
    const limits = codexLimitsFrame(this.res);
    if (limits !== null) {
      frames.push(limits);
    }
    return frames;
  }

  private sendWholeReply(): void {
    const text = Buffer.concat(this.buffer).toString("utf8").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed) || parsed.object !== "response" || typeof parsed.id !== "string") {
      this.status = 502;
      void this.send(
        JSON.stringify({
          type: "error",
          status: 502,
          error: { type: "server_error", message: "the reply was neither a stream nor a response" },
        }),
      );
      this.ended = true;
      return;
    }
    for (const frame of this.headerFrames()) {
      void this.send(frame);
    }
    this.event(JSON.stringify({ type: "response.created", response: parsed }));
    const output = Array.isArray(parsed.output) ? parsed.output : [];
    output.forEach((item, index) => {
      this.event(JSON.stringify({ type: "response.output_item.done", output_index: index, item }));
    });
    let kind = "response.completed";
    if (parsed.status === "incomplete") {
      kind = "response.incomplete";
    } else if (parsed.status === "failed") {
      kind = "response.failed";
    }
    this.event(JSON.stringify({ type: kind, response: parsed }));
  }

  /**
   * An error reply as Codex reads one on a socket: the status, the error
   * object and the headers it acts on (Retry-After, the account's x-codex-*
   * windows).
   */
  private sendHttpError(): void {
    this.ended = true;
    const text = Buffer.concat(this.buffer).toString("utf8").trim();
    let error: unknown = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && parsed.error !== undefined) {
        error = parsed.error;
      }
    } catch {
      error = null;
    }
    if (error === null) {
      error = {
        type: "server_error",
        message: text.length > 0 ? text : (STATUS_TEXT[this.res.statusCode] ?? "Error"),
      };
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.res.getHeaders())) {
      const lower = name.toLowerCase();
      const keep =
        lower === "retry-after" ||
        lower === "retry-after-ms" ||
        lower === "x-request-id" ||
        lower === "x-error-json" ||
        lower.startsWith("x-codex-") ||
        lower.startsWith("x-ratelimit-");
      if (keep) {
        headers[lower] = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
      }
    }
    const frame: Record<string, unknown> = {
      type: "error",
      status: this.res.statusCode,
      error,
    };
    if (Object.keys(headers).length > 0) {
      frame.headers = headers;
    }
    void this.send(JSON.stringify(frame));
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function codexLimitsFrame(res: ServerResponse): string | null {
  const windows: Record<string, unknown> = {};
  for (const which of ["primary", "secondary"]) {
    const used = headerOfResponse(res, `x-codex-${which}-used-percent`);
    const percent = Number.parseFloat(used);
    if (!Number.isFinite(percent)) {
      continue;
    }
    const window: Record<string, unknown> = { used_percent: percent };
    const minutes = Number.parseInt(headerOfResponse(res, `x-codex-${which}-window-minutes`), 10);
    if (Number.isFinite(minutes)) {
      window.window_minutes = minutes;
    }
    const reset = Number.parseInt(headerOfResponse(res, `x-codex-${which}-reset-at`), 10);
    if (Number.isFinite(reset)) {
      window.reset_at = reset;
    }
    windows[which] = window;
  }
  if (Object.keys(windows).length === 0) {
    return null;
  }
  const event: Record<string, unknown> = { type: "codex.rate_limits", rate_limits: windows };
  const plan = headerOfResponse(res, "x-codex-plan-type");
  if (plan.length > 0) {
    event.plan_type = plan;
  }
  const has = headerOfResponse(res, "x-codex-credits-has-credits");
  const unlimited = headerOfResponse(res, "x-codex-credits-unlimited");
  if (has.length > 0 && unlimited.length > 0) {
    const credits: Record<string, unknown> = {
      has_credits: has.toLowerCase() === "true",
      unlimited: unlimited.toLowerCase() === "true",
    };
    const balance = headerOfResponse(res, "x-codex-credits-balance");
    if (balance.length > 0) {
      credits.balance = balance;
    }
    event.credits = credits;
  }
  return JSON.stringify(event);
}

function headerOfResponse(res: ServerResponse, name: string): string {
  const value = res.getHeader(name);
  if (value === undefined) {
    return "";
  }
  return Array.isArray(value) ? String(value[0] ?? "") : String(value);
}

/** input as a list of items; a string becomes one user message. */
function prevInput(raw: unknown): unknown[] | null {
  if (typeof raw === "string") {
    return [{ type: "message", role: "user", content: raw }];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  return null;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function responseIdOf(response: unknown): string {
  if (isRecord(response) && typeof response.id === "string") {
    return response.id;
  }
  return "";
}

function upgradeRequest(req: IncomingMessage): GatewayRequest {
  return {
    get: (name: string) => {
      const value = req.headers[name.toLowerCase()];
      if (Array.isArray(value)) {
        return value[0];
      }
      return value;
    },
    query: queryOf(req.url ?? "/"),
    socket: req.socket,
  };
}

function queryOf(url: string): Record<string, string> {
  try {
    const parsed = new URL(url, "http://localhost");
    const out: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) {
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function headerOf(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://localhost").pathname;
  } catch {
    return "";
  }
}

function typeOf(frame: string | typeof TURN_DONE): string {
  if (frame === TURN_DONE) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(frame);
    return isRecord(parsed) && typeof parsed.type === "string" ? parsed.type : "";
  } catch {
    return "";
  }
}

function stringField(frame: string | typeof TURN_DONE, field: string): string {
  if (frame === TURN_DONE) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(frame);
    return isRecord(parsed) && typeof parsed[field] === "string" ? parsed[field] : "";
  } catch {
    return "";
  }
}

function interruptReply(kind: string, id: string): string {
  return JSON.stringify({ type: kind, response_id: id });
}

function incompleteFrame(id: string): string {
  return JSON.stringify({
    type: "response.incomplete",
    response: {
      id,
      object: "response",
      status: "incomplete",
      incomplete_details: { reason: "interrupted" },
      output: [],
    },
  });
}

function randomId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

function reject(
  socket: Duplex,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body = `${JSON.stringify({ error: { message } })}\n`;
  const extra = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\n${extra}content-type: application/json\r\ncontent-length: ${Buffer.byteLength(
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

/** Exported for tests: the input a turn continues. */
export const responsesSocketInternals = { prevInput, codexLimitsFrame, turnHeaders, SOCKET_PATHS };
