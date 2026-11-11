// FILE: splitView.logic.test.ts
// Purpose: Verify pure pane-tree helpers used by the store and chat surfaces.
// Layer: UI state helpers test
// Targets: tree traversal, immutable replace/split/resize, leaf removal/collapse, directional
// focus, and legacy/persisted-state normalization.

import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  canSubdividePane,
  clampSplitRatio,
  collectLeaves,
  findDirectionalNeighbor,
  isLegacySplitViewLike,
  layoutSplitPanes,
  normalizePersistedSplitViewState,
  removeLeafByPaneId,
  removeLeafByThreadId,
  replacePaneInTree,
  resizeSplitNodeInTree,
  resolveDefaultFocusLeafId,
  splitPaneInTree,
} from "./splitView.logic";
import type {
  LeafPane,
  Pane,
  SplitNode,
  SplitView,
  SplitViewPanePanelState,
} from "./splitViewStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const THREAD_C = ThreadId.makeUnsafe("thread-c");
const THREAD_D = ThreadId.makeUnsafe("thread-d");
const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makePanel(): SplitViewPanePanelState {
  return {
    panel: null,
    diffTurnId: null,
    diffFilePath: null,
    hasOpenedPanel: false,
    lastOpenPanel: "browser",
  };
}

function makeLeaf(id: string, threadId: ThreadId | null): LeafPane {
  return { kind: "leaf", id, threadId, panel: makePanel() };
}

function makeSplit(input: {
  id: string;
  direction: "horizontal" | "vertical";
  first: Pane;
  second: Pane;
  ratio?: number;
}): SplitNode {
  return {
    kind: "split",
    id: input.id,
    direction: input.direction,
    first: input.first,
    second: input.second,
    ratio: input.ratio ?? 0.5,
  };
}

describe("collectLeaves", () => {
  it("returns leaves in left-to-right (depth-first) order", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const inner = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafA,
      second: leafB,
    });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({ id: "root", direction: "horizontal", first: inner, second: leafC });

    expect(collectLeaves(root).map((leaf) => leaf.id)).toEqual(["leaf-a", "leaf-b", "leaf-c"]);
  });
});

describe("replacePaneInTree", () => {
  it("returns a new tree where the specified pane is replaced", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });

    const replacement: LeafPane = makeLeaf("leaf-a", THREAD_C);
    const updated = replacePaneInTree(root, "leaf-a", replacement);

    expect(updated).not.toBe(root);
    expect((updated as SplitNode).first).toBe(replacement);
    expect((updated as SplitNode).second).toBe(leafB);
  });
});

describe("removeLeafByThreadId", () => {
  it("removes leaves nested inside a perpendicular subtree", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const inner = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafA,
      second: leafB,
    });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({ id: "root", direction: "horizontal", first: inner, second: leafC });

    const result = removeLeafByThreadId(root, THREAD_B);
    expect(result.removedLeafIds).toEqual(["leaf-b"]);
    expect(result.nextRoot).not.toBe(root);
    if (result.nextRoot && result.nextRoot.kind === "split") {
      expect(result.nextRoot.first).toBe(leafA);
      expect(result.nextRoot.second).toBe(leafC);
    }
  });
});

describe("removeLeafByPaneId", () => {
  it("does not remove matching threads in other panes", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_A);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });

    const result = removeLeafByPaneId(root, "leaf-a");

    expect(result.removedLeafIds).toEqual(["leaf-a"]);
    expect(result.nextRoot).toBe(leafB);
  });
});

describe("canSubdividePane", () => {
  it("allows a root leaf to split in either direction", () => {
    const root = makeLeaf("root-leaf", THREAD_D);
    expect(canSubdividePane(root, "root-leaf", "horizontal")).toBe(true);
    expect(canSubdividePane(root, "root-leaf", "vertical")).toBe(true);
  });

  it("allows same-direction splits at any depth", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const inner = makeSplit({ id: "inner", direction: "vertical", first: leafA, second: leafB });
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({ id: "root", direction: "horizontal", first: inner, second: leafC });

    expect(canSubdividePane(root, "leaf-a", "vertical")).toBe(true);
    expect(canSubdividePane(root, "leaf-a", "horizontal")).toBe(true);
    expect(canSubdividePane(root, "leaf-c", "horizontal")).toBe(true);
    expect(canSubdividePane(root, "missing-pane", "horizontal")).toBe(false);
  });
});

describe("clampSplitRatio", () => {
  it("clamps to the usable range and defaults non-finite values", () => {
    expect(clampSplitRatio(0.1)).toBe(0.25);
    expect(clampSplitRatio(0.9)).toBe(0.75);
    expect(clampSplitRatio(0.4)).toBe(0.4);
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
  });
});

