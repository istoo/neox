import { createHash, randomBytes } from "node:crypto";
import type { GatewayConfig } from "./config.js";
import type { UsageRecord } from "./usage.js";

const EXPORT_TIMEOUT_MS = 3_000;
// OTel service, scope and attribute names are what users' collectors and dashboards filter on.
const SERVICE_NAME = "neolix-gateway";
const SCOPE_NAME = "neolix.llm-gateway";

export type GatewayOtelConfig = NonNullable<GatewayConfig["otel"]>;

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

function numberAttribute(key: string, value: number | undefined): OtlpAttribute | null {
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

/** A session's spans share a trace; a request without one gets its own. */
function traceIdFor(record: UsageRecord): string {
  const seed = record.session ?? record.requestId ?? `${record.time}:${record.model}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

function spanTime(record: UsageRecord): { start: bigint; end: bigint } {
  const parsed = Date.parse(record.time);
  const endMs = Number.isFinite(parsed) ? parsed : Date.now();
  const startMs = endMs - Math.max(0, record.durationMs);
  return { start: BigInt(startMs) * 1_000_000n, end: BigInt(endMs) * 1_000_000n };
}

/** A request's bodies as the trace content setting offers them. */
export interface GatewayBodies {
  request?: string;
  response?: string;
}

/** myna cuts each body at 256 KiB (settings.OTel.BodiesWhole lifts it). */
const BODY_LIMIT = 256 * 1024;
/** Reads BodiesWhole from the live gateway config; tests may replace it. */
let spanBodiesWhole: () => boolean = () => false;

/** Points the body limit at the current config, so a setting change applies at once. */
export function setGatewaySpanBodiesWholeSource(source: () => boolean): void {
  spanBodiesWhole = source;
}
/** Bodies wait here between the route's end and the ledger's record. */
const pendingBodies = new Map<string, GatewayBodies>();

/**
 * Offers a request's bodies to its span, masked before they are kept and
 * cut at 256 KiB. The route calls this as its request ends; the ledger's
 * record, written right after, picks them up. Never called: no content.
 */
export function offerGatewaySpanBodies(
  requestId: string,
  bodies: GatewayBodies,
  mask: (text: string) => string,
): void {
  const masked: GatewayBodies = {};
  if (bodies.request !== undefined) {
    masked.request = cutBody(mask(bodies.request));
  }
  if (bodies.response !== undefined) {
    masked.response = cutBody(mask(bodies.response));
  }
  pendingBodies.set(requestId, masked);
  while (pendingBodies.size > 64) {
    const oldest = pendingBodies.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    pendingBodies.delete(oldest);
  }
}

function cutBody(text: string): string {
  return spanBodiesWhole() || text.length <= BODY_LIMIT ? text : text.slice(0, BODY_LIMIT);
}

function takeBodies(record: UsageRecord): GatewayBodies | null {
  if (record.requestId === undefined) {
    return null;
  }
  const bodies = pendingBodies.get(record.requestId);
  if (bodies !== undefined) {
    pendingBodies.delete(record.requestId);
  }
  return bodies ?? null;
}

/** Forgets bodies not yet taken; tests use it between cases. */
export function resetGatewaySpanBodiesForTests(): void {
  pendingBodies.clear();
}

/** The OTLP/HTTP JSON body for one gateway request, as Langfuse reads it. */
export function buildOtlpTrace(
  record: UsageRecord,
  spanId = randomBytes(8).toString("hex"),
  bodies: GatewayBodies | null = null,
) {
  const { start, end } = spanTime(record);
  const attributes = [
    stringAttribute("langfuse.observation.input", bodies?.request),
    stringAttribute("langfuse.observation.output", bodies?.response),
    stringAttribute("gen_ai.system", record.protocol),
    stringAttribute("gen_ai.request.model", record.requested),
    stringAttribute("gen_ai.response.model", record.model),
    stringAttribute("gen_ai.operation.name", "chat"),
    numberAttribute("gen_ai.usage.input_tokens", record.inputTokens),
    numberAttribute("gen_ai.usage.output_tokens", record.outputTokens),
    numberAttribute("http.response.status_code", record.status),
    stringAttribute("neolix.provider", record.provider),
    stringAttribute("neolix.account", record.account),
    stringAttribute("neolix.key", record.key),
    stringAttribute("neolix.client", record.client),
    stringAttribute("neolix.session", record.session),
    stringAttribute("neolix.request_id", record.requestId),
    stringAttribute("neolix.upstream_protocol", record.upstreamProtocol),
    numberAttribute("neolix.attempts", record.attempts),
    doubleAttribute("neolix.cost_usd", record.costUsd),
    booleanAttribute("neolix.priced", record.priced),
    booleanAttribute("error", record.ok ? undefined : true),
  ].filter((attribute): attribute is OtlpAttribute => attribute !== null);

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeSpans: [
          {
            scope: { name: SCOPE_NAME },
            spans: [
              {
                traceId: traceIdFor(record),
                spanId,
                name: "llm.request",
                kind: 3,
                startTimeUnixNano: String(start),
                endTimeUnixNano: String(end),
                attributes,
                status: record.ok ? { code: 1 } : { code: 2, message: `HTTP ${record.status}` },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function tracesUrl(endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return `${endpoint.replace(/\/+$/, "")}/v1/traces`;
  } catch {
    return null;
  }
}

/** Duration and token histograms, as myna's "Export metrics" sends them. */
const DURATION_BOUNDS = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120];
const TOKEN_BOUNDS = [100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];
const METRICS_FLUSH_MS = 30_000;

interface HistogramGroup {
  provider: string;
  model: string;
  durations: number[];
  inputTokens: number[];
  outputTokens: number[];
}

function unixNano(ms: number): string {
  return String(BigInt(Math.round(ms)) * 1_000_000n);
}

function histogramPoint(
  attributes: OtlpAttribute[],
  values: readonly number[],
  bounds: readonly number[],
  startMs: number,
  endMs: number,
) {
  const bucketCounts = Array.from({ length: bounds.length + 1 }, () => 0);
  let sum = 0;
  for (const value of values) {
    sum += value;
    const index = bounds.findIndex((bound) => value <= bound);
    bucketCounts[index < 0 ? bounds.length : index] += 1;
  }
  return {
    attributes,
    startTimeUnixNano: unixNano(startMs),
    timeUnixNano: unixNano(endMs),
    count: String(values.length),
    sum,
    bucketCounts: bucketCounts.map(String),
    explicitBounds: [...bounds],
  };
}

function groupRecords(records: readonly UsageRecord[]): HistogramGroup[] {
  const groups = new Map<string, HistogramGroup>();
  for (const record of records) {
    const key = `${record.provider}\u0000${record.model}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        provider: record.provider,
        model: record.model,
        durations: [],
        inputTokens: [],
        outputTokens: [],
      };
      groups.set(key, group);
    }
    group.durations.push(record.durationMs / 1_000);
    group.inputTokens.push(record.inputTokens);
    group.outputTokens.push(record.outputTokens);
  }
  return [...groups.values()];
}

