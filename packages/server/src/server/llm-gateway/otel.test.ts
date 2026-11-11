import { describe, expect, it, vi } from "vitest";
import type { UsageRecord } from "./usage.js";
import {
  buildOtlpMetrics,
  offerGatewaySpanBodies,
  buildOtlpTrace,
  exportGatewayMetrics,
  exportGatewaySpan,
  setGatewaySpanBodiesWholeSource,
} from "./otel.js";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    time: "2026-01-02T03:04:05.000Z",
    requested: "claude-sonnet-4-5",
    provider: "anthropic",
    account: "work",
    model: "claude-sonnet-4-5-20250929",
    protocol: "anthropic",
    status: 200,
    ok: true,
    inputTokens: 120,
    outputTokens: 30,
    attempts: 1,
    durationMs: 2_500,
    costUsd: 0.0123,
    priced: true,
    key: "pk-1",
    client: "claude-code",
    upstreamProtocol: "openai",
    session: "session-a",
    requestId: "req-1",
    ...overrides,
  };
}

function firstSpan(body: ReturnType<typeof buildOtlpTrace>) {
  return body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
}

describe("buildOtlpTrace", () => {
  it("builds one llm.request span with session, usage and cost attributes", () => {
    const span = firstSpan(buildOtlpTrace(record(), "0011223344556677"));
    expect(span.spanId).toBe("0011223344556677");
    expect(span.name).toBe("llm.request");
    expect(span.kind).toBe(3);
    expect(span.status).toEqual({ code: 1 });
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);

    const attributes = Object.fromEntries(
      span.attributes.map(({ key, value }) => [key, Object.values(value)[0]]),
    );
    expect(attributes["gen_ai.request.model"]).toBe("claude-sonnet-4-5");
    expect(attributes["gen_ai.response.model"]).toBe("claude-sonnet-4-5-20250929");
    expect(attributes["gen_ai.usage.input_tokens"]).toBe("120");
    expect(attributes["gen_ai.usage.output_tokens"]).toBe("30");
    expect(attributes["neolix.session"]).toBe("session-a");
    expect(attributes["neolix.cost_usd"]).toBe(0.0123);
    expect(attributes["http.response.status_code"]).toBe("200");
    expect(attributes).not.toHaveProperty("error");
  });

  it("gives every request in one session the same trace", () => {
    const first = firstSpan(buildOtlpTrace(record({ requestId: "req-1" })));
    const second = firstSpan(buildOtlpTrace(record({ requestId: "req-2" })));
    const other = firstSpan(buildOtlpTrace(record({ session: "session-b" })));
    expect(first.traceId).toBe(second.traceId);
    expect(other.traceId).not.toBe(first.traceId);
  });

  it("marks a failed request and ends the span when the request ended", () => {
    const span = firstSpan(buildOtlpTrace(record({ ok: false, status: 529 })));
    expect(span.status).toEqual({ code: 2, message: "HTTP 529" });
    expect(span.endTimeUnixNano).toBe(
      `${BigInt(Date.parse("2026-01-02T03:04:05.000Z")) * 1_000_000n}`,
    );
    expect(span.startTimeUnixNano).toBe(
      `${BigInt(Date.parse("2026-01-02T03:04:05.000Z") - 2_500) * 1_000_000n}`,
    );
    expect(span.attributes).toContainEqual({ key: "error", value: { boolValue: true } });
  });

  it("leaves absent optional fields out instead of sending empty strings", () => {
    const span = firstSpan(
      buildOtlpTrace(record({ account: null, key: null, client: undefined, session: undefined })),
    );
    const keys = span.attributes.map(({ key }) => key);
    expect(keys).not.toContain("neolix.account");
    expect(keys).not.toContain("neolix.key");
    expect(keys).not.toContain("neolix.client");
    expect(keys).not.toContain("neolix.session");
  });
});

