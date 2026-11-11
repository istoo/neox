import {
  DEFAULT_CHAT_FONT_SIZE_PX,
  MAX_CHAT_FONT_SIZE_PX,
  MAX_CODE_FONT_SIZE_PX,
  MAX_UI_FONT_SIZE_PX,
  MIN_CODE_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  normalizeCodeFontSizePx,
  normalizeUiFontSizePx,
} from "../appSettings";

export interface AppTypographyScale {
  basePx: number;
  uiPx: number;
  uiLgPx: number;
  uiSmPx: number;
  uiXsPx: number;
  ui2XsPx: number;
  uiMetaPx: number;
  uiTimestampPx: number;
  chatPx: number;
  chatCodePx: number;
  chatMetaPx: number;
  chatTinyPx: number;
}

function clampTypographyPx(value: number, min: number, max = MAX_CHAT_FONT_SIZE_PX + 2): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export interface AppTypographyRoots {
  /** Interface root; null follows the content size. */
  uiFontSizePx?: number | null;
  /** Code root; null follows the content size. */
  codeFontSizePx?: number | null;
}

export function getAppTypographyScale(
  baseFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
  roots: AppTypographyRoots = {},
): AppTypographyScale {
  const basePx = normalizeChatFontSizePx(baseFontSizePx);
  // The UI ramp grows from its own root (Settings' interface size), while the
  // transcript keeps the content size. Code text has a separate absolute root.
  const uiPx = normalizeUiFontSizePx(roots.uiFontSizePx) ?? basePx;
  const chatCodePx =
    normalizeCodeFontSizePx(roots.codeFontSizePx) ??
    clampTypographyPx(basePx * 0.95, MIN_CODE_FONT_SIZE_PX, MAX_CODE_FONT_SIZE_PX);

  return {
    basePx,
    uiPx,
    uiLgPx: clampTypographyPx(uiPx * 1.08, uiPx, MAX_UI_FONT_SIZE_PX + 2),
    uiSmPx: clampTypographyPx(uiPx * 0.92, 10),
    uiXsPx: clampTypographyPx(uiPx * 0.84, 10),
    ui2XsPx: clampTypographyPx(uiPx * 0.76, 9),
    uiMetaPx: clampTypographyPx(uiPx * 0.84, 10),
    uiTimestampPx: clampTypographyPx(uiPx * 0.72, 8),
    chatPx: basePx,
    chatCodePx,
    chatMetaPx: clampTypographyPx(basePx * 0.72, 8),
    chatTinyPx: clampTypographyPx(basePx * 0.66, 8),
  };
}
