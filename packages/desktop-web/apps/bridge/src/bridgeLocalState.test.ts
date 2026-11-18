import { describe, expect, it } from "vitest";

import type { OrchestrationThreadShell } from "@synara/contracts";

import { BridgeLocalState } from "./bridgeLocalState.ts";

const AT = "2026-11-05T05:27:06.873Z";

function shell(id: string, extra: Record<string, unknown> = {}): OrchestrationThreadShell {
  return {
    id,
    projectId: "client-project",
    title: "新终端",
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  } as unknown as OrchestrationThreadShell;
}

describe("BridgeLocalState", () => {
  it("resolves client-minted project ids and persists drafts without fork transcripts", () => {
    let saved: readonly OrchestrationThreadShell[] = [];
    const state = new BridgeLocalState({
      draftThreads: {
        load: async () => saved,
        save: async (drafts) => {
          saved = drafts;
        },
      },
    });
    state.aliasProject("client-project", "prj_daemon");

    const registered = state.registerDraft(shell("draft-1"));
    expect(registered.projectId).toBe("prj_daemon");
    expect(saved.map((draft) => draft.id)).toEqual(["draft-1"]);

    state.registerDraft(shell("fork-1", { forkSourceThreadId: "agent-1" }));
    expect(state.hasDraft("fork-1")).toBe(true);
    expect(saved.map((draft) => draft.id)).toEqual(["draft-1"]);

    const renamed = state.renameDraft("draft-1", " 构建终端 ");
    expect(renamed?.title).toBe("构建终端");
    expect(saved.find((draft) => draft.id === "draft-1")?.title).toBe("构建终端");
    expect(state.renameDraft("draft-1", "  ")).toBeNull();
    expect(state.renameDraft("missing", "ignored")).toBeNull();

    expect(state.removeDraft("draft-1")).toBe(true);
    expect(state.removeDraft("draft-1")).toBe(false);
  });

  it("keeps transcripts, user stops, created agents and project pins locally", () => {
    const pinned = new Set(["prj_1"]);
    const state = new BridgeLocalState({
      projectPins: { isPinned: (projectId) => pinned.has(projectId) },
    });
    expect(state.isProjectPinned("prj_1")).toBe(true);
    expect(state.isProjectPinned("prj_2")).toBe(false);

    state.setImportedTranscript("t1", []);
    expect(state.importedTranscript("t1")).toEqual([]);
    state.forgetThread("t1");
    expect(state.importedTranscript("t1")).toEqual([]);

    state.recordUserStop("t1");
    expect(typeof state.userStoppedAt("t1")).toBe("string");
    state.clearUserStop("t1");
    expect(state.userStoppedAt("t1")).toBeNull();

    expect(state.wasCreated("t1")).toBe(false);
    state.markCreated("t1");
    expect(state.wasCreated("t1")).toBe(true);

    state.aliasProject("same", "same");
    expect(state.resolveProjectId("same")).toBe("same");
    expect(state.resolveProjectId("unknown")).toBe("unknown");
  });

  it("loads saved drafts, and reports none when the store is absent", async () => {
    const saved = [shell("draft-1")];
    const state = new BridgeLocalState({
      draftThreads: { load: async () => saved, save: async () => {} },
    });
    expect(await state.savedDrafts()).toEqual(saved);
    expect(await new BridgeLocalState().savedDrafts()).toEqual([]);
  });
});
