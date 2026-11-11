import { useCallback, useMemo } from "react";
import { useToast } from "@/contexts/toast-context";
import type { PluginIcon } from "@neolix/plugin/client";
import { createPluginCapabilities } from "../actions";
import { createPluginNavigation } from "../navigation";
import { useInstalledPlugins } from "../registry";
import type { InstalledPlugin } from "../types";

/** One plugin item in a provider or agent row's menu. */
export interface PluginRowAction {
  key: string;
  title: string;
  icon?: PluginIcon;
  run(): void;
}

function reportError(toast: ReturnType<typeof useToast>, error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error));
}

function capabilitiesOf(plugin: InstalledPlugin, workspaceId: string | null) {
  return createPluginCapabilities(
    plugin,
    createPluginNavigation({ serverId: plugin.serverId, workspaceId }),
  );
}

/** A gateway provider row's plugin menu items, for this host's providers. */
export function useProviderRowActions(provider: {
  serverId: string;
  id: string;
  name: string;
}): readonly PluginRowAction[] {
  const installed = useInstalledPlugins();
  const toast = useToast();
  const run = useCallback(
    (plugin: InstalledPlugin, action: InstalledPlugin["providerActions"][number]) => {
      try {
        void Promise.resolve(
          action.onSelect({
            ...capabilitiesOf(plugin, null),
            provider: { id: provider.id, name: provider.name },
          }),
        ).catch((error: unknown) => reportError(toast, error));
      } catch (error) {
        reportError(toast, error);
      }
    },
    [provider.id, provider.name, toast],
  );
  return useMemo(
    () =>
      installed
        .filter((plugin) => plugin.serverId === provider.serverId)
        .flatMap((plugin) =>
          plugin.providerActions.map((action) => ({
            key: `${plugin.id}/${action.id}`,
            title: plugin.i18n.resolve(action.title, plugin.locale),
            icon: action.icon,
            run: () => run(plugin, action),
          })),
        ),
    [installed, provider.serverId, run],
  );
}

/** An agent row's plugin menu items; picking one hands it the agent's id and name. */
export function useAgentRowActions(agent: {
  serverId: string;
  id: string;
  name: string;
  workspaceId?: string;
}): readonly PluginRowAction[] {
  const installed = useInstalledPlugins();
  const toast = useToast();
  const run = useCallback(
    (
      plugin: InstalledPlugin,
      action: InstalledPlugin["agentActions"][number],
      workspaceId: string | null,
    ) => {
      try {
        void Promise.resolve(
          action.onSelect({
            ...capabilitiesOf(plugin, workspaceId),
            agent: { id: agent.id, name: agent.name },
          }),
        ).catch((error: unknown) => reportError(toast, error));
      } catch (error) {
        reportError(toast, error);
      }
    },
    [agent.id, agent.name, toast],
  );
  const workspaceId = agent.workspaceId ?? null;
  return useMemo(
    () =>
      installed
        .filter((plugin) => plugin.serverId === agent.serverId)
        .flatMap((plugin) =>
          plugin.agentActions.map((action) => ({
            key: `${plugin.id}/${action.id}`,
            title: plugin.i18n.resolve(action.title, plugin.locale),
            icon: action.icon,
            run: () => run(plugin, action, workspaceId),
          })),
        ),
    [agent.serverId, installed, run, workspaceId],
  );
}
