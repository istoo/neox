import { describe, expect, it, vi } from "vitest";
import type { ExternalSession } from "../external-sessions/types.js";
import { buildOtlpSessionTrace, OtelSessionsExporter } from "./otel-sessions.js";

function session(overrides: Partial<ExternalSession> = {}): ExternalSession {
  return {
    id: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
    agent: "claude",
    cwd: "/tmp/work",
    title: "Fix the tests",
    start: "2026-03-04T05:06:07.000Z",
    last: "2026-03-04T05:16:07.000Z",
    messages: 12,
    size: 4_096,
    tokens: { input: 900, output: 300, cacheRead: 100, cacheWrite: 20 },
    models: [
      {
        model: "claude-sonnet-4-5",
        tokens: { input: 900, output: 300, cacheRead: 100, cacheWrite: 20 },
        cost: 0.04,
        priced: true,
      },
    ],
    cost: 0.04,
    priced: true,
    resume: "claude --resume 0f1e",
    path: "/tmp/sessions/0f1e.jsonl",
    deletable: true,
    ...overrides,
  };
}

function spansOf(body: NonNullable<ReturnType<typeof buildOtlpSessionTrace>>) {
  return body.resourceSpans[0]!.scopeSpans[0]!.spans;
}

function attributesOf(span: { attributes: unknown[] }) {
  return Object.fromEntries(
    span.attributes.map((attribute) => {
      const { key, value } = attribute as { key: string; value: Record<string, unknown> };
      return [key, Object.values(value)[0]];
    }),
  );
}

describe("buildOtlpSessionTrace", () => {
  it("builds a session span and one generation per model, sharing a trace", () => {
    const body = buildOtlpSessionTrace(session(), null);
    expect(body).not.toBeNull();
    const [root, model] = spansOf(body!);
    expect(root).toBeDefined();
    expect(model).toBeDefined();
    expect(root!.traceId).toBe(model!.traceId);
    expect(model!.parentSpanId).toBe(root!.spanId);
    expect(root!.name).toBe("claude interaction");
    expect(root!.kind).toBe(1);
    expect(model!.name).toBe("chat claude-sonnet-4-5");
    expect(model!.kind).toBe(3);

    const rootAttributes = attributesOf(root!);
    expect(rootAttributes["neolix.agent"]).toBe("claude");
    expect(rootAttributes["langfuse.session.id"]).toBe(`claude:${session().id}`);
    expect(rootAttributes["langfuse.observation.type"]).toBe("span");
    expect(rootAttributes["langfuse.trace.name"]).toBe("claude interaction");
    expect(rootAttributes["gen_ai.usage.input_tokens"]).toBe("1020");
    expect(rootAttributes["gen_ai.usage.output_tokens"]).toBe("300");

    const modelAttributes = attributesOf(model!);
    expect(modelAttributes["langfuse.observation.type"]).toBe("generation");
    expect(modelAttributes["gen_ai.request.model"]).toBe("claude-sonnet-4-5");
    expect(modelAttributes["neolix.timing.source"]).toBe("inferred");
    expect(modelAttributes["neolix.cost_usd"]).toBe(0.04);
  });

  it("keeps span ids stable across reads so a later send updates the trace", () => {
    const first = spansOf(buildOtlpSessionTrace(session(), null)!);
    const second = spansOf(buildOtlpSessionTrace(session({ messages: 13 }), null)!);
    expect(second[0]!.spanId).toBe(first[0]!.spanId);
    expect(second[1]!.spanId).toBe(first[1]!.spanId);
    expect(second[0]!.traceId).toBe(first[0]!.traceId);
  });

  it("has no trace without a readable start and end", () => {
    expect(buildOtlpSessionTrace(session({ last: "" }), null)).toBeNull();
  });

  it("masks bodies and cuts them at 256 KiB", () => {
    const body = buildOtlpSessionTrace(
      session(),
      { input: "PRIVATE-PROMPT " + "x".repeat(300_000), output: "reply" },
      (text) => text.replace("PRIVATE-PROMPT", "[masked]"),
    );
    const root = spansOf(body!)[0]!;
    const attributes = attributesOf(root);
    expect(String(attributes["langfuse.observation.input"]).startsWith("[masked]")).toBe(true);
    expect(String(attributes["langfuse.observation.input"])).toHaveLength(256 * 1024);
    expect(attributes["langfuse.observation.output"]).toBe("reply");
  });
});

