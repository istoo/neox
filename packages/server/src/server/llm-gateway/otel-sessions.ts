import { createHash } from "node:crypto";
import type { ExternalSession } from "../external-sessions/types.js";
import type { SessionTraceSpan } from "../external-sessions/trace-spans.js";
import { tracesUrl, type GatewayOtelConfig } from "./otel.js";

const EXPORT_TIMEOUT_MS = 3_000;
const SERVICE_NAME = "neolix-gateway";
const SCOPE_NAME = "neolix.llm-gateway";
/** myna's OTelSessionsEvery reads every 2s; a full directory scan costs more here. */
const DEFAULT_EVERY_MS = 15_000;
/** myna cuts a body at 256 KiB (settings.OTel.BodiesWhole lifts it). */
const BODY_LIMIT = 256 * 1024;

interface OtlpAttribute {
  key: string;
  value:
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean };
}

function stringAttribute(key: string, value: string | null | undefined): OtlpAttribute | null {
  return value === null || value === undefined || value.length === 0
    ? null
    : { key, value: { stringValue: value } };
}

function intAttribute(key: string, value: number | undefined): OtlpAttribute | null {
  return value === undefined || !Number.isFinite(value)
    ? null
    : { key, value: { intValue: String(Math.round(value)) } };
}

function doubleAttribute(key: string, value: number | undefined): OtlpAttribute | null {
  return value === undefined || !Number.isFinite(value)
    ? null
    : { key, value: { doubleValue: value } };
}

function booleanAttribute(key: string, value: boolean | undefined): OtlpAttribute | null {
  return value === undefined ? null : { key, value: { boolValue: value } };
}

function attributesOf(values: readonly (OtlpAttribute | null)[]): OtlpAttribute[] {
  return values.filter((attribute): attribute is OtlpAttribute => attribute !== null);
}

/** myna's TraceID: agent, session and turn joined by NUL, sha256, first 16 bytes. */
function traceIdOf(agent: string, session: string): string {
  return createHash("sha256").update(`${agent}\u0000${session}\u0000`).digest("hex").slice(0, 32);
}

function spanIdOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

function timeOf(iso: string): number | null {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

/** What the caller read from a session's transcript, already the whole story. */
export interface SessionBodies {
  input?: string | undefined;
  output?: string | undefined;
}

function cutBody(text: string | undefined, mask: (text: string) => string): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const masked = mask(text);
  return masked.length > BODY_LIMIT ? masked.slice(0, BODY_LIMIT) : masked;
}

function usageAttributes(session: ExternalSession): (OtlpAttribute | null)[] {
  return [
    intAttribute(
      "gen_ai.usage.input_tokens",
      session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite,
    ),
    intAttribute("gen_ai.usage.output_tokens", session.tokens.output),
    intAttribute("gen_ai.usage.cache_read.input_tokens", session.tokens.cacheRead),
    intAttribute("gen_ai.usage.cache_creation.input_tokens", session.tokens.cacheWrite),
  ];
}

/**
 * The OTLP spans for one local session: a root span for the conversation and
 * a generation per model it used. external-sessions keeps no per-turn timing,
 * so the model spans inherit the session's span and say their timing is
 * inferred, as myna marks timing it did not read.
 */