/** The OTLP/HTTP JSON body for a window of gateway requests. */
export function buildOtlpMetrics(records: readonly UsageRecord[], startMs: number, endMs: number) {
  const groups = groupRecords(records);
  const metrics: unknown[] = [];
  if (groups.length > 0) {
    metrics.push({
      name: "gen_ai.client.operation.duration",
      unit: "s",
      histogram: {
        aggregationTemporality: 1,
        dataPoints: groups.map((group) =>
          histogramPoint(
            [
              { key: "gen_ai.provider", value: { stringValue: group.provider } },
              { key: "gen_ai.response.model", value: { stringValue: group.model } },
            ],
            group.durations,
            DURATION_BOUNDS,
            startMs,
            endMs,
          ),
        ),
      },
    });
    metrics.push({
      name: "gen_ai.client.token.usage",
      unit: "{token}",
      histogram: {
        aggregationTemporality: 1,
        dataPoints: groups.flatMap((group) =>
          (
            [
              ["input", group.inputTokens],
              ["output", group.outputTokens],
            ] as const
          ).map(([kind, values]) =>
            histogramPoint(
              [
                { key: "gen_ai.provider", value: { stringValue: group.provider } },
                { key: "gen_ai.response.model", value: { stringValue: group.model } },
                { key: "gen_ai.token.type", value: { stringValue: kind } },
              ],
              values,
              TOKEN_BOUNDS,
              startMs,
              endMs,
            ),
          ),
        ),
      },
    });
  }
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: SERVICE_NAME } }],
        },
        scopeMetrics: [{ scope: { name: SCOPE_NAME }, metrics }],
      },
    ],
  };
}

function signalUrl(endpoint: string, signal: "traces" | "metrics"): string | null {
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    const base = endpoint.replace(/\/+$/, "").replace(/\/v1\/traces$/, "");
    return `${base}/v1/${signal}`;
  } catch {
    return null;
  }
}

/** Sends a window's histograms; failures never affect a request. */
export function exportGatewayMetrics(
  config: GatewayOtelConfig | undefined,
  records: readonly UsageRecord[],
  startMs: number,
  endMs: number,
  fetchImpl: typeof fetch = fetch,
): void {
  try {
    if (config?.enabled !== true || config.metrics !== true || records.length === 0) {
      return;
    }
    const url = signalUrl(config.endpoint ?? "", "metrics");
    if (url === null) {
      return;
    }
    const body = JSON.stringify(buildOtlpMetrics(records, startMs, endMs));
    void fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body,
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })
      .then((response) => {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      })
      .catch(() => undefined);
  } catch {
    // An exporter never takes a request down with it.
  }
}

/** Collects metrics for a window and sends them on a timer. */
export class OtelMetricsExporter {
  private pending: UsageRecord[] = [];
  private windowStart = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      config: () => GatewayOtelConfig | undefined;
      flushMs?: number;
    },
  ) {}

  add(record: UsageRecord): void {
    if (this.options.config()?.metrics === true) {
      this.pending.push(record);
    }
  }

  start(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => this.flush(), this.options.flushMs ?? METRICS_FLUSH_MS);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  flush(): void {
    const records = this.pending;
    if (records.length === 0) {
      return;
    }
    this.pending = [];
    const endMs = Date.now();
    exportGatewayMetrics(this.options.config(), records, this.windowStart, endMs);
    this.windowStart = endMs;
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.pending = [];
  }
}

/**
 * Sends one request's span to the configured OTLP collector. Fire and
 * forget: the request that produced it has already been answered, a slow or
 * broken collector is bounded by the timeout, and nothing here throws.
 */
export function exportGatewaySpan(
  config: GatewayOtelConfig | undefined,
  record: UsageRecord,
): void {
  try {
    if (config?.enabled !== true || config.endpoint === undefined) {
      return;
    }
    const url = tracesUrl(config.endpoint);
    if (url === null) {
      return;
    }
    const bodies = config.bodies === true ? takeBodies(record) : null;
    const body = JSON.stringify(buildOtlpTrace(record, undefined, bodies));
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...config.headers },
      body,
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    })
      .then((response) => {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      })
      .catch(() => undefined);
  } catch {
    // An exporter never takes a request down with it.
  }
}
