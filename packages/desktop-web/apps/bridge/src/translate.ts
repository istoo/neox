// Pure Neox → Synara read-model translation. No I/O here, so the shapes are unit-tested
// against the contract schemas (translate.test.ts).
import * as path from "node:path";
import type {
  ChatAttachment,
  ChatReviewComment,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
  ProviderKind,
  RuntimeMode,
  UserInputQuestion,
} from "@synara/contracts";

import type {
  FetchAgentTimelinePayload,
  FetchAgentsEntry,
} from "../../../../client/dist/daemon-client.js";
import { driverForProvider, instanceIdForProvider } from "./providers.ts";

export type NeolixAgent = FetchAgentsEntry["agent"];
export type NeolixAgentProject = FetchAgentsEntry["project"];
export type NeolixTimelineEntry = FetchAgentTimelinePayload["entries"][number];

export interface NeolixProject {
  readonly projectId: string;
  readonly projectDisplayName: string;
  readonly projectRootPath: string;
}

// Synara's ids, models, and timestamps are branded strings; the bridge mints them from Neox
// values that already satisfy the underlying "trimmed, non-empty" check.
// oxlint-disable-next-line typescript/no-explicit-any -- brand casts only
const brand = <T>(value: string): T => value as any as T;

/**
 * The project registered at the host's home folder is the client's Home chat container
 * (`kind: "chat"`), which lists project-less chats instead of appearing as a project.
 */
export function toProjectShell(
  project: NeolixProject,
  at: string,
  homeDir?: string,
  isPinned = false,
): OrchestrationProjectShell {
  const isHome =
    homeDir !== undefined && path.resolve(project.projectRootPath) === path.resolve(homeDir);
  return {
    id: brand(project.projectId),
    kind: isHome ? "chat" : "project",
    title: brand(project.projectDisplayName.trim() || project.projectRootPath),
    workspaceRoot: brand(project.projectRootPath),
    defaultModelSelection: null,
    scripts: [],
    isPinned,
    spaceId: null,
    additionalFolders: [],
    createdAt: at,
    updatedAt: at,
  };
}

const PROVIDER_KIND: Record<string, ProviderKind> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
  pi: "pi",
  antigravity: "antigravity",
  cursor: "cursor",
  grok: "grok",
  droid: "droid",
  devin: "devin",
};

/**
 * The Synara driver for an agent: its own provider's, else the provider its sessions run on
 * (gateway agents record it in persistence metadata), else Claude's.
 */
export function toProviderKind(agent: NeolixAgent): ProviderKind {
  const direct = PROVIDER_KIND[agent.provider];
  if (direct) return direct;
  const hosted = (agent.persistence?.metadata as { provider?: unknown } | undefined)?.provider;
  if (typeof hosted === "string" && PROVIDER_KIND[hosted]) return PROVIDER_KIND[hosted];
  return driverForProvider(agent.provider);
}

/** The fast/slow toggle a provider advertises, if it has one. */
function fastModeEnabled(agent: NeolixAgent): boolean | undefined {
  const features = (agent.features ?? []) as ReadonlyArray<{
    id: string;
    type: string;
    value?: unknown;
    options?: ReadonlyArray<{ id: string; label: string }>;
  }>;
  const toggle = features.find(
    (feature) => feature.id === "fast_mode" && feature.type === "toggle",
  );
  if (toggle) return toggle.value === true;
  const tier = features.find(
    (feature) => feature.id === "service_tier" && feature.type === "select",
  );
  if (!tier || typeof tier.value !== "string") return undefined;
  const selected = tier.options?.find((option) => option.id === tier.value);
  return selected ? /fast/i.test(selected.label) : tier.value !== "default";
}

/**
 * The composer traits Synara keeps on `modelSelection.options`, rebuilt from the Neox values
 * the agent reports. Absent fields mean "provider default" and are left out, so the picker shows
 * the provider's own default rather than a fabricated choice.
 */
