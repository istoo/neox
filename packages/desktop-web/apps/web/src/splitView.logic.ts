// FILE: splitView.logic.ts
// Purpose: Pure helpers for the recursive split-view pane tree (find/replace/collapse leaves, splits,
//          resizes, directional focus, and persisted-state normalization).
// Layer: UI state helpers
// Exports: tree traversal/mutation utilities consumed by the store, the surface, and route helpers

import type { ProjectId, ThreadId } from "@synara/contracts";
import type { ChatRightPanel } from "./diffRouteSearch";
import type {
  LeafPane,
  Pane,
  PaneId,
  SplitDirection,
  SplitDropSide,
  SplitNode,
  SplitView,
  SplitViewId,
  SplitViewPanePanelState,
} from "./splitViewStore";

export const SPLIT_RATIO_DEFAULT = 0.5;
export const SPLIT_RATIO_MIN = 0.25;
export const SPLIT_RATIO_MAX = 0.75;

export function clampSplitRatio(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_RATIO_DEFAULT;
  return Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, value));
}

// --- pane lookup ---

export function findPaneById(root: Pane, paneId: PaneId): Pane | null {
  if (root.id === paneId) {
    return root;
  }
  if (root.kind === "leaf") {
    return null;
  }
  return findPaneById(root.first, paneId) ?? findPaneById(root.second, paneId);
}

export function findLeafPaneById(root: Pane, paneId: PaneId): LeafPane | null {
  const found = findPaneById(root, paneId);
  return found?.kind === "leaf" ? found : null;
}

export function findSplitNodeById(root: Pane, paneId: PaneId): SplitNode | null {
  const found = findPaneById(root, paneId);
  return found?.kind === "split" ? found : null;
}

// Returns the SplitNode that directly contains the pane with paneId, or null if paneId is the root.
export function findParentSplitNode(root: Pane, paneId: PaneId): SplitNode | null {
  if (root.kind === "leaf") {
    return null;
  }
  if (root.first.id === paneId || root.second.id === paneId) {
    return root;
  }
  return findParentSplitNode(root.first, paneId) ?? findParentSplitNode(root.second, paneId);
}

export function findPaneDepth(root: Pane, paneId: PaneId): number | null {
  if (root.id === paneId) {
    return 0;
  }
  if (root.kind === "leaf") {
    return null;
  }
  const firstDepth = findPaneDepth(root.first, paneId);
  if (firstDepth !== null) {
    return firstDepth + 1;
  }
  const secondDepth = findPaneDepth(root.second, paneId);
  return secondDepth === null ? null : secondDepth + 1;
}

export function collectLeaves(root: Pane): LeafPane[] {
  if (root.kind === "leaf") {
    return [root];
  }
  return [...collectLeaves(root.first), ...collectLeaves(root.second)];
}

// --- flat layout ---

/** A pane's box as fractions (0..1) of the whole split surface. */
export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface SplitPaneLayout {
  leaves: { leaf: LeafPane; rect: PaneRect }[];
  splits: { node: SplitNode; rect: PaneRect }[];
}

// Resolves the tree into absolute boxes so the surface can render every leaf as a sibling
// keyed by its id. Rendering the tree as nested elements instead changes a leaf's parent
// whenever a pane is added, moved, or closed, which remounts the chat inside it. Leaves come
// back in tree order (the same as collectLeaves), so DOM and tab order follow the panes on
// screen and the first leaf is the leading one.
export function layoutSplitPanes(root: Pane): SplitPaneLayout {
  const layout: SplitPaneLayout = { leaves: [], splits: [] };
  const visit = (pane: Pane, rect: PaneRect) => {
    if (pane.kind === "leaf") {
      layout.leaves.push({ leaf: pane, rect });
      return;
    }
    layout.splits.push({ node: pane, rect });
    if (pane.direction === "horizontal") {
      const firstWidth = rect.width * pane.ratio;
      visit(pane.first, { ...rect, width: firstWidth });
      visit(pane.second, {
        ...rect,
        left: rect.left + firstWidth,
        width: rect.width - firstWidth,
      });
      return;
    }
    const firstHeight = rect.height * pane.ratio;
    visit(pane.first, { ...rect, height: firstHeight });
    visit(pane.second, {
      ...rect,
      top: rect.top + firstHeight,
      height: rect.height - firstHeight,
    });
  };
  visit(root, { left: 0, top: 0, width: 1, height: 1 });
  return layout;
}

// --- pane mutation (immutable) ---

