// FILE: usePluginSlashCommands.ts
// Purpose: Surfaces manifest slash commands in the composer menu and executes them before a
//          prompt is sent to the agent.
// Layer: Web plugin host
// Exports: usePluginSlashCommandItems, usePluginSlashCommandHandler

import type { NeolixPluginSlashCommand } from "@synara/contracts";
import { useCallback, useMemo } from "react";

import { toastManager } from "~/components/ui/toast";
import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";
import { useTranslation } from "~/i18n";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex, invokePluginRpc } from "./contributions";
import { runDeclaredPluginAction } from "./usePluginCommandActions";

export interface PluginSlashCommandInvocation {
  readonly pluginId: string;
  readonly contribution: NeolixPluginSlashCommand;
  readonly args: string;
}

const PLUGIN_SLASH_PATTERN = /^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/;

export function usePluginSlashCommandItems(): ComposerCommandItem[] {
  const plugins = useRunningPlugins();
  return useMemo(
    () =>
      buildPluginContributionIndex(plugins).slashCommands.map((entry) => {
        const item: ComposerCommandItem & { type: "plugin-slash-command" } = {
          id: `plugin-slash:${entry.pluginId}:${entry.contribution.name}`,
          type: "plugin-slash-command",
          pluginId: entry.pluginId,
          name: entry.contribution.name,
          label: `/${entry.contribution.name}`,
          description: entry.contribution.description,
        };
        return entry.contribution.argumentHint
          ? Object.assign(item, { argumentHint: entry.contribution.argumentHint })
          : item;
      }),
    [plugins],
  );
}

export function findPluginSlashCommandInvocation(
  text: string,
  entries: readonly {
    readonly pluginId: string;
    readonly contribution: NeolixPluginSlashCommand;
  }[],
): PluginSlashCommandInvocation | null {
  const match = PLUGIN_SLASH_PATTERN.exec(text.trim());
  if (!match) return null;
  const name = match[1]!;
  const entry = entries.find((candidate) => candidate.contribution.name === name);
  if (!entry) return null;
  return { pluginId: entry.pluginId, contribution: entry.contribution, args: match[2] ?? "" };
}

/**
 * Returns a handler that claims plugin slash commands, or false so the caller falls through to the
 * built-in slash-command handling and then a normal send.
 */
export function usePluginSlashCommandHandler(): (trimmed: string) => Promise<boolean> {
  const plugins = useRunningPlugins();
  const { t } = useTranslation();
  return useCallback(
    async (trimmed: string) => {
      const entries = buildPluginContributionIndex(plugins).slashCommands;
      const invocation = findPluginSlashCommandInvocation(trimmed, entries);
      if (!invocation) return false;
      const action = invocation.contribution.action;
      try {
        if (action.kind === "pluginRpc") {
          const base =
            typeof action.input === "object" &&
            action.input !== null &&
            !Array.isArray(action.input)
              ? (action.input as Record<string, unknown>)
              : {};
          await invokePluginRpc(invocation.pluginId, action.method, {
            ...base,
            args: invocation.args,
          });
        } else {
          await runDeclaredPluginAction(invocation.pluginId, action);
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("common:pluginCommandFailedNamed", { value0: invocation.contribution.name }),
          description: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    },
    [plugins, t],
  );
}