function toModelSelectionOptions(agent: NeolixAgent): Record<string, unknown> | undefined {
  const provider = toProviderKind(agent);
  const thinking =
    agent.effectiveThinkingOptionId ??
    agent.thinkingOptionId ??
    agent.runtimeInfo?.thinkingOptionId ??
    null;
  const options: Record<string, unknown> = {};
  if (thinking && thinking !== "default") {
    switch (provider) {
      case "claudeAgent":
        if (thinking === "off") options.thinking = false;
        else {
          options.thinking = true;
          // Neox has no prompt-prefix "Ultrathink"; max effort is its closest equivalent.
          options.effort = thinking === "ultrathink" ? "max" : thinking;
        }
        break;
      case "pi":
      case "omp":
        options.thinkingLevel = thinking;
        break;
      case "opencode":
        break;
      default:
        options.reasoningEffort = thinking;
        break;
    }
  }
  // Only these drivers' model-selection options carry a fast toggle; putting it on another
  // provider's selection would fail the contract's per-provider union.
  const fast = fastModeEnabled(agent);
  if (fast !== undefined && ["claudeAgent", "codex", "cursor", "devin"].includes(provider)) {
    options.fastMode = fast;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Neox permission modes → Synara's runtime modes; the reverse of `modeIdFor` in commands.ts.
 * Codex's `auto` is its asking tier, told apart from Claude's classifier `auto` by the
 * `auto-review` tier only Codex offers, or by the provider when the daemon has not loaded the
 * agent and so lists no modes.
 */
export function toRuntimeMode(
  modeId: string | null | undefined,
  availableModes: readonly { readonly id: string }[] = [],
  provider?: string,
): RuntimeMode {
  if (
    modeId === "bypassPermissions" ||
    modeId === "full-access" ||
    modeId === "allow-all" ||
    modeId === "full"
  )
    return "full-access";
  // acceptEdits is its own edit-only tier, not the classifier-backed auto mode; keeping them
  // separate lets the composer show which one the provider is actually in.
  if (modeId === "acceptEdits") return "accept-edits";
  if (modeId === "auto-review") return "auto";
  const codexTiers =
    availableModes.length > 0
      ? availableModes.some((mode) => mode.id === "auto-review")
      : provider !== undefined && driverForProvider(provider) === "codex";
  if (modeId === "auto" && !codexTiers) return "auto";
  return "approval-required";
}

const PLAN_MODE_IDS = new Set([
  "plan",
  "https://agentclientprotocol.com/protocol/session-modes#plan",
]);

/** Codex plans through this toggle feature instead of a mode. */
export const PLAN_FEATURE_ID = "plan_mode";

/** The daemon's marker for a turn failure recorded as an assistant message (agent-manager.ts). */
const SYSTEM_ERROR_PREFIX = "[System Error]";

/**
 * A readable cause from a provider failure. Providers pass the HTTP status and raw response body
 * through (`401 {"type":"error","error":{"type":"authentication_error","message":"…"}} (…)`);
 * the status, error type and message are what a person needs, the request id and JSON are not.
 */
export function systemErrorCause(raw: string): string {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return text;
  let body: unknown;
  try {
    body = JSON.parse(text.slice(start, end + 1));
  } catch {
    return text;
  }
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const inner =
    record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : record;
  const message = typeof inner.message === "string" ? inner.message.trim() : "";
  if (!message) return text;
  const status = /^\d{3}\b/.exec(text)?.[0];
  const type = typeof inner.type === "string" && inner.type !== "error" ? inner.type : null;
  const prefix = [status, type].filter(Boolean).join(" ");
  return prefix ? `${prefix}: ${message}` : message;
}

interface PlanningState {
  readonly currentModeId?: string | null | undefined;
  readonly features?:
    | ReadonlyArray<{ readonly id: string; readonly type: string; readonly value?: unknown }>
    | undefined;
}

/** Whether the agent is planning, through a plan mode or (Codex) the plan toggle. */
export function toInteractionMode(agent: PlanningState): "plan" | "default" {
  if (PLAN_MODE_IDS.has(agent.currentModeId ?? "")) return "plan";
  const toggle = agent.features?.find(
    (feature) => feature.id === PLAN_FEATURE_ID && feature.type === "toggle",
  );
  return toggle?.value === true ? "plan" : "default";
}

function toSessionStatus(status: string): OrchestrationSession["status"] {
  switch (status) {
    case "running":
      return "running";
    case "initializing":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    default:
      return "ready";
  }
}

export function turnIdFor(agentId: string, userSeq: number): string {
  return `turn:${agentId}:${userSeq}`;
}

/** Server-owned thread metadata the bridge folds in: workspace pin, subagent labels, PR badge. */
export interface ThreadShellExtras {
  readonly isPinned?: boolean;
  readonly lastKnownPr?: OrchestrationThreadShell["lastKnownPr"];
}

const LABEL_PARENT_AGENT_ID = "neolix.parent-agent-id";
const LABEL_SUBAGENT_AGENT_ID = "neolix.subagent-agent-id";
const LABEL_SUBAGENT_NICKNAME = "neolix.subagent-nickname";
const LABEL_SUBAGENT_ROLE = "neolix.subagent-role";
/**
 * When the user marked the thread done (ISO time; empty once restored). An agent label so
 * every client and a bridge restart see it; labels cannot be deleted, only overwritten.
 */
export const LABEL_SETTLED_AT = "neox.settled-at";

/** A non-empty string label, or null. */
function stringLabel(
  labels: Readonly<Record<string, string>> | undefined,
  key: string,
): string | null {
  const value = labels?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** A label holding a timestamp, normalized to ISO; anything unparseable reads as unset. */
function isoLabel(
  labels: Readonly<Record<string, string>> | undefined,
  key: string,
): string | null {
  const value = stringLabel(labels, key);
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function toThreadShell(
  entry: FetchAgentsEntry,
  latestTurn: OrchestrationLatestTurn | null,
  extras: ThreadShellExtras = {},
): OrchestrationThreadShell {
  const { agent, project } = entry;
  const labels = agent.labels as Readonly<Record<string, string>> | undefined;
  const parentThreadId = stringLabel(labels, LABEL_PARENT_AGENT_ID);
  const checkout = project?.checkout;
  const runtimeMode = toRuntimeMode(
    agent.currentModeId,
    agent.availableModes ?? [],
    agent.provider,
  );
  const instanceId = instanceIdForProvider(agent.provider);
  const model = agent.model?.trim() || agent.runtimeInfo?.model?.trim() || "default";
  const options = toModelSelectionOptions(agent);
  const pendingPermissions = (agent.pendingPermissions ?? []) as unknown as NeolixPermission[];
  return {
    id: brand(agent.id),
    projectId: brand(project?.projectKey ?? `cwd:${agent.cwd}`),
    title: brand(agent.title?.trim() || "New chat"),
    // oxlint-disable-next-line typescript/no-explicit-any -- provider-specific union, validated by tests
    modelSelection: {
      provider: toProviderKind(agent),
      model,
      instanceId,
      ...(options ? { options } : {}),
    } as any,
    runtimeMode,
    interactionMode: toInteractionMode(agent as PlanningState),
    envMode: checkout?.isNeolixOwnedWorktree ? "worktree" : "local",
    branch: checkout?.currentBranch?.trim() ? brand(checkout.currentBranch) : null,
    worktreePath:
      checkout?.isNeolixOwnedWorktree && checkout.worktreeRoot
        ? brand(checkout.worktreeRoot)
        : null,
    workingDirectory: agent.cwd ? brand(agent.cwd) : null,
    neolixWorkspaceId: agent.workspaceId?.trim() ? brand(agent.workspaceId.trim()) : null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: extras.isPinned === true,
    parentThreadId: parentThreadId ? brand(parentThreadId) : null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: stringLabel(labels, LABEL_SUBAGENT_AGENT_ID),
    subagentNickname: stringLabel(labels, LABEL_SUBAGENT_NICKNAME),
    subagentRole: stringLabel(labels, LABEL_SUBAGENT_ROLE),
    forkSourceThreadId: null,
    lastKnownPr: extras.lastKnownPr ?? null,
    latestTurn,
    latestUserMessageAt: agent.lastUserMessageAt ?? null,
    // A prompt after settledAt reopens a done thread; unopened threads have no messages to
    // derive this from, so it comes from the daemon.
    latestHumanMessageAt: agent.lastUserMessageAt ?? null,
    // A question is answered through the composer's user-input card, not an approval card.
    hasPendingApprovals: pendingPermissions.some((permission) => permission.kind !== "question"),
    hasPendingUserInput: pendingPermissions.some((permission) => permission.kind === "question"),
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    archivedAt: agent.archivedAt ?? null,
    settledAt: isoLabel(labels, LABEL_SETTLED_AT),
    snoozedUntil: null,
    snoozeReminderAt: null,
    handoff: null,
    session: {
      threadId: brand(agent.id),
      status: toSessionStatus(agent.status),
      // The front end reads the provider kind from providerName and treats any other value
      // as its default provider, so this is the Synara kind, not the Neox provider name.
      providerName: toProviderKind(agent),
      providerInstanceId: brand(instanceId),
      runtimeMode,
      activeTurnId: latestTurn?.state === "running" ? latestTurn.turnId : null,
      // The same wording the turn's failure card uses, so the client shows one, not both.
      lastError: agent.lastError?.trim() ? systemErrorCause(agent.lastError) : null,
      updatedAt: agent.updatedAt,
    },
  } as OrchestrationThreadShell;
}

interface ToolItem {
  readonly type: "tool_call";
  readonly callId: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed" | "canceled";
  readonly error: unknown;
  readonly detail: { readonly type: string } & Record<string, unknown>;
  /** Provider bookkeeping the daemon keeps on the item (e.g. a task notification's ids). */
  readonly metadata?: Record<string, unknown>;
}

const TOOL_ITEM_TYPE: Record<string, string> = {
  shell: "command_execution",
  edit: "file_change",
  write: "file_change",
  read: "dynamic_tool_call",
  search: "web_search",
  fetch: "web_search",
  sub_agent: "collab_agent_tool_call",
};

function toolTitle(tool: ToolItem): string {
  const d = tool.detail;
  switch (d.type) {
    case "shell":
      return String(d.command ?? tool.name);
    case "read":
      // A read is a dynamic tool call, whose title the web treats as an MCP-style identifier and
      // re-cases on `-`/`_`; the file shows as the row's file chip (data.input.file_path) instead.
      return tool.name;
    case "edit":
    case "write":
      return `${tool.name} ${String(d.filePath ?? "")}`.trim();
    case "search":
      return `${tool.name} ${String(d.query ?? "")}`.trim();
    case "fetch":
      return `${tool.name} ${String(d.url ?? "")}`.trim();
    case "sub_agent":
      return String(d.description ?? d.subAgentType ?? tool.name);
    default:
      return tool.name;
  }
}

function toolDetail(tool: ToolItem): string | undefined {
  const d = tool.detail;
  const text =
    (typeof d.output === "string" && d.output) ||
    (typeof d.unifiedDiff === "string" && d.unifiedDiff) ||
    (typeof d.content === "string" && d.content) ||
    (typeof d.result === "string" && d.result) ||
    (typeof d.text === "string" && d.text) ||
    undefined;
  return text ? text.slice(0, 4000) : undefined;
}

// The web work log only reads Synara's provider shapes (data.input/rawOutput/unifiedDiff); each
// text field is bounded here because the web treats ingestion as the size boundary.
const TOOL_DATA_TEXT_LIMIT = 20_000;

function boundedText(value: unknown): { text?: string; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) return { truncated: false };
  return value.length > TOOL_DATA_TEXT_LIMIT
    ? { text: value.slice(0, TOOL_DATA_TEXT_LIMIT), truncated: true }
    : { text: value, truncated: false };
}

function toolData(tool: ToolItem): Record<string, unknown> {
  const d = tool.detail;
  switch (d.type) {
    case "shell": {
      const output = boundedText(d.output);
      const exitCode = typeof d.exitCode === "number" ? d.exitCode : undefined;
      return {
        input: { command: String(d.command ?? "") },
        ...(output.text !== undefined || exitCode !== undefined || output.truncated
          ? {
              rawOutput: {
                ...(output.text !== undefined ? { output: output.text } : {}),
                ...(exitCode !== undefined ? { exitCode } : {}),
                ...(output.truncated ? { truncated: true } : {}),
              },
            }
          : {}),
      };
    }
    case "edit": {
      const oldText = boundedText(d.oldString);
      const newText = boundedText(d.newString);
      const diff = boundedText(d.unifiedDiff);
      return {
        input: {
          file_path: String(d.filePath ?? ""),
          ...(oldText.text !== undefined ? { old_string: oldText.text } : {}),
          ...(newText.text !== undefined ? { new_string: newText.text } : {}),
        },
        ...(diff.text !== undefined ? { unifiedDiff: diff.text } : {}),
      };
    }
    case "write": {
      const content = boundedText(d.content);
      return {
        input: {
          file_path: String(d.filePath ?? ""),
          ...(content.text !== undefined ? { content: content.text } : {}),
        },
      };
    }
    case "read":
      return { input: { file_path: String(d.filePath ?? "") } };
    default:
      return {};
  }
}

interface NeolixPermission {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly title?: string;
  readonly description?: string;
  readonly input?: Record<string, unknown>;
  readonly detail?: { readonly type: string } & Record<string, unknown>;
  readonly suggestions?: readonly Record<string, unknown>[];
  readonly actions?: readonly NeolixPermissionAction[];
  readonly metadata?: Record<string, unknown>;
}

interface NeolixPermissionAction {
  readonly id: string;
  readonly label?: string;
  readonly behavior: "allow" | "deny";
  readonly intent?: string;
}

const SESSION_ACTION_ID = /always|session/i;

/**
 * The provider's own "don't ask again" grant for a request, if it has one: Claude ships SDK
 * permission `suggestions` to echo back as `updatedPermissions`; OpenCode offers an `always`
 * action. `null` means the provider can only allow this one request.
 */
export function nativeSessionGrant(
  permission: Pick<NeolixPermission, "suggestions" | "actions"> | undefined,
):
  | { updatedPermissions: readonly Record<string, unknown>[] }
  | { selectedActionId: string }
  | null {
  if (permission?.suggestions && permission.suggestions.length > 0) {
    return { updatedPermissions: permission.suggestions };
  }
  const action = permission?.actions?.find(
    (candidate) => candidate.behavior === "allow" && SESSION_ACTION_ID.test(candidate.id),
  );
  return action ? { selectedActionId: action.id } : null;
}

/** The provider action that answers a plain allow/deny, so it records which button was pressed. */
export function plainPermissionActionId(
  permission: Pick<NeolixPermission, "actions"> | undefined,
  behavior: "allow" | "deny",
): string | undefined {
  return permission?.actions?.find(
    (candidate) => candidate.behavior === behavior && !SESSION_ACTION_ID.test(candidate.id),
  )?.id;
}

/**
 * Provider actions the standard approve / always / decline choices don't reach — Claude and
 * Codex plan "Implement with <mode>", ACP options such as "Always reject". The approval card
 * offers them as extra rows with the provider's own label, as the old app did.
 */
export function extraProviderActions(
  permission: Pick<NeolixPermission, "suggestions" | "actions"> | undefined,
): { id: string; label: string; behavior: "allow" | "deny"; intent?: string }[] {
  const grant = nativeSessionGrant(permission);
  const covered = new Set(
    [
      plainPermissionActionId(permission, "allow"),
      plainPermissionActionId(permission, "deny"),
      grant && "selectedActionId" in grant ? grant.selectedActionId : undefined,
    ].filter((id): id is string => id !== undefined),
  );
  return (permission?.actions ?? [])
    .filter((action) => !covered.has(action.id))
    .map((action) => ({
      id: action.id,
      label: action.label?.trim() || action.id,
      behavior: action.behavior,
      ...(action.intent ? { intent: action.intent } : {}),
    }));
}

// Mirrors @synara/shared approvalSessionGrantWidensSessionPolicy: for these kinds "always allow"
// means a full-access runtime mode, so the grant holds without provider support. The bridge
// switches the agent itself (commands.ts) — the web reads a server thread's mode from the host.
const SESSION_WIDENING_REQUEST_KINDS = new Set(["command", "file-read", "file-change"]);

/** Whether "always allow" on this request widens the chat to full access. */
export function sessionGrantWidensRuntimeMode(
  permission: Pick<NeolixPermission, "detail"> | undefined,
): boolean {
  return (
    permission !== undefined && SESSION_WIDENING_REQUEST_KINDS.has(approvalRequestKind(permission))
  );
}

function approvalRequestKind(permission: Pick<NeolixPermission, "detail">): string {
  switch (permission.detail?.type) {
    case "shell":
      return "command";
    case "read":
      return "file-read";
    case "edit":
    case "write":
      return "file-change";
    default:
      return "tool";
  }
}

/**
 * Open Neox permission requests as Synara approval activities. The client derives its approval
 * cards from these; a resolved request drops out of `pendingPermissions`, and with it the card.
 */
export function toApprovalActivities(
  agent: NeolixAgent,
  turnId: string | null,
): OrchestrationThreadActivity[] {
  const permissions = ((agent.pendingPermissions ?? []) as unknown as NeolixPermission[]).filter(
    (permission) => permission.kind !== "question",
  );
  return permissions.map((permission) => {
    const command = permission.detail?.type === "shell" ? permission.detail.command : undefined;
    // A plan approval's text is the provider's own boilerplate ("Review the proposed plan…");
    // the plan itself is the timeline card and the client words the prompt.
    const detail =
      permission.kind === "plan"
        ? undefined
        : (typeof command === "string" && command) ||
          (typeof permission.detail?.filePath === "string" && permission.detail.filePath) ||
          permission.description ||
          permission.title ||
          permission.name;
    const requestKind = approvalRequestKind(permission);
    const providerActions = extraProviderActions(permission);
    // Claude reports the held call as `toolUseId`; it matches the tool row's call id.
    const toolCallId =
      typeof permission.metadata?.toolUseId === "string" && permission.metadata.toolUseId
        ? permission.metadata.toolUseId
        : undefined;
    return {
      id: brand(`approval:${agent.id}:${permission.id}`),
      tone: "approval",
      kind: "approval.requested",
      summary: brand(permission.title?.trim() || `${permission.name} approval requested`),
      payload: {
        requestId: permission.id,
        requestKind,
        requestType: "permissions_approval",
        ...(detail ? { detail } : {}),
        toolName: permission.name,
        ...(toolCallId ? { toolCallId } : {}),
        ...(permission.kind === "plan" ? { approvalScope: "plan" } : {}),
        sessionApprovalAvailable:
          nativeSessionGrant(permission) !== null ||
          SESSION_WIDENING_REQUEST_KINDS.has(requestKind),
        ...(providerActions.length > 0 ? { providerActions } : {}),
      },
      turnId: turnId ? brand(turnId) : null,
      createdAt: agent.updatedAt,
    } as OrchestrationThreadActivity;
  });
}

/** Tools whose call is a question to the user; the timeline renders them as question → answer. */
const QUESTION_TOOL_NAMES = new Set(["AskUserQuestion"]);

/** The message the bridge answers a declined approval with (see commands.ts). */
export const DECLINED_BY_USER_MESSAGE = "Declined by user.";

/** A tool call's error text: a string, or the provider's `{ content }` tool result. */
function toolErrorMessage(error: unknown): string | null {
  if (typeof error === "string") return error.trim();
  if (error && typeof error === "object") {
    const content = (error as { content?: unknown; message?: unknown }).content;
    const message = (error as { message?: unknown }).message;
    if (typeof content === "string") return content.trim();
    if (typeof message === "string") return message.trim();
  }
  return null;
}

/**
 * Answers from a settled AskUserQuestion call, keyed by question text. Claude reports them in
 * the tool result as `"<question>"="<answer>"` pairs; an answer the result does not carry
 * renders as unanswered.
 */
export function parseQuestionAnswers(output: unknown): Record<string, string> {
  const text =
    typeof output === "string"
      ? output
      : output &&
          typeof output === "object" &&
          typeof (output as { output?: unknown }).output === "string"
        ? (output as { output: string }).output
        : "";
  const answers: Record<string, string> = {};
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g)) {
    const question = match[1]?.replace(/\\(.)/g, "$1").trim();
    const answer = match[2]?.replace(/\\(.)/g, "$1").trim();
    if (question && answer) answers[question] = answer;
  }
  return answers;
}

/**
 * Neox question input (`AskUserQuestion`, Codex `request_user_input_async`) → the shape the
 * composer's user-input card reads. Question ids are the header the provider expects as the
 * answer key, made unique when two questions share one.
 */
export function toUserInputQuestions(
  input: Record<string, unknown> | undefined,
): UserInputQuestion[] | null {
  const raw = input?.questions;
  if (!Array.isArray(raw)) return null;
  const headers = raw.map((entry, index) => {
    const question = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
    const header =
      typeof question?.header === "string" && question.header.trim()
        ? question.header.trim()
        : null;
    const title =
      typeof question?.title === "string" && question.title.trim() ? question.title.trim() : null;
    return header ?? title ?? `Question ${index + 1}`;
  });
  const counts = new Map<string, number>();
  for (const header of headers) counts.set(header, (counts.get(header) ?? 0) + 1);

  const questions: UserInputQuestion[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const question = entry as Record<string, unknown>;
    const text =
      typeof question.question === "string" && question.question.trim()
        ? question.question.trim()
        : typeof question.title === "string" && question.title.trim()
          ? question.title.trim()
          : null;
    if (!text) return;
    const header = headers[index] ?? `Question ${index + 1}`;
    const id = (counts.get(header) ?? 0) > 1 ? `${header} (${index + 1})` : header;
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
      const record = typeof option === "string" ? { label: option } : option;
      if (!record || typeof record !== "object") return [];
      const label = (record as Record<string, unknown>).label;
      if (typeof label !== "string" || !label.trim()) return [];
      const description = (record as Record<string, unknown>).description;
      const preview = (record as Record<string, unknown>).preview;
      return [
        {
          label: label.trim(),
          description:
            typeof description === "string" && description.trim()
              ? description.trim()
              : label.trim(),
          // AskUserQuestion options can carry a code/text preview; the client shows it as
          // preformatted text so options are comparable before picking.
          ...(typeof preview === "string" && preview.trim() ? { preview: preview.trim() } : {}),
        },
      ];
    });
    questions.push({
      id,
      header,
      question: text,
      options,
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    } as UserInputQuestion);
  });
  return questions.length > 0 ? questions : null;
}

