import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, type Href } from "expo-router";
import type { DaemonGetStatusResponse } from "@neolix/protocol/messages";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useSettingsHostSelection } from "@/navigation/settings-presentation";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";

/**
 * A settings row whose control is a button that opens another settings page.
 * The myna pages use these for settings owned by a host instead of drawing a
 * second copy of the control.
 */
export function SettingsLinkRow({
  label,
  hint,
  actionLabel,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  hint?: string;
  actionLabel: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <SettingsRow label={label} hint={hint} testID={testID}>
      <Button variant="outline" onPress={onPress} disabled={disabled}>
        {actionLabel}
      </Button>
    </SettingsRow>
  );
}

/** Replaces the route on desktop's split view and pushes on a compact layout. */
export function useSettingsNavigate(): (href: Href) => void {
  const router = useRouter();
  const isCompactLayout = useIsCompactFormFactor();
  return useCallback(
    (href: Href) => {
      if (isCompactLayout) {
        router.push(href);
        return;
      }
      router.replace(href);
    },
    [isCompactLayout, router],
  );
}

/** The daemon's status for a host, for the rows myna reads an address from (null until it answers). */
export function useDaemonStatus(
  serverId: string | null,
): DaemonGetStatusResponse["payload"] | null {
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId, "daemonStatusRpc");
  const [status, setStatus] = useState<DaemonGetStatusResponse["payload"] | null>(null);
  useEffect(() => {
    if (client === null || !supported) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    void client
      .getDaemonStatus()
      .then((value) => {
        if (!cancelled) setStatus(value);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, supported]);
  return status;
}

/** The host the app settings pages scope to, resolved as the settings screen does. */
export function useSettingsHostServerId(): string | null {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const selectedServerId = useSettingsHostSelection();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  return useMemo(
    () =>
      resolveActiveHostServerId({
        selectedServerId,
        localServerId,
        hosts,
        orderedHosts,
      }),
    [hosts, localServerId, orderedHosts, selectedServerId],
  );
}
