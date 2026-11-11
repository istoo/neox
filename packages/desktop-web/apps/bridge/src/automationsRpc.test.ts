import {
  AutomationCancelRunResult,
  AutomationDefinition,
  AutomationListResult,
  AutomationRunNowResult,
  AutomationStreamEvent,
  WS_METHODS,
  type AutomationCreateInput,
} from "@synara/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeAutomationHandlers } from "./automationsRpc.ts";
import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";

const AT = "2026-11-08T00:00:00.000Z";
const LATER = "2026-11-09T00:00:00.000Z";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

interface FixtureSchedule {
  id: string;
  name: string;
  prompt: string;
  cadence:
    | { type: "cron"; expression: string; timezone: string }
    | { type: "every"; everyMs: number };
  target:
    | { type: "new-agent"; config: { provider: string; cwd: string } }
    | { type: "agent"; agentId: string }
    | { type: "self"; agentId: string };
  status: "active" | "paused" | "completed";
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pausedAt: string | null;
  expiresAt: string | null;
  maxRuns: number | null;
}

const baseSchedule: FixtureSchedule = {
  id: "sch_1",
  name: "Nightly review",
  prompt: "Review the repository",
  cadence: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
  target: { type: "new-agent", config: { provider: "claude", cwd: "/repo" } },
  status: "active",
  createdAt: AT,
  updatedAt: AT,
  nextRunAt: LATER,
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
};

const baseRun = {
  id: "run_1",
  scheduledFor: AT,
  startedAt: AT,
  endedAt: LATER,
  status: "succeeded" as const,
  agentId: "agent_1",
  output: "two findings",
  error: null,
};

function makeHarness(
  schedule: FixtureSchedule = baseSchedule,
  runStatus: "running" | "succeeded" = baseRun.status,
) {
  const calls: Array<[string, unknown]> = [];
  let current: FixtureSchedule = { ...schedule };
  const client = {
    scheduleList: async () => ({ requestId: "r", schedules: [current], error: null }),
    scheduleLogs: async (options: { id: string }) => {
      calls.push(["scheduleLogs", options]);
      return { requestId: "r", runs: [{ ...baseRun, status: runStatus }], error: null };
    },
    cancelAgent: async (agentId: string) => {
      calls.push(["cancelAgent", agentId]);
    },
    scheduleInspect: async () => ({
      requestId: "r",
      schedule: { ...current, runs: [baseRun] },
      error: null,
    }),
    scheduleCreate: async (options: unknown) => {
      calls.push(["scheduleCreate", options]);
      current = {
        ...current,
        id: "sch_new",
        prompt: (options as { prompt: string }).prompt,
        cadence: (options as { cadence: typeof baseSchedule.cadence }).cadence,
      };
      return { requestId: "r", schedule: current, error: null };
    },
    scheduleUpdate: async (options: unknown) => {
      calls.push(["scheduleUpdate", options]);
      current = { ...current, updatedAt: LATER };
      return { requestId: "r", schedule: { ...current, runs: [baseRun] }, error: null };
    },
    schedulePause: async (options: { id: string }) => {
      calls.push(["schedulePause", options]);
      current = { ...current, status: "paused", pausedAt: LATER };
      return { requestId: "r", schedule: current, error: null };
    },
    scheduleResume: async (options: { id: string }) => {
      calls.push(["scheduleResume", options]);
      current = { ...current, status: "active", pausedAt: null };
      return { requestId: "r", schedule: current, error: null };
    },
    scheduleDelete: async (options: { id: string }) => {
      calls.push(["scheduleDelete", options]);
      return { requestId: "r", scheduleId: options.id, error: null };
    },
    scheduleRunOnce: async (options: { id: string }) => {
      calls.push(["scheduleRunOnce", options]);
      return { requestId: "r", schedule: { ...current, runs: [baseRun] }, error: null };
    },
  };
  const model = {
    client,
    shellSnapshot: () => ({
      projects: [{ id: "prj_1", workspaceRoot: "/repo" }],
    }),
    projectRoot: (projectId: string) => (projectId === "prj_1" ? "/repo" : undefined),
    entry: (threadId: string) =>
      threadId === "agent_1"
        ? { agent: { provider: "claude", model: "sonnet", cwd: "/repo" } }
        : undefined,
  } as unknown as BridgeModel;
  return { handlers: makeAutomationHandlers(model), calls, client };
}