/**
 * The composer answers questions keyed by the id in the card; providers expect the question
 * header as the key (Claude also accepts the full question text). Multi-select answers are
 * joined because both Neox provider question paths take one string per question.
 */
export function toProviderUserInputAnswers(
  input: Record<string, unknown> | undefined,
  answers: Record<string, unknown>,
): Record<string, string> {
  const questions = toUserInputQuestions(input);
  const textFor = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (Array.isArray(value)) {
      const parts = value
        .filter((part): part is string => typeof part === "string")
        .map((part) => part.trim());
      return parts.filter(Boolean).join(", ") || null;
    }
    return null;
  };
  if (!questions) {
    const passthrough: Record<string, string> = {};
    for (const [key, value] of Object.entries(answers)) {
      const text = textFor(value);
      if (text) passthrough[key] = text;
    }
    return passthrough;
  }
  const output: Record<string, string> = {};
  for (const question of questions) {
    const text = textFor(
      answers[question.id] ?? answers[question.question] ?? answers[question.header],
    );
    if (text) output[question.header] = text;
  }
  return output;
}

/** Open question requests as the activities the client derives its user-input cards from. */
export function toUserInputActivities(
  agent: NeolixAgent,
  turnId: string | null,
): OrchestrationThreadActivity[] {
  const permissions = (agent.pendingPermissions ?? []) as unknown as NeolixPermission[];
  return permissions.flatMap((permission) => {
    if (permission.kind !== "question") return [];
    const questions = toUserInputQuestions(permission.input);
    if (!questions) return [];
    return [
      {
        id: brand(`user-input:${agent.id}:${permission.id}`),
        tone: "info",
        kind: "user-input.requested",
        summary: brand(permission.title?.trim() || "Question"),
        payload: { requestId: permission.id, questions },
        turnId: turnId ? brand(turnId) : null,
        createdAt: agent.updatedAt,
      } as OrchestrationThreadActivity,
    ];
  });
}