describe("exportGatewaySpan", () => {
  it("posts to the collector's /v1/traces with the configured headers", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    exportGatewaySpan(
      { enabled: true, endpoint: "http://collector:4318/", headers: { authorization: "Bearer t" } },
      record(),
    );

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://collector:4318/v1/traces");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      authorization: "Bearer t",
    });
    const body = JSON.parse(String(init.body));
    expect(body.resourceSpans[0].resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "neolix-gateway" } },
    ]);
    vi.unstubAllGlobals();
  });

  it("sends nothing when export is off or has no endpoint", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    exportGatewaySpan(undefined, record());
    exportGatewaySpan({ enabled: false, endpoint: "http://collector:4318" }, record());
    exportGatewaySpan({ enabled: true }, record());
    exportGatewaySpan({ enabled: true, endpoint: "not a url" }, record());
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("swallows a failing collector", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connection refused");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(() =>
      exportGatewaySpan({ enabled: true, endpoint: "http://collector:4318" }, record()),
    ).not.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    vi.unstubAllGlobals();
  });
});

describe("buildOtlpMetrics", () => {
  function metricsOf(body: ReturnType<typeof buildOtlpMetrics>) {
    return body.resourceMetrics[0]!.scopeMetrics[0]!.metrics as {
      name: string;
      histogram: {
        aggregationTemporality: number;
        dataPoints: {
          attributes: { key: string; value: Record<string, unknown> }[];
          count: string;
          sum: number;
          bucketCounts: string[];
          explicitBounds: number[];
        }[];
      };
    }[];
  }

  it("groups a window's requests by provider and model as histograms", () => {
    const body = buildOtlpMetrics(
      [record({ durationMs: 500 }), record({ durationMs: 3_000, requestId: "req-2" })],
      1_000,
      61_000,
    );
    const metrics = metricsOf(body);
    const duration = metrics.find((metric) => metric.name === "gen_ai.client.operation.duration");
    const tokens = metrics.find((metric) => metric.name === "gen_ai.client.token.usage");
    expect(duration?.histogram.aggregationTemporality).toBe(1);
    expect(duration?.histogram.dataPoints).toHaveLength(1);
    expect(duration?.histogram.dataPoints[0]).toMatchObject({ count: "2", sum: 3.5 });
    expect(duration?.histogram.dataPoints[0]?.explicitBounds[0]).toBe(0.1);
    expect(duration?.histogram.dataPoints[0]?.bucketCounts).toHaveLength(10);
    expect(tokens?.histogram.dataPoints).toHaveLength(2);
    const tokenKinds: unknown[] = [];
    for (const point of tokens?.histogram.dataPoints ?? []) {
      tokenKinds.push(point.attributes.find((attribute) => attribute.key === "gen_ai.token.type"));
    }
    expect(tokenKinds).toEqual([
      { key: "gen_ai.token.type", value: { stringValue: "input" } },
      { key: "gen_ai.token.type", value: { stringValue: "output" } },
    ]);
  });

  it("keeps providers and models apart", () => {
    const body = buildOtlpMetrics(
      [record(), record({ provider: "openai", model: "gpt-5", requestId: "req-2" })],
      1_000,
      61_000,
    );
    const duration = metricsOf(body).find(
      (metric) => metric.name === "gen_ai.client.operation.duration",
    );
    expect(duration?.histogram.dataPoints).toHaveLength(2);
  });

  it("sends an empty metric set when the window had no requests", () => {
    const metrics = metricsOf(buildOtlpMetrics([], 1_000, 61_000));
    expect(metrics).toEqual([]);
  });
});

