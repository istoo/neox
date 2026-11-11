// `orchestration.dispatchCommand` → Neox calls. Every command the front end can send is listed:
// the ones Neox can carry out run, the rest fail with a typed "not supported" error so the UI
// reports it rather than waiting on a turn that never starts.
import type {
  ChatAttachment,
  OrchestrationThreadShell,
  RuntimeMode,
  WsRpcError,
} from "@synara/contracts";
import { Effect } from "effect";

import { type AttachmentStore, sharedAttachmentStore } from "./attachments.ts";
import type { BridgeModel } from "./model.ts";
import {
  DECLINED_BY_USER_MESSAGE,
  LABEL_SETTLED_AT,
  nativeSessionGrant,
  plainPermissionActionId,
  toImportedMessages,
  toProviderUserInputAnswers,
  PLAN_FEATURE_ID,
  sessionGrantWidensRuntimeMode,
  toInteractionMode,
  toRuntimeMode,
} from "./translate.ts";
import { bridgeError } from "./rpcErrors.ts";
import { killThreadTerminals } from "./terminalRpc.ts";
import { notSupported } from "./stubs.ts";
import { makeProjectHandlers, type ProjectPinStore } from "./projectsRpc.ts";
import { driverForProvider, instanceIdForProvider } from "./providers.ts";
import type { ProviderDirectory } from "./providers.ts";
import { daemonProviderIdForInstanceId } from "./providerConfig.ts";

interface Command {
  readonly type: string;
  readonly threadId?: string;
  readonly [key: string]: unknown;
}

interface ModelSelectionInput {
  readonly provider: string;
  readonly instanceId?: string;
  readonly model: string;
  readonly options?: Record<string, unknown>;
}

/** Neox providers whose thinking option is a single `setAgentThinkingOption` id. */
const THINKING_OPTION_PROVIDERS = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "droid",
  "antigravity",
  "devin",
  "pi",
  "omp",
]);

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Synara keeps reasoning effort in `modelSelection.options`; Neox keeps it as one thinking
 * option id. `ultrathink` is Synara's prompt-prefix mode, so it maps to the max effort Neox
 * offers rather than a separate option it does not have.
 */
export function thinkingOptionFor(selection: ModelSelectionInput | undefined): string | undefined {
  const options = selection?.options;
  if (!selection || !options) return undefined;
  switch (selection.provider) {
    case "claudeAgent": {
      if (options.thinking === false) return "off";
      const effort = nonEmptyString(options.effort);
      if (!effort) return undefined;
      return effort === "ultrathink" ? "max" : effort;
    }
    case "opencode":
      return undefined;
    case "pi":
    case "omp":
      return nonEmptyString(options.thinkingLevel);
    default:
      return THINKING_OPTION_PROVIDERS.has(selection.provider)
        ? nonEmptyString(options.reasoningEffort)
        : undefined;
  }
}

/**
 * Creation-time settings; an existing agent applies the same values through setters instead.
 * `providerModes` is what the target provider offers; a mode it does not offer is left to the
 * provider's default, since the daemon refuses a create that names an unknown mode.
 */