export interface ThreadTimeline {
  readonly messages: OrchestrationMessage[];
  readonly activities: OrchestrationThreadActivity[];
  readonly proposedPlans: OrchestrationProposedPlan[];
  readonly latestTurn: OrchestrationLatestTurn | null;
}

/**
 * Daemon attachments are the persisted source of truth for a user message's chips.
 * Assistant selections stay out: the bridge sends them inside the prompt text and the
 * transcript already parses them from there, so mapping both would duplicate the chip.
 */
function toTimelineAttachments(value: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: ChatAttachment[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const attachment = raw as Record<string, unknown>;
    if (attachment.type === "stored_image") {
      if (
        typeof attachment.id !== "string" ||
        typeof attachment.fileName !== "string" ||
        typeof attachment.mimeType !== "string" ||
        typeof attachment.size !== "number"
      ) {
        continue;
      }
      attachments.push({
        type: "image",
        id: brand(attachment.id),
        name: brand(attachment.fileName),
        mimeType: brand(attachment.mimeType),
        sizeBytes: attachment.size,
      });
      continue;
    }
    if (attachment.type === "uploaded_file") {
      if (
        typeof attachment.id !== "string" ||
        typeof attachment.fileName !== "string" ||
        typeof attachment.mimeType !== "string" ||
        typeof attachment.size !== "number"
      ) {
        continue;
      }
      attachments.push({
        type: "file",
        id: brand(attachment.id),
        name: brand(attachment.fileName),
        mimeType: brand(attachment.mimeType),
        sizeBytes: attachment.size,
      });
      continue;
    }
    if (
      attachment.type === "review" &&
      typeof attachment.cwd === "string" &&
      (attachment.mode === "uncommitted" ||
        attachment.mode === "base" ||
        attachment.mode === "all") &&
      Array.isArray(attachment.comments)
    ) {
      attachments.push({
        type: "review",
        ...(typeof attachment.id === "string" ? { id: brand(attachment.id) } : {}),
        cwd: brand(attachment.cwd),
        mode: attachment.mode,
        ...(typeof attachment.baseRef === "string" || attachment.baseRef === null
          ? { baseRef: attachment.baseRef }
          : {}),
        comments: attachment.comments as ChatReviewComment[],
      });
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

/**
 * Stable activity-summary tokens. The bridge reports which activity it saw, never the
 * sentence the UI shows; the web catalogs (chat:timeline_*) own the display text.
 */
export const BRIDGE_ACTIVITY_SUMMARY = {
  tasksUpdated: "activity.tasksUpdated",
  reasoningTrace: "activity.reasoningTrace",
  contextCompacting: "activity.contextCompacting",
  contextCompacted: "activity.contextCompacted",
  contextWindow: "activity.contextWindow",
} as const;

/** The later of two ISO timestamps; blank or unparseable values are skipped. */
function latestTimestamp(...values: ReadonlyArray<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms) || ms <= latestMs) continue;
    latest = trimmed;
    latestMs = ms;
  }
  return latest;
}