// Returns a new tree where the pane with paneId is replaced. Preserves identity when nothing changes.
export function replacePaneInTree(root: Pane, paneId: PaneId, replacement: Pane): Pane {
  if (root.id === paneId) {
    return replacement;
  }
  if (root.kind === "leaf") {
    return root;
  }
  const first = replacePaneInTree(root.first, paneId, replacement);
  const second = replacePaneInTree(root.second, paneId, replacement);
  if (first === root.first && second === root.second) {
    return root;
  }
  return { ...root, first, second };
}

export interface RemoveLeafResult {
  nextRoot: Pane | null;
  removedLeafIds: PaneId[];
}

// Walks the tree, removing every leaf whose threadId matches. SplitNodes whose subtree
// loses every leaf collapse to null; nodes with one surviving subtree collapse to that subtree.
export function removeLeafByThreadId(root: Pane, threadId: ThreadId): RemoveLeafResult {
  if (root.kind === "leaf") {
    if (root.threadId === threadId) {
      return { nextRoot: null, removedLeafIds: [root.id] };
    }
    return { nextRoot: root, removedLeafIds: [] };
  }

  const firstResult = removeLeafByThreadId(root.first, threadId);
  const secondResult = removeLeafByThreadId(root.second, threadId);
  const removedLeafIds = [...firstResult.removedLeafIds, ...secondResult.removedLeafIds];

  if (removedLeafIds.length === 0) {
    return { nextRoot: root, removedLeafIds };
  }

  if (firstResult.nextRoot && secondResult.nextRoot) {
    return {
      nextRoot: { ...root, first: firstResult.nextRoot, second: secondResult.nextRoot },
      removedLeafIds,
    };
  }
  if (firstResult.nextRoot) {
    return { nextRoot: firstResult.nextRoot, removedLeafIds };
  }
  if (secondResult.nextRoot) {
    return { nextRoot: secondResult.nextRoot, removedLeafIds };
  }
  return { nextRoot: null, removedLeafIds };
}

// Removes exactly one leaf by pane id. SplitNodes whose subtree loses every leaf collapse to null;
// nodes with one surviving subtree collapse to that subtree so the remaining panes resize naturally.
export function removeLeafByPaneId(root: Pane, paneId: PaneId): RemoveLeafResult {
  if (root.kind === "leaf") {
    if (root.id === paneId) {
      return { nextRoot: null, removedLeafIds: [root.id] };
    }
    return { nextRoot: root, removedLeafIds: [] };
  }

  const firstResult = removeLeafByPaneId(root.first, paneId);
  const secondResult = removeLeafByPaneId(root.second, paneId);
  const removedLeafIds = [...firstResult.removedLeafIds, ...secondResult.removedLeafIds];

  if (removedLeafIds.length === 0) {
    return { nextRoot: root, removedLeafIds };
  }

  if (firstResult.nextRoot && secondResult.nextRoot) {
    return {
      nextRoot: { ...root, first: firstResult.nextRoot, second: secondResult.nextRoot },
      removedLeafIds,
    };
  }
  if (firstResult.nextRoot) {
    return { nextRoot: firstResult.nextRoot, removedLeafIds };
  }
  if (secondResult.nextRoot) {
    return { nextRoot: secondResult.nextRoot, removedLeafIds };
  }
  return { nextRoot: null, removedLeafIds };
}

// --- split / resize (immutable) ---

export interface SplitPaneInTreeInput {
  root: Pane;
  targetPaneId: PaneId;
  direction: SplitDirection;
  side: SplitDropSide;
  /** Pre-built leaf to insert; the caller owns its id and initial thread. */
  newLeaf: LeafPane;
  /** Id for the new SplitNode; the caller owns id generation so this stays pure. */
  newSplitId: PaneId;
  ratio?: number;
}

// Wraps an existing leaf in a new SplitNode. Any leaf can be subdivided in any direction at any
// depth, so the tree is an arbitrary binary partition (VS Code editor groups / tmux panes) rather
// than a fixed grid. Returns null when the target is not a leaf.
export function splitPaneInTree(input: SplitPaneInTreeInput): Pane | null {
  if (!findLeafPaneById(input.root, input.targetPaneId)) {
    return null;
  }
  const target = findPaneById(input.root, input.targetPaneId);
  if (!target || target.kind !== "leaf") {
    return null;
  }
  const node: SplitNode = {
    kind: "split",
    id: input.newSplitId,
    direction: input.direction,
    first: input.side === "first" ? input.newLeaf : target,
    second: input.side === "first" ? target : input.newLeaf,
    ratio: clampSplitRatio(input.ratio ?? SPLIT_RATIO_DEFAULT),
  };
  return replacePaneInTree(input.root, target.id, node);
}