function creationSettings(
  selection: ModelSelectionInput,
  runtimeMode: RuntimeMode,
  interactionMode: string,
  providerModes: readonly { readonly id: string }[],
): Record<string, unknown> {
  const plansByMode = modeIdFor(runtimeMode, "plan", providerModes) !== undefined;
  const planByToggle = interactionMode === "plan" && selection.provider === "codex" && !plansByMode;
  const modeId = modeIdFor(runtimeMode, plansByMode ? interactionMode : "default", providerModes);
  const thinkingOptionId = thinkingOptionFor(selection);
  // At creation there is no feature list to inspect, so only the providers whose create path
  // reads the legacy fast flag are given one, and only Codex is given its plan toggle.
  const fastMode = selection.options?.fastMode;
  const featureValues = {
    ...(typeof fastMode === "boolean" &&
    (selection.provider === "claudeAgent" || selection.provider === "codex")
      ? { fast_mode: fastMode }
      : {}),
    ...(planByToggle ? { [PLAN_FEATURE_ID]: true } : {}),
  };
  return {
    ...(selection.model && selection.model !== "default" ? { model: selection.model } : {}),
    ...(modeId ? { modeId } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
    ...(Object.keys(featureValues).length > 0 ? { featureValues } : {}),
  };
}

interface NeolixFeature {
  readonly id: string;
  readonly type: string;
  readonly label?: string;
  readonly value?: unknown;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
}

function currentFeatureValue(
  features: readonly NeolixFeature[] | undefined,
  featureId: string,
): unknown {
  const feature = features?.find((candidate) => candidate.id === featureId);
  return feature?.value;
}

/**
 * The feature behind Synara's fast toggle, as the agent itself advertises it: Claude exposes a
 * `fast_mode` toggle, Codex a `service_tier` select whose fast tier the label names.
 */
export function fastFeatureUpdate(
  features: readonly NeolixFeature[] | undefined,
  enabled: boolean,
): { readonly featureId: string; readonly value: unknown } | null {
  const toggle = features?.find(
    (feature) => feature.id === "fast_mode" && feature.type === "toggle",
  );
  if (toggle) return { featureId: "fast_mode", value: enabled };
  const tier = features?.find(
    (feature) => feature.id === "service_tier" && feature.type === "select",
  );
  if (tier) {
    if (!enabled) return { featureId: "service_tier", value: "default" };
    const fast = tier.options?.find((option) => /fast/i.test(option.label));
    return fast ? { featureId: "service_tier", value: fast.id } : null;
  }
  return null;
}

const ACP_PLAN_MODE = "https://agentclientprotocol.com/protocol/session-modes#plan";
const ACP_AGENT_MODE = "https://agentclientprotocol.com/protocol/session-modes#agent";
const CODEX_REVIEW_MODE = "auto-review";

/**
 * Synara runtime and interaction modes → the Neox mode id, when the agent offers it. Each
 * provider names its tiers differently (Claude `default`/`bypassPermissions`, Codex
 * `auto`/`auto-review`/`full-access`, Copilot ACP URLs, OpenCode `build`, Oh My Pi `ask`/`full`),
 * so every tier lists each provider's id and the first one the agent offers wins. Codex's `auto`
 * is its asking tier and `auto-review` its reviewer-decides tier, which is what Synara's Codex
 * Auto describes. The reverse is `toRuntimeMode` in translate.ts; keep the two in step.
 */
export function modeIdFor(
  runtimeMode: RuntimeMode,
  interactionMode: string,
  availableModes: readonly { readonly id: string }[],
): string | undefined {
  const offers = (id: string) => availableModes.some((mode) => mode.id === id);
  const codexTiers = offers(CODEX_REVIEW_MODE);
  const candidates =
    interactionMode === "plan"
      ? ["plan", ACP_PLAN_MODE]
      : runtimeMode === "full-access"
        ? ["bypassPermissions", "full-access", "allow-all", "full"]
        : runtimeMode === "accept-edits"
          ? ["acceptEdits"]
          : runtimeMode === "auto"
            ? codexTiers
              ? [CODEX_REVIEW_MODE]
              : ["auto", "acceptEdits"]
            : codexTiers
              ? ["auto"]
              : ["default", ACP_AGENT_MODE, "build", "ask"];
  return candidates.find(offers);
}

type PendingPermission = Parameters<typeof nativeSessionGrant>[0] &
  Parameters<typeof sessionGrantWidensRuntimeMode>[0];

export function decisionToResponse(
  decision: string,
  permission: PendingPermission,
  selectedActionId?: string,
) {
  if (selectedActionId !== undefined) {
    const action = permission?.actions?.find((candidate) => candidate.id === selectedActionId);
    if (!action) {
      throw bridgeError(
        "command.approval-action-gone",
        `Approval action "${selectedActionId}" is no longer offered.`,
        { action: selectedActionId },
      );
    }
    return action.behavior === "allow"
      ? { behavior: "allow" as const, selectedActionId }
      : { behavior: "deny" as const, message: DECLINED_BY_USER_MESSAGE, selectedActionId };
  }
  const allowId = plainPermissionActionId(permission, "allow");
  const denyId = plainPermissionActionId(permission, "deny");
  const denied = (message: string) => ({
    behavior: "deny" as const,
    message,
    ...(denyId ? { selectedActionId: denyId } : {}),
  });
  switch (decision) {
    case "acceptForSession":
      // Without a provider grant the web widens the thread's runtime mode instead; this request
      // is still allowed once either way.
      return { behavior: "allow" as const, ...(nativeSessionGrant(permission) ?? {}) };
    case "accept":
      return { behavior: "allow" as const, ...(allowId ? { selectedActionId: allowId } : {}) };
    default:
      return denied(DECLINED_BY_USER_MESSAGE);
  }
}

export class CommandDispatcher {
  constructor(
    private readonly model: BridgeModel,
    private readonly directory: ProviderDirectory,
    private readonly log: (line: string) => void,
    private readonly attachments: AttachmentStore = sharedAttachmentStore,
    private readonly projectPins?: ProjectPinStore,
  ) {}

  /** Turn-start command ids the daemon accepted, and ids settled as lost before they arrived. */
  private readonly acceptedTurns = new Map<string, number>();
  private readonly rejectedTurns = new Set<string>();
  /** Forked threads' chat-history attachment, sent with their first turn (as the app does). */
  private readonly forkContexts = new Map<string, unknown>();
  /**
   * Workspace placement announced by `thread.meta.update`. The front end creates a worktree
   * before the first turn, then updates the thread's env/branch/path; turn.start itself carries
   * no path, so the dispatcher must remember it or create a second worktree.
   */
  private readonly placements = new Map<string, Record<string, unknown>>();

  /**
   * `orchestration.settleTurnDispatch`: the client lost the acknowledgement of a turn start.
   * An accepted command reports its receipt; an unknown one is rejected for good, so a late
   * copy can never start a second turn.
   */
  settleTurn(
    commandId: string,
  ): { status: "accepted"; sequence: number } | { status: "rejected"; message: string } {
    const sequence = this.acceptedTurns.get(commandId);
    if (sequence !== undefined) return { status: "accepted", sequence };
    this.rejectedTurns.add(commandId);
    return { status: "rejected", message: "The message never reached the agent. Send it again." };
  }

  async dispatch(command: Command): Promise<{ sequence: number }> {
    const client = this.model.client;
    const threadId = command.threadId ?? "";
    switch (command.type) {
      case "thread.create":
        this.model.registerDraft(this.draftShell(command));
        break;
      case "thread.fork.create":
        await this.forkThread(command);
        break;
      case "thread.checkpoint.revert":
        await this.revertToCheckpoint(command);
        break;
      case "thread.turn.start": {
        const commandId = String(command.commandId);
        const accepted = this.acceptedTurns.get(commandId);
        if (accepted !== undefined) return { sequence: accepted };
        if (this.rejectedTurns.has(commandId)) throw notSupported("thread.turn.start after settle");
        this.model.clearUserStop(threadId);
        await this.startTurn(command);
        const sequence = this.model.nextSequence();
        this.acceptedTurns.set(commandId, sequence);
        return { sequence };
      }
      case "thread.turn.interrupt":
      case "thread.session.stop":
        // Remember the stop so the next read-model fold can mark the turn as canceled.
        this.model.recordUserStop(threadId);
        await client.cancelAgent(threadId);
        break;
      case "thread.task.stop":
        // Ends one background task; the turn continues and the provider reports the task's
        // own end, so no local stop marker is recorded.
        await client.stopAgentTask(threadId, String(command.taskId));
        break;
      case "thread.approval.respond": {
        // "Cancel turn" is the stop button: the provider's own cancel rejects every pending
        // permission and ends the turn. Answering the request first (deny, or deny+interrupt)
        // lets Claude resume with the denial and race the cancel, and leaves the agent in error.
        if (command.decision === "cancel") {
          this.model.recordUserStop(threadId);
          await client.cancelAgent(threadId);
          break;
        }
        const requestId = String(command.requestId);
        const permission = (this.model.entry(threadId)?.agent.pendingPermissions ?? []).find(
          (candidate) => candidate.id === requestId,
        ) as PendingPermission;
        await client.respondToPermission(
          threadId,
          requestId,
          decisionToResponse(
            String(command.decision),
            permission,
            command.selectedActionId === undefined ? undefined : String(command.selectedActionId),
          ) as never,
        );
        // "Always allow for this chat" on a command or file request means the chat stops asking:
        // a supervised agent moves to full access. The provider's own grant only covers that
        // exact command, so a different one would ask again.
        const agent = this.model.entry(threadId)?.agent;
        if (
          command.decision === "acceptForSession" &&
          agent &&
          sessionGrantWidensRuntimeMode(permission) &&
          toRuntimeMode(agent.currentModeId, agent.availableModes ?? [], agent.provider) ===
            "approval-required"
        ) {
          await this.applyModes(threadId, agent, "full-access", toInteractionMode(agent));
        }
        break;
      }
      case "thread.user-input.respond": {
        const requestId = String(command.requestId);
        const permission = (this.model.entry(threadId)?.agent.pendingPermissions ?? []).find(
          (candidate) => candidate.id === requestId,
        );
        await client.respondToPermission(threadId, requestId, {
          behavior: "allow",
          updatedInput: {
            answers: toProviderUserInputAnswers(
              permission?.input as Record<string, unknown> | undefined,
              (command.answers ?? {}) as Record<string, unknown>,
            ),
          },
        } as never);
        break;
      }
      case "thread.archive":
        await client.archiveAgent(threadId);
        break;
      case "thread.unarchive":
        // Neox clears the archived flag when it refreshes an agent; this is the same path
        // the app uses to bring an archived session back, without sending it a message.
        await client.refreshAgent(threadId);
        break;
      case "thread.delete":
        this.forkContexts.delete(threadId);
        // A draft has no agent yet (an import placeholder, an abandoned new chat).
        if (!this.model.discardDraft(threadId)) await client.deleteAgent(threadId);
        // The thread is gone either way; a terminal that will not die is logged, not reported.
        await killThreadTerminals(client, threadId).catch((error: unknown) => {
          this.log(`thread ${threadId}: terminals not closed after delete: ${String(error)}`);
        });
        break;
      case "thread.meta.update":
        await this.updateMeta(command);
        break;
      case "project.create":
      case "project.meta.update":
      case "project.delete": {
        // Project commands run through their own module; the shell then re-reads the project
        // list so the receipt sequence comes after the change it confirms.
        const handler = makeProjectHandlers(
          this.model,
          this.projectPins ? { projectPins: this.projectPins } : {},
        )[command.type]!;
        await Effect.runPromise(handler(command, undefined) as Effect.Effect<unknown, WsRpcError>);
        await this.model.reloadProjects();
        break;
      }
      case "thread.runtime-mode.set":
      case "thread.interaction-mode.set":
        await this.setMode(command);
        break;
      default:
        this.log(`unsupported command ${command.type}`);
        throw notSupported(command.type);
    }
    return { sequence: this.model.nextSequence() };
  }

  private draftShell(command: Command): OrchestrationThreadShell {
    const now = new Date().toISOString();
    return {
      id: command.threadId,
      projectId: command.projectId,
      title: command.title,
      modelSelection: command.modelSelection,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode ?? "default",
      envMode: command.envMode ?? "local",
      branch: command.branch ?? null,
      worktreePath: command.worktreePath ?? null,
      workingDirectory: command.workingDirectory ?? null,
      ...(command.primarySurface === "terminal" ? { primarySurface: "terminal" } : {}),
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      handoff: null,
      session: null,
    } as unknown as OrchestrationThreadShell;
  }

  private async startTurn(command: Command): Promise<void> {
    const client = this.model.client;
    const threadId = String(command.threadId);
    const message = command.message as {
      messageId: string;
      text: string;
      attachments?: ChatAttachment[];
    };
    const forwarded =
      message.attachments && message.attachments.length > 0
        ? await this.attachments.resolve(client, message.attachments)
        : {};
    const runtimeMode = command.runtimeMode as RuntimeMode;
    const interactionMode = String(command.interactionMode ?? "default");
    const selection = command.modelSelection as ModelSelectionInput | undefined;
    const entry = this.model.entry(threadId);
    // Synara's queue mode is client-side (the message is held and sent after the turn
    // settles), so a live send is either a nudge into the running turn or a deliberate
    // interruption. Omitting the option makes the daemon interrupt, matching old UI's
    // default; be explicit so steer really steers.
    const activeTurnBehavior: "steer" | "interrupt" =
      command.dispatchMode === "steer" ? "steer" : "interrupt";

    if (entry) {
      await this.applyModes(threadId, entry.agent, runtimeMode, interactionMode);
      await this.applyModel(threadId, entry.agent, selection);
      await this.applyTraits(threadId, entry.agent, selection);
      await client.sendAgentMessage(threadId, message.text, {
        messageId: message.messageId,
        activeTurnBehavior,
        ...forwarded,
      } as never);
      return;
    }

    // An agent this bridge just created, whose `agent_update` may not have reached the model
    // yet; a fast follow-up turn goes straight to it instead of creating a second agent.
    if (this.model.wasCreated(threadId)) {
      await client.sendAgentMessage(threadId, message.text, {
        messageId: message.messageId,
        activeTurnBehavior,
        ...forwarded,
      } as never);
      return;
    }

    const draft = this.model.draft(threadId);
    if (!draft) throw notSupported(`thread.turn.start for unknown thread ${threadId}`);
    const projectId = this.model.resolveProjectId(String(command.projectId ?? draft.projectId));
    const projectRoot = this.model.projectRoot(projectId);
    if (!projectRoot) throw notSupported(`thread.turn.start without a project folder`);
    // The draft carries the environment chosen at creation; a meta update may have recorded the
    // worktree path created for it, and the turn may repeat either.
    const announced = this.placements.get(threadId);
    const placement = await this.resolvePlacement(
      {
        ...command,
        envMode: command.envMode ?? announced?.envMode ?? draft.envMode,
        branch: command.branch ?? announced?.branch ?? draft.branch,
        worktreePath: command.worktreePath ?? announced?.worktreePath ?? draft.worktreePath,
        workingDirectory:
          command.workingDirectory ?? announced?.workingDirectory ?? draft.workingDirectory,
      },
      { cwd: projectRoot, projectId },
    );
    if (placement.envMode === "worktree") this.model.updateDraftWorkspace(threadId, placement);
    const chosen = selection ?? (draft.modelSelection as ModelSelectionInput);
    const provider = await this.resolveNeolixProvider(chosen);
    // A fork's transcript is attached to its first turn, matching the app's fork draft.
    const forkContext = this.forkContexts.get(threadId);
    const attachments = [...(forkContext ? [forkContext] : []), ...(forwarded.attachments ?? [])];
    const providerModes = await this.providerModes(provider, placement.cwd);
    await client.createAgent({
      agentId: threadId,
      provider: provider as never,
      cwd: placement.cwd,
      ...(placement.workspaceId ? { workspaceId: placement.workspaceId } : {}),
      ...creationSettings(chosen, runtimeMode, interactionMode, providerModes),
      ...(forwarded.images ? { images: forwarded.images } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      initialPrompt: message.text,
      clientMessageId: message.messageId,
      idempotencyKey: String(command.commandId),
    } as never);
    this.forkContexts.delete(threadId);
    this.model.markCreated(threadId);
  }

  /**
   * The modes a new agent of `provider` can start in. A provider that cannot list them (its
   * binary is missing, say) yields none, so the agent starts in the provider's default mode and
   * the create reports the real problem instead of a mode error.
   */
  private async providerModes(
    provider: string,
    cwd: string,
  ): Promise<readonly { readonly id: string }[]> {
    try {
      const { modes } = await this.model.client.listProviderModes(provider as never, { cwd });
      return modes ?? [];
    } catch (error) {
      console.warn(`[bridge] listProviderModes ${provider} failed:`, error);
      return [];
    }
  }

  /** The provider id the daemon creates the agent under, or a typed failure. */
  private async resolveNeolixProvider(selection: ModelSelectionInput): Promise<string> {
    const byInstance = await this.directory.resolve(this.model.client, {
      provider: selection.provider,
      instanceId: selection.instanceId,
    });
    if (byInstance) return byInstance;
    if (selection.instanceId) {
      // Synara instance ids allow uppercase and underscores; daemon provider ids do not.
      // A just-added account may not be in the refreshed directory yet, so resolve the
      // normalized id the bridge wrote to the daemon's provider config.
      const normalized = daemonProviderIdForInstanceId(selection.instanceId);
      const byNormalized = this.directory.neolixProviderFor({
        provider: selection.provider,
        instanceId: normalized,
      });
      if (byNormalized) return byNormalized;
      if (normalized !== instanceIdForProvider(selection.provider)) return normalized;
      return selection.instanceId;
    }
    throw notSupported(`provider ${selection.instanceId ?? selection.provider}`);
  }

  /**
   * The cwd a new agent runs in. A worktree thread without a path yet gets its workspace created
   * here, mirroring the app's first-send bootstrap; local threads never switch branches.
   */
  private async resolvePlacement(
    command: Command,
    fallback: { readonly cwd: string; readonly projectId: string },
  ): Promise<{
    readonly cwd: string;
    readonly workspaceId: string | null;
    readonly envMode: "local" | "worktree";
    readonly branch: string | null;
    readonly worktreePath: string | null;
  }> {
    const envMode = command.envMode === "worktree" ? "worktree" : "local";
    const branch = nonEmptyString(command.branch) ?? null;
    let worktreePath = nonEmptyString(command.worktreePath) ?? null;
    if (envMode === "worktree" && !worktreePath) {
      const created = (await this.model.client.createNeolixWorktree({
        cwd: fallback.cwd,
        ...(fallback.projectId ? { projectId: fallback.projectId } : {}),
        ...(branch ? { refName: branch } : {}),
      })) as unknown as {
        workspace?: {
          workspaceId?: string;
          workspaceDirectory?: string;
          projectRootPath?: string;
          gitRuntime?: { currentBranch?: string | null } | null;
        } | null;
        error?: string | null;
      };
      const workspace = created.workspace;
      worktreePath = workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? null;
      if (!worktreePath)
        throw bridgeError(
          "command.worktree-create-failed",
          created.error ?? "The worktree could not be created for this thread.",
          created.error ? { detail: created.error } : undefined,
        );
      const createdBranch = workspace?.gitRuntime?.currentBranch?.trim();
      this.model.rememberWorktree(worktreePath, createdBranch || branch);
      return {
        cwd: worktreePath,
        // Create the agent in the workspace the worktree create just registered. Omitting
        // this makes the daemon provision a second workspace (and a stray project) for the
        // same directory, so the thread leaves its project's sidebar group.
        workspaceId: workspace?.workspaceId?.trim() || null,
        envMode,
        branch: createdBranch || branch,
        worktreePath,
      };
    }
    return {
      cwd: worktreePath ?? nonEmptyString(command.workingDirectory) ?? fallback.cwd,
      // A worktree path announced before the first turn already owns a workspace; join it.
      workspaceId: worktreePath ? this.model.workspaceIdForDirectory(worktreePath) : null,
      envMode,
      branch,
      worktreePath,
    };
  }

  /**
   * `thread.fork.create` keeps the source provider's conversation: Neox yields a chat-history
   * attachment for the forked agent, and the client's imported transcript is served by the bridge
   * until that agent has a timeline of its own.
   */
  private async forkThread(command: Command): Promise<void> {
    const client = this.model.client;
    const threadId = String(command.threadId);
    const sourceThreadId = String(command.sourceThreadId);
    const selection = command.modelSelection as ModelSelectionInput;
    // Reject an unsupported provider now rather than on the first turn.
    await this.resolveNeolixProvider(selection);
    const throughMessageId = nonEmptyString(command.throughMessageId);
    const fork = await client.buildAgentForkContext(
      sourceThreadId,
      throughMessageId ? { boundaryMessageId: throughMessageId } : {},
    );
    if (!fork.attachment) {
      throw bridgeError(
        "command.fork-no-transcript",
        "This conversation cannot be forked: the provider returned no transcript for it.",
      );
    }
    const imported = Array.isArray(command.importedMessages) ? command.importedMessages : [];
    this.forkContexts.set(threadId, fork.attachment);
    this.model.setImportedTranscript(threadId, toImportedMessages(imported as never));
    this.model.registerDraft({
      ...this.draftShell(command),
      forkSourceThreadId: sourceThreadId,
    } as unknown as OrchestrationThreadShell);
  }

  /**
   * `thread.checkpoint.revert` names a turn count; Neox rewinds to a user message, so the count
   * is the index of the first user message to discard. `scope: "files"` keeps the conversation,
   * `scope: "conversation"` keeps the files.
   */
  private async revertToCheckpoint(command: Command): Promise<void> {
    const client = this.model.client;
    const threadId = String(command.threadId);
    const turnCount = Number(command.turnCount);
    if (this.model.importedTranscript(threadId).some((message) => message.role === "user")) {
      throw notSupported("thread.checkpoint.revert across forked history");
    }
    const timeline = await client.fetchAgentTimeline(threadId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
    });
    const userMessages = timeline.entries.filter(
      (entry) => (entry.item as { type?: string }).type === "user_message",
    );
    const target = userMessages[turnCount];
    if (!target) {
      throw bridgeError("command.nothing-to-revert", "There is nothing to revert in this thread.");
    }
    const messageId = (target.item as { messageId?: unknown }).messageId;
    if (typeof messageId !== "string" || !messageId.trim()) {
      throw bridgeError(
        "command.rewind-unsupported",
        "The provider cannot rewind to this message.",
      );
    }
    const scope = String(command.scope ?? "thread");
    await client.rewindAgent(
      threadId,
      messageId,
      scope === "files" ? "files" : scope === "conversation" ? "conversation" : "both",
    );
  }

  /**
   * A Neox agent stays on the provider it was created with, so a selection on another
   * provider's instance is not a model change for this agent and is left out.
   */
  private async applyModel(
    threadId: string,
    agent: { readonly provider: string; readonly model: string | null },
    selection: ModelSelectionInput | undefined,
  ): Promise<void> {
    if (!selection?.model || selection.model === agent.model) return;
    if ((await this.directory.resolve(this.model.client, selection)) !== agent.provider) {
      this.log(`thread ${threadId}: ignored model ${selection.model} from another provider`);
      return;
    }
    await this.model.client.setAgentModel(threadId, selection.model);
  }

  private async updateMeta(command: Command): Promise<void> {
    const client = this.model.client;
    const threadId = String(command.threadId);
    const placement: Record<string, unknown> = {};
    if (command.envMode === "local" || command.envMode === "worktree") {
      placement.envMode = command.envMode;
    }
    for (const key of ["branch", "worktreePath", "workingDirectory"] as const) {
      const value = command[key];
      if (typeof value === "string" || value === null) placement[key] = value;
    }
    if (Object.keys(placement).length > 0) {
      this.placements.set(threadId, { ...this.placements.get(threadId), ...placement });
    }
    const entry = this.model.entry(threadId);
    if (!entry) {
      // A draft (a terminal chat, say) has no agent; its title lives on the bridge's draft shell.
      if (typeof command.title === "string") this.model.renameDraft(threadId, command.title);
      return;
    }
    if (typeof command.title === "string") {
      // The sidebar labels a session with its workspace's title, which the daemon set from the
      // first prompt. Rename a workspace only this thread uses, before the agent, so the agent
      // update that refreshes clients already finds the new workspace title.
      const workspaceId = entry.agent.workspaceId?.trim();
      if (workspaceId && this.model.isSoleWorkspaceAgent(threadId, workspaceId)) {
        await client.setWorkspaceTitle(workspaceId, command.title.trim());
      }
      await client.updateAgent(threadId, { name: command.title });
    }
    if (typeof command.isSettled === "boolean") {
      // The bridge stamps the time so concurrent clients converge on the last write.
      await client.updateAgent(threadId, {
        labels: { [LABEL_SETTLED_AT]: command.isSettled ? new Date().toISOString() : "" },
      });
    }
    const selection = command.modelSelection as ModelSelectionInput | undefined;
    await this.applyModel(threadId, entry.agent, selection);
    await this.applyTraits(threadId, entry.agent, selection);
  }

  /**
   * Traits are forwarded best-effort: a provider that rejects one (an unsupported effort for
   * the current model, say) must not stop the message the user is sending.
   */
  private async applyTraits(
    threadId: string,
    agent: {
      readonly features?: readonly NeolixFeature[] | undefined;
      readonly thinkingOptionId?: string | null | undefined;
      readonly effectiveThinkingOptionId?: string | null | undefined;
      readonly runtimeInfo?: { readonly thinkingOptionId?: string | null | undefined } | undefined;
    },
    selection: ModelSelectionInput | undefined,
  ): Promise<void> {
    const options = selection?.options;
    if (!options) return;
    const thinkingOptionId = thinkingOptionFor(selection);
    const currentThinking =
      agent.effectiveThinkingOptionId ??
      agent.thinkingOptionId ??
      agent.runtimeInfo?.thinkingOptionId ??
      null;
    if (thinkingOptionId && thinkingOptionId !== currentThinking) {
      try {
        await this.model.client.setAgentThinkingOption(threadId, thinkingOptionId);
      } catch (error) {
        this.log(`thread ${threadId}: thinking ${thinkingOptionId} rejected: ${String(error)}`);
      }
    }
    if (typeof options.fastMode === "boolean") {
      const update = fastFeatureUpdate(agent.features, options.fastMode);
      if (update && currentFeatureValue(agent.features, update.featureId) !== update.value) {
        try {
          await this.model.client.setAgentFeature(threadId, update.featureId, update.value);
        } catch (error) {
          this.log(`thread ${threadId}: feature ${update.featureId} rejected: ${String(error)}`);
        }
      }
    }
  }

  private async setMode(command: Command): Promise<void> {
    const threadId = String(command.threadId);
    const entry = this.model.entry(threadId);
    if (!entry) return;
    // Each command carries only the half it changes; keep the other as the agent has it.
    const runtimeMode =
      (command.runtimeMode as RuntimeMode | undefined) ??
      toRuntimeMode(
        entry.agent.currentModeId,
        entry.agent.availableModes ?? [],
        entry.agent.provider,
      );
    const interactionMode =
      command.interactionMode === undefined
        ? toInteractionMode(entry.agent)
        : String(command.interactionMode);
    await this.applyModes(threadId, entry.agent, runtimeMode, interactionMode);
  }

  /**
   * Puts an agent in the runtime tier and interaction mode. Planning is a mode where the agent
   * offers one (Claude, Copilot, OpenCode) and otherwise Codex's plan toggle, which sits beside
   * the permission tier rather than replacing it.
   */
  private async applyModes(
    threadId: string,
    agent: {
      readonly provider: string;
      readonly cwd: string;
      readonly currentModeId?: string | null | undefined;
      readonly availableModes?: readonly { readonly id: string }[] | null | undefined;
      readonly features?: readonly NeolixFeature[] | undefined;
    },
    runtimeMode: RuntimeMode,
    interactionMode: string,
  ): Promise<void> {
    // An agent the daemon has not loaded (after a restart, say) reports no modes or features;
    // its provider's modes stand in, and the daemon loads the session on the first setter.
    const loaded = (agent.availableModes?.length ?? 0) > 0 || (agent.features?.length ?? 0) > 0;
    const availableModes = agent.availableModes?.length
      ? agent.availableModes
      : await this.providerModes(agent.provider, agent.cwd);
    const planToggle: { readonly value?: unknown } | undefined =
      agent.features?.find(
        (feature) => feature.id === PLAN_FEATURE_ID && feature.type === "toggle",
      ) ?? (!loaded && driverForProvider(agent.provider) === "codex" ? {} : undefined);
    const plansByMode = modeIdFor(runtimeMode, "plan", availableModes) !== undefined;
    const modeId = modeIdFor(
      runtimeMode,
      plansByMode ? interactionMode : "default",
      availableModes,
    );
    if (modeId && modeId !== agent.currentModeId)
      await this.model.client.setAgentMode(threadId, modeId);
    const planning = interactionMode === "plan";
    if (!plansByMode && planToggle && planToggle.value !== planning)
      await this.model.client.setAgentFeature(threadId, PLAN_FEATURE_ID, planning);
  }
}
