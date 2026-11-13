import {
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type NeolixTimelineEntry,
  toProjectShell,
  toProviderKind,
  toRuntimeMode,
  toInteractionMode,
  systemErrorCause,
  toThread,
  toThreadShell,
  toThreadTimeline,
  toUserInputQuestions,
  parseQuestionAnswers,
} from "./translate.ts";
import type { FetchAgentsEntry } from "../../../../client/dist/daemon-client.js";

const AT = "2026-11-05T05:27:06.873Z";
const PLAN_TOGGLE = { id: "plan_mode", type: "toggle", value: false };

function makeEntry(overrides: Record<string, unknown> = {}): FetchAgentsEntry {
  return {
    agent: {
      id: "4916614f-c855-4774-9cd0-d66d1f1baa96",
      provider: "neolix-gateway",
      cwd: "/repo",
      model: "gateway/auto",
      runtimeInfo: {
        provider: "neolix-gateway",
        sessionId: "s1",
        model: "gateway/auto",
        modeId: "default",
      },
      createdAt: AT,
      updatedAt: AT,
      lastUserMessageAt: AT,
      status: "idle",
      activeTurn: null,
      currentModeId: "default",
      availableModes: [],
      features: [],
      pendingPermissions: [],
      persistence: {
        provider: "neolix-gateway",
        sessionId: "s1",
        metadata: { provider: "claude" },
      },
      title: "Add a comment to README",
      labels: {},
      archivedAt: null,
      ...overrides,
    },
    project: {
      projectKey: "prj_714ff0b821f44464",
      projectName: "Neox",
      workspaceName: "main",
      checkout: {
        cwd: "/repo",
        currentBranch: "main",
        remoteUrl: null,
        worktreeRoot: "/repo",
        isGit: true,
        isNeolixOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  } as unknown as FetchAgentsEntry;
}

function timelineEntry(seq: number, item: Record<string, unknown>): NeolixTimelineEntry {
  return {
    provider: "neolix-gateway",
    item,
    timestamp: `2026-11-05T05:27:0${seq}.000Z`,
    seqStart: seq,
    seqEnd: seq,
    sourceSeqRanges: [],
    collapsed: [],
  } as unknown as NeolixTimelineEntry;
}

const TIMELINE = [
  timelineEntry(1, { type: "user_message", text: "Add a comment", messageId: "u1" }),
  timelineEntry(2, { type: "reasoning", text: "Looking at README" }),
  timelineEntry(3, {
    type: "tool_call",
    callId: "call-1",
    name: "Edit",
    status: "completed",
    error: null,
    detail: { type: "edit", filePath: "README.md", unifiedDiff: "+<!-- note -->" },
  }),
  timelineEntry(4, { type: "assistant_message", text: "Done.", messageId: "a1" }),
];

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function askCall(status: "running" | "completed" | "canceled", output?: unknown) {
  return {
    type: "tool_call",
    callId: "toolu_q",
    name: "AskUserQuestion",
    status,
    error: null,
    detail: {
      type: "unknown",
      input: {
        questions: [
          {
            question: "选哪种颜色？",
            header: "颜色",
            options: [{ label: "红色" }, { label: "蓝色" }],
          },
        ],
      },
      ...(output === undefined ? {} : { output }),
    },
  } as const;
}

describe("translate", () => {
  it("encodes a project shell with the contract schema", () => {
    const shell = toProjectShell(
      { projectId: "prj_1", projectDisplayName: "Neox", projectRootPath: "/repo" },
      AT,
    );
    expect(() => encode(OrchestrationProjectShell, shell)).not.toThrow();
  });

  it("marks only the project at the host home folder as the Home chat container", () => {
    const project = { projectId: "prj_1", projectDisplayName: "me", projectRootPath: "/Users/me/" };
    expect(toProjectShell(project, AT, "/Users/me").kind).toBe("chat");
    expect(toProjectShell(project, AT, "/Users/other").kind).toBe("project");
    expect(toProjectShell(project, AT).kind).toBe("project");
  });

  it("carries the project's neox.json actions, but not on the Home chat container", () => {
    const project = { projectId: "prj_1", projectDisplayName: "neox", projectRootPath: "/repo" };
    const scripts = [
      { id: "ping", name: "ping", command: "echo pong", icon: "play", runOnWorktreeCreate: false },
    ] as const;
    expect(toProjectShell(project, AT, "/Users/me", false, scripts).scripts).toEqual(scripts);
    expect(toProjectShell(project, AT, "/repo", false, scripts).scripts).toEqual([]);
  });

  it("hands tool details to the web in the provider shapes its work log parses", () => {
    const tool = (callId: string, detail: Record<string, unknown>) =>
      timelineEntry(2, {
        type: "tool_call",
        callId,
        name: "T",
        status: "completed",
        error: null,
        detail,
      });
    const timeline = toThreadTimeline(makeEntry().agent, [
      tool("e", {
        type: "edit",
        filePath: "a.ts",
        oldString: "x",
        newString: "y",
        unifiedDiff: "-x\n+y",
      }),
      tool("s", { type: "shell", command: "ls", output: "z".repeat(25_000), exitCode: 2 }),
      tool("w", { type: "write", filePath: "b.ts", content: "hi" }),
    ]);
    const dataOf = (callId: string) =>
      (
        timeline.activities.find((activity) => activity.id.endsWith(`:${callId}`))?.payload as {
          data: Record<string, unknown>;
        }
      ).data;

    expect(dataOf("e")).toMatchObject({
      input: { file_path: "a.ts", old_string: "x", new_string: "y" },
      unifiedDiff: "-x\n+y",
      toolCallId: "e",
    });
    const shell = dataOf("s") as { input: unknown; rawOutput: { output: string } };
    expect(shell.input).toEqual({ command: "ls" });
    expect(shell.rawOutput).toMatchObject({ exitCode: 2, truncated: true });
    expect(shell.rawOutput.output).toHaveLength(20_000);
    expect(dataOf("w")).toMatchObject({ input: { file_path: "b.ts", content: "hi" } });
  });

  it("reads the done mark from its label and the latest prompt from the daemon", () => {
    const settled = toThreadShell(
      makeEntry({ labels: { "neox.settled-at": "2026-11-10T08:00:00.000Z" } }),
      null,
    );
    expect(() => encode(OrchestrationThreadShell, settled)).not.toThrow();
    expect(settled.settledAt).toBe("2026-11-10T08:00:00.000Z");
    expect(settled.latestHumanMessageAt).toBe(AT);
    // Restored (empty) and unparseable labels both read as not done.
    for (const value of ["", "not a date"]) {
      expect(
        toThreadShell(makeEntry({ labels: { "neox.settled-at": value } }), null).settledAt,
      ).toBe(null);
    }
  });

  it("folds the workspace pin, subagent labels and last known PR into the shell", () => {
    const shell = toThreadShell(
      makeEntry({
        labels: {
          "neolix.parent-agent-id": "parent-agent",
          "neolix.subagent-agent-id": "subagent-1",
          "neolix.subagent-nickname": "Kepler",
          "neolix.subagent-role": "explorer",
        },
      }),
      null,
      {
        isPinned: true,
        lastKnownPr: {
          number: 7,
          title: "Add a feature",
          url: "https://github.com/neolix/neolix/pull/7",
          baseBranch: "main",
          headBranch: "feature",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
          additions: null,
          deletions: null,
          changedFiles: null,
        },
      },
    );
    expect(() => encode(OrchestrationThreadShell, shell)).not.toThrow();
    expect(shell.isPinned).toBe(true);
    expect(shell.parentThreadId).toBe("parent-agent");
    expect(shell.subagentAgentId).toBe("subagent-1");
    expect(shell.subagentNickname).toBe("Kepler");
    expect(shell.subagentRole).toBe("explorer");
    expect(shell.lastKnownPr).toMatchObject({ number: 7, headBranch: "feature" });
  });

  it("encodes a thread shell and maps gateway agents to the provider they run on", () => {
    const shell = toThreadShell(makeEntry(), null);
    expect(() => encode(OrchestrationThreadShell, shell)).not.toThrow();
    expect(shell.modelSelection.provider).toBe("claudeAgent");
    expect(shell.projectId).toBe("prj_714ff0b821f44464");
    expect(shell.branch).toBe("main");
    expect(shell.session?.status).toBe("ready");
    expect(shell.session?.providerName).toBe("claudeAgent");
    expect(shell.session?.providerInstanceId).toBe(shell.modelSelection.instanceId);
  });

  it("folds a timeline into one turn with messages and activities", () => {
    const entry = makeEntry();
    const timeline = toThreadTimeline(entry.agent, TIMELINE);
    expect(timeline.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Add a comment"],
      ["assistant", "Done."],
    ]);
    expect(timeline.activities.map((a) => a.kind)).toEqual(["task.progress", "tool.completed"]);
    expect(new Set(timeline.messages.map((m) => m.turnId)).size).toBe(1);
    expect(timeline.latestTurn).toMatchObject({ state: "completed", assistantMessageId: "a1" });

    const thread = toThread(toThreadShell(entry, timeline.latestTurn), timeline);
    expect(() => encode(OrchestrationThread, thread)).not.toThrow();
  });

  it("maps persisted daemon attachments onto the user message chips", () => {
    const entry = makeEntry();
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, {
        type: "user_message",
        text: "Review this",
        messageId: "provider-user-1",
        attachments: [
          {
            type: "stored_image",
            id: "0f8fad5b-d9cb-469f-a165-70867728950e",
            fileName: "shot.png",
            mimeType: "image/png",
            size: 8,
            path: "/home/.neox/attachments/0f8fad5b-d9cb-469f-a165-70867728950e.png",
          },
          {
            type: "uploaded_file",
            id: "upload_1",
            fileName: "notes.txt",
            mimeType: "text/plain",
            size: 42,
            path: "/tmp/notes.txt",
          },
          {
            type: "review",
            mimeType: "application/neolix-review",
            cwd: "/repo",
            mode: "uncommitted",
            baseRef: "main",
            comments: [
              {
                filePath: "src/app.ts",
                side: "new",
                lineNumber: 12,
                body: "Rename this",
                context: {
                  hunkHeader: "@@ -10,3 +10,3 @@",
                  targetLine: {
                    oldLineNumber: 11,
                    newLineNumber: 12,
                    type: "context",
                    content: "const x = 1;",
                  },
                  lines: [
                    {
                      oldLineNumber: 11,
                      newLineNumber: 12,
                      type: "context",
                      content: "const x = 1;",
                    },
                  ],
                },
              },
            ],
          },
          { type: "text", mimeType: "text/plain", text: "selected text" },
          {
            type: "github_pr",
            mimeType: "application/github-pr",
            number: 7,
            title: "PR",
            url: "u",
          },
        ],
      }),
    ]);

    expect(timeline.messages[0]?.attachments).toEqual([
      {
        type: "image",
        id: "0f8fad5b-d9cb-469f-a165-70867728950e",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 8,
      },
      {
        type: "file",
        id: "upload_1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 42,
      },
      {
        type: "review",
        cwd: "/repo",
        mode: "uncommitted",
        baseRef: "main",
        comments: [
          expect.objectContaining({
            filePath: "src/app.ts",
            lineNumber: 12,
            body: "Rename this",
          }),
        ],
      },
    ]);
    const thread = toThread(toThreadShell(entry, timeline.latestTurn), timeline);
    expect(() => encode(OrchestrationThread, thread)).not.toThrow();
  });

  it("marks the latest turn running and exposes it as the active turn while the agent runs", () => {
    const entry = makeEntry({ status: "running" });
    const timeline = toThreadTimeline(entry.agent, TIMELINE.slice(0, 2));
    const shell = toThreadShell(entry, timeline.latestTurn);
    expect(timeline.latestTurn?.state).toBe("running");
    expect(shell.session?.activeTurnId).toBe(timeline.latestTurn?.turnId);
    expect(() => encode(OrchestrationThreadShell, shell)).not.toThrow();
  });

  it("keeps a question option's preview and drops blank ones", () => {
    const questions = toUserInputQuestions({
      questions: [
        {
          header: "Layout",
          question: "Which layout?",
          options: [
            { label: "Stacked", description: "Stacked cards", preview: "| a | b |\n| - | - |" },
            { label: "Inline", description: "Inline chips", preview: "   " },
          ],
        },
      ],
    });
    expect(questions?.[0]?.options).toEqual([
      { label: "Stacked", description: "Stacked cards", preview: "| a | b |\n| - | - |" },
      { label: "Inline", description: "Inline chips" },
    ]);
  });

  it("maps Neox permission modes onto Synara runtime modes", () => {
    expect(toRuntimeMode("bypassPermissions")).toBe("full-access");
    expect(toRuntimeMode("acceptEdits")).toBe("accept-edits");
    expect(toRuntimeMode("default")).toBe("approval-required");
    expect(toRuntimeMode(null)).toBe("approval-required");
    // Codex's `auto` asks; its `auto-review` is the reviewer-decides tier.
    const codex = [{ id: "auto" }, { id: "auto-review" }, { id: "full-access" }];
    expect(toRuntimeMode("auto", codex)).toBe("approval-required");
    expect(toRuntimeMode("auto-review", codex)).toBe("auto");
    expect(toRuntimeMode("auto", [{ id: "auto" }, { id: "default" }])).toBe("auto");
    expect(toRuntimeMode("allow-all")).toBe("full-access");
    // An unloaded agent lists no modes; the provider tells Codex's `auto` apart.
    expect(toRuntimeMode("auto", [], "codex")).toBe("approval-required");
    expect(toRuntimeMode("auto", [], "claude")).toBe("auto");
    expect(toRuntimeMode("full")).toBe("full-access");
  });

  it("reads planning from a plan mode or Codex's plan toggle", () => {
    expect(toInteractionMode({ currentModeId: "plan" })).toBe("plan");
    expect(
      toInteractionMode({
        currentModeId: "https://agentclientprotocol.com/protocol/session-modes#plan",
      }),
    ).toBe("plan");
    expect(
      toInteractionMode({ currentModeId: "auto", features: [{ ...PLAN_TOGGLE, value: true }] }),
    ).toBe("plan");
    expect(toInteractionMode({ currentModeId: "auto", features: [PLAN_TOGGLE] })).toBe("default");
    expect(toInteractionMode({ currentModeId: "default" })).toBe("default");
  });

  it("keeps known providers and falls back to Claude", () => {
    expect(toProviderKind(makeEntry({ provider: "codex" }).agent)).toBe("codex");
    expect(toProviderKind(makeEntry({ provider: "copilot", persistence: null }).agent)).toBe(
      "claudeAgent",
    );
  });

  it("keeps an archived thread and maps its archivedAt", () => {
    const entry = makeEntry({ archivedAt: "2026-11-06T01:00:00.000Z" });
    const shell = toThreadShell(entry, null);
    expect(shell.archivedAt).toBe("2026-11-06T01:00:00.000Z");
    expect(() => encode(OrchestrationThreadShell, shell)).not.toThrow();
  });

  it("forwards thinking effort and fast mode on the model selection", () => {
    const entry = makeEntry({
      thinkingOptionId: "high",
      features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: true }],
    });
    const shell = toThreadShell(entry, null);
    expect(shell.modelSelection.options).toMatchObject({
      thinking: true,
      effort: "high",
      fastMode: true,
    });
    expect(() => encode(OrchestrationThreadShell, shell)).not.toThrow();
  });

  it("translates todo, compaction, plan and question items", () => {
    const entry = makeEntry({
      pendingPermissions: [
        {
          id: "q1",
          provider: "claude",
          name: "AskUserQuestion",
          kind: "question",
          title: "Question",
          input: {
            questions: [
              {
                question: "Which provider?",
                header: "Provider",
                options: [{ label: "Claude", description: "Use Claude Code" }, { label: "Codex" }],
                multiSelect: false,
              },
            ],
          },
        },
      ],
    });
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, { type: "user_message", text: "Plan it", messageId: "u1" }),
      timelineEntry(2, {
        type: "todo",
        items: [
          { text: "Inspect", completed: false, status: "in_progress" },
          { text: "Write", completed: true },
        ],
      }),
      timelineEntry(3, {
        type: "compaction",
        status: "completed",
        trigger: "auto",
        preTokens: 1200,
      }),
      timelineEntry(4, {
        type: "tool_call",
        callId: "plan-1",
        name: "ExitPlanMode",
        status: "completed",
        error: null,
        detail: { type: "plan", text: "# Plan\n\n- Ship it" },
      }),
    ]);

    const kinds = timeline.activities.map((activity) => activity.kind);
    expect(kinds).toContain("turn.tasks.updated");
    expect(kinds).toContain("context-compaction");
    expect(kinds).toContain("user-input.requested");
    expect(kinds).not.toContain("approval.requested");
    expect(kinds).not.toContain("tool.completed");

    const tasks = timeline.activities.find((activity) => activity.kind === "turn.tasks.updated");
    expect((tasks?.payload as { tasks: unknown }).tasks).toEqual([
      { task: "Inspect", status: "inProgress" },
      { task: "Write", status: "completed" },
    ]);
    const compaction = timeline.activities.find(
      (activity) => activity.kind === "context-compaction",
    );
    expect(compaction?.payload).toMatchObject({ state: "compacted", status: "completed" });
    const question = timeline.activities.find(
      (activity) => activity.kind === "user-input.requested",
    );
    expect(question?.payload).toMatchObject({
      requestId: "q1",
      questions: [
        {
          id: "Provider",
          header: "Provider",
          question: "Which provider?",
          options: [
            { label: "Claude", description: "Use Claude Code" },
            { label: "Codex", description: "Codex" },
          ],
        },
      ],
    });

    expect(timeline.proposedPlans).toHaveLength(1);
    expect(timeline.proposedPlans[0]).toMatchObject({
      planMarkdown: "# Plan\n\n- Ship it",
      turnId: timeline.latestTurn?.turnId,
    });

    const shell = toThreadShell(entry, timeline.latestTurn);
    expect(shell.hasPendingUserInput).toBe(true);
    expect(shell.hasPendingApprovals).toBe(false);
    const thread = toThread(shell, timeline);
    expect(() => encode(OrchestrationThread, thread)).not.toThrow();
  });

  it("turns a settled AskUserQuestion call into a question → answer pair, not a tool row", () => {
    const entry = makeEntry({});
    const kindsFor = (status: "running" | "completed" | "canceled", output?: unknown) =>
      toThreadTimeline(entry.agent, [
        timelineEntry(1, { type: "user_message", text: "ask", messageId: "u1" }),
        timelineEntry(2, askCall(status, output)),
      ]).activities;

    // While unanswered the pending permission carries the question; no raw tool row.
    expect(kindsFor("running").map((activity) => activity.kind)).toEqual([]);

    const answered = kindsFor("completed", {
      output: 'Your questions have been answered: "选哪种颜色？"="蓝色". You can now continue.',
    });
    expect(answered.map((activity) => activity.kind)).toEqual([
      "user-input.requested",
      "user-input.resolved",
    ]);
    expect(answered[1]?.payload).toEqual({
      requestId: "toolu_q",
      answers: { "选哪种颜色？": "蓝色" },
    });

    const cancelled = kindsFor("canceled");
    expect(cancelled[1]?.payload).toEqual({ requestId: "toolu_q", answers: {} });
  });

  it("marks a call the user declined at its approval as declined, not failed", () => {
    const toolActivity = (error: unknown) =>
      toThreadTimeline(makeEntry({}).agent, [
        timelineEntry(1, { type: "user_message", text: "run", messageId: "u1" }),
        timelineEntry(2, {
          type: "tool_call",
          callId: "toolu_d",
          name: "Bash",
          status: "failed",
          error,
          detail: { type: "shell", command: "echo x" },
        }),
      ]).activities.find((activity) => activity.kind === "tool.completed");

    const declined = toolActivity({
      type: "tool_result",
      content: "Declined by user.",
      is_error: true,
    });
    expect(declined?.tone).toBe("tool");
    expect(declined?.payload).toMatchObject({ status: "declined" });

    const failed = toolActivity({ type: "tool_result", content: "exit 1", is_error: true });
    expect(failed?.tone).toBe("error");
    expect(failed?.payload).toMatchObject({ status: "failed" });
  });

  it("reads every answer pair from an AskUserQuestion result", () => {
    expect(
      parseQuestionAnswers({
        output: 'Your questions have been answered: "A?"="one", "B \\"x\\"?"="two, three". Go on.',
      }),
    ).toEqual({ "A?": "one", 'B "x"?': "two, three" });
    expect(parseQuestionAnswers(undefined)).toEqual({});
  });

  it("exposes provider usage as the context window meter snapshot", () => {
    const entry = makeEntry({
      lastUsage: {
        contextWindowUsedTokens: 12_345,
        contextWindowMaxTokens: 200_000,
        inputTokens: 10_000,
        outputTokens: 2_345,
      },
    });
    const timeline = toThreadTimeline(entry.agent, []);
    const usage = timeline.activities.find(
      (activity) => activity.kind === "context-window.updated",
    );
    expect(usage?.payload).toMatchObject({
      usedTokens: 12_345,
      maxTokens: 200_000,
      inputTokens: 10_000,
      outputTokens: 2_345,
    });
    expect(usage?.turnId).toBeNull();
  });

  it("carries the daemon's session cost on the context window snapshot", () => {
    const entry = makeEntry({ lastUsage: { totalCostUsd: 0.42 } });
    const usage = toThreadTimeline(entry.agent, []).activities.find(
      (activity) => activity.kind === "context-window.updated",
    );
    expect(usage?.payload).toMatchObject({ usedTokens: 0, cumulativeCostUsd: 0.42 });
  });

  it("passes on only the provider actions the standard approval choices miss", () => {
    const entry = makeEntry({
      status: "running",
      pendingPermissions: [
        {
          id: "perm-acp",
          provider: "acp",
          name: "edit",
          kind: "tool",
          actions: [
            { id: "allow_once", label: "Allow once", behavior: "allow" },
            { id: "allow_always", label: "Always allow", behavior: "allow" },
            { id: "reject_once", label: "Reject", behavior: "deny" },
            { id: "reject_always", label: "Always reject", behavior: "deny" },
          ],
        },
      ],
    } as never);
    const approval = toThreadTimeline(entry.agent, []).activities.find(
      (activity) => activity.kind === "approval.requested",
    );
    expect(approval?.payload).toMatchObject({
      providerActions: [{ id: "reject_always", label: "Always reject", behavior: "deny" }],
    });
  });

  it("carries the provider intent for plan implementation choices", () => {
    const entry = makeEntry({
      status: "running",
      pendingPermissions: [
        {
          id: "perm-plan",
          provider: "claude",
          name: "ExitPlanMode",
          kind: "plan",
          actions: [
            { id: "reject", label: "Reject", behavior: "deny", intent: "dismiss" },
            { id: "implement", label: "Implement", behavior: "allow", intent: "implement" },
            {
              id: "implement_resume",
              label: "Implement with Auto",
              behavior: "allow",
              intent: "implement_resume",
            },
          ],
        },
      ],
    } as never);
    const approval = toThreadTimeline(entry.agent, []).activities.find(
      (activity) => activity.kind === "approval.requested",
    );
    expect(approval?.payload).toMatchObject({
      approvalScope: "plan",
      providerActions: [
        {
          id: "implement_resume",
          label: "Implement with Auto",
          behavior: "allow",
          intent: "implement_resume",
        },
      ],
    });
  });

  it("turns a pending permission into an approval request the composer can answer", () => {
    const entry = makeEntry({
      status: "running",
      pendingPermissions: [
        {
          id: "perm-1",
          name: "Bash",
          kind: "tool",
          title: "Run ls",
          detail: { type: "shell", command: "ls -la" },
          metadata: { toolUseId: "toolu_1" },
        },
      ],
    });
    const timeline = toThreadTimeline(entry.agent, TIMELINE.slice(0, 1));
    const approval = timeline.activities.find((a) => a.kind === "approval.requested");
    expect(approval?.payload).toMatchObject({
      requestId: "perm-1",
      requestKind: "command",
      detail: "ls -la",
      toolCallId: "toolu_1",
      sessionApprovalAvailable: true,
    });
    expect(approval?.turnId).toBe(timeline.latestTurn?.turnId);
    const thread = toThread(toThreadShell(entry, timeline.latestTurn), timeline);
    expect(() => encode(OrchestrationThread, thread)).not.toThrow();
  });

  it("offers a session grant for tool prompts only when the provider has one", () => {
    const sessionOffer = (permission: Record<string, unknown>) => {
      const entry = makeEntry({
        status: "running",
        pendingPermissions: [{ id: "p", name: "mcp__x", kind: "tool", ...permission }],
      });
      const approval = toThreadTimeline(entry.agent, TIMELINE.slice(0, 1)).activities.find(
        (activity) => activity.kind === "approval.requested",
      );
      return (approval?.payload as { sessionApprovalAvailable: boolean }).sessionApprovalAvailable;
    };
    expect(sessionOffer({})).toBe(false);
    expect(sessionOffer({ suggestions: [{ type: "addRules" }] })).toBe(true);
    expect(sessionOffer({ actions: [{ id: "always", behavior: "allow" }] })).toBe(true);
  });

  it("scopes a plan-mode exit so the composer offers implement / keep planning", () => {
    const entry = makeEntry({
      status: "running",
      pendingPermissions: [
        {
          id: "plan-p",
          name: "ExitPlanMode",
          kind: "plan",
          description: "Review the proposed plan before implementation starts.",
          actions: [
            { id: "reject", behavior: "deny" },
            { id: "implement", behavior: "allow" },
          ],
        },
      ],
    });
    const approval = toThreadTimeline(entry.agent, TIMELINE.slice(0, 1)).activities.find(
      (activity) => activity.kind === "approval.requested",
    );
    expect(approval?.payload).toMatchObject({
      approvalScope: "plan",
      sessionApprovalAvailable: false,
    });
    // The provider's English boilerplate stays out; the client words plan approvals itself.
    expect(approval?.payload).not.toHaveProperty("detail");
  });

  it("keeps a synthetic prompt's turn without showing it as the user's message", () => {
    const entry = makeEntry();
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, { type: "user_message", text: "Plan it", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "Plan ready" }),
      timelineEntry(3, {
        type: "user_message",
        text: "The user approved the plan. Implement it now.",
        messageId: "u2",
        synthetic: true,
      }),
      timelineEntry(4, { type: "assistant_message", text: "Done" }),
    ]);
    expect(timeline.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Plan it"],
      ["assistant", "Plan ready"],
      ["assistant", "Done"],
    ]);
    expect(new Set(timeline.messages.map((message) => message.turnId)).size).toBe(2);
  });

  it("reports the agent's failure on the shell in the failure card's wording", () => {
    const lastError =
      '401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}} (stopReason=error)';
    expect(toThreadShell(makeEntry({ lastError }), null).session?.lastError).toBe(
      "401 authentication_error: Invalid bearer token",
    );
    expect(toThreadShell(makeEntry(), null).session?.lastError).toBeNull();
  });

  it("shows a daemon system error as the turn's failure, not as the agent's reply", () => {
    const entry = makeEntry({ status: "error" });
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, { type: "user_message", text: "Hi", messageId: "u1" }),
      timelineEntry(2, {
        type: "assistant_message",
        text: '[System Error] 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"},"request_id":"req_1"} (stopReason=error, model=anthropic/claude-fable-5)',
      }),
    ]);
    expect(timeline.messages.map((message) => message.role)).toEqual(["user"]);
    const failure = timeline.activities.find((activity) => activity.kind === "runtime.error");
    expect(failure).toMatchObject({
      tone: "error",
      turnId: timeline.messages[0]?.turnId,
      payload: { errorMessage: "401 authentication_error: Invalid bearer token" },
    });
    expect(timeline.latestTurn?.state).toBe("error");
    // After a daemon restart the stored agent is no longer in error; the row still is.
    const restarted = toThreadTimeline(makeEntry({ status: "closed" }).agent, [
      timelineEntry(1, { type: "user_message", text: "Hi", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "[System Error] spawn pi ENOENT" }),
    ]);
    expect(restarted.latestTurn?.state).toBe("error");
  });

  it("drops a reply that only repeats the failure it is followed by", () => {
    const error = "There's an issue with the selected model (myna/auto/claude-haiku-5-5).";
    const timeline = toThreadTimeline(makeEntry({ status: "error" }).agent, [
      timelineEntry(1, { type: "user_message", text: "Hi", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: error }),
      timelineEntry(3, { type: "assistant_message", text: `[System Error] ${error}` }),
    ]);
    expect(timeline.messages.map((message) => message.role)).toEqual(["user"]);
    expect(timeline.activities.find((a) => a.kind === "runtime.error")?.payload).toEqual({
      errorMessage: error,
    });
    // A real partial reply before a failure stays.
    const partial = toThreadTimeline(makeEntry({ status: "error" }).agent, [
      timelineEntry(1, { type: "user_message", text: "Hi", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "Working on it" }),
      timelineEntry(3, { type: "assistant_message", text: `[System Error] ${error}` }),
    ]);
    expect(partial.messages.map((message) => message.text)).toEqual(["Hi", "Working on it"]);
  });

  it("keeps a provider failure readable when it is not a JSON body", () => {
    expect(systemErrorCause(" spawn pi ENOENT ")).toBe("spawn pi ENOENT");
    expect(systemErrorCause('500 {"message":"upstream down"}')).toBe("500: upstream down");
    expect(systemErrorCause("bad {json")).toBe("bad {json");
  });

  it("emits stable summary tokens instead of English timeline copy", () => {
    const entry = makeEntry();
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, { type: "user_message", text: "Go", messageId: "u1" }),
      timelineEntry(2, {
        type: "todo",
        items: [{ text: "Write it", status: "in_progress" }],
      }),
      timelineEntry(3, { type: "reasoning", text: "Thinking" }),
    ]);
    const summaries = new Map(timeline.activities.map((a) => [a.kind, a.summary]));
    expect(summaries.get("turn.tasks.updated")).toBe("activity.tasksUpdated");
    expect(summaries.get("task.progress")).toBe("activity.reasoningTrace");
  });

  it("marks a canceled tool call as cancelled rather than failed", () => {
    const entry = makeEntry();
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, { type: "user_message", text: "Run it", messageId: "u1" }),
      timelineEntry(2, {
        type: "tool_call",
        callId: "call-cancel",
        name: "Bash",
        status: "canceled",
        error: null,
        detail: { type: "shell", command: "ls" },
      }),
    ]);
    const tool = timeline.activities.find((activity) => activity.kind === "tool.completed");
    expect(tool?.tone).toBe("tool");
    expect(tool?.payload).toMatchObject({ status: "cancelled" });
  });

  it("drops the daemon's generic rejection placeholder that duplicates a canceled call", () => {
    const entry = makeEntry();
    const timeline = toThreadTimeline(entry.agent, [
      timelineEntry(1, { type: "user_message", text: "Run it", messageId: "u1" }),
      timelineEntry(2, {
        type: "tool_call",
        callId: "call-cancel",
        name: "Bash",
        status: "canceled",
        error: null,
        detail: { type: "shell", command: "echo hi" },
      }),
      timelineEntry(3, {
        type: "tool_call",
        callId: "call-cancel",
        name: "tool",
        status: "failed",
        error: { type: "tool_result", content: "rejected", is_error: true },
        detail: { type: "unknown", input: null, output: null },
      }),
    ]);
    const tools = timeline.activities.filter((activity) => activity.kind === "tool.completed");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.payload).toMatchObject({ status: "cancelled" });
  });

  it("derives a stop marker for the latest turn the user canceled", () => {
    const entry = makeEntry({ status: "idle" });
    const entries = [
      timelineEntry(1, { type: "user_message", text: "Count", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "One, two", messageId: "a1" }),
    ];
    const timeline = toThreadTimeline(entry.agent, entries, {
      userStoppedAt: "2026-11-05T05:27:03.000Z",
    });
    const kinds = timeline.activities.map((activity) => activity.kind);
    expect(kinds).toContain("turn.stop-requested");
    expect(kinds).toContain("turn.aborted");
    for (const activity of timeline.activities) {
      expect(() => encode(OrchestrationThreadActivity, activity)).not.toThrow();
    }
    const stopped = timeline.activities.find((activity) => activity.kind === "turn.stop-requested");
    const aborted = timeline.activities.find((activity) => activity.kind === "turn.aborted");
    expect(stopped?.payload).toEqual({ requestedBy: "user" });
    expect(aborted?.createdAt).toBe("2026-11-05T05:27:03.000Z");
  });

  it("ignores a stop that predates a newer user message", () => {
    const entry = makeEntry({ status: "idle" });
    const entries = [
      timelineEntry(1, { type: "user_message", text: "First", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "One", messageId: "a1" }),
      timelineEntry(4, { type: "user_message", text: "Second", messageId: "u2" }),
      timelineEntry(5, { type: "assistant_message", text: "Two", messageId: "a2" }),
    ];
    const timeline = toThreadTimeline(entry.agent, entries, {
      userStoppedAt: "2026-11-05T05:27:03.000Z",
    });
    expect(timeline.activities.some((activity) => activity.kind === "turn.aborted")).toBe(false);
  });

  it("derives the stop marker from the daemon's persisted stop after a bridge restart", () => {
    const entry = makeEntry({ status: "idle", lastUserStopAt: "2026-11-05T05:27:03.000Z" });
    const entries = [
      timelineEntry(1, { type: "user_message", text: "Count", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "One, two", messageId: "a1" }),
    ];
    const timeline = toThreadTimeline(entry.agent, entries);
    const aborted = timeline.activities.find((activity) => activity.kind === "turn.aborted");
    expect(aborted?.payload).toEqual({ reason: "user" });
    expect(aborted?.createdAt).toBe("2026-11-05T05:27:03.000Z");
  });

  it("uses the later of the local and persisted stops", () => {
    const entry = makeEntry({ status: "idle", lastUserStopAt: "2026-11-05T05:27:01.500Z" });
    const entries = [
      timelineEntry(1, { type: "user_message", text: "First", messageId: "u1" }),
      timelineEntry(2, { type: "assistant_message", text: "One", messageId: "a1" }),
      timelineEntry(4, { type: "user_message", text: "Second", messageId: "u2" }),
      timelineEntry(5, { type: "assistant_message", text: "Two", messageId: "a2" }),
    ];
    const stale = toThreadTimeline(entry.agent, entries);
    expect(stale.activities.some((activity) => activity.kind === "turn.aborted")).toBe(false);

    const timeline = toThreadTimeline(entry.agent, entries, {
      userStoppedAt: "2026-11-05T05:27:06.000Z",
    });
    const aborted = timeline.activities.find((activity) => activity.kind === "turn.aborted");
    expect(aborted?.createdAt).toBe("2026-11-05T05:27:06.000Z");
  });

  it("publishes the live background task list as the activity the work log reads", () => {
    const timeline = toThreadTimeline(makeEntry().agent, [
      timelineEntry(1, { type: "user_message", text: "Run it", messageId: "u1" }),
      timelineEntry(2, {
        type: "background_tasks",
        tasks: [
          { taskId: "shell-1", taskType: "local_bash", description: "npm test" },
          { taskId: "agent-1", taskType: "local_agent", description: "research" },
        ],
      }),
    ]);

    const announcement = timeline.activities.find(
      (activity) =>
        activity.kind === "runtime.warning" &&
        (activity.payload as Record<string, unknown>).nativeEventType ===
          "background_tasks_changed",
    );
    expect(announcement).toBeDefined();
    expect((announcement?.payload as { data: { tasks: unknown } }).data.tasks).toEqual([
      { task_id: "shell-1", task_type: "local_bash", description: "npm test" },
      { task_id: "agent-1", task_type: "local_agent", description: "research" },
    ]);
  });

  it("admits a background row from a task edge event", () => {
    const timeline = toThreadTimeline(makeEntry().agent, [
      timelineEntry(1, { type: "user_message", text: "Run it", messageId: "u1" }),
      timelineEntry(2, {
        type: "background_task",
        taskId: "shell-2",
        taskType: "local_bash",
        description: "sleep 60",
        isBackgrounded: true,
        status: "running",
      }),
    ]);

    const updated = timeline.activities.find((activity) => activity.kind === "task.updated");
    expect(updated?.payload).toMatchObject({
      taskId: "shell-2",
      taskType: "local_bash",
      detail: "sleep 60",
      isBackgrounded: true,
      status: "running",
    });
  });

  it("ends a background task row when its notification arrives", () => {
    const timeline = toThreadTimeline(makeEntry().agent, [
      timelineEntry(1, { type: "user_message", text: "Run it", messageId: "u1" }),
      timelineEntry(2, {
        type: "tool_call",
        callId: "notify-1",
        name: "task_notification",
        status: "completed",
        error: null,
        detail: { type: "plain_text", label: "Background task finished", text: "done" },
        metadata: { synthetic: true, source: "claude_task_notification", taskId: "shell-1" },
      }),
    ]);

    const completed = timeline.activities.find((activity) => activity.kind === "task.completed");
    expect(completed?.payload).toMatchObject({ taskId: "shell-1", status: "completed" });
    // The task's own row carries the outcome; no raw "Task Notification …" tool row.
    expect(
      timeline.activities.some(
        (activity) => activity.kind === "tool.completed" || activity.kind === "tool.started",
      ),
    ).toBe(false);
  });
});