// Moves one SplitNode's divider. Preserves tree identity when the ratio is unchanged or the node
// is missing, so React can skip re-rendering unrelated panes.
export function resizeSplitNodeInTree(root: Pane, splitNodeId: PaneId, ratio: number): Pane {
  const node = findSplitNodeById(root, splitNodeId);
  if (!node) return root;
  const nextRatio = clampSplitRatio(ratio);
  if (node.ratio === nextRatio) return root;
  return replacePaneInTree(root, splitNodeId, { ...node, ratio: nextRatio });
}

// --- directional focus ---

export type PaneFocusDirection = "left" | "right" | "up" | "down";

const RECT_EPSILON = 1e-6;

// Shared extent along one axis: "vertical" compares top/height, "horizontal" compares left/width.
function rectOverlap(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
  axis: "horizontal" | "vertical",
): number {
  if (axis === "vertical") {
    return Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  }
  return Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
}

// Geometry-based neighbour lookup, matching how editor groups move focus: candidates must be
// strictly beyond the focused pane's edge and overlap it on the perpendicular axis. Ties go to
// the pane with the largest overlap, then to the top/left-most, then to tree order.
export function findDirectionalNeighbor(
  root: Pane,
  focusedPaneId: PaneId,
  direction: PaneFocusDirection,
): LeafPane | null {
  const { leaves } = layoutSplitPanes(root);
  const focused = leaves.find((entry) => entry.leaf.id === focusedPaneId);
  if (!focused) return null;

  const focusedRight = focused.rect.left + focused.rect.width;
  const focusedBottom = focused.rect.top + focused.rect.height;
  const horizontalDirection = direction === "left" || direction === "right";

  let best: { leaf: LeafPane; distance: number; overlap: number; crossStart: number } | null = null;

  for (const entry of leaves) {
    if (entry.leaf.id === focusedPaneId) continue;
    const overlap = rectOverlap(
      focused.rect,
      entry.rect,
      horizontalDirection ? "vertical" : "horizontal",
    );
    if (overlap <= RECT_EPSILON) continue;

    let distance: number;
    let crossStart: number;
    if (direction === "right") {
      distance = entry.rect.left - focusedRight;
      crossStart = entry.rect.top;
    } else if (direction === "left") {
      distance = focused.rect.left - (entry.rect.left + entry.rect.width);
      crossStart = entry.rect.top;
    } else if (direction === "down") {
      distance = entry.rect.top - focusedBottom;
      crossStart = entry.rect.left;
    } else {
      distance = focused.rect.top - (entry.rect.top + entry.rect.height);
      crossStart = entry.rect.left;
    }
    if (distance < -RECT_EPSILON) continue;
    distance = Math.max(0, distance);

    if (
      best === null ||
      distance < best.distance - RECT_EPSILON ||
      (Math.abs(distance - best.distance) <= RECT_EPSILON &&
        (overlap > best.overlap + RECT_EPSILON ||
          (Math.abs(overlap - best.overlap) <= RECT_EPSILON && crossStart < best.crossStart)))
    ) {
      best = { leaf: entry.leaf, distance, overlap, crossStart };
    }
  }

  return best?.leaf ?? null;
}

// --- structural rules ---

// Any leaf may be split again, in either direction, at any depth. Kept as a named predicate so the
// drop overlay and surface share one place to add future structural guards (minimum pane size,
// pane-count budgets). Returns false only when the pane does not exist.
export function canSubdividePane(
  root: Pane,
  targetPaneId: PaneId,
  _requestedDirection?: SplitDirection,
): boolean {
  return findLeafPaneById(root, targetPaneId) !== null;
}

// Returns the first leaf id encountered in DFS order; falls back to root id when there are no leaves.
export function resolveDefaultFocusLeafId(root: Pane): PaneId {
  const leaves = collectLeaves(root);
  return leaves[0]?.id ?? root.id;
}

// --- legacy split-view migration ---

export interface LegacySplitViewLike {
  id: string;
  sourceThreadId: ThreadId;
  ownerProjectId: ProjectId;
  leftThreadId: ThreadId | null;
  rightThreadId: ThreadId | null;
  focusedPane: "left" | "right";
  ratio: number;
  leftPanel: SplitViewPanePanelState;
  rightPanel: SplitViewPanePanelState;
  createdAt: string;
  updatedAt: string;
}

export function isLegacySplitViewLike(value: unknown): value is LegacySplitViewLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.sourceThreadId === "string" &&
    "leftThreadId" in candidate &&
    "rightThreadId" in candidate &&
    typeof candidate.focusedPane === "string"
  );
}