function createInput(overrides: Partial<AutomationCreateInput>): AutomationCreateInput {
  return {
    projectId: "prj_1",
    name: "Interval task",
    prompt: "Do the thing",
    schedule: { type: "interval", everySeconds: 300 },
    modelSelection: { provider: "claudeAgent", model: "sonnet" },
    worktreeMode: "auto",
    mode: "standalone",
    runtimeMode: "approval-required",
    interactionMode: "default",
    enabled: true,
    ...overrides,
  } as AutomationCreateInput;
}

describe("automationsRpc list", () => {
  it("maps a Neox cron schedule and its run log", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<AutomationListResult>(handlers[WS_METHODS.automationList], {});
    const encoded = encode(AutomationListResult, result) as AutomationListResult;
    expect(encoded.definitions).toHaveLength(1);
    expect(encoded.definitions[0]).toMatchObject({
      id: "sch_1",
      projectId: "prj_1",
      name: "Nightly review",
      schedule: { type: "daily", timeOfDay: "09:00", timezone: "UTC" },
      enabled: true,
      mode: "standalone",
      targetThreadId: null,
    });
    expect(encoded.runs[0]).toMatchObject({
      id: "run_1",
      automationId: "sch_1",
      projectId: "prj_1",
      threadId: "agent_1",
      status: "succeeded",
    });
    expect(calls).toEqual([["scheduleLogs", { id: "sch_1" }]]);
  });

  it("reads calendar cron back as its calendar kind and keeps other cron as cron", async () => {
    const cases = [
      ["30 8 * * 1-5", { type: "weekdays", timeOfDay: "08:30", timezone: "Asia/Shanghai" }],
      [
        "5 17 * * 0",
        { type: "weekly", dayOfWeek: 0, timeOfDay: "17:05", timezone: "Asia/Shanghai" },
      ],
      [
        "*/15 9-17 * * 1-5",
        { type: "cron", expression: "*/15 9-17 * * 1-5", timezone: "Asia/Shanghai" },
      ],
      ["0 9 1 * *", { type: "cron", expression: "0 9 1 * *", timezone: "Asia/Shanghai" }],
    ] as const;
    for (const [expression, schedule] of cases) {
      const { handlers } = makeHarness({
        ...baseSchedule,
        cadence: { type: "cron", expression, timezone: "Asia/Shanghai" },
      });
      const result = await run<AutomationListResult>(handlers[WS_METHODS.automationList], {});
      const encoded = encode(AutomationListResult, result) as AutomationListResult;
      expect(encoded.definitions[0]?.schedule).toEqual(schedule);
    }
  });

  it("maps an agent-target schedule to a heartbeat automation", async () => {
    const { handlers } = makeHarness({
      ...baseSchedule,
      target: { type: "agent", agentId: "agent_1" },
    });
    const result = await run<AutomationListResult>(handlers[WS_METHODS.automationList], {});
    const encoded = encode(AutomationListResult, result) as AutomationListResult;
    expect(encoded.definitions[0]).toMatchObject({
      mode: "heartbeat",
      targetThreadId: "agent_1",
      modelSelection: { provider: "claudeAgent", model: "sonnet" },
    });
  });
});

