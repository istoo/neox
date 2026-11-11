// Synara automations backed by the Neox scheduler.
//
// Neox schedules are cron/every jobs attached to an agent (or a fresh agent per run). Synara
// models the same idea as an automation definition plus its run log, so this module translates
// both ways: schedule -> definition/run, automation input -> schedule create/update. Fields the
// daemon has no home for (memory, proposals, manual/once/project-event schedules, read/archive
// flags on runs) answer with a typed "not supported" error instead of inventing state; the web
// hides the run read/archive actions (NEOLIX_AUTOMATION_RUN_TRIAGE_ENABLED).
//
// Neox has no schedule change push event, so `automation.subscribe` replays a snapshot when a
// client attaches and publishes another after every mutation made through this bridge.
import {
  type AutomationCreateInput,
  type AutomationDefinition,
  type AutomationListInput,
  type AutomationListResult,
  type AutomationRun,
  type AutomationRunNowResult,
  type AutomationSchedule,
  type AutomationStreamEvent,
  type AutomationUpdateInput,
  type ModelSelection,
  type ProviderKind,
  type RuntimeMode,
  WS_METHODS,
} from "@synara/contracts";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import { bridgeError, fromPromise } from "./rpcErrors.ts";
import { notSupported, type AnyHandler } from "./stubs.ts";

interface NeolixScheduleRun {
  readonly id: string;
  readonly scheduledFor: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly status: "running" | "succeeded" | "failed";
  readonly agentId: string | null;
  readonly output: string | null;
  readonly error: string | null;
}

interface NeolixSchedule {
  readonly id: string;
  readonly name: string | null;
  readonly prompt: string;
  readonly cadence:
    | { readonly type: "every"; readonly everyMs: number }
    | { readonly type: "cron"; readonly expression: string; readonly timezone?: string };
  readonly target:
    | {
        readonly type: "new-agent";
        readonly config: {
          readonly provider: string;
          readonly cwd: string;
          readonly model?: string;
          readonly modeId?: string;
          readonly thinkingOptionId?: string;
          readonly isolation?: "local" | "worktree";
          readonly title?: string | null;
        };
      }
    | { readonly type: "agent"; readonly agentId: string }
    | { readonly type: "self"; readonly agentId: string };
  readonly status: "active" | "paused" | "completed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly pausedAt: string | null;
  readonly expiresAt: string | null;
  readonly maxRuns: number | null;
  /** Present on inspect/update/run-once responses. */
  readonly runs?: ReadonlyArray<NeolixScheduleRun>;
}

interface CreateScheduleInput {
  readonly prompt: string;
  readonly name?: string | null;
  readonly cadence:
    | { readonly type: "every"; readonly everyMs: number }
    | { readonly type: "cron"; readonly expression: string; readonly timezone?: string };
  readonly target:
    | {
        readonly type: "agent";
        readonly agentId: string;
      }
    | {
        readonly type: "new-agent";
        readonly config: {
          readonly provider: string;
          readonly cwd: string;
          readonly model?: string;
          readonly modeId?: string;
          readonly thinkingOptionId?: string;
          readonly isolation?: "local" | "worktree";
          readonly title?: string | null;
          readonly providerOptions?: unknown;
        };
      };
  readonly maxRuns?: number;
  readonly expiresAt?: string;
  readonly runOnCreate?: boolean;
}

interface UpdateScheduleInput {
  readonly id: string;
  readonly name?: string | null;
  readonly prompt?: string;
  readonly cadence?:
    | { readonly type: "every"; readonly everyMs: number }
    | { readonly type: "cron"; readonly expression: string; readonly timezone?: string };
  readonly newAgentConfig?: {
    readonly provider?: string;
    readonly model?: string | null;
    readonly modeId?: string | null;
    readonly thinkingOptionId?: string | null;
    readonly isolation?: "local" | "worktree";
    readonly cwd?: string;
  };
  readonly maxRuns?: number | null;
  readonly expiresAt?: string | null;
}