/**
 * Folds a Neox timeline into Synara messages and activities. A user message opens a turn.
 * `userStoppedAt` is the local user's cancel request: the daemon keeps no terminal row for
 * a canceled turn, so the bridge derives one from it while that turn is still the latest.
 */
export function toThreadTimeline(
  agent: NeolixAgent,
  entries: readonly NeolixTimelineEntry[],
  options: { readonly userStoppedAt?: string | null } = {},
): ThreadTimeline {
  const messages: OrchestrationMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  const plansByCall = new Map<string, OrchestrationProposedPlan>();
  // The daemon records a second generic "tool/unknown failed" item for a tool the user
  // rejected during an interrupt; the richer canceled item already describes that call.
  const toolSnapshots = new Map<string, { readonly name: string }>();
  const settledQuestionCalls = new Set<string>();
  interface Turn {
    readonly id: string;
    readonly requestedAt: string;
    lastAt: string;
    assistantMessageId: string | null;
    /** A `[System Error]` row ended it; the agent's error status does not survive a restart. */
    failed: boolean;
  }
  let turn: Turn | null = null;
  const turns: Turn[] = [];

  for (const entry of entries) {
    const item = entry.item as { type: string } & Record<string, unknown>;
    const at = entry.timestamp;
    const seq = entry.seqStart;
    if (item.type === "user_message") {
      turn = {
        id: turnIdFor(agent.id, seq),
        requestedAt: at,
        lastAt: at,
        assistantMessageId: null,
        failed: false,
      };
      turns.push(turn);
    } else if (turn) {
      turn.lastAt = at;
    }
    const turnId = turn ? brand<OrchestrationMessage["turnId"]>(turn.id) : null;
    // A prompt written on the user's behalf (Codex's plan implementation) opens its turn but is
    // not the user's message; the approved plan card above already says what started it.
    if (item.type === "user_message" && item.synthetic === true) continue;
    // The daemon records a failed turn as an assistant message prefixed `[System Error]`. It is
    // the provider's failure, not the agent's reply: the client shows it as the turn's failure.
    if (
      item.type === "assistant_message" &&
      typeof item.text === "string" &&
      item.text.startsWith(SYSTEM_ERROR_PREFIX)
    ) {
      const raw = item.text.slice(SYSTEM_ERROR_PREFIX.length).trim();
      // A provider that also streams its failure as reply text (the gateway does) would show
      // the same error twice: as that reply and as the failure card below it.
      const last = messages.at(-1);
      if (last?.role === "assistant" && last.turnId === turnId && last.text.trim() === raw) {
        messages.pop();
        if (turn?.assistantMessageId === last.id) turn.assistantMessageId = null;
      }
      activities.push({
        id: brand<OrchestrationThreadActivity["id"]>(`act:${agent.id}:${seq}`),
        turnId,
        sequence: seq,
        createdAt: at,
        tone: "error",
        kind: "runtime.error",
        summary: brand("activity.error"),
        payload: { errorMessage: systemErrorCause(raw) },
      } as OrchestrationThreadActivity);
      if (turn) turn.failed = true;
      continue;
    }

    if (item.type === "user_message" || item.type === "assistant_message") {
      const id =
        typeof item.messageId === "string" && item.messageId
          ? item.messageId
          : `msg:${agent.id}:${seq}`;
      const text = typeof item.text === "string" ? item.text : "";
      if (item.type === "assistant_message" && turn) turn.assistantMessageId = id;
      const attachments =
        item.type === "user_message" ? toTimelineAttachments(item.attachments) : undefined;
      messages.push({
        id: brand(id),
        role: item.type === "user_message" ? "user" : "assistant",
        text,
        ...(attachments ? { attachments } : {}),
        turnId,
        streaming: false,
        source: "native",
        createdAt: at,
        updatedAt: at,
      } as OrchestrationMessage);
      continue;
    }

    const base = {
      id: brand<OrchestrationThreadActivity["id"]>(`act:${agent.id}:${seq}`),
      turnId,
      sequence: seq,
      createdAt: at,
    };
    if (item.type === "todo") {
      const tasks = Array.isArray(item.items)
        ? (item.items as Array<Record<string, unknown>>).flatMap((task) => {
            const text =
              typeof task.text === "string" && task.text.trim() ? task.text.trim() : null;
            if (!text) return [];
            const status =
              task.status === "in_progress"
                ? "inProgress"
                : task.status === "completed" || task.completed === true
                  ? "completed"
                  : "pending";
            return [{ task: text, status }];
          })
        : [];
      activities.push({
        ...base,
        id: brand(`todo:${agent.id}:${seq}`),
        tone: "info",
        kind: "turn.tasks.updated",
        summary: brand(BRIDGE_ACTIVITY_SUMMARY.tasksUpdated),
        payload: { tasks },
      } as OrchestrationThreadActivity);
    } else if (item.type === "compaction") {
      const completed = item.status === "completed";
      activities.push({
        ...base,
        id: brand(`compaction:${agent.id}:${seq}`),
        tone: "info",
        kind: "context-compaction",
        summary: brand(
          completed
            ? BRIDGE_ACTIVITY_SUMMARY.contextCompacted
            : BRIDGE_ACTIVITY_SUMMARY.contextCompacting,
        ),
        payload: {
          state: completed ? "compacted" : "compacting",
          status: completed ? "completed" : "running",
          ...(typeof item.trigger === "string" ? { trigger: item.trigger } : {}),
          ...(typeof item.preTokens === "number" ? { preTokens: item.preTokens } : {}),
        },
      } as OrchestrationThreadActivity);
    } else if (item.type === "tool_call") {
      const tool = item as unknown as ToolItem;
      // A provider task notification is the bookend of a background task, not a tool the
      // agent ran: the task's own row already says what happened, so no raw English row.
      if (tool.metadata?.source === "claude_task_notification") {
        const notifiedTaskId =
          typeof tool.metadata.taskId === "string" ? tool.metadata.taskId : null;
        if (notifiedTaskId !== null && tool.status !== "running") {
          activities.push({
            ...base,
            id: brand(`task-completed:${agent.id}:${tool.callId}`),
            tone: tool.status === "failed" ? "error" : "info",
            kind: "task.completed",
            summary: brand(BRIDGE_ACTIVITY_SUMMARY.tasksUpdated),
            payload: {
              taskId: notifiedTaskId,
              status:
                tool.status === "failed"
                  ? "failed"
                  : tool.metadata?.status === "stopped"
                    ? "stopped"
                    : "completed",
            },
          } as OrchestrationThreadActivity);
        }
        continue;
      }
      const previousTool = toolSnapshots.get(tool.callId);
      const isRejectionPlaceholder =
        tool.status === "failed" && tool.name === "tool" && tool.detail.type === "unknown";
      if (previousTool && isRejectionPlaceholder) {
        continue;
      }
      toolSnapshots.set(tool.callId, { name: tool.name });
      const title = toolTitle(tool);
      const detail = toolDetail(tool);
      if (
        tool.detail.type === "plan" &&
        typeof tool.detail.text === "string" &&
        tool.detail.text.trim()
      ) {
        // A plan is rendered as its own card, not as a generic tool row; a later entry for the
        // same call (running → completed) replaces the earlier snapshot.
        const planId = `plan:${agent.id}:${tool.callId}`;
        plansByCall.set(tool.callId, {
          id: brand(planId),
          turnId: turnId ?? null,
          planMarkdown: brand(tool.detail.text.trim()),
          implementedAt: null,
          implementationThreadId: null,
          createdAt: at,
          updatedAt: at,
        } as OrchestrationProposedPlan);
        continue;
      }
      const questions = QUESTION_TOOL_NAMES.has(tool.name)
        ? toUserInputQuestions(tool.detail.input as Record<string, unknown> | undefined)
        : null;
      if (questions) {
        // An unanswered question is already on screen through its pending permission (the
        // question row and the composer card). Once settled, the call becomes the question →
        // answer pair the transcript renders as one exchange row, instead of a raw tool row.
        if (tool.status === "running" || settledQuestionCalls.has(tool.callId)) continue;
        settledQuestionCalls.add(tool.callId);
        activities.push(
          {
            ...base,
            id: brand(`question:${agent.id}:${tool.callId}`),
            tone: "info",
            kind: "user-input.requested",
            summary: brand(questions[0]?.question ?? tool.name),
            payload: { requestId: tool.callId, questions },
          } as OrchestrationThreadActivity,
          {
            ...base,
            id: brand(`question-answer:${agent.id}:${tool.callId}`),
            tone: "info",
            kind: "user-input.resolved",
            summary: brand(questions[0]?.question ?? tool.name),
            payload: {
              requestId: tool.callId,
              answers: tool.status === "completed" ? parseQuestionAnswers(tool.detail.output) : {},
            },
          } as OrchestrationThreadActivity,
        );
        continue;
      }
      // A call the user declined at its approval never ran; the provider reports it as failed
      // with the message the bridge answered the approval with.
      const declined =
        tool.status === "failed" && toolErrorMessage(tool.error) === DECLINED_BY_USER_MESSAGE;
      activities.push({
        ...base,
        id: brand(`tool:${agent.id}:${tool.callId}`),
        tone: tool.status === "failed" && !declined ? "error" : "tool",
        kind: tool.status === "running" ? "tool.started" : "tool.completed",
        summary: brand(title || tool.name || "activity.tool"),
        payload: {
          itemType: TOOL_ITEM_TYPE[tool.detail.type] ?? "dynamic_tool_call",
          status:
            tool.status === "running"
              ? "inProgress"
              : tool.status === "completed"
                ? "completed"
                : tool.status === "canceled"
                  ? "cancelled"
                  : declined
                    ? "declined"
                    : "failed",
          title,
          ...(detail ? { detail } : {}),
          // `toolName` lets the web classify provider tools by name (Read wears the book icon and
          // counts as a file read, Grep/Glob as searches) instead of by their raw title.
          data: {
            ...toolData(tool),
            toolCallId: tool.callId,
            toolName: tool.name,
            neolix: { name: tool.name },
          },
        },
      } as OrchestrationThreadActivity);
    } else if (item.type === "background_task") {
      // Edge event for one task: the web admits a background row when it is backgrounded and
      // closes it from the task.completed activity below.
      activities.push({
        ...base,
        id: brand(`background-task:${agent.id}:${seq}`),
        tone: "info",
        kind: "task.updated",
        summary: brand(BRIDGE_ACTIVITY_SUMMARY.tasksUpdated),
        payload: {
          taskId: String(item.taskId),
          ...(typeof item.taskType === "string" ? { taskType: item.taskType } : {}),
          ...(typeof item.description === "string" ? { detail: item.description } : {}),
          ...(typeof item.isBackgrounded === "boolean"
            ? { isBackgrounded: item.isBackgrounded }
            : {}),
          ...(typeof item.status === "string" ? { status: item.status } : {}),
        },
      } as OrchestrationThreadActivity);
    } else if (item.type === "background_tasks") {
      // REPLACE semantics: the daemon's list is every task alive now. The web builds its
      // running-task rows and stop controls from this activity.
      const tasks = Array.isArray(item.tasks) ? (item.tasks as Array<Record<string, unknown>>) : [];
      activities.push({
        ...base,
        id: brand(`background-tasks:${agent.id}:${seq}`),
        tone: "info",
        kind: "runtime.warning",
        summary: brand(BRIDGE_ACTIVITY_SUMMARY.tasksUpdated),
        payload: {
          nativeEventType: "background_tasks_changed",
          data: {
            tasks: tasks.map((task) => ({
              task_id: String(task.taskId),
              task_type: String(task.taskType),
              description: String(task.description),
            })),
          },
        },
      } as OrchestrationThreadActivity);
    } else if (item.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
      activities.push({
        ...base,
        tone: "tool",
        kind: "task.progress",
        summary: brand(BRIDGE_ACTIVITY_SUMMARY.reasoningTrace),
        payload: { detail: item.text.slice(0, 8000), data: { toolCallId: `reasoning:${seq}` } },
      } as OrchestrationThreadActivity);
    } else if (item.type === "error" && typeof item.message === "string") {
      activities.push({
        ...base,
        tone: "error",
        kind: "runtime.warning",
        summary: brand(item.message.trim() || "activity.error"),
        payload: { detail: item.message },
      } as OrchestrationThreadActivity);
    } else if (item.type === "plugin") {
      // Declarative plugin timeline items ride the ordinary activity channel; the web host picks
      // the renderer by kind/version. Custom views are the same sandboxed iframe path as pages.
      const pluginKind = typeof item.kind === "string" ? item.kind : "item";
      activities.push({
        ...base,
        tone: "info",
        kind: "plugin.item",
        summary: brand(pluginKind),
        payload: {
          pluginItem: {
            kind: pluginKind,
            version: typeof item.version === "number" ? item.version : 1,
            data: item.data ?? null,
          },
        },
      } as OrchestrationThreadActivity);
    }
  }

  const last = turns.at(-1) ?? null;
  // The daemon records no timeline item when the user stops a turn. While the canceled turn
  // is still the latest one, derive the terminal rows the web reads for its "Stopped by you"
  // marker. A later user message makes this stop stale and it is ignored. The daemon's
  // persisted `lastUserStopAt` survives a bridge restart; the local stamp covers older daemons.
  const stoppedAt = latestTimestamp(options.userStoppedAt, agent.lastUserStopAt);
  if (stoppedAt && last && agent.status !== "running") {
    const stoppedMs = Date.parse(stoppedAt);
    const requestedMs = Date.parse(last.requestedAt);
    if (!Number.isNaN(stoppedMs) && !Number.isNaN(requestedMs) && stoppedMs >= requestedMs) {
      const lastMs = Date.parse(last.lastAt);
      const completedAt = !Number.isNaN(lastMs) && lastMs > stoppedMs ? last.lastAt : stoppedAt;
      const stopTurnId = brand<OrchestrationThreadActivity["turnId"]>(last.id);
      const stopSequence = entries.at(-1)?.seqEnd ?? 0;
      activities.push({
        id: brand(`turn-stop-requested:${agent.id}:${last.id}`),
        turnId: stopTurnId,
        sequence: stopSequence,
        createdAt: stoppedAt,
        tone: "info",
        kind: "turn.stop-requested",
        summary: brand("activity.turnStopRequested"),
        payload: { requestedBy: "user" },
      } as unknown as OrchestrationThreadActivity);
      activities.push({
        id: brand(`turn-aborted:${agent.id}:${last.id}`),
        turnId: stopTurnId,
        sequence: stopSequence,
        createdAt: completedAt,
        tone: "info",
        kind: "turn.aborted",
        summary: brand("activity.turnAborted"),
        payload: { reason: "user" },
      } as unknown as OrchestrationThreadActivity);
    }
  }
  activities.push(...toApprovalActivities(agent, last ? last.id : null));
  activities.push(...toUserInputActivities(agent, last ? last.id : null));

  // The composer's context meter reads this activity, not the work log, so one snapshot per
  // thread is enough; a later re-read replaces it in place.
  const usage = agent.lastUsage as
    | {
        contextWindowUsedTokens?: number;
        contextWindowMaxTokens?: number;
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
        totalCostUsd?: number;
      }
    | undefined;
  // The daemon reports the provider's session cost here (the old UI shows it as-is), so it rides on
  // the same snapshot as a cumulative value rather than as a per-turn delta.
  const costUsd =
    typeof usage?.totalCostUsd === "number" &&
    Number.isFinite(usage.totalCostUsd) &&
    usage.totalCostUsd >= 0
      ? usage.totalCostUsd
      : null;
  const usedTokens =
    typeof usage?.contextWindowUsedTokens === "number" && usage.contextWindowUsedTokens >= 0
      ? Math.round(usage.contextWindowUsedTokens)
      : null;
  const maxTokens =
    typeof usage?.contextWindowMaxTokens === "number" && usage.contextWindowMaxTokens > 0
      ? Math.round(usage.contextWindowMaxTokens)
      : null;
  if (usedTokens !== null || maxTokens !== null || costUsd !== null) {
    activities.push({
      id: brand(`context-window:${agent.id}`),
      tone: "info",
      kind: "context-window.updated",
      summary: brand(BRIDGE_ACTIVITY_SUMMARY.contextWindow),
      payload: {
        ...(usedTokens !== null ? { usedTokens } : { usedTokens: 0 }),
        ...(maxTokens !== null ? { maxTokens } : {}),
        ...(typeof usage?.inputTokens === "number"
          ? { inputTokens: Math.max(0, Math.round(usage.inputTokens)) }
          : {}),
        ...(typeof usage?.cachedInputTokens === "number"
          ? { cachedInputTokens: Math.max(0, Math.round(usage.cachedInputTokens)) }
          : {}),
        ...(typeof usage?.outputTokens === "number"
          ? { outputTokens: Math.max(0, Math.round(usage.outputTokens)) }
          : {}),
        ...(costUsd !== null ? { cumulativeCostUsd: costUsd } : {}),
      },
      turnId: null,
      createdAt: agent.updatedAt,
    } as OrchestrationThreadActivity);
  }

  const running = agent.status === "running";
  const latestTurn: OrchestrationLatestTurn | null = last
    ? {
        turnId: brand(last.id),
        state: running
          ? "running"
          : agent.status === "error" || last.failed
            ? "error"
            : "completed",
        requestedAt: last.requestedAt,
        startedAt: last.requestedAt,
        completedAt: running ? null : last.lastAt,
        assistantMessageId: last.assistantMessageId ? brand(last.assistantMessageId) : null,
      }
    : null;
  return { messages, activities, proposedPlans: [...plansByCall.values()], latestTurn };
}

