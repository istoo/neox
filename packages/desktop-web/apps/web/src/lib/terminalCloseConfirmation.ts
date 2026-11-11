// FILE: terminalCloseConfirmation.ts
// Purpose: Shares terminal-tab close confirmation copy and dialog plumbing across chat and workspace surfaces.
// Layer: UI logic helper
// Depends on: Native dialog contract from the app shell.

import type { NativeApi } from "@synara/contracts";

import { t } from "~/i18n";
import { displayTerminalLabel } from "./terminalLabel";

// Prefer title overrides, then persisted labels, so confirmation copy matches visible tab names.
export function resolveTerminalCloseTitle(options: {
  terminalId: string;
  terminalLabelsById: Record<string, string>;
  terminalTitleOverridesById: Record<string, string>;
}): string {
  const title =
    options.terminalTitleOverridesById[options.terminalId]?.trim() ||
    options.terminalLabelsById[options.terminalId]?.trim();
  return title ? displayTerminalLabel(title) : t("workspace:viewportPane_terminal");
}

function buildTerminalCloseConfirmationMessage(options: {
  terminalTitle: string | null | undefined;
  willDeleteThread: boolean;
}): string {
  const trimmedTitle = options.terminalTitle?.trim();
  return [
    trimmedTitle && trimmedTitle.length > 0
      ? t("workspace:terminalCloseNamedTitle", { title: trimmedTitle })
      : t("workspace:terminalCloseCurrentTitle"),
    options.willDeleteThread
      ? t("workspace:terminalCloseDeletesThreadDescription")
      : t("workspace:terminalCloseDescription"),
  ].join("\n");
}

export function shouldPromptForTerminalClose(options: {
  confirmationEnabled: boolean;
  runningTerminalIds: readonly string[];
  terminalAttentionStatesById: Record<string, unknown>;
  terminalId: string;
}): boolean {
  if (!options.confirmationEnabled) {
    return false;
  }
  return (
    options.runningTerminalIds.includes(options.terminalId) ||
    options.terminalAttentionStatesById[options.terminalId] !== undefined
  );
}

export async function confirmTerminalTabClose(options: {
  api: Pick<NativeApi, "dialogs"> | null | undefined;
  enabled: boolean;
  terminalTitle: string | null | undefined;
  willDeleteThread?: boolean;
}): Promise<boolean> {
  if (!options.enabled || !options.api) {
    return true;
  }

  // Closing a running terminal ends its processes, so the action reads as destructive.
  return options.api.dialogs.confirm(
    buildTerminalCloseConfirmationMessage({
      terminalTitle: options.terminalTitle,
      willDeleteThread: options.willDeleteThread ?? false,
    }),
    { confirmLabel: t("common:form_close"), destructive: true },
  );
}
