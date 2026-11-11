// FILE: terminalCharacterWidths.ts
// Purpose: Map the daemon's advertised width table to the xterm Unicode version.
// Layer: Terminal runtime infrastructure

import type { TerminalCharacterWidths } from "@synara/contracts";

/**
 * A daemon that predates `terminal-grapheme-widths` parsed its buffer with xterm's Unicode 11
 * table. The web terminal keeps that table until a snapshot says otherwise.
 */
export const DEFAULT_TERMINAL_CHARACTER_WIDTHS: TerminalCharacterWidths = "unicode11";

/** xterm's registered Unicode provider names, as loaded by addon-unicode11/graphemes. */
export function unicodeVersionForCharacterWidths(
  widths: TerminalCharacterWidths | undefined,
): "11" | "15-graphemes" {
  return widths === "graphemes" ? "15-graphemes" : "11";
}