interface ScheduleResponse {
  readonly schedule?: NeolixSchedule | null;
  readonly schedules?: ReadonlyArray<NeolixSchedule>;
  readonly runs?: ReadonlyArray<NeolixScheduleRun>;
  readonly error: string | null;
}

function fromSubscription<A>(subscribe: (emit: (item: A) => void) => () => void): Stream.Stream<A> {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((item) => Queue.offerUnsafe(queue, item))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
}

/** Accepts the daemon's provider names and the contract's provider ids. */
const PROVIDER_KIND_BY_NAME: Readonly<Record<string, ProviderKind>> = {
  claude: "claudeAgent",
  claudeagent: "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  antigravity: "antigravity",
  grok: "grok",
  droid: "droid",
  opencode: "opencode",
  pi: "pi",
  omp: "omp",
  devin: "devin",
};

function toProviderKind(provider: string | undefined): ProviderKind {
  return PROVIDER_KIND_BY_NAME[(provider ?? "").trim().toLowerCase()] ?? "claudeAgent";
}

function toNeolixProvider(kind: ProviderKind): string {
  return kind === "claudeAgent" ? "claude" : kind;
}

function iso(value: string | null | undefined, fallback?: string): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return fallback ?? new Date().toISOString();
}

function trimmedOrNull(value: string | null | undefined, maxLength: number): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 160) || "Automation";
}

function modelSelectionFor(provider: string, model: string | null | undefined): ModelSelection {
  return {
    provider: toProviderKind(provider),
    model: model?.trim() || "default",
  } as ModelSelection;
}

/** The bridge's project shells carry the daemon root; schedules only carry a cwd. */
function projectIdForCwd(model: BridgeModel, cwd: string | null | undefined): string | null {
  const normalized = cwd?.trim().replace(/\/+$/, "");
  if (!normalized) return null;
  const projects = model.shellSnapshot().projects;
  let best: { id: string; root: string } | null = null;
  for (const project of projects) {
    const root = project.workspaceRoot.replace(/\/+$/, "");
    if (normalized !== root && !normalized.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.root.length) best = { id: project.id, root };
  }
  return best?.id ?? null;
}

function targetCwd(model: BridgeModel, schedule: NeolixSchedule): string | null {
  if (schedule.target.type === "new-agent") return schedule.target.config.cwd;
  const agent = model.entry(schedule.target.agentId)?.agent;
  return agent?.cwd ?? null;
}

/**
 * The daemon keeps cron/every cadences only. Synara's calendar schedules are expressed as cron
 * expressions, which is exactly how the app's own form serializes them.
 */
function toAutomationSchedule(cadence: NeolixSchedule["cadence"]): AutomationSchedule | null {
  if (cadence.type === "every") {
    const everySeconds = Math.max(1, Math.round(cadence.everyMs / 1000));
    return { type: "interval", everySeconds };
  }
  const expression = cadence.expression.trim();
  if (!expression) return null;
  const timezone = cadence.timezone?.trim() || "UTC";
  return calendarScheduleFromCron(expression, timezone) ?? { type: "cron", expression, timezone };
}

/**
 * Inverse of `cadenceFromAutomationSchedule` for the calendar kinds: the form saves
 * daily/weekdays/weekly as `M H * * *` / `M H * * 1-5` / `M H * * D`, so reading those back as
 * raw cron would turn "Daily 9:00" into "Cron 0 9 * * *" after the first save.
 */
function calendarScheduleFromCron(expression: string, timezone: string): AutomationSchedule | null {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(expression.replace(/\s+/g, " "));
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const timeOfDay = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const day = match[3];
  if (day === "*") return { type: "daily", timeOfDay, timezone };
  if (day === "1-5") return { type: "weekdays", timeOfDay, timezone };
  return { type: "weekly", dayOfWeek: Number(day), timeOfDay, timezone };
}

function cronFromTimeOfDay(timeOfDay: string): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(timeOfDay.trim());
  if (!match) return null;
  return `${Number(match[2])} ${Number(match[1])}`;
}