describe("splitPaneInTree", () => {
  it("wraps the target leaf in a new split on the requested side", () => {
    const target = makeLeaf("leaf-a", THREAD_A);
    const newLeaf = makeLeaf("leaf-new", null);

    const next = splitPaneInTree({
      root: target,
      targetPaneId: "leaf-a",
      direction: "vertical",
      side: "first",
      newLeaf,
      newSplitId: "split-new",
    });

    expect(next).toEqual({
      kind: "split",
      id: "split-new",
      direction: "vertical",
      first: newLeaf,
      second: target,
      ratio: 0.5,
    });
  });

  it("supports deep splits and returns null for unknown panes", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });
    const newLeaf = makeLeaf("leaf-new", null);

    const next = splitPaneInTree({
      root,
      targetPaneId: "leaf-b",
      direction: "horizontal",
      side: "second",
      newLeaf,
      newSplitId: "nested",
    });
    if (!next || next.kind !== "split" || next.second.kind !== "split") {
      throw new Error("expected a nested split");
    }
    expect(next.first).toBe(leafA);
    expect(next.second.second).toBe(newLeaf);
    expect(collectLeaves(next).map((leaf) => leaf.id)).toEqual(["leaf-a", "leaf-b", "leaf-new"]);

    expect(
      splitPaneInTree({
        root,
        targetPaneId: "missing",
        direction: "vertical",
        side: "first",
        newLeaf,
        newSplitId: "never",
      }),
    ).toBeNull();
  });
});

describe("resizeSplitNodeInTree", () => {
  it("clamps the ratio and preserves identity when nothing changes", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });

    const widened = resizeSplitNodeInTree(root, "root", 0.95);
    expect((widened as SplitNode).ratio).toBe(0.75);

    const unchanged = resizeSplitNodeInTree(widened, "root", 0.75);
    expect(unchanged).toBe(widened);
    expect(resizeSplitNodeInTree(widened, "missing", 0.4)).toBe(widened);
  });
});

describe("findDirectionalNeighbor", () => {
  it("moves between nested panes by geometry", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const column = makeSplit({
      id: "column",
      direction: "vertical",
      first: leafB,
      second: leafC,
      ratio: 0.5,
    });
    const root = makeSplit({
      id: "root",
      direction: "horizontal",
      first: leafA,
      second: column,
      ratio: 0.5,
    });

    expect(findDirectionalNeighbor(root, "leaf-a", "right")?.id).toBe("leaf-b");
    expect(findDirectionalNeighbor(root, "leaf-b", "right")).toBeNull();
    expect(findDirectionalNeighbor(root, "leaf-c", "left")?.id).toBe("leaf-a");
    expect(findDirectionalNeighbor(root, "leaf-b", "down")?.id).toBe("leaf-c");
    expect(findDirectionalNeighbor(root, "leaf-c", "up")?.id).toBe("leaf-b");
    expect(findDirectionalNeighbor(root, "leaf-a", "left")).toBeNull();
    expect(findDirectionalNeighbor(root, "missing", "right")).toBeNull();
  });

  it("prefers the candidate with the largest perpendicular overlap", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const rightColumn = makeSplit({
      id: "right-column",
      direction: "vertical",
      first: leafB,
      second: leafC,
      ratio: 0.2,
    });
    const root = makeSplit({
      id: "root",
      direction: "horizontal",
      first: leafA,
      second: rightColumn,
      ratio: 0.5,
    });

    // B spans 0–0.2 of the height, C spans 0.2–1: C overlaps A more.
    expect(findDirectionalNeighbor(root, "leaf-a", "right")?.id).toBe("leaf-c");
  });
});

describe("resolveDefaultFocusLeafId", () => {
  it("returns the first leaf id in DFS order", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const root = makeSplit({ id: "root", direction: "horizontal", first: leafA, second: leafB });
    expect(resolveDefaultFocusLeafId(root)).toBe("leaf-a");
  });
});

