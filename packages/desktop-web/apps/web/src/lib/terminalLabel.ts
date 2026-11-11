// FILE: terminalLabel.ts
// Purpose: Shows generated terminal names ("Terminal", "Terminal 2") in the UI language.
// Layer: Web terminal presentation
// Exports: displayTerminalLabel
// Why: The terminal store generates and persists English names and dedupes new ones against
//      them, so the stored value stays as is and only what the user sees is translated. Names
//      the user typed are shown unchanged.

import { t } from "../i18n";

const GENERATED_TERMINAL_LABEL = /^Terminal(?: (\d+))?$/;

export function displayTerminalLabel(label: string): string {
  const match = GENERATED_TERMINAL_LABEL.exec(label.trim());
  if (!match) return label;
  return match[1]
    ? t("workspace:terminalNumbered", { value0: match[1] })
    : t("workspace:viewportPane_terminal");
}