// --- persisted state normalization ---

export interface NormalizedSplitViewState {
  splitViewsById: Record<SplitViewId, SplitView | undefined>;
  splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined>;
}

export interface NormalizeSplitViewOptions {
  /** Id factory for panes/split views that lack a usable id. Injected so tests stay deterministic. */
  createId: () => string;
  /** Timestamp factory for entries whose dates are missing. */
  now: () => string;
  /** Structural ceiling for damaged payloads; interactive splits are not capped. */
  maxDepth?: number;
}

// A persisted tree is untrusted input: a hand-edited or half-written payload must never crash the
// renderer. Recursion stops well above any usable layout so a deeply nested payload cannot exhaust
// the stack, and every dropped field falls back to a safe value.
const DEFAULT_MAX_PANE_DEPTH = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizePanelValue(value: unknown): ChatRightPanel | null {
  return value === "browser" || value === "diff" ? value : null;
}

function normalizePaneContent(value: unknown): LeafPane["content"] {
  if (!isRecord(value) || value.kind !== "panel") return undefined;
  const panel = value.panel;
  if (panel !== "browser" && panel !== "diff" && panel !== "terminal" && panel !== "explorer") {
    return undefined;
  }
  return { kind: "panel", panel };
}

function normalizePanePanelState(raw: unknown): SplitViewPanePanelState {
  const candidate = isRecord(raw) ? raw : {};
  return {
    panel: normalizePanelValue(candidate.panel),
    diffTurnId: nonEmptyString(candidate.diffTurnId) as SplitViewPanePanelState["diffTurnId"],
    diffFilePath: nonEmptyString(candidate.diffFilePath),
    hasOpenedPanel: candidate.hasOpenedPanel === true,
    lastOpenPanel: normalizePanelValue(candidate.lastOpenPanel) ?? "browser",
  };
}