describe("OtelSessionsExporter", () => {
  const config = { enabled: true, sessions: true, endpoint: "https://collector.example" };

  it("sends recorded turns as their own traces, one send per change", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const start = Date.parse("2026-03-04T05:06:07.000Z");
    const turn = (endMs: number) => [
      {
        id: "1111111111111111",
        traceId: "22222222222222222222222222222222",
        name: "claude interaction",
        kind: "span" as const,
        startMs: start,
        endMs,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "3333333333333333",
        parentId: "1111111111111111",
        traceId: "22222222222222222222222222222222",
        name: "model claude-sonnet-4-5",
        kind: "generation" as const,
        startMs: start,
        endMs,
        model: "claude-sonnet-4-5",
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        inferred: true,
      },
    ];
    let spans = turn(start + 1_000);
    let listed = [session()];
    const exporter = new OtelSessionsExporter({
      config: () => config,
      load: async () => listed,
      trace: async () => spans,
      now: () => Date.parse("2026-03-04T05:00:00.000Z"),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await exporter.poll();
    await exporter.poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    spans = turn(start + 2_000);
    listed = [session({ last: "2026-03-04T05:20:00.000Z", messages: 14 })];
    await exporter.poll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    const root = sent.resourceSpans[0].scopeSpans[0].spans[0];
    expect(root.name).toBe("claude interaction");
    expect(root.kind).toBe(1);
    const attributes = attributesOf(root);
    expect(attributes["langfuse.session.id"]).toBe(`claude:${session().id}`);
    expect(attributes["neolix.timing.source"]).toBe("recorded");
  });

  it("sends a session once, then again only when it grew", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    let listed = [session()];
    const exporter = new OtelSessionsExporter({
      config: () => config,
      load: async () => listed,
      now: () => Date.parse("2026-03-04T05:00:00.000Z"),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await exporter.poll();
    await exporter.poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    listed = [session({ last: "2026-03-04T05:20:00.000Z", messages: 14 })];
    await exporter.poll();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://collector.example/v1/traces");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
  });

  it("leaves out sessions that ended before exporting was on", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const exporter = new OtelSessionsExporter({
      config: () => config,
      load: async () => [session()],
      now: () => Date.parse("2026-04-01T00:00:00.000Z"),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await exporter.poll();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips gateway-only sessions and does nothing while off", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    let enabled = false;
    const exporter = new OtelSessionsExporter({
      config: () => ({ ...config, enabled, sessions: enabled }),
      load: async () => [session({ gateway: true })],
      now: () => 0,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await exporter.poll();
    enabled = true;
    const now = Date.parse("2026-03-01T00:00:00.000Z");
    const turnedOn = new OtelSessionsExporter({
      config: () => ({ ...config, enabled, sessions: enabled }),
      load: async () => [session({ gateway: true })],
      now: () => now,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await turnedOn.poll();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a body only when content is on", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const bodies = vi.fn(async () => ({ input: "hello", output: "hi" }));
    const exporter = new OtelSessionsExporter({
      config: () => ({ ...config, bodies: true }),
      load: async () => [session()],
      bodies,
      now: () => Date.parse("2026-03-04T05:00:00.000Z"),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await exporter.poll();
    expect(bodies).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    const attributes = attributesOf(sent.resourceSpans[0].scopeSpans[0].spans[0]);
    expect(attributes["langfuse.observation.input"]).toBe("hello");
  });
});
