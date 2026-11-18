import { describe, expect, it } from "vitest";

import { AttachmentStore } from "./attachments.ts";
import { CommandDispatcher, decisionToResponse, modeIdFor } from "./commands.ts";
import type { BridgeModel } from "./model.ts";
import { ProviderDirectory } from "./providers.ts";
import { toRuntimeMode } from "./translate.ts";

const PROJECT_ID = "prj_1";
const THREAD_ID = "8a1f0e6c-0d0e-4c64-9d61-1d2f6f9b7c11";
const CLAUDE_MODES = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"].map((id) => ({
  id,
}));
const CODEX_MODES = ["auto", "auto-review", "full-access"].map((id) => ({ id }));

/** A model and daemon client that record the calls the dispatcher makes. */
function makeFakes(
  options: {
    existing?: boolean;
    thinkingOptionId?: string | null;
    features?: Array<Record<string, unknown>>;
    pendingPermissions?: Array<Record<string, unknown>>;
    timeline?: Array<Record<string, unknown>>;
    forkAttachment?: Record<string, unknown> | null;
    worktreePath?: string;
    attachments?: AttachmentStore;
    providerModes?: Array<{ id: string }> | Error;
    currentModeId?: string;
    availableModes?: Array<{ id: string }>;
    provider?: string;
    terminals?: Array<{ id: string; name: string }>;
    workspaceId?: string;
    workspaceShared?: boolean;
    announcedWorkspaceId?: string;
  } = {},
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const modeLookups: unknown[][] = [];
  const workspaceUpdates: unknown[] = [];
  const transcripts = new Map<string, unknown[]>();
  const created = new Set<string>();
  let sequence = 0;
  const drafts = new Map<string, { projectId: string; modelSelection: unknown }>();
  const client = new Proxy(
    {},
    {
      get:
        (_target, name: string) =>
        async (...args: unknown[]) => {
          // A read the dispatcher makes before creating; kept apart so `calls` lists mutations.
          if (name === "listProviderModes") {
            modeLookups.push(args);
            if (options.providerModes instanceof Error) throw options.providerModes;
            return { modes: options.providerModes ?? CLAUDE_MODES };
          }
          calls.push([name, ...args]);
          if (name === "fetchAgentTimeline") return { entries: options.timeline ?? [] };
          if (name === "listTerminals") return { terminals: options.terminals ?? [] };
          if (name === "buildAgentForkContext")
            return {
              attachment:
                options.forkAttachment === undefined
                  ? { type: "text", mimeType: "text/plain", text: "imported history" }
                  : options.forkAttachment,
              itemCount: 1,
              boundaryMessageId: null,
            };
          if (name === "createNeolixWorktree")
            return {
              workspace: {
                workspaceId: "wks-worktree",
                workspaceDirectory: options.worktreePath ?? "/repo-worktree",
                projectRootPath: "/repo",
                gitRuntime: { currentBranch: "feature-branch" },
              },
              error: null,
            };
          if (name === "uploadFile") {
            const upload = args[0] as { fileName: string; mimeType: string; bytes: Uint8Array };
            return {
              file: {
                type: "uploaded_file",
                id: "file-1",
                fileName: upload.fileName,
                mimeType: upload.mimeType,
                size: upload.bytes.byteLength,
                path: "/tmp/file-1",
              },
            };
          }
          return {};
        },
    },
  );
  const model = {
    client,
    nextSequence: () => ++sequence,
    entry: (id: string) =>
      options.existing && id === THREAD_ID
        ? {
            agent: {
              id,
              provider: options.provider ?? "claude",
              cwd: "/repo",
              model: "m1",
              currentModeId: options.currentModeId ?? "default",
              availableModes: options.availableModes ?? [{ id: "default" }, { id: "plan" }],
              thinkingOptionId: options.thinkingOptionId ?? null,
              features: options.features ?? [],
              pendingPermissions: options.pendingPermissions ?? [],
              ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            },
          }
        : undefined,
    draft: (id: string) => drafts.get(id),
    registerDraft: (shell: { id: string; projectId: string; modelSelection: unknown }) =>
      drafts.set(shell.id, shell),
    projectRoot: (id: string) => (id === PROJECT_ID ? "/repo" : undefined),
    resolveProjectId: (id: string) => id,
    allEntries: () => [],
    markCreated: (id: string) => created.add(id),
    wasCreated: (id: string) => created.has(id) || Boolean(options.existing && id === THREAD_ID),
    setImportedTranscript: (id: string, messages: unknown[]) => transcripts.set(id, messages),
    importedTranscript: (id: string) => transcripts.get(id) ?? [],
    updateDraftWorkspace: (id: string, workspace: unknown) => {
      workspaceUpdates.push([id, workspace]);
    },
    discardDraft: (id: string) => !created.has(id) && drafts.delete(id),
    renameDraft: (id: string, title: string) => {
      const draft = drafts.get(id);
      if (draft) drafts.set(id, { ...draft, title } as typeof draft);
    },
    isSoleWorkspaceAgent: () => options.workspaceShared !== true,
    workspaceIdForDirectory: () => options.announcedWorkspaceId ?? null,
    rememberWorktree: () => {},
    recordUserStop: () => {},
    clearUserStop: () => {},
    userStoppedAt: () => null,
  } as unknown as BridgeModel;
  const directory = new ProviderDirectory();
  directory.update(["claude", "codex"]);
  const store = options.attachments ?? new AttachmentStore();
  return {
    calls,
    modeLookups,
    workspaceUpdates,
    transcripts,
    store,
    drafts,
    dispatcher: new CommandDispatcher(model, directory, () => {}, store),
  };
}

