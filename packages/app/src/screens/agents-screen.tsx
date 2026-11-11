import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { PageLayout } from "@/components/page-layout";
import { AgentPage } from "@/screens/settings/agent/agent-page";
import { useHosts } from "@/runtime/host-runtime";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { orderHostsLocalFirst, resolveActiveHostServerId } from "@/types/host-connection";
import { settingsStyles } from "@/styles/settings";

/**
 * The host the workspace is scoped to. Same resolution order as the rest of the
 * app: the active workspace's host, then the local daemon, then any connected
 * host.
 */
function useWorkspaceHostServerId(): string | null {
  const selection = useActiveWorkspaceSelection();
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const orderedHosts = useMemo(
    () => orderHostsLocalFirst(hosts, localServerId),
    [hosts, localServerId],
  );
  const selectedServerId = selection?.serverId ?? null;
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

/**
 * Agents is a workspace page, not a settings page: it is where the installed
 * CLIs, their connections and their models are day to day.
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  const serverId = useWorkspaceHostServerId();
  return (
    <PageLayout title={t("sidebar.sections.agents")}>
      {serverId === null ? (
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>{t("quickPanel.noHost")}</Text>
          </View>
        </View>
      ) : (
        <AgentPage serverId={serverId} />
      )}
    </PageLayout>
  );
}
