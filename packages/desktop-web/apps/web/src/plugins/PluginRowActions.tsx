// FILE: PluginRowActions.tsx
// Purpose: Declarative provider/agent row actions and provider panels for hosts that cannot run
//          the plugin's client bundle: the settings provider row menu, the provider editor body,
//          and the agent row menu.
// Layer: Web plugin host
// Exports: provider action menu, provider panels, agent action items + runner

import type { ContextMenuItem, NeolixPlugin } from "@synara/contracts";
import { useMemo } from "react";

import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { IconButton } from "~/components/ui/icon-button";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { EllipsisIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex, runPluginAction } from "./contributions";
import { PluginViewHost } from "./PluginViewHost";
import { openPluginView } from "./viewStore";

const AGENT_ACTION_PREFIX = "plugin-agent-action:";

function actionParams(provider: { id: string; name: string }) {
  return { providerId: provider.id, providerName: provider.name };
}

export function PluginProviderActionsMenu(props: {
  readonly providerId: string;
  readonly providerName: string;
}) {
  const { t } = useTranslation();
  const plugins = useRunningPlugins();
  const actions = useMemo(() => buildPluginContributionIndex(plugins).providerActions, [plugins]);
  if (actions.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            variant="ghost"
            size="icon-sm"
            shape="capsule"
            label={t("settings:pluginProviderActions", { name: props.providerName })}
          >
            <EllipsisIcon className="size-4" />
          </IconButton>
        }
      />
      <ComposerPickerMenuPopup align="end" side="bottom" sideOffset={6} className="w-52 min-w-52">
        {actions.map((entry) => (
          <MenuItem
            key={`${entry.pluginId}:${entry.contribution.id}`}
            onClick={() => {
              void runPluginAction(
                entry.pluginId,
                entry.contribution.action,
                (_pluginId, viewId, params) =>
                  openPluginView({
                    pluginId: entry.pluginId,
                    viewId,
                    params: {
                      ...params,
                      ...actionParams({ id: props.providerId, name: props.providerName }),
                    },
                  }),
              ).catch(() => undefined);
            }}
          >
            {entry.contribution.title}
          </MenuItem>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

/** Provider panels render inside the provider's editor body. */
export function PluginProviderPanels(props: {
  readonly providerId: string;
  readonly providerName: string;
}) {
  const plugins = useRunningPlugins();
  const panels = useMemo(() => buildPluginContributionIndex(plugins).providerPanels, [plugins]);
  if (panels.length === 0) return null;
  return (
    <div className="space-y-2">
      {panels.map((entry) => {
        const plugin = plugins.find((candidate) => candidate.id === entry.pluginId);
        if (!plugin) return null;
        return (
          <div key={`${entry.pluginId}:${entry.contribution.id}`} className="space-y-1">
            <div className="text-ui-sm font-medium text-foreground">{entry.contribution.title}</div>
            <PluginViewHost
              plugin={plugin}
              viewId={entry.contribution.view}
              params={actionParams({ id: props.providerId, name: props.providerName })}
              minHeight={240}
            />
          </div>
        );
      })}
    </div>
  );
}

function runningPlugins(plugins: readonly NeolixPlugin[]): readonly NeolixPlugin[] {
  return plugins.filter((plugin) => plugin.enabled && plugin.status === "running");
}

/** Rows appended to an agent row's context menu. */
export function pluginAgentActionItems(plugins: readonly NeolixPlugin[]): ContextMenuItem[] {
  return buildPluginContributionIndex(runningPlugins(plugins)).agentActions.map((entry, index) => {
    const item: ContextMenuItem = {
      id: `${AGENT_ACTION_PREFIX}${entry.pluginId}:${entry.contribution.id}`,
      label: entry.contribution.title,
    };
    if (index === 0) item.separatorBefore = true;
    return item;
  });
}

export function isPluginAgentActionItemId(id: string): boolean {
  return id.startsWith(AGENT_ACTION_PREFIX);
}

/** Runs one agent action with the row's id and title as params. */
export async function runPluginAgentActionItem(input: {
  readonly plugins: readonly NeolixPlugin[];
  readonly itemId: string;
  readonly agentId: string;
  readonly agentName: string;
}): Promise<void> {
  const index = buildPluginContributionIndex(runningPlugins(input.plugins));
  const entry = index.agentActions.find(
    (candidate) =>
      `${AGENT_ACTION_PREFIX}${candidate.pluginId}:${candidate.contribution.id}` === input.itemId,
  );
  if (!entry) return;
  await runPluginAction(entry.pluginId, entry.contribution.action, (pluginId, viewId, params) =>
    openPluginView({
      pluginId,
      viewId,
      params: {
        ...params,
        agentId: input.agentId,
        agentName: input.agentName,
      },
    }),
  );
}
