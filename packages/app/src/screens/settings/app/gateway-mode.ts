import { useMemo } from "react";
import { getIsElectron, isWeb } from "@/constants/platform";
import type { GatewayMode } from "@/hooks/use-settings";
import { useAppSettings } from "@/hooks/use-settings";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import type { HostSectionSlug, ModelsView } from "@/utils/host-routes";
import { useSettingsHostServerId } from "./shared";
import type { SettingsPageId } from "./types";

/**
 * App settings pages gateway mode leaves out. myna's GATEWAY_HIDES names
 * only its Agents and Library pages, so no app page goes.
 */
export const GATEWAY_MODE_HIDDEN_PAGES: ReadonlySet<SettingsPageId> = new Set();

/** myna's GATEWAY_HIDES (gui/assets/app.js): the Agents and Library pages. */
export const GATEWAY_MODE_HIDDEN_HOST_SECTIONS: ReadonlySet<HostSectionSlug> = new Set([
  "agents",
  "library",
]);

/** Where gateway mode sends a hidden page, as myna sends it to Providers. */
export const GATEWAY_MODE_FALLBACK_VIEW: ModelsView = "sources";

export type GatewayModeReason =
  | "pinned-on"
  | "pinned-off"
  | "flag"
  | "no-agents"
  | "agents"
  | "checking";

/**
 * The daemon's own reading of gateway mode (myna's gatewaymode.go): a pinned
 * setting, the `neolix web --gateway` flag, or no agent installed here.
 * An empty reason means auto with agents found, which reads as plain Off.
 */
export function gatewayModeReasonFromServer(reason: string): GatewayModeReason {
  const reasons: Record<string, GatewayModeReason> = {
    on: "pinned-on",
    off: "pinned-off",
    flag: "flag",
    "no-agents": "no-agents",
    "": "agents",
  };
  return reasons[reason] ?? "agents";
}

export interface GatewayModeState {
  mode: GatewayMode;
  /** Whether only the gateway-facing screens should show. */
  enabled: boolean;
  reason: GatewayModeReason;
}

/**
 * myna's Gateway mode: `on` shows only what serving other machines needs,
 * `off` shows everything, and `auto` is on when the host has no agent that is
 * ready to work. Until the host's provider snapshot says otherwise, auto
 * stays off so the normal app does not flicker into gateway mode.
 */
export function useGatewayMode(hostServerId?: string | null): GatewayModeState {
  const { settings } = useAppSettings();
  const selectedServerId = useSettingsHostServerId();
  // A host settings page already knows its host from the route; the picker's
  // selection can lag behind a deep link.
  const serverId = hostServerId === undefined ? selectedServerId : hostServerId;
  const mode = settings.gatewayMode;
  const { entries, supportsSnapshot } = useProvidersSnapshot(serverId, {
    enabled: mode === "auto",
  });
  // A browser page is told its mode by the daemon (myna's gatewaymode.go):
  // Settings' on/off first, then `neolix web --gateway`. An app window is
  // never sent one, and keeps its own reading.
  const serverMode = useSessionStore((store) =>
    serverId === null ? null : (store.sessions[serverId]?.serverInfo?.gatewayMode ?? null),
  );
  const hasAgents = useMemo(() => {
    if (!supportsSnapshot || entries === undefined) {
      return null;
    }
    return entries.some((entry) => entry.status === "ready");
  }, [entries, supportsSnapshot]);

  // myna sets gatewayMode only for the page `myna web` serves (app.js:44
  // `web && !!window.bootPrefs?.gateway`). An app window shows everything
  // however the setting reads.
  if (!isWeb || getIsElectron()) {
    return { mode, enabled: false, reason: "agents" };
  }

  if (serverMode !== null) {
    return {
      mode,
      enabled: serverMode.on,
      reason: gatewayModeReasonFromServer(serverMode.reason),
    };
  }
  if (mode === "on") {
    return { mode, enabled: true, reason: "pinned-on" };
  }
  if (mode === "off") {
    return { mode, enabled: false, reason: "pinned-off" };
  }
  if (hasAgents === null) {
    return { mode, enabled: false, reason: "checking" };
  }
  return {
    mode,
    enabled: !hasAgents,
    reason: hasAgents ? "agents" : "no-agents",
  };
}
