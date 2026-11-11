import { COMPACT_CONTENT_WIDTH } from "@/constants/layout";

export function shouldUseCompactWorkspaceHeader(width: number): boolean {
  return width < COMPACT_CONTENT_WIDTH;
}

export type WorkspaceTabCloseButtonPolicy = "all" | "none";

export interface WorkspaceTabLayoutMetrics {
  rowHorizontalInset: number;
  actionsReservedWidth: number;
  rowPaddingHorizontal: number;
  tabGap: number;
  minTabWidth: number;
  /**
   * The normal cap. Tabs only grow past it when every label still fits at its measured
   * width (see `roomyMaxTabWidth`); a crowded row keeps this cap so overflow behaves as before.
   */
  maxTabWidth: number;
  /**
   * The cap used when the measured labels fit the whole track. Without it a lone tab with
   * a long title stops at `maxTabWidth` while the rest of the row sits empty.
   */
  roomyMaxTabWidth?: number;
  tabIconWidth: number;
  tabContentGap: number;
  tabHorizontalPadding: number;
  closeButtonWidth: number;
}

export interface WorkspaceTabLayoutInput {
  viewportWidth: number;
  tabLabelWidths: number[];
  metrics: WorkspaceTabLayoutMetrics;
  /**
   * Compact layouts are touch-first. Tabs keep their natural width and the row scrolls as soon as
   * they overflow, so a label is never squeezed to make room; chips carry no inline close because a
   * narrow X beside the label is easy to hit by accident and the tab's long-press menu closes it.
   */
  compact: boolean;
}

export interface WorkspaceTabLayoutItem {
  width: number;
  showLabel: boolean;
}

export interface WorkspaceTabLayoutResult {
  items: WorkspaceTabLayoutItem[];
  closeButtonPolicy: WorkspaceTabCloseButtonPolicy;
  requiresHorizontalScrollFallback: boolean;
}

export function retainWorkspaceTabMeasuredWidth(
  currentWidth: number,
  measuredWidth: number,
): number {
  if (measuredWidth <= 0 || Math.abs(currentWidth - measuredWidth) <= 1) {
    return currentWidth;
  }
  return measuredWidth;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

export function computeWorkspaceTabLayout(
  input: WorkspaceTabLayoutInput,
): WorkspaceTabLayoutResult {
  const tabCount = input.tabLabelWidths.length;
  const closeButtonPolicy: WorkspaceTabCloseButtonPolicy = input.compact ? "none" : "all";
  if (tabCount === 0) {
    return {
      items: [],
      closeButtonPolicy,
      requiresHorizontalScrollFallback: false,
    };
  }

  const availableWidth = Math.max(
    0,
    input.viewportWidth - input.metrics.rowHorizontalInset * 2 - input.metrics.actionsReservedWidth,
  );
  const rowOverhead =
    input.metrics.rowPaddingHorizontal * 2 + Math.max(tabCount - 1, 0) * input.metrics.tabGap;
  const availableTabsWidth = Math.max(0, availableWidth - rowOverhead);
  const tabChromeWidth =
    input.metrics.tabIconWidth +
    input.metrics.tabContentGap +
    input.metrics.tabHorizontalPadding * 2 +
    input.metrics.closeButtonWidth;
  const naturalWidths = input.tabLabelWidths.map((labelWidth) =>
    clamp(tabChromeWidth + labelWidth, input.metrics.minTabWidth, input.metrics.maxTabWidth),
  );
  const roomyMaxTabWidth = input.metrics.roomyMaxTabWidth ?? input.metrics.maxTabWidth;
  const roomyWidths =
    roomyMaxTabWidth > input.metrics.maxTabWidth
      ? input.tabLabelWidths.map((labelWidth) =>
          clamp(tabChromeWidth + labelWidth, input.metrics.minTabWidth, roomyMaxTabWidth),
        )
      : naturalWidths;
  // Give a sparse row its measured label widths, up to the roomy cap, but never at the
  // cost of the crowded-row layout: if even the roomy widths overflow the track, keep the
  // normal widths and let the existing shrink/scroll path decide exactly as it did before.
  // debt: all-or-nothing widening; distribute the track per tab if mixed short/long titles
  // start losing their measured width in rows that still have room.
  const resolvedNaturalWidths =
    roomyWidths.reduce((total, width) => total + width, 0) <= availableTabsWidth
      ? roomyWidths
      : naturalWidths;
  const naturalTotalWidth = resolvedNaturalWidths.reduce((total, width) => total + width, 0);
  const minimumTotalWidth = input.metrics.minTabWidth * tabCount;
  // A row that scrolls has no reason to truncate: the tabs keep their natural widths and the
  // viewport pans over them. Pointer layouts first shrink toward the clickable minimum and scroll
  // only once even that does not fit; compact layouts skip the shrink.
  const requiresHorizontalScrollFallback = input.compact
    ? naturalTotalWidth > availableTabsWidth
    : availableTabsWidth < minimumTotalWidth;

  let resolvedWidths = resolvedNaturalWidths;
  if (
    !requiresHorizontalScrollFallback &&
    !input.compact &&
    naturalTotalWidth > availableTabsWidth
  ) {
    const widthToRemove = naturalTotalWidth - availableTabsWidth;
    const shrinkCapacity = naturalTotalWidth - minimumTotalWidth;
    const shrinkRatio = widthToRemove / shrinkCapacity;
    resolvedWidths = resolvedNaturalWidths.map(
      (width) => width - (width - input.metrics.minTabWidth) * shrinkRatio,
    );
  }

  // The roomy cap only applies to the widths it produced; everything else keeps the
  // normal cap so a crowded row rounds exactly as it did before.
  const activeMaxTabWidth =
    resolvedNaturalWidths === roomyWidths ? roomyMaxTabWidth : input.metrics.maxTabWidth;
  const roundedWidths = resolvedWidths.map((width) =>
    Math.round(clamp(width, input.metrics.minTabWidth, activeMaxTabWidth)),
  );

  return {
    items: roundedWidths.map((width) => ({
      width,
      showLabel: width > tabChromeWidth,
    })),
    closeButtonPolicy,
    requiresHorizontalScrollFallback,
  };
}

export function selectWorkspaceChrome<Compact, Full>(input: {
  width: number | null;
  compact: Compact;
  full: Full;
}): Compact | Full {
  const compact = input.width !== null && shouldUseCompactWorkspaceHeader(input.width);
  return compact ? input.compact : input.full;
}

// A count badge is only 16pt wide. Native popovers need a content width floor
// because their scrolling tab list does not contribute an intrinsic width.
export const workspaceTabSwitcherPopoverLayout = { desktopMinWidth: 320 } as const;