function cadenceFromAutomationSchedule(
  schedule: AutomationSchedule,
): CreateScheduleInput["cadence"] | null {
  switch (schedule.type) {
    case "interval":
      return { type: "every", everyMs: Math.max(1, schedule.everySeconds) * 1000 };
    case "cron":
      return {
        type: "cron",
        expression: schedule.expression.trim(),
        ...(schedule.timezone.trim() ? { timezone: schedule.timezone.trim() } : {}),
      };
    case "daily": {
      const clock = cronFromTimeOfDay(schedule.timeOfDay);
      return clock
        ? {
            type: "cron",
            expression: `${clock} * * *`,
            ...(schedule.timezone?.trim() ? { timezone: schedule.timezone.trim() } : {}),
          }
        : null;
    }
    case "weekdays": {
      const clock = cronFromTimeOfDay(schedule.timeOfDay);
      return clock
        ? {
            type: "cron",
            expression: `${clock} * * 1-5`,
            ...(schedule.timezone?.trim() ? { timezone: schedule.timezone.trim() } : {}),
          }
        : null;
    }
    case "weekly": {
      const clock = cronFromTimeOfDay(schedule.timeOfDay);
      return clock
        ? {
            type: "cron",
            expression: `${clock} * * ${schedule.dayOfWeek}`,
            ...(schedule.timezone?.trim() ? { timezone: schedule.timezone.trim() } : {}),
          }
        : null;
    }
    // manual / once / project-event have no Neox schedule cadence.
    case "manual":
    case "once":
    case "project-event":
      return null;
  }
}

function toDefinition(model: BridgeModel, schedule: NeolixSchedule): AutomationDefinition {
  const cwd = targetCwd(model, schedule);
  const projectId = projectIdForCwd(model, cwd) ?? cwd?.trim() ?? schedule.id;
  const targetAgentId = schedule.target.type === "new-agent" ? null : schedule.target.agentId;
  const targetEntry = targetAgentId ? model.entry(targetAgentId) : undefined;
  const provider =
    schedule.target.type === "new-agent"
      ? schedule.target.config.provider
      : (targetEntry?.agent.provider ?? "claude");
  const modelName =
    schedule.target.type === "new-agent"
      ? schedule.target.config.model
      : (targetEntry?.agent.model ?? null);
  const isolation = schedule.target.type === "new-agent" ? schedule.target.config.isolation : null;
  const now = new Date().toISOString();
  const paused = schedule.status === "paused";
  const completed = schedule.status === "completed";

  return {
    id: schedule.id as AutomationDefinition["id"],
    projectId: projectId as AutomationDefinition["projectId"],
    sourceThreadId: null,
    name: trimmedOrNull(schedule.name, 160) ?? titleFromPrompt(schedule.prompt),
    prompt: schedule.prompt,
    schedule: toAutomationSchedule(schedule.cadence) ?? {
      type: "cron",
      expression: "0 0 * * *",
      timezone: "UTC",
    },
    enabled: schedule.status === "active",
    nextRunAt: schedule.nextRunAt ? iso(schedule.nextRunAt) : null,
    modelSelection: modelSelectionFor(provider, modelName),
    runtimeMode: "approval-required" as RuntimeMode,
    interactionMode: "default",
    worktreeMode: isolation === "worktree" ? "worktree" : isolation === "local" ? "local" : "auto",
    mode: targetAgentId ? "heartbeat" : "standalone",
    targetThreadId: targetAgentId as AutomationDefinition["targetThreadId"],
    proposalState: null,
    notificationPolicy: "all",
    heartbeatCooldownSeconds: 60,
    maxIterations: schedule.maxRuns,
    stopAfterConsecutiveFailures: null,
    consecutiveFailureCount: 0,
    disabledReason: paused ? "user" : completed ? "schedule" : null,
    disabledAt: paused && schedule.pausedAt ? iso(schedule.pausedAt) : null,
    completionPolicy: { type: "none" },
    completionPolicyVersion: 0,
    completionPolicyUpdatedAt: "1970-01-01T00:00:00.000Z",
    minimumIntervalSeconds: 60,
    maxRuntimeSeconds: 60 * 60,
    retryPolicy: { type: "none" },
    misfirePolicy: "coalesce",
    acknowledgedRisks: [],
    iterationCount: schedule.runs?.length ?? 0,
    managedByProject: false,
    createdAt: iso(schedule.createdAt, now),
    updatedAt: iso(schedule.updatedAt, now),
    archivedAt: completed ? iso(schedule.updatedAt, now) : null,
  };
}

