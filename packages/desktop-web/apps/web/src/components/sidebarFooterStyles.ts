// FILE: sidebarFooterStyles.ts
// Purpose: Shared look for the thread sidebar's bottom icon row (settings, usage, help,
//          update): the same 36px box as a sidebar row, in idle / hover / active tones.
// Layer: App shell styles

import { cn } from "~/lib/utils";
import {
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME,
} from "~/sidebarRowStyles";

/** Footer glyph size. */
export const SIDEBAR_FOOTER_GLYPH_CLASS_NAME = "size-5";

/** Footer button box and active/idle tone, shared by every bottom-row control. */
export function sidebarFooterButtonClassName(active: boolean): string {
  return cn(
    "size-9 rounded-lg",
    active
      ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
      : cn(SIDEBAR_SECTION_LABEL_TONE_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
  );
}