export function buildOtlpSessionTrace(
  session: ExternalSession,
  bodies: SessionBodies | null,
  mask: (text: string) => string = (text) => text,
) {
  const startMs = timeOf(session.start);
  const endMs = timeOf(session.last);
  if (startMs === null || endMs === null) {
    return null;
  }
  const traceName = `${session.agent} interaction`;
  const traceId = traceIdOf(session.agent, session.id);
  const rootId = spanIdOf(session.agent, session.id, "root");
  const input = bodies === null ? undefined : cutBody(bodies.input, mask);
  const output = bodies === null ? undefined : cutBody(bodies.output, mask);
  const root = {
    traceId,
    spanId: rootId,
    name: traceName,
    kind: 1,
    startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    attributes: attributesOf([
      stringAttribute("neolix.agent", session.agent),
      stringAttribute("langfuse.session.id", `${session.agent}:${session.id}`),
      stringAttribute("langfuse.trace.name", traceName),
      stringAttribute("langfuse.observation.type", "span"),
      stringAttribute("neolix.timing.source", "recorded"),
      intAttribute("neolix.messages", session.messages),
      ...usageAttributes(session),
      stringAttribute("langfuse.observation.input", input),
      stringAttribute("langfuse.observation.output", output),
    ]),
    status: { code: 1 },
  };
  const models = session.models.map((model) => ({
    traceId,
    spanId: spanIdOf(session.agent, session.id, "model", model.model, model.effort ?? ""),
    parentSpanId: rootId,
    name: `chat ${model.model}`,
    kind: 3,
    startTimeUnixNano: root.startTimeUnixNano,
    endTimeUnixNano: root.endTimeUnixNano,
    attributes: attributesOf([
      stringAttribute("gen_ai.operation.name", "chat"),
      stringAttribute("gen_ai.request.model", model.model),
      stringAttribute("neolix.agent", session.agent),
      stringAttribute("langfuse.session.id", `${session.agent}:${session.id}`),
      stringAttribute("langfuse.observation.type", "generation"),
      stringAttribute("neolix.timing.source", "inferred"),
      stringAttribute("neolix.effort", model.effort),
      intAttribute(
        "gen_ai.usage.input_tokens",
        model.tokens.input + model.tokens.cacheRead + model.tokens.cacheWrite,
      ),
      intAttribute("gen_ai.usage.output_tokens", model.tokens.output),
      intAttribute("gen_ai.usage.cache_read.input_tokens", model.tokens.cacheRead),
      intAttribute("gen_ai.usage.cache_creation.input_tokens", model.tokens.cacheWrite),
      doubleAttribute("neolix.cost_usd", model.priced ? model.cost : undefined),
    ]),
    status: { code: 1 },
  }));
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: [root, ...models],
          },
        ],
      },
    ],
  };
}

function otlpSpanOf(
  span: SessionTraceSpan,
  agent: string,
  sessionId: string,
  mask: (text: string) => string,
) {
  const tokens = span.tokens;
  return {
    traceId: span.traceId,
    spanId: span.id,
    ...(span.parentId === undefined ? {} : { parentSpanId: span.parentId }),
    name: span.name,
    kind: span.kind === "generation" ? 3 : 1,
    startTimeUnixNano: String(BigInt(Math.round(span.startMs)) * 1_000_000n),
    endTimeUnixNano: String(BigInt(Math.round(span.endMs)) * 1_000_000n),
    attributes: attributesOf([
      stringAttribute("neolix.agent", agent),
      stringAttribute("langfuse.session.id", `${agent}:${sessionId}`),
      stringAttribute("langfuse.trace.name", `${agent} interaction`),
      stringAttribute("langfuse.observation.type", span.kind),
      stringAttribute("neolix.timing.source", span.inferred === true ? "inferred" : "recorded"),
      stringAttribute("gen_ai.operation.name", span.kind === "generation" ? "chat" : undefined),
      stringAttribute("gen_ai.request.model", span.model),
      intAttribute(
        "gen_ai.usage.input_tokens",
        tokens === undefined ? undefined : tokens.input + tokens.cacheRead + tokens.cacheWrite,
      ),
      intAttribute("gen_ai.usage.output_tokens", tokens?.output),
      intAttribute("gen_ai.usage.cache_read.input_tokens", tokens?.cacheRead),
      intAttribute("gen_ai.usage.cache_creation.input_tokens", tokens?.cacheWrite),
      stringAttribute("langfuse.observation.input", cutBody(span.input, mask)),
      stringAttribute("langfuse.observation.output", cutBody(span.output, mask)),
      booleanAttribute("error", span.error === true ? true : undefined),
    ]),
    status: { code: span.error === true ? 2 : 1 },
  };
}

/** One turn's spans as an OTLP body, root first. */
export function buildOtlpTurnTrace(
  spans: readonly SessionTraceSpan[],
  agent: string,
  sessionId: string,
  mask: (text: string) => string = (text) => text,
) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: spans.map((span) => otlpSpanOf(span, agent, sessionId, mask)),
          },
        ],
      },
    ],
  };
}

interface TurnTrace {
  traceId: string;
  endMs: number;
  signature: string;
  spans: SessionTraceSpan[];
}

/** The spans of one session grouped by turn, each with a change signature. */
export function groupTurnTraces(spans: readonly SessionTraceSpan[]): TurnTrace[] {
  const groups = new Map<string, SessionTraceSpan[]>();
  for (const span of spans) {
    const group = groups.get(span.traceId);
    if (group === undefined) {
      groups.set(span.traceId, [span]);
    } else {
      group.push(span);
    }
  }
  return [...groups].map(([traceId, group]) => {
    const ordered = [...group];
    const rootIndex = ordered.findIndex((span) => span.kind === "span");
    if (rootIndex > 0) {
      const [root] = ordered.splice(rootIndex, 1);
      if (root !== undefined) {
        ordered.unshift(root);
      }
    }
    const signature = ordered
      .map((span) => `${span.id}:${span.endMs}:${span.tokens?.output ?? ""}`)
      .join("|");
    return {
      traceId,
      endMs: Math.max(...ordered.map((span) => span.endMs)),
      signature,
      spans: ordered,
    };
  });
}