function toRun(
  model: BridgeModel,
  run: NeolixScheduleRun,
  definition: AutomationDefinition,
): AutomationRun {
  const status = (
    run.status === "running" ? "running" : run.status === "succeeded" ? "succeeded" : "failed"
  ) as AutomationRun["status"];
  const scheduledFor = iso(run.scheduledFor, definition.createdAt);
  const startedAt = iso(run.startedAt, scheduledFor);
  return {
    id: run.id as AutomationRun["id"],
    automationId: definition.id,
    projectId: definition.projectId,
    threadId: run.agentId as AutomationRun["threadId"],
    turnId: null,
    trigger: { type: "scheduled" },
    status,
    scheduledFor,
    deferredUntil: null,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    startedAt,
    finishedAt: run.endedAt ? iso(run.endedAt) : null,
    threadCreateCommandId: null,
    turnStartCommandId: null,
    messageId: null,
    error: trimmedOrNull(run.error, 4_000),
    result: run.output
      ? {
          outcome: "unknown",
          summary: run.output.slice(0, 2_000),
          unread: false,
          archivedAt: null,
        }
      : null,
    permissionSnapshot: {
      provider: definition.modelSelection.provider,
      modelSelection: definition.modelSelection,
      runtimeMode: definition.runtimeMode,
      interactionMode: definition.interactionMode,
      worktreeMode: definition.worktreeMode,
      allowedCapabilities: [],
      createdAt: startedAt,
    },
    createdAt: scheduledFor,
    updatedAt: run.endedAt ? iso(run.endedAt) : startedAt,
  };
}

async function listAutomations(
  model: BridgeModel,
  filter?: {
    readonly projectId?: string | undefined;
    readonly includeArchived?: boolean | undefined;
  },
): Promise<AutomationListResult> {
  const client = model.client;
  const listed = (await client.scheduleList()) as unknown as ScheduleResponse;
  if (listed.error) {
    throw bridgeError("automation.list-failed", listed.error, { detail: listed.error });
  }
  const definitions: AutomationDefinition[] = [];
  const runs: AutomationRun[] = [];
  for (const schedule of listed.schedules ?? []) {
    const definition = toDefinition(model, schedule);
    if (filter?.projectId && definition.projectId !== filter.projectId) continue;
    // Completed schedules are the closest thing Neox has to an archived automation.
    if (!filter?.includeArchived && definition.archivedAt !== null) continue;
    definitions.push(definition);
    // Schedule list omits runs; the detail page needs them, so read the log per schedule.
    const logs = (await client.scheduleLogs({ id: schedule.id })) as unknown as ScheduleResponse;
    if (logs.error) continue;
    for (const run of logs.runs ?? []) runs.push(toRun(model, run, definition));
  }
  return { definitions, runs, memories: [] };
}

/**
 * A schedule run is one agent turn, so cancelling the run cancels that agent. The scheduler's own
 * run record lags the agent, so the returned run is marked cancelled here.
 */
async function cancelRun(model: BridgeModel, runId: string): Promise<{ run: AutomationRun }> {
  const { runs } = await listAutomations(model, { includeArchived: true });
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) {
    throw bridgeError("automation.run-not-found", `Automation run ${runId} was not found.`, {
      run: runId,
    });
  }
  if (run.status !== "running" || !run.threadId) return { run };
  await model.client.cancelAgent(run.threadId);
  return {
    run: {
      ...run,
      status: "cancelled",
      finishedAt: new Date().toISOString() as typeof run.finishedAt,
    },
  };
}