describe("automationsRpc create", () => {
  it("creates a standalone schedule as a new agent and keeps the interval cadence", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<AutomationDefinition>(
      handlers[WS_METHODS.automationCreate],
      createInput({}),
    );
    const encoded = encode(AutomationDefinition, result) as AutomationDefinition;
    expect(encoded.id).toBe("sch_new");
    const call = calls.find(([name]) => name === "scheduleCreate")?.[1] as {
      cadence: unknown;
      target: unknown;
    };
    expect(call.cadence).toEqual({ type: "every", everyMs: 300_000 });
    expect(call.target).toEqual({
      type: "new-agent",
      config: {
        provider: "claude",
        cwd: "/repo",
        model: "sonnet",
        title: "Interval task",
      },
    });
  });

  it("serializes a daily calendar schedule as cron", async () => {
    const { handlers, calls } = makeHarness();
    await run<AutomationDefinition>(
      handlers[WS_METHODS.automationCreate],
      createInput({
        schedule: { type: "daily", timeOfDay: "08:30", timezone: "Asia/Shanghai" },
      }),
    );
    const call = calls.find(([name]) => name === "scheduleCreate")?.[1] as { cadence: unknown };
    expect(call.cadence).toEqual({
      type: "cron",
      expression: "30 8 * * *",
      timezone: "Asia/Shanghai",
    });
  });

  it("rejects schedule kinds the daemon cannot run", async () => {
    const { handlers } = makeHarness();
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.automationCreate]!(
          createInput({ schedule: { type: "manual" } }),
          {},
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.automationCreate]!(
          createInput({
            mode: "dedicated",
            targetThreadId: "agent_1" as AutomationCreateInput["targetThreadId"],
          }),
          {},
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
  });
});

describe("automationsRpc update and runNow", () => {
  it("pauses the schedule when the patch disables it", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<AutomationDefinition>(handlers[WS_METHODS.automationUpdate], {
      id: "sch_1",
      enabled: false,
    });
    const encoded = encode(AutomationDefinition, result) as AutomationDefinition;
    expect(encoded.enabled).toBe(false);
    expect(encoded.disabledReason).toBe("user");
    expect(calls).toContainEqual(["schedulePause", { id: "sch_1" }]);
  });

  it("returns the run created by runNow", async () => {
    const { handlers } = makeHarness();
    const result = await run<AutomationRunNowResult>(handlers[WS_METHODS.automationRunNow], {
      automationId: "sch_1",
    });
    const encoded = encode(AutomationRunNowResult, result) as AutomationRunNowResult;
    expect(encoded.run).toMatchObject({ id: "run_1", automationId: "sch_1" });
  });

  it("refuses to retarget a heartbeat automation", async () => {
    const { handlers } = makeHarness({
      ...baseSchedule,
      target: { type: "agent", agentId: "agent_1" },
    });
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.automationUpdate]!(
          { id: "sch_1", targetThreadId: "agent_2" },
          {},
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
  });

  it("cancels a running run by cancelling its agent", async () => {
    const { handlers, calls } = makeHarness(baseSchedule, "running");
    const result = await run<AutomationCancelRunResult>(handlers[WS_METHODS.automationCancelRun], {
      runId: "run_1",
    });
    const encoded = encode(AutomationCancelRunResult, result) as AutomationCancelRunResult;
    expect(encoded.run).toMatchObject({ id: "run_1", status: "cancelled" });
    expect(calls).toContainEqual(["cancelAgent", "agent_1"]);
  });

  it("reports memory as unsupported", async () => {
    const { handlers } = makeHarness();
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.automationGetMemory]!({ automationId: "sch_1" }, {}) as Effect.Effect<
          unknown,
          never
        >,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
  });
});

describe("automationsRpc subscribe", () => {
  it("replays a snapshot when a client attaches", async () => {
    const { handlers } = makeHarness();
    const stream = handlers[WS_METHODS.subscribeAutomationEvents]!(
      {},
      {},
    ) as Stream.Stream<AutomationStreamEvent>;
    const events = [...(await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))))];
    const encoded = encode(AutomationStreamEvent, events[0]) as AutomationStreamEvent;
    expect(encoded.type).toBe("snapshot");
    if (encoded.type === "snapshot") {
      expect(encoded.definitions).toHaveLength(1);
      expect(encoded.runs).toHaveLength(1);
    }
  });
});