function signatureOf(session: ExternalSession): string {
  return [
    session.last,
    String(session.messages),
    String(session.tokens.input),
    String(session.tokens.output),
    String(session.tokens.cacheRead),
    String(session.tokens.cacheWrite),
    session.models
      .map(
        (model) =>
          `${model.model}/${model.effort ?? ""}/${model.tokens.input}/${model.tokens.output}`,
      )
      .join(","),
  ].join("\u0000");
}

export interface OtelSessionsOptions {
  config: () => GatewayOtelConfig | undefined;
  /** Every local session, as external-sessions lists them. */
  load: () => Promise<ExternalSession[]>;
  /** A session's transcript, read only when bodies are on. */
  bodies?: (session: ExternalSession) => Promise<SessionBodies | null>;
  /** A session's recorded turns; empty for agents with no per-line time. */
  trace?: (session: ExternalSession, bodies: boolean) => Promise<SessionTraceSpan[]>;
  mask?: (text: string) => string;
  everyMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Polls the agents' local sessions and sends a trace for each one that grew
 * while exporting was on. Span IDs are deterministic, so a later send of the
 * same session updates the observation instead of adding another.
 */
export class OtelSessionsExporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private enabledSince = 0;
  private readonly signatures = new Map<string, string>();
  private readonly turns = new Map<string, string>();

  constructor(private readonly options: OtelSessionsOptions) {}

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), this.options.everyMs ?? DEFAULT_EVERY_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.signatures.clear();
    this.turns.clear();
    this.enabledSince = 0;
  }

  async poll(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.pollOnce();
    } catch {
      // An exporter never takes anything down with it.
    } finally {
      this.running = false;
    }
  }

  private async pollOnce(): Promise<void> {
    const config = this.options.config();
    if (config?.enabled !== true || config.sessions !== true) {
      this.signatures.clear();
      this.turns.clear();
      this.enabledSince = 0;
      return;
    }
    const now = this.options.now?.() ?? Date.now();
    if (this.enabledSince === 0) {
      this.enabledSince = now;
    }
    const sessions = await this.options.load();
    for (const session of sessions) {
      await this.offer(session, config);
    }
  }

  private async offer(session: ExternalSession, config: GatewayOtelConfig): Promise<void> {
    if (session.gateway === true) {
      return;
    }
    const last = timeOf(session.last);
    if (last === null || last < this.enabledSince) {
      return;
    }
    const key = `${session.agent}\u0000${session.id}`;
    const signature = signatureOf(session);
    if (this.signatures.get(key) === signature) {
      return;
    }
    this.signatures.set(key, signature);
    const traced =
      this.options.trace === undefined
        ? []
        : await this.options
            .trace(session, config.bodies === true)
            .catch(() => [] as SessionTraceSpan[]);
    if (traced.length > 0) {
      this.offerTurns(session, traced, config);
      return;
    }
    const bodies =
      config.bodies === true && this.options.bodies !== undefined
        ? await this.options.bodies(session).catch(() => null)
        : null;
    const body = buildOtlpSessionTrace(session, bodies, this.options.mask);
    if (body === null) {
      return;
    }
    this.send(config, body);
  }

  /** Each turn grown while exporting was on, sent as its own trace. */
  private offerTurns(
    session: ExternalSession,
    spans: readonly SessionTraceSpan[],
    config: GatewayOtelConfig,
  ): void {
    for (const turn of groupTurnTraces(spans)) {
      if (turn.endMs < this.enabledSince) {
        continue;
      }
      const key = `${session.agent}\u0000${session.id}\u0000${turn.traceId}`;
      if (this.turns.get(key) === turn.signature) {
        continue;
      }
      this.turns.set(key, turn.signature);
      this.send(
        config,
        buildOtlpTurnTrace(turn.spans, session.agent, session.id, this.options.mask),
      );
    }
  }

  private send(config: GatewayOtelConfig, body: unknown): void {
    const url = tracesUrl(config.endpoint ?? "");
    if (url === null) {
      return;
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    void fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })
      .then((response) => {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      })
      .catch(() => undefined);
  }
}