/**
 * A cached latest turn kept in step with its agent's status, the same states the timeline fold
 * gives. The bridge follows a thread's timeline only while it is open, so a closed thread learns
 * that its turn settled, or that another one started, from the agent alone. A new turn keeps
 * the cached id until the thread is opened: its seq-based id is only known from the timeline.
 */
export function settleLatestTurn(
  agent: Pick<NeolixAgent, "status" | "updatedAt">,
  turn: OrchestrationLatestTurn | null,
): OrchestrationLatestTurn | null {
  if (!turn) return null;
  if (agent.status === "running") {
    return turn.state === "running" ? turn : { ...turn, state: "running", completedAt: null };
  }
  if (turn.state !== "running") return turn;
  return {
    ...turn,
    state: agent.status === "error" ? "error" : "completed",
    completedAt: agent.updatedAt,
  };
}

export function toThread(
  shell: OrchestrationThreadShell,
  timeline: ThreadTimeline,
): OrchestrationThread {
  return {
    ...shell,
    latestTurn: timeline.latestTurn ?? shell.latestTurn,
    deletedAt: null,
    messages: timeline.messages,
    proposedPlans: timeline.proposedPlans,
    activities: timeline.activities,
    checkpoints: [],
  } as OrchestrationThread;
}

/**
 * A fork's imported transcript, as the client already built it. Neox has no thread of its own
 * for these messages, so the bridge serves them ahead of the forked agent's timeline.
 */
export function toImportedMessages(
  imported: ReadonlyArray<{
    readonly messageId: string;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly attachments?: ReadonlyArray<unknown> | undefined;
    readonly createdAt: string;
    readonly updatedAt: string;
  }>,
): OrchestrationMessage[] {
  return imported.map(
    (message) =>
      ({
        id: brand(message.messageId),
        role: message.role,
        text: message.text,
        ...(message.attachments && message.attachments.length > 0
          ? { attachments: message.attachments as OrchestrationMessage["attachments"] }
          : {}),
        turnId: null,
        streaming: false,
        source: "fork-import",
        createdAt: brand(message.createdAt),
        updatedAt: brand(message.updatedAt),
      }) as OrchestrationMessage,
  );
}
