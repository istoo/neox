import type { MutableDaemonConfig, MutableDaemonConfigPatch } from "@neolix/protocol/messages";

export interface BrowserToolsCardState {
  isVisible: boolean;
  isEnabled: boolean;
}

export interface BrowserToolsMutationViewState {
  isSwitchDisabled: boolean;
  isPending: boolean;
  errorText: string | null;
}

export function getBrowserToolsCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): BrowserToolsCardState {
  return {
    isVisible: input.isConnected,
    isEnabled: input.config?.browserTools.enabled === true,
  };
}

export function createBrowserToolsPatch(enabled: boolean): MutableDaemonConfigPatch {
  return { browserTools: { enabled } };
}

export function getBrowserToolsMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): BrowserToolsMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    isPending: input.isPending,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