function requireProjectRoot(model: BridgeModel, projectId: string): string {
  const root = model.projectRoot(projectId);
  if (!root) {
    throw bridgeError("automation.unknown-project", `Unknown project ${projectId}.`, {
      project: projectId,
    });
  }
  return root;
}

function createInputFor(model: BridgeModel, input: AutomationCreateInput): CreateScheduleInput {
  if (input.mode === "dedicated") throw notSupported("automation.create mode dedicated");
  const cadence = cadenceFromAutomationSchedule(input.schedule);
  if (!cadence) throw notSupported(`automation.create schedule ${input.schedule.type}`);

  if (input.mode === "heartbeat") {
    const agentId = input.targetThreadId?.trim();
    if (!agentId) {
      throw bridgeError(
        "automation.heartbeat-target-required",
        "A heartbeat automation needs a target thread.",
      );
    }
    return {
      prompt: input.prompt,
      ...(input.name ? { name: input.name } : {}),
      cadence,
      target: { type: "agent", agentId },
      ...(typeof input.maxIterations === "number" ? { maxRuns: input.maxIterations } : {}),
    };
  }

  const cwd = requireProjectRoot(model, input.projectId);
  const isolation =
    input.worktreeMode === "worktree"
      ? "worktree"
      : input.worktreeMode === "local"
        ? "local"
        : undefined;
  return {
    prompt: input.prompt,
    ...(input.name ? { name: input.name } : {}),
    cadence,
    target: {
      type: "new-agent",
      config: {
        provider: toNeolixProvider(input.modelSelection.provider),
        cwd,
        ...(input.modelSelection.model && input.modelSelection.model !== "default"
          ? { model: input.modelSelection.model }
          : {}),
        ...(isolation ? { isolation } : {}),
        title: input.name ?? null,
      },
    },
    ...(typeof input.maxIterations === "number" ? { maxRuns: input.maxIterations } : {}),
  };
}

function updateInputFor(input: AutomationUpdateInput): UpdateScheduleInput {
  if (input.mode === "dedicated") throw notSupported("automation.update mode dedicated");
  const patch: {
    -readonly [K in keyof UpdateScheduleInput]: UpdateScheduleInput[K];
  } = { id: input.id };
  if (input.name !== undefined) patch.name = input.name;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.schedule !== undefined) {
    const cadence = cadenceFromAutomationSchedule(input.schedule);
    if (!cadence) throw notSupported(`automation.update schedule ${input.schedule.type}`);
    patch.cadence = cadence;
  }
  if (input.maxIterations !== undefined) patch.maxRuns = input.maxIterations;
  if (input.modelSelection) {
    patch.newAgentConfig = {
      provider: toNeolixProvider(input.modelSelection.provider),
      ...(input.modelSelection.model && input.modelSelection.model !== "default"
        ? { model: input.modelSelection.model }
        : {}),
    };
  }
  return patch;
}

class AutomationSessions {
  private readonly listeners = new Set<(event: AutomationStreamEvent) => void>();

  constructor(private readonly model: BridgeModel) {}

  subscribe(listener: (event: AutomationStreamEvent) => void): () => void {
    this.listeners.add(listener);
    void this.publish();
    return () => this.listeners.delete(listener);
  }

  async publish(): Promise<void> {
    try {
      const list = await listAutomations(this.model);
      const event: AutomationStreamEvent = { type: "snapshot", ...list };
      for (const listener of this.listeners) listener(event);
    } catch {
      // A refresh failure must not tear down the stream; the client keeps its last snapshot and
      // queries again on the next mutation.
    }
  }