const turnStart = (commandId: string) => ({
  type: "thread.turn.start",
  commandId,
  threadId: THREAD_ID,
  message: { messageId: "msg-1", role: "user", text: "Hello", attachments: [] },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-11-08T00:00:00.000Z",
});

describe("commands", () => {
  it("maps runtime and interaction modes to the Neox mode the agent offers", () => {
    expect(modeIdFor("full-access", "default", CLAUDE_MODES)).toBe("bypassPermissions");
    expect(modeIdFor("auto", "default", CLAUDE_MODES)).toBe("auto");
    expect(modeIdFor("auto", "default", [{ id: "acceptEdits" }])).toBe("acceptEdits");
    expect(modeIdFor("accept-edits", "default", [{ id: "acceptEdits" }])).toBe("acceptEdits");
    expect(modeIdFor("accept-edits", "default", [{ id: "default" }])).toBeUndefined();
    expect(modeIdFor("approval-required", "plan", [{ id: "plan" }])).toBe("plan");
    expect(modeIdFor("full-access", "default", [{ id: "default" }])).toBeUndefined();
    expect(modeIdFor("approval-required", "default", [])).toBeUndefined();
  });

  it("uses each provider's own id for a tier, and the reverse mapping agrees", () => {
    // Codex: `auto` asks, `auto-review` lets the reviewer decide.
    expect(modeIdFor("approval-required", "default", CODEX_MODES)).toBe("auto");
    expect(modeIdFor("auto", "default", CODEX_MODES)).toBe("auto-review");
    expect(modeIdFor("full-access", "default", CODEX_MODES)).toBe("full-access");
    expect(modeIdFor("accept-edits", "default", CODEX_MODES)).toBeUndefined();
    // Without the reviewer tier Codex still asks in `auto`; the reverse mapping must find it
    // so the composer can return from Full access to Ask for approval.
    const codexWithoutReview = [{ id: "auto" }, { id: "full-access" }];
    expect(modeIdFor("approval-required", "default", codexWithoutReview)).toBe("auto");
    expect(
      toRuntimeMode(
        modeIdFor("approval-required", "default", codexWithoutReview),
        codexWithoutReview,
        "codex",
      ),
    ).toBe("approval-required");
    const copilot = [
      { id: "https://agentclientprotocol.com/protocol/session-modes#agent" },
      { id: "https://agentclientprotocol.com/protocol/session-modes#plan" },
      { id: "allow-all" },
    ];
    expect(modeIdFor("approval-required", "plan", copilot)).toBe(copilot[1]?.id);
    expect(modeIdFor("approval-required", "default", copilot)).toBe(copilot[0]?.id);
    expect(modeIdFor("full-access", "default", copilot)).toBe("allow-all");
    expect(modeIdFor("approval-required", "default", [{ id: "build" }, { id: "plan" }])).toBe(
      "build",
    );
    const omp = [{ id: "full" }, { id: "write" }, { id: "ask" }];
    expect(modeIdFor("approval-required", "default", omp)).toBe("ask");
    expect(modeIdFor("full-access", "default", omp)).toBe("full");
    for (const [modes, runtimeModes] of [
      [CLAUDE_MODES, ["approval-required", "accept-edits", "auto", "full-access"]],
      [CODEX_MODES, ["approval-required", "auto", "full-access"]],
      [copilot, ["approval-required", "full-access"]],
      [omp, ["approval-required", "full-access"]],
    ] as const) {
      for (const runtimeMode of runtimeModes) {
        expect(toRuntimeMode(modeIdFor(runtimeMode, "default", modes), modes)).toBe(runtimeMode);
      }
    }
  });

  it("creates a Codex agent in the Codex mode for the chosen tier", async () => {
    const { calls, modeLookups, dispatcher } = makeFakes({ providerModes: CODEX_MODES });
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Codex thread",
      modelSelection: { provider: "codex", instanceId: "codex", model: "default" },
      runtimeMode: "approval-required",
    });
    await dispatcher.dispatch(turnStart("cmd-codex"));
    expect(modeLookups).toEqual([["codex", { cwd: "/repo" }]]);
    expect(calls.map((call) => call[0])).toEqual(["createAgent"]);
    expect(calls[0]?.[1]).toMatchObject({ provider: "codex", modeId: "auto" });
  });

  it("leaves the mode to the provider when its modes cannot be listed", async () => {
    const { calls, dispatcher } = makeFakes({ providerModes: new Error("binary missing") });
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "New thread",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "full-access",
    });
    await dispatcher.dispatch(turnStart("cmd-no-modes"));
    expect(calls.map((call) => call[0])).toEqual(["createAgent"]);
    expect(calls[0]?.[1]).not.toHaveProperty("modeId");
  });

  it("plans with Codex through its plan toggle, beside the permission tier", async () => {
    const planToggle = { id: "plan_mode", type: "toggle", label: "Plan", value: false };
    const { calls, dispatcher } = makeFakes({
      existing: true,
      currentModeId: "auto",
      availableModes: CODEX_MODES,
      features: [planToggle],
    });
    await dispatcher.dispatch({
      type: "thread.interaction-mode.set",
      commandId: "cmd-codex-plan",
      threadId: THREAD_ID,
      interactionMode: "plan",
    });
    expect(calls).toEqual([["setAgentFeature", THREAD_ID, "plan_mode", true]]);
    calls.length = 0;
    planToggle.value = true;
    // A tier change alone keeps the agent planning.
    await dispatcher.dispatch({
      type: "thread.runtime-mode.set",
      commandId: "cmd-codex-full",
      threadId: THREAD_ID,
      runtimeMode: "full-access",
    });
    expect(calls).toEqual([["setAgentMode", THREAD_ID, "full-access"]]);
  });

  it("creates a planning Codex agent with the plan toggle on and the chosen tier", async () => {
    const { calls, dispatcher } = makeFakes({ providerModes: CODEX_MODES });
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Codex plan",
      modelSelection: { provider: "codex", instanceId: "codex", model: "default" },
      runtimeMode: "full-access",
    });
    await dispatcher.dispatch({
      ...turnStart("cmd-codex-plan-create"),
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    expect(calls[0]?.[1]).toMatchObject({
      modeId: "full-access",
      featureValues: { plan_mode: true },
    });
  });

  it("applies modes to an agent the daemon has not loaded, from its provider's modes", async () => {
    const claude = makeFakes({ existing: true, availableModes: [], features: [] });
    await claude.dispatcher.dispatch({
      type: "thread.runtime-mode.set",
      commandId: "cmd-unloaded-full",
      threadId: THREAD_ID,
      runtimeMode: "full-access",
    });
    expect(claude.modeLookups).toEqual([["claude", { cwd: "/repo" }]]);
    expect(claude.calls).toEqual([["setAgentMode", THREAD_ID, "bypassPermissions"]]);

    const codex = makeFakes({
      existing: true,
      provider: "codex",
      currentModeId: "auto",
      availableModes: [],
      features: [],
      providerModes: CODEX_MODES,
    });
    await codex.dispatcher.dispatch({
      type: "thread.interaction-mode.set",
      commandId: "cmd-unloaded-plan",
      threadId: THREAD_ID,
      interactionMode: "plan",
    });
    // Codex's `auto` is its asking tier, so the tier stays; planning is the toggle.
    expect(codex.calls).toEqual([["setAgentFeature", THREAD_ID, "plan_mode", true]]);
  });

  it("keeps the agent's tier when only the interaction mode changes", async () => {
    const { calls, dispatcher } = makeFakes({
      existing: true,
      currentModeId: "bypassPermissions",
      availableModes: CLAUDE_MODES,
    });
    await dispatcher.dispatch({
      type: "thread.interaction-mode.set",
      commandId: "cmd-plan-off",
      threadId: THREAD_ID,
      interactionMode: "default",
    });
    expect(calls).toEqual([]);
    await dispatcher.dispatch({
      type: "thread.interaction-mode.set",
      commandId: "cmd-plan-on",
      threadId: THREAD_ID,
      interactionMode: "plan",
    });
    expect(calls).toEqual([["setAgentMode", THREAD_ID, "plan"]]);
  });

  it("creates the agent with the thread id on the first turn of a draft", async () => {
    const { calls, dispatcher } = makeFakes();
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "New thread",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
    });
    await dispatcher.dispatch(turnStart("cmd-1"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("createAgent");
    expect(calls[0]?.[1]).toMatchObject({
      agentId: THREAD_ID,
      provider: "claude",
      cwd: "/repo",
      initialPrompt: "Hello",
      clientMessageId: "msg-1",
      modeId: "default",
    });
  });

  it("sends to an existing agent once per command id and settles it as accepted", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    const first = await dispatcher.dispatch(turnStart("cmd-2"));
    const repeat = await dispatcher.dispatch(turnStart("cmd-2"));
    expect(repeat).toEqual(first);
    expect(calls.map((call) => call[0])).toEqual(["sendAgentMessage"]);
    expect(dispatcher.settleTurn("cmd-2")).toEqual({
      status: "accepted",
      sequence: first.sequence,
    });
  });

  it("rejects a turn that arrives after it was settled as lost", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    expect(dispatcher.settleTurn("cmd-3").status).toBe("rejected");
    await expect(dispatcher.dispatch(turnStart("cmd-3"))).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("keeps an existing agent on its provider when the selection names another one", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    await dispatcher.dispatch({
      ...turnStart("cmd-4"),
      modelSelection: { provider: "codex", instanceId: "codex", model: "auto/claude-opus-5-5" },
    });
    expect(calls.map((call) => call[0])).toEqual(["sendAgentMessage"]);
  });

  it("unarchives through the daemon's refresh path", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    await dispatcher.dispatch({ type: "thread.unarchive", threadId: THREAD_ID });
    expect(calls).toEqual([["refreshAgent", THREAD_ID]]);
  });

  it("answers a question with the keys the provider expects", async () => {
    const { calls, dispatcher } = makeFakes({
      existing: true,
      pendingPermissions: [
        {
          id: "q1",
          name: "AskUserQuestion",
          kind: "question",
          input: {
            questions: [
              {
                question: "Which one?",
                header: "Choice",
                options: [{ label: "A" }, { label: "B" }],
              },
            ],
          },
        },
      ],
    });
    await dispatcher.dispatch({
      type: "thread.user-input.respond",
      threadId: THREAD_ID,
      requestId: "q1",
      answers: { Choice: "A" },
    });
    expect(calls).toEqual([
      [
        "respondToPermission",
        THREAD_ID,
        "q1",
        { behavior: "allow", updatedInput: { answers: { Choice: "A" } } },
      ],
    ]);
  });

  it("forwards thinking effort and fast mode before sending to an existing agent", async () => {
    const { calls, dispatcher } = makeFakes({
      existing: true,
      features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }],
    });
    await dispatcher.dispatch({
      ...turnStart("cmd-5"),
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "m1",
        options: { thinking: true, effort: "high", fastMode: true },
      },
    });
    expect(calls.map((call) => call[0])).toEqual([
      "setAgentThinkingOption",
      "setAgentFeature",
      "sendAgentMessage",
    ]);
    expect(calls[0]).toEqual(["setAgentThinkingOption", THREAD_ID, "high"]);
    expect(calls[1]).toEqual(["setAgentFeature", THREAD_ID, "fast_mode", true]);
  });

  it("creates the agent with thinking and fast settings", async () => {
    const { calls, dispatcher } = makeFakes();
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "New thread",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
    });
    await dispatcher.dispatch({
      ...turnStart("cmd-6"),
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "default",
        options: { thinking: true, effort: "low", fastMode: true },
      },
    });
    expect(calls[0]?.[1]).toMatchObject({
      thinkingOptionId: "low",
      featureValues: { fast_mode: true },
    });
  });

  it("drops a draft locally on delete instead of asking the daemon", async () => {
    const { calls, dispatcher } = makeFakes();
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Import placeholder",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
    });
    await dispatcher.dispatch({ type: "thread.delete", threadId: THREAD_ID });
    expect(calls.map((call) => call[0])).not.toContain("deleteAgent");
  });

  it("stores a done mark on the agent and clears it on restore", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    await dispatcher.dispatch({ type: "thread.meta.update", threadId: THREAD_ID, isSettled: true });
    await dispatcher.dispatch({
      type: "thread.meta.update",
      threadId: THREAD_ID,
      isSettled: false,
    });
    const labelWrites = calls
      .filter((call) => call[0] === "updateAgent")
      .map((call) => (call[2] as { labels: Record<string, string> }).labels["neox.settled-at"]);
    expect(labelWrites).toHaveLength(2);
    expect(Number.isNaN(Date.parse(labelWrites[0]!))).toBe(false);
    expect(labelWrites[1]).toBe("");
  });

  it("renames a session's own workspace before its agent, and a draft in place", async () => {
    const rename = { type: "thread.meta.update", threadId: THREAD_ID, title: " 新名字 " };
    const own = makeFakes({ existing: true, workspaceId: "wks_1" });
    await own.dispatcher.dispatch(rename);
    expect(own.calls.map((call) => call.slice(0, 3))).toEqual([
      ["setWorkspaceTitle", "wks_1", "新名字"],
      ["updateAgent", THREAD_ID, { name: " 新名字 " }],
    ]);

    // Another session in the same workspace keeps the workspace's title.
    const shared = makeFakes({ existing: true, workspaceId: "wks_1", workspaceShared: true });
    await shared.dispatcher.dispatch(rename);
    expect(shared.calls.map((call) => call[0])).toEqual(["updateAgent"]);

    const draft = makeFakes();
    await draft.dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "新终端",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
    });
    await draft.dispatcher.dispatch(rename);
    expect(draft.drafts.get(THREAD_ID)).toMatchObject({ title: " 新名字 " });
    expect(draft.calls.map((call) => call[0])).not.toContain("updateAgent");
  });

  it("keeps a terminal-first thread's surface on its draft", async () => {
    const { drafts, dispatcher } = makeFakes();
    for (const [threadId, primarySurface] of [
      ["terminal-thread", "terminal"],
      ["chat-thread", undefined],
    ] as const) {
      await dispatcher.dispatch({
        type: "thread.create",
        threadId,
        projectId: PROJECT_ID,
        title: "新终端",
        modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
        runtimeMode: "approval-required",
        ...(primarySurface ? { primarySurface } : {}),
      });
    }
    expect(drafts.get("terminal-thread")).toMatchObject({ primarySurface: "terminal" });
    expect(drafts.get("chat-thread")).not.toHaveProperty("primarySurface");
  });

  it("closes the deleted thread's daemon terminals and no other", async () => {
    const terminals = [
      { id: "t-own", name: `synara:${THREAD_ID}:default` },
      { id: "t-own-2", name: `synara:${THREAD_ID}:terminal-2` },
      { id: "t-other", name: "synara:another-thread:default" },
      { id: "t-script", name: "synara:dev:prj_1" },
    ];
    for (const existing of [true, false]) {
      const { calls, dispatcher } = makeFakes({ existing, terminals });
      if (!existing) {
        await dispatcher.dispatch({
          type: "thread.create",
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "新终端",
          modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
          runtimeMode: "approval-required",
        });
      }
      await dispatcher.dispatch({ type: "thread.delete", threadId: THREAD_ID });
      expect(calls.filter((call) => call[0] === "killTerminal").map((call) => call[1])).toEqual([
        "t-own",
        "t-own-2",
      ]);
    }
  });

  it("moves a supervised chat to full access when a command is always allowed", async () => {
    const shell = {
      id: "p1",
      name: "Bash",
      kind: "tool",
      detail: { type: "shell", command: "ls" },
    };
    const supervised = makeFakes({
      existing: true,
      currentModeId: "default",
      availableModes: CLAUDE_MODES,
      pendingPermissions: [shell],
    });
    await supervised.dispatcher.dispatch({
      type: "thread.approval.respond",
      threadId: THREAD_ID,
      requestId: "p1",
      decision: "acceptForSession",
    });
    expect(supervised.calls).toEqual([
      ["respondToPermission", THREAD_ID, "p1", { behavior: "allow" }],
      ["setAgentMode", THREAD_ID, "bypassPermissions"],
    ]);

    // A tool request keeps the provider's narrow grant; "accept once" changes nothing either.
    const tool = makeFakes({
      existing: true,
      currentModeId: "default",
      availableModes: CLAUDE_MODES,
      pendingPermissions: [
        { id: "p2", name: "mcp__x", kind: "tool" },
        { ...shell, id: "p3" },
      ],
    });
    await tool.dispatcher.dispatch({
      type: "thread.approval.respond",
      threadId: THREAD_ID,
      requestId: "p2",
      decision: "acceptForSession",
    });
    await tool.dispatcher.dispatch({
      type: "thread.approval.respond",
      threadId: THREAD_ID,
      requestId: "p3",
      decision: "accept",
    });
    expect(tool.calls.filter((call) => call[0] === "setAgentMode")).toEqual([]);
  });

  it("answers approvals and interrupts through the daemon", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    await dispatcher.dispatch({
      type: "thread.approval.respond",
      threadId: THREAD_ID,
      requestId: "p1",
      decision: "accept",
    });
    await dispatcher.dispatch({
      type: "thread.approval.respond",
      threadId: THREAD_ID,
      requestId: "p2",
      decision: "decline",
    });
    await dispatcher.dispatch({
      type: "thread.approval.respond",
      threadId: THREAD_ID,
      requestId: "p3",
      decision: "cancel",
    });
    await dispatcher.dispatch({ type: "thread.turn.interrupt", threadId: THREAD_ID });
    expect(calls).toEqual([
      ["respondToPermission", THREAD_ID, "p1", { behavior: "allow" }],
      ["respondToPermission", THREAD_ID, "p2", { behavior: "deny", message: "Declined by user." }],
      ["cancelAgent", THREAD_ID],
      ["cancelAgent", THREAD_ID],
    ]);
  });

  it("maps approval decisions onto the provider's own grant and action ids", () => {
    const claude = { suggestions: [{ type: "addRules", destination: "session" }] };
    expect(decisionToResponse("acceptForSession", claude)).toEqual({
      behavior: "allow",
      updatedPermissions: claude.suggestions,
    });
    const opencode = {
      actions: [
        { id: "once", behavior: "allow" as const },
        { id: "always", behavior: "allow" as const },
        { id: "reject", behavior: "deny" as const },
      ],
    };
    expect(decisionToResponse("acceptForSession", opencode)).toEqual({
      behavior: "allow",
      selectedActionId: "always",
    });
    expect(decisionToResponse("accept", opencode)).toEqual({
      behavior: "allow",
      selectedActionId: "once",
    });
    expect(decisionToResponse("decline", opencode)).toEqual({
      behavior: "deny",
      message: "Declined by user.",
      selectedActionId: "reject",
    });
    // No provider grant: this request is allowed once; the web widens the runtime mode.
    expect(decisionToResponse("acceptForSession", undefined)).toEqual({ behavior: "allow" });
  });

  it("answers a provider action by its id and behavior", () => {
    const plan = {
      actions: [
        { id: "reject", behavior: "deny" as const },
        { id: "implement", behavior: "allow" as const },
        { id: "implement_resume", behavior: "allow" as const },
      ],
    };
    expect(decisionToResponse("accept", plan, "implement_resume")).toEqual({
      behavior: "allow",
      selectedActionId: "implement_resume",
    });
    const acp = { actions: [{ id: "reject_always", behavior: "deny" as const }] };
    expect(decisionToResponse("decline", acp, "reject_always")).toEqual({
      behavior: "deny",
      message: "Declined by user.",
      selectedActionId: "reject_always",
    });
    expect(() => decisionToResponse("accept", plan, "gone")).toThrow(/no longer offered/u);
  });

  it("forwards staged images when the first turn creates the agent", async () => {
    const { calls, dispatcher, store } = makeFakes();
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "New thread",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
    });
    const image = store.stage({
      type: "image",
      name: "shot.png",
      mimeType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await dispatcher.dispatch({
      ...turnStart("cmd-image"),
      message: { messageId: "msg-image", role: "user", text: "Look", attachments: [image] },
    });
    expect(calls[0]?.[1]).toMatchObject({
      images: [{ data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" }],
      initialPrompt: "Look",
    });
  });

  it("uploads staged files to the daemon and sends them with the turn", async () => {
    const { calls, dispatcher, store } = makeFakes({ existing: true });
    const file = store.stage({
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([4, 5]),
    });
    await dispatcher.dispatch({
      ...turnStart("cmd-file"),
      message: { messageId: "msg-file", role: "user", text: "Read this", attachments: [file] },
    });
    expect(calls.map((call) => call[0])).toEqual(["uploadFile", "sendAgentMessage"]);
    expect(calls[0]?.[1]).toMatchObject({ fileName: "notes.txt", mimeType: "text/plain" });
    expect(calls[1]?.[3]).toMatchObject({
      messageId: "msg-file",
      attachments: [
        { type: "uploaded_file", fileName: "notes.txt", id: "file-1", path: "/tmp/file-1" },
      ],
    });
  });

  it("refuses a turn whose staged attachment is gone", async () => {
    const { calls, dispatcher } = makeFakes({ existing: true });
    await expect(
      dispatcher.dispatch({
        ...turnStart("cmd-gone"),
        message: {
          messageId: "msg-gone",
          role: "user",
          text: "Look",
          attachments: [
            { type: "image", id: "gone", name: "gone.png", mimeType: "image/png", sizeBytes: 1 },
          ],
        },
      }),
    ).rejects.toThrow(/no longer available/u);
    expect(calls).toHaveLength(0);
  });

  it("forks as a draft whose first turn carries the provider's chat-history attachment", async () => {
    const FORK_ID = "0b6f7b1e-9c1e-4f0a-9f0e-2f6c3f0f6a11";
    const { calls, dispatcher, transcripts } = makeFakes({ existing: true });
    await dispatcher.dispatch({
      type: "thread.fork.create",
      commandId: "cmd-fork",
      threadId: FORK_ID,
      sourceThreadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Forked chat",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
      branch: null,
      worktreePath: null,
      importedMessages: [
        {
          messageId: "imported-1",
          role: "user",
          text: "Earlier question",
          createdAt: "2026-11-08T00:00:00.000Z",
          updatedAt: "2026-11-08T00:00:01.000Z",
        },
      ],
      createdAt: "2026-11-08T00:00:02.000Z",
    });
    expect(calls.map((call) => call[0])).toEqual(["buildAgentForkContext"]);
    expect(transcripts.get(FORK_ID)).toHaveLength(1);

    await dispatcher.dispatch({
      ...turnStart("cmd-fork-turn"),
      threadId: FORK_ID,
      message: { messageId: "msg-fork", role: "user", text: "Continue", attachments: [] },
    });
    expect(calls.map((call) => call[0])).toEqual(["buildAgentForkContext", "createAgent"]);
    expect(calls[1]?.[1]).toMatchObject({
      agentId: FORK_ID,
      provider: "claude",
      cwd: "/repo",
      initialPrompt: "Continue",
      attachments: [{ type: "text", mimeType: "text/plain", text: "imported history" }],
    });
  });

  it("rewinds a checkpoint to the user message named by the turn count", async () => {
    const timeline = [
      { seqStart: 1, item: { type: "user_message", messageId: "u1", text: "one" } },
      { seqStart: 2, item: { type: "assistant_message", messageId: "a1", text: "ok" } },
      { seqStart: 3, item: { type: "user_message", messageId: "u2", text: "two" } },
    ];
    const { calls, dispatcher } = makeFakes({ existing: true, timeline });
    await dispatcher.dispatch({
      type: "thread.checkpoint.revert",
      threadId: THREAD_ID,
      turnCount: 1,
      scope: "thread",
    });
    await dispatcher.dispatch({
      type: "thread.checkpoint.revert",
      threadId: THREAD_ID,
      turnCount: 1,
      scope: "files",
    });
    await dispatcher.dispatch({
      type: "thread.checkpoint.revert",
      threadId: THREAD_ID,
      turnCount: 1,
      scope: "conversation",
    });
    expect(calls.map((call) => call[0])).toEqual([
      "fetchAgentTimeline",
      "rewindAgent",
      "fetchAgentTimeline",
      "rewindAgent",
      "fetchAgentTimeline",
      "rewindAgent",
    ]);
    expect(calls[1]).toEqual(["rewindAgent", THREAD_ID, "u2", "both"]);
    expect(calls[3]).toEqual(["rewindAgent", THREAD_ID, "u2", "files"]);
    expect(calls[5]).toEqual(["rewindAgent", THREAD_ID, "u2", "conversation"]);
  });

  it("creates the worktree on the first worktree turn and creates the agent there", async () => {
    const { calls, dispatcher, workspaceUpdates } = makeFakes();
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Worktree chat",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
      envMode: "worktree",
      branch: "feature",
      worktreePath: null,
    });
    await dispatcher.dispatch({ ...turnStart("cmd-worktree"), envMode: "worktree" });
    expect(calls.map((call) => call[0])).toEqual(["createNeolixWorktree", "createAgent"]);
    expect(calls[0]?.[1]).toMatchObject({
      cwd: "/repo",
      projectId: PROJECT_ID,
      refName: "feature",
    });
    expect(calls[1]?.[1]).toMatchObject({
      cwd: "/repo-worktree",
      workspaceId: "wks-worktree",
    });
    expect(workspaceUpdates).toHaveLength(1);
  });

  it("uses the worktree announced by thread.meta.update instead of creating a second one", async () => {
    const { calls, dispatcher } = makeFakes({ announcedWorkspaceId: "wks-announced" });
    await dispatcher.dispatch({
      type: "thread.create",
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Worktree chat",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "default" },
      runtimeMode: "approval-required",
      envMode: "worktree",
      branch: "feature",
      worktreePath: null,
    });
    await dispatcher.dispatch({
      type: "thread.meta.update",
      commandId: "cmd-meta",
      threadId: THREAD_ID,
      envMode: "worktree",
      branch: "synara/ab12cd34",
      worktreePath: "/created-worktree",
    });
    await dispatcher.dispatch({
      ...turnStart("cmd-worktree"),
      envMode: "worktree",
      branch: "synara/ab12cd34",
    });
    expect(calls.map((call) => call[0])).toEqual(["createAgent"]);
    expect(calls[0]?.[1]).toMatchObject({
      cwd: "/created-worktree",
      workspaceId: "wks-announced",
    });
  });
});
