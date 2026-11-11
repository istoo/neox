import { useCallback } from "react";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";

interface UsageAlertSettings {
  /** Whether the host keeps the thresholds; older hosts keep them in this app. */
  supported: boolean;
  /** The value in force: the daemon's when it has one, else this app's. */
  usageAlertPercent: number;
  balanceAlert: number;
  setUsageAlertPercent: (value: number) => void;
  setBalanceAlert: (value: number) => void;
}

/**
 * myna's UsageAlert and BalanceAlert (settings.go): the daemon keeps them,
 * so every client of a host agrees. A host that has not saved them yet
 * falls back to this app's local settings, and the first save writes them
 * to the daemon.
 */
export function useUsageAlertSettings(serverId: string | null): UsageAlertSettings {
  const supported = useSessionStore((state) =>
    Boolean(serverId && state.sessions[serverId]?.serverInfo?.features?.usageAlertSettings),
  );
  const { config, patchConfig } = useDaemonConfig(supported ? serverId : null);
  const { settings, updateSettings } = useAppSettings();
  const usageAlertPercent = config?.usageAlertPercent ?? settings.usageAlertPercent;
  const balanceAlert = config?.balanceAlert ?? settings.balanceAlert;

  const setUsageAlertPercent = useCallback(
    (value: number) => {
      // Kept locally too, for a client that later meets a host without it.
      void updateSettings({ usageAlertPercent: value });
      if (supported) {
        void patchConfig({ usageAlertPercent: value });
      }
    },
    [patchConfig, supported, updateSettings],
  );
  const setBalanceAlert = useCallback(
    (value: number) => {
      void updateSettings({ balanceAlert: value });
      if (supported) {
        void patchConfig({ balanceAlert: value });
      }
    },
    [patchConfig, supported, updateSettings],
  );

  return {
    supported,
    usageAlertPercent,
    balanceAlert,
    setUsageAlertPercent,
    setBalanceAlert,
  };
}