  async create(input: AutomationCreateInput): Promise<AutomationDefinition> {
    const client = this.model.client;
    const created = (await client.scheduleCreate(
      createInputFor(this.model, input) as never,
    )) as unknown as ScheduleResponse;
    if (created.error) {
      throw bridgeError("automation.create-failed", created.error, { detail: created.error });
    }
    if (!created.schedule) {
      throw bridgeError("automation.schedule-missing", "The daemon did not create the schedule.");
    }
    let schedule = created.schedule;
    if (input.enabled === false) {
      const paused = (await client.schedulePause({
        id: schedule.id,
      })) as unknown as ScheduleResponse;
      if (paused.error) {
        throw bridgeError("automation.pause-failed", paused.error, { detail: paused.error });
      }
      schedule = paused.schedule ?? schedule;
    }
    await this.publish();
    return toDefinition(this.model, schedule);
  }

  async update(input: AutomationUpdateInput): Promise<AutomationDefinition> {
    const client = this.model.client;
    const inspected = (await client.scheduleInspect({
      id: input.id,
    })) as unknown as ScheduleResponse;
    if (inspected.error) {
      throw bridgeError("automation.inspect-failed", inspected.error, { detail: inspected.error });
    }
    const current = inspected.schedule;
    if (!current) {
      throw bridgeError("automation.unknown", `Unknown automation ${input.id}.`, {
        automation: input.id,
      });
    }
    const existing = toDefinition(this.model, current);
    // Neox cannot retarget a schedule; changing the continued thread would silently keep the
    // old target, so refuse instead of pretending the edit landed.
    if (input.targetThreadId !== undefined) {
      const currentTarget = current.target.type === "new-agent" ? null : current.target.agentId;
      if ((input.targetThreadId ?? null) !== currentTarget) {
        throw notSupported("automation.update targetThreadId");
      }
    }
    if (input.mode !== undefined && input.mode !== existing.mode) {
      throw notSupported("automation.update mode");
    }
    // These are Synara-side execution policies Neox schedules do not store. A changed value
    // would be silently lost, so reject it; unchanged values ride along with normal edits.
    const unsupported: ReadonlyArray<[string, unknown, unknown]> = [
      ["runtimeMode", input.runtimeMode, existing.runtimeMode],
      ["interactionMode", input.interactionMode, existing.interactionMode],
      ["worktreeMode", input.worktreeMode, existing.worktreeMode],
      ["notificationPolicy", input.notificationPolicy, existing.notificationPolicy],
      [
        "stopAfterConsecutiveFailures",
        input.stopAfterConsecutiveFailures,
        existing.stopAfterConsecutiveFailures,
      ],
      ["completionPolicy", input.completionPolicy, existing.completionPolicy],
      ["retryPolicy", input.retryPolicy, existing.retryPolicy],
      ["misfirePolicy", input.misfirePolicy, existing.misfirePolicy],
      ["minimumIntervalSeconds", input.minimumIntervalSeconds, existing.minimumIntervalSeconds],
      ["maxRuntimeSeconds", input.maxRuntimeSeconds, existing.maxRuntimeSeconds],
    ];
    for (const [field, next, previous] of unsupported) {
      if (next === undefined) continue;
      if (JSON.stringify(next) !== JSON.stringify(previous)) {
        throw notSupported(`automation.update ${field}`);
      }
    }
    // A heartbeat automation continues an existing agent, and the daemon update route cannot
    // change an agent target's provider/model.
    if (input.modelSelection && current.target.type !== "new-agent") {
      if (
        input.modelSelection.provider !== existing.modelSelection.provider ||
        input.modelSelection.model !== existing.modelSelection.model
      ) {
        throw notSupported("automation.update modelSelection for a continued thread");
      }
    }

    const patch = updateInputFor(input);
    let schedule: NeolixSchedule = current;
    if (Object.keys(patch).length > 1) {
      const updated = (await client.scheduleUpdate(patch as never)) as unknown as ScheduleResponse;
      if (updated.error) {
        throw bridgeError("automation.update-failed", updated.error, { detail: updated.error });
      }
      schedule = updated.schedule ?? schedule;
    }
    if (input.enabled !== undefined && input.enabled !== (schedule.status === "active")) {
      const result = input.enabled
        ? ((await client.scheduleResume({ id: input.id })) as unknown as ScheduleResponse)
        : ((await client.schedulePause({ id: input.id })) as unknown as ScheduleResponse);
      if (result.error) {
        throw bridgeError("automation.enablement-failed", result.error, {
          detail: result.error,
        });
      }
      schedule = result.schedule ?? schedule;
    }
    await this.publish();
    return toDefinition(this.model, schedule);
  }