function claimId(raw: unknown, seen: Set<string>, createId: () => string): string {
  const candidate = nonEmptyString(raw);
  if (candidate && !seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  // Bounded: a pathological id factory must not spin forever on a damaged payload.
  let id = createId();
  if (!seen.has(id)) {
    seen.add(id);
    return id;
  }
  let suffix = seen.size;
  do {
    id = `pane-${suffix}`;
    suffix += 1;
  } while (seen.has(id));
  seen.add(id);
  return id;
}

function normalizePane(
  raw: unknown,
  depth: number,
  seen: Set<string>,
  options: NormalizeSplitViewOptions,
): Pane | null {
  if (!isRecord(raw) || depth > (options.maxDepth ?? DEFAULT_MAX_PANE_DEPTH)) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const looksSplit =
    candidate.kind === "split" ||
    (candidate.kind !== "leaf" && "first" in candidate && "second" in candidate);
  if (!looksSplit) {
    const content = normalizePaneContent(candidate.content);
    return {
      kind: "leaf",
      id: claimId(candidate.id, seen, options.createId),
      threadId: nonEmptyString(candidate.threadId) as ThreadId | null,
      ...(content ? { content } : {}),
      panel: normalizePanePanelState(candidate.panel),
    };
  }

  const first = normalizePane(candidate.first, depth + 1, seen, options);
  const second = normalizePane(candidate.second, depth + 1, seen, options);
  if (!first && !second) return null;
  // A split that lost one side collapses to the survivor instead of rendering a half-tree.
  if (!first) return second;
  if (!second) return first;
  return {
    kind: "split",
    id: claimId(candidate.id, seen, options.createId),
    direction: candidate.direction === "vertical" ? "vertical" : "horizontal",
    first,
    second,
    ratio: clampSplitRatio(typeof candidate.ratio === "number" ? candidate.ratio : Number.NaN),
  };
}

function normalizeSplitView(
  raw: Record<string, unknown>,
  entryKey: string,
  options: NormalizeSplitViewOptions,
): SplitView | null {
  const root = normalizePane(raw.root, 0, new Set<string>(), options);
  if (!root) return null;
  const leaves = collectLeaves(root);
  const firstThreadedLeaf = leaves.find((leaf) => leaf.threadId !== null);
  if (!firstThreadedLeaf?.threadId) return null;

  const persistedSourceThreadId = nonEmptyString(raw.sourceThreadId);
  const sourceThreadId =
    persistedSourceThreadId && leaves.some((leaf) => leaf.threadId === persistedSourceThreadId)
      ? (persistedSourceThreadId as ThreadId)
      : firstThreadedLeaf.threadId;
  const focusedPaneId =
    typeof raw.focusedPaneId === "string" && leaves.some((leaf) => leaf.id === raw.focusedPaneId)
      ? raw.focusedPaneId
      : resolveDefaultFocusLeafId(root);
  const maximizedPaneId =
    typeof raw.maximizedPaneId === "string" &&
    leaves.some((leaf) => leaf.id === raw.maximizedPaneId)
      ? raw.maximizedPaneId
      : null;

  return {
    id: nonEmptyString(raw.id) ?? nonEmptyString(entryKey) ?? options.createId(),
    sourceThreadId,
    ownerProjectId: (nonEmptyString(raw.ownerProjectId) ?? "") as ProjectId,
    root,
    focusedPaneId,
    maximizedPaneId,
    createdAt: nonEmptyString(raw.createdAt) ?? options.now(),
    updatedAt: nonEmptyString(raw.updatedAt) ?? options.now(),
  };
}

function migrateLegacySplitViewWithOptions(
  legacy: LegacySplitViewLike,
  options: NormalizeSplitViewOptions,
): SplitView | null {
  const leftLeaf: LeafPane = {
    kind: "leaf",
    id: options.createId(),
    threadId: nonEmptyString(legacy.leftThreadId) as ThreadId | null,
    panel: normalizePanePanelState(legacy.leftPanel),
  };
  const rightLeaf: LeafPane = {
    kind: "leaf",
    id: options.createId(),
    threadId: nonEmptyString(legacy.rightThreadId) as ThreadId | null,
    panel: normalizePanePanelState(legacy.rightPanel),
  };
  const firstThreadedLeaf = [leftLeaf, rightLeaf].find((leaf) => leaf.threadId !== null);
  if (!firstThreadedLeaf?.threadId) return null;

  const splitId = nonEmptyString(legacy.id) ?? options.createId();
  const root: SplitNode = {
    kind: "split",
    id: options.createId(),
    direction: "horizontal",
    first: leftLeaf,
    second: rightLeaf,
    ratio: clampSplitRatio(typeof legacy.ratio === "number" ? legacy.ratio : SPLIT_RATIO_DEFAULT),
  };
  const sourceThreadId =
    legacy.sourceThreadId === leftLeaf.threadId || legacy.sourceThreadId === rightLeaf.threadId
      ? legacy.sourceThreadId
      : firstThreadedLeaf.threadId;
  return {
    id: splitId,
    sourceThreadId,
    ownerProjectId: (nonEmptyString(legacy.ownerProjectId) ?? "") as ProjectId,
    root,
    focusedPaneId: legacy.focusedPane === "right" ? rightLeaf.id : leftLeaf.id,
    maximizedPaneId: null,
    createdAt: nonEmptyString(legacy.createdAt) ?? options.now(),
    updatedAt: nonEmptyString(legacy.updatedAt) ?? options.now(),
  };
}

/**
 * Canonicalizes any persisted split-view payload (v1 flat panes or v2 recursive trees) into the
 * current shape. Invalid entries are dropped individually, never thrown, and the source→split map
 * is rebuilt from the surviving trees so a stale index cannot point at a missing split.
 */
export function normalizePersistedSplitViewState(
  raw: unknown,
  options: NormalizeSplitViewOptions,
): NormalizedSplitViewState {
  const splitViewsById: Record<SplitViewId, SplitView | undefined> = {};
  const splitViewIdBySourceThreadId: Record<string, SplitViewId | undefined> = {};
  if (!isRecord(raw)) {
    return { splitViewsById, splitViewIdBySourceThreadId };
  }
  const persistedMap = isRecord(raw.splitViewsById) ? raw.splitViewsById : null;
  if (!persistedMap) {
    return { splitViewsById, splitViewIdBySourceThreadId };
  }

  for (const [entryKey, value] of Object.entries(persistedMap)) {
    if (!isRecord(value)) continue;
    const normalized = isLegacySplitViewLike(value)
      ? migrateLegacySplitViewWithOptions(value, options)
      : normalizeSplitView(value, entryKey, options);
    if (!normalized) continue;
    // Routes hold the persisted map key, so it wins over a disagreeing `id` field.
    const canonicalId = nonEmptyString(entryKey) ?? normalized.id;
    const splitView =
      normalized.id === canonicalId ? normalized : { ...normalized, id: canonicalId };
    if (splitViewsById[splitView.id]) continue;
    if (splitViewIdBySourceThreadId[splitView.sourceThreadId]) continue;
    splitViewsById[splitView.id] = splitView;
    splitViewIdBySourceThreadId[splitView.sourceThreadId] = splitView.id;
  }

  return { splitViewsById, splitViewIdBySourceThreadId };
}