describe("isLegacySplitViewLike", () => {
  it("matches the v1 persisted shape", () => {
    const legacy = {
      id: "split-1",
      sourceThreadId: THREAD_A,
      ownerProjectId: PROJECT_ID,
      leftThreadId: THREAD_A,
      rightThreadId: THREAD_B,
      focusedPane: "left",
      ratio: 0.5,
      leftPanel: makePanel(),
      rightPanel: makePanel(),
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(isLegacySplitViewLike(legacy)).toBe(true);
    expect(isLegacySplitViewLike(null)).toBe(false);
    expect(isLegacySplitViewLike({})).toBe(false);
  });
});

describe("layoutSplitPanes", () => {
  it("resolves nested splits into boxes that tile the surface", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const inner = makeSplit({
      id: "inner",
      direction: "vertical",
      first: leafB,
      second: leafC,
      ratio: 0.25,
    });
    const root = makeSplit({
      id: "root",
      direction: "horizontal",
      first: leafA,
      second: inner,
      ratio: 0.4,
    });

    const layout = layoutSplitPanes(root);

    expect(Object.fromEntries(layout.leaves.map(({ leaf, rect }) => [leaf.id, rect]))).toEqual({
      "leaf-a": { left: 0, top: 0, width: 0.4, height: 1 },
      "leaf-b": { left: 0.4, top: 0, width: 0.6, height: 0.25 },
      "leaf-c": { left: 0.4, top: 0.25, width: 0.6, height: 0.75 },
    });
    expect(layout.splits.map(({ node, rect }) => [node.id, rect])).toEqual([
      ["root", { left: 0, top: 0, width: 1, height: 1 }],
      ["inner", { left: 0.4, top: 0, width: 0.6, height: 1 }],
    ]);
  });

  it("lists leaves in tree order so siblings follow the panes on screen", () => {
    const leafA = makeLeaf("leaf-a", THREAD_A);
    const leafB = makeLeaf("leaf-b", THREAD_B);
    const leafC = makeLeaf("leaf-c", THREAD_C);
    const root = makeSplit({
      id: "root",
      direction: "vertical",
      first: makeSplit({ id: "inner", direction: "horizontal", first: leafC, second: leafA }),
      second: leafB,
    });

    expect(layoutSplitPanes(root).leaves.map(({ leaf }) => leaf.id)).toEqual(
      collectLeaves(root).map((leaf) => leaf.id),
    );
  });
});

function normalizeOptions(maxDepth?: number): {
  createId: () => string;
  now: () => string;
  maxDepth?: number;
} {
  let nextId = 0;
  return {
    createId: () => `generated-${++nextId}`,
    now: () => "2026-01-01T00:00:00.000Z",
    ...(maxDepth === undefined ? {} : { maxDepth }),
  };
}