  async remove(id: string): Promise<void> {
    const deleted = (await this.model.client.scheduleDelete({ id })) as unknown as {
      error: string | null;
    };
    if (deleted.error) {
      throw bridgeError("automation.delete-failed", deleted.error, { detail: deleted.error });
    }
    await this.publish();
  }

  async runNow(automationId: string): Promise<AutomationRunNowResult> {
    const client = this.model.client;
    const inspected = (await client.scheduleInspect({
      id: automationId,
    })) as unknown as ScheduleResponse;
    if (inspected.error) {
      throw bridgeError("automation.inspect-failed", inspected.error, { detail: inspected.error });
    }
    if (!inspected.schedule) {
      throw bridgeError("automation.unknown", `Unknown automation ${automationId}.`, {
        automation: automationId,
      });
    }
    const definition = toDefinition(this.model, inspected.schedule);

    const ran = (await client.scheduleRunOnce({ id: automationId })) as unknown as ScheduleResponse;
    if (ran.error) {
      throw bridgeError("automation.run-failed", ran.error, { detail: ran.error });
    }
    const run = ran.schedule?.runs?.at(-1) ?? ran.runs?.at(-1);
    if (!run) throw bridgeError("automation.run-missing", "The daemon did not create a run.");
    await this.publish();
    return { run: toRun(this.model, run, definition) };
  }
}

export function makeAutomationHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const sessions = new AutomationSessions(model);
  return {
    [WS_METHODS.automationList]: (payload) =>
      fromPromise("automation.list", () => listAutomations(model, payload as AutomationListInput)),

    // Neox schedules have no per-automation memory, proposal review, or per-run read/archive
    // state. Answer with a typed error so those affordances are disabled by the client.
    [WS_METHODS.automationGetMemory]: () =>
      Effect.fail(notSupported(WS_METHODS.automationGetMemory)),
    [WS_METHODS.automationResolveProposal]: () =>
      Effect.fail(notSupported(WS_METHODS.automationResolveProposal)),
    [WS_METHODS.automationCancelRun]: (payload) =>
      fromPromise("automation.cancelRun", async () => {
        const result = await cancelRun(model, String((payload as { runId: string }).runId));
        await sessions.publish();
        return result;
      }),
    [WS_METHODS.automationMarkRunRead]: () =>
      Effect.fail(notSupported(WS_METHODS.automationMarkRunRead)),
    [WS_METHODS.automationArchiveRun]: () =>
      Effect.fail(notSupported(WS_METHODS.automationArchiveRun)),

    [WS_METHODS.automationCreate]: (payload) =>
      fromPromise("automation.create", () => sessions.create(payload as AutomationCreateInput)),
    [WS_METHODS.automationUpdate]: (payload) =>
      fromPromise("automation.update", () => sessions.update(payload as AutomationUpdateInput)),
    [WS_METHODS.automationDelete]: (payload) =>
      fromPromise("automation.delete", () =>
        sessions.remove(String((payload as { id: string }).id)),
      ),
    [WS_METHODS.automationRunNow]: (payload) =>
      fromPromise("automation.runNow", () =>
        sessions.runNow(String((payload as { automationId: string }).automationId)),
      ),
    [WS_METHODS.subscribeAutomationEvents]: () =>
      fromSubscription<AutomationStreamEvent>((emit) => sessions.subscribe(emit)),
  };
}

export type { NeolixSchedule, NeolixScheduleRun, ScheduleResponse };