describe("exportGatewayMetrics", () => {
  it("posts histograms to /v1/metrics, beside a Langfuse trace endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    exportGatewayMetrics(
      {
        enabled: true,
        metrics: true,
        endpoint: "https://cloud.langfuse.com/api/public/otel",
      },
      [record()],
      1_000,
      61_000,
      fetchMock as unknown as typeof fetch,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.langfuse.com/api/public/otel/v1/metrics");
    expect(JSON.parse(String(init.body)).resourceMetrics).toHaveLength(1);
  });

  it("sends nothing when metrics, export or records are off", () => {
    const fetchMock = vi.fn();
    exportGatewayMetrics(undefined, [record()], 0, 1, fetchMock as unknown as typeof fetch);
    exportGatewayMetrics(
      { enabled: true, metrics: false, endpoint: "http://c:4318" },
      [record()],
      0,
      1,
      fetchMock as unknown as typeof fetch,
    );
    exportGatewayMetrics(
      { enabled: false, metrics: true, endpoint: "http://c:4318" },
      [record()],
      0,
      1,
      fetchMock as unknown as typeof fetch,
    );
    exportGatewayMetrics(
      { enabled: true, metrics: true, endpoint: "http://c:4318" },
      [],
      0,
      1,
      fetchMock as unknown as typeof fetch,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swallows a failing collector", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("offline")));
    expect(() =>
      exportGatewayMetrics(
        { enabled: true, metrics: true, endpoint: "http://c:4318" },
        [record()],
        0,
        1,
        fetchMock as unknown as typeof fetch,
      ),
    ).not.toThrow();
  });
});

describe("trace content", () => {
  it("attaches request and reply bodies as Langfuse's observation input and output", () => {
    const span = firstSpan(
      buildOtlpTrace(record(), "0011223344556677", {
        request: '{"messages":[]}',
        response: '{"choices":[]}',
      }),
    );
    const attributes = Object.fromEntries(
      span.attributes.map(({ key, value }) => [key, Object.values(value)[0]]),
    );
    expect(attributes["langfuse.observation.input"]).toBe('{"messages":[]}');
    expect(attributes["langfuse.observation.output"]).toBe('{"choices":[]}');
  });

  it("masks before keeping a body and cuts it at 256 KiB", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    offerGatewaySpanBodies(
      "req-1",
      { request: "token sk-secret", response: "x".repeat(300 * 1024) },
      (text) => text.replaceAll("sk-secret", "{{SECRET}}"),
    );
    exportGatewaySpan(
      { enabled: true, bodies: true, endpoint: "http://collector:4318" },
      record({ requestId: "req-1" }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const span = JSON.parse(String(init.body)).resourceSpans[0].scopeSpans[0].spans[0];
    const attributes = Object.fromEntries(
      span.attributes.map(({ key, value }: { key: string; value: Record<string, unknown> }) => [
        key,
        Object.values(value)[0],
      ]),
    );
    expect(attributes["langfuse.observation.input"]).toBe("token {{SECRET}}");
    expect(String(attributes["langfuse.observation.output"])).toHaveLength(256 * 1024);
    // The next record has no bodies waiting.
    exportGatewaySpan(
      { enabled: true, bodies: true, endpoint: "http://collector:4318" },
      record({ requestId: "req-1" }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, second] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(second.body)).not.toContain("langfuse.observation.input");
    vi.unstubAllGlobals();
  });

  it("sends the whole body when BodiesWhole is on", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setGatewaySpanBodiesWholeSource(() => true);
    try {
      offerGatewaySpanBodies("req-whole", { response: "y".repeat(300 * 1024) }, (text) => text);
      exportGatewaySpan(
        { enabled: true, bodies: true, bodiesWhole: true, endpoint: "http://collector:4318" },
        record({ requestId: "req-whole" }),
      );
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const span = JSON.parse(String(init.body)).resourceSpans[0].scopeSpans[0].spans[0];
      const attributes = Object.fromEntries(
        span.attributes.map(({ key, value }: { key: string; value: Record<string, unknown> }) => [
          key,
          Object.values(value)[0],
        ]),
      );
      expect(String(attributes["langfuse.observation.output"])).toHaveLength(300 * 1024);
    } finally {
      setGatewaySpanBodiesWholeSource(() => false);
      vi.unstubAllGlobals();
    }
  });

  it("attaches nothing when content export is off", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    offerGatewaySpanBodies("req-2", { request: "hello" }, (text) => text);
    exportGatewaySpan(
      { enabled: true, bodies: false, endpoint: "http://collector:4318" },
      record({ requestId: "req-2" }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).not.toContain("langfuse.observation.input");
    vi.unstubAllGlobals();
  });
});
