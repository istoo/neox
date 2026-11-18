// FILE: pageReplacement.ts
// Purpose: Read the installed catalog once and expose the plugin entry replacing a built-in page.
// Layer: Web plugin host

import { useMemo } from "react";

import { buildPluginContributionIndex, type PluginSidebarEntry } from "./contributions";
import { useRunningPlugins } from "./catalog";
import { replacedPluginPage, type PluginReplaceablePage } from "./pageReplacement.logic";

/** The running plugin's sidebar entry that replaced `page`, or null when none does. */
export function useReplacedPluginPage(page: PluginReplaceablePage): PluginSidebarEntry | null {
  const plugins = useRunningPlugins();
  return useMemo(
    () => replacedPluginPage(buildPluginContributionIndex(plugins).sidebarItems, page),
    [page, plugins],
  );
}