describe("normalizePersistedSplitViewState", () => {
  it("keeps arbitrary-depth trees, clamps ratios, and repairs focus", () => {
    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          "split-1": {
            id: "split-1",
            sourceThreadId: THREAD_A,
            ownerProjectId: PROJECT_ID,
            focusedPaneId: "missing-pane",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            root: {
              kind: "split",
              id: "root",
              direction: "horizontal",
              ratio: 9,
              first: {
                kind: "split",
                id: "inner",
                direction: "vertical",
                ratio: 0.5,
                first: {
                  kind: "leaf",
                  id: "leaf-a",
                  threadId: THREAD_A,
                  panel: { panel: "bogus", lastOpenPanel: "bogus" },
                },
                second: { kind: "leaf", id: "leaf-b", threadId: THREAD_B },
              },
              second: { kind: "leaf", id: "leaf-c", threadId: THREAD_C },
            },
          },
        },
      },
      normalizeOptions(),
    );

    const splitView = result.splitViewsById["split-1"];
    expect(splitView).toBeDefined();
    if (!splitView) return;
    expect(collectLeaves(splitView.root).map((leaf) => leaf.id)).toEqual([
      "leaf-a",
      "leaf-b",
      "leaf-c",
    ]);
    expect((splitView.root as SplitNode).ratio).toBe(0.75);
    expect(splitView.focusedPaneId).toBe("leaf-a");
    const leafA = collectLeaves(splitView.root)[0] as LeafPane;
    expect(leafA.panel.panel).toBeNull();
    expect(leafA.panel.lastOpenPanel).toBe("browser");
    expect(result.splitViewIdBySourceThreadId[THREAD_A]).toBe("split-1");
  });

  it("collapses a split that lost one side instead of dropping the whole view", () => {
    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          "split-1": {
            id: "split-1",
            sourceThreadId: THREAD_A,
            ownerProjectId: PROJECT_ID,
            root: {
              kind: "split",
              id: "root",
              direction: "horizontal",
              first: { kind: "leaf", id: "leaf-a", threadId: THREAD_A },
              second: "not-a-pane",
            },
          },
        },
      },
      normalizeOptions(),
    );

    const splitView = result.splitViewsById["split-1"];
    expect(splitView?.root).toMatchObject({ kind: "leaf", id: "leaf-a" });
  });

  it("drops malformed entries and empty trees without throwing", () => {
    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          "bad-root": { id: "bad-root", sourceThreadId: THREAD_A, root: "nope" },
          "empty-tree": {
            id: "empty-tree",
            sourceThreadId: THREAD_B,
            root: {
              kind: "split",
              id: "root",
              direction: "horizontal",
              first: { kind: "leaf", id: "x", threadId: null },
              second: { kind: "leaf", id: "y", threadId: null },
            },
          },
          "not-an-object": "garbage",
          valid: {
            id: "valid",
            sourceThreadId: THREAD_C,
            ownerProjectId: PROJECT_ID,
            root: {
              kind: "split",
              id: "root",
              direction: "horizontal",
              first: { kind: "leaf", id: "c", threadId: THREAD_C },
              second: { kind: "leaf", id: "d", threadId: THREAD_D },
            },
          },
        },
      },
      normalizeOptions(),
    );

    expect(Object.keys(result.splitViewsById)).toEqual(["valid"]);
    expect(result.splitViewIdBySourceThreadId[THREAD_C]).toBe("valid");
  });

  it("keys splits by their persisted entry so routes resolve", () => {
    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          "route-key": {
            id: "a-different-id",
            sourceThreadId: THREAD_A,
            ownerProjectId: PROJECT_ID,
            root: {
              kind: "split",
              id: "root",
              direction: "horizontal",
              first: { kind: "leaf", id: "a", threadId: THREAD_A },
              second: { kind: "leaf", id: "b", threadId: THREAD_B },
            },
          },
        },
      },
      normalizeOptions(),
    );

    expect(result.splitViewsById["route-key"]?.id).toBe("route-key");
    expect(result.splitViewsById["a-different-id"]).toBeUndefined();
    expect(result.splitViewIdBySourceThreadId[THREAD_A]).toBe("route-key");
  });

  it("migrates the v1 flat shape per entry", () => {
    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          "split-legacy": {
            id: "split-legacy",
            sourceThreadId: THREAD_B,
            ownerProjectId: PROJECT_ID,
            leftThreadId: THREAD_A,
            rightThreadId: THREAD_B,
            focusedPane: "right",
            ratio: 0.6,
            leftPanel: makePanel(),
            rightPanel: { ...makePanel(), panel: "diff" },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      },
      normalizeOptions(),
    );

    const splitView = result.splitViewsById["split-legacy"];
    expect(splitView).toBeDefined();
    if (!splitView) return;
    expect(collectLeaves(splitView.root).map((leaf) => leaf.threadId)).toEqual([
      THREAD_A,
      THREAD_B,
    ]);
    expect(splitView.focusedPaneId).toBe(collectLeaves(splitView.root)[1]?.id);
  });

  it("keeps one split per source thread so the index stays unambiguous", () => {
    const makeRaw = (id: string, threads: [string, string]) => ({
      id,
      sourceThreadId: threads[0],
      ownerProjectId: PROJECT_ID,
      root: {
        kind: "split",
        id: `${id}-root`,
        direction: "horizontal",
        first: { kind: "leaf", id: `${id}-a`, threadId: threads[0] },
        second: { kind: "leaf", id: `${id}-b`, threadId: threads[1] },
      },
    });

    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          first: makeRaw("first", [THREAD_A, THREAD_B]),
          second: makeRaw("second", [THREAD_A, THREAD_C]),
        },
      },
      normalizeOptions(),
    );

    expect(Object.keys(result.splitViewsById)).toEqual(["first"]);
    expect(result.splitViewIdBySourceThreadId[THREAD_A]).toBe("first");
  });

  it("cuts off payloads nested beyond the structural ceiling", () => {
    let root: unknown = { kind: "leaf", id: "deep-leaf", threadId: THREAD_B };
    for (let index = 0; index < 12; index += 1) {
      root = {
        kind: "split",
        id: `split-${index}`,
        direction: "horizontal",
        first: { kind: "leaf", id: `leaf-${index}`, threadId: THREAD_A },
        second: root,
      };
    }

    const result = normalizePersistedSplitViewState(
      {
        splitViewsById: {
          deep: {
            id: "deep",
            sourceThreadId: THREAD_A,
            ownerProjectId: PROJECT_ID,
            root,
          },
        },
      },
      normalizeOptions(4),
    );

    const splitView = result.splitViewsById.deep as SplitView | undefined;
    expect(splitView).toBeDefined();
    if (!splitView) return;
    const leaves = collectLeaves(splitView.root);
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.length).toBeLessThan(20);
  });
});
