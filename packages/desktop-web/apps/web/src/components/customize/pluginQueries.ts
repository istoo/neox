// FILE: pluginQueries.ts
// Purpose: The installed-plugin list query and its "host too old" error, used by the plugin
//          library (Settings › Plugins).
// Layer: Plugin data hooks
// Exports: NEOLIX_PLUGINS_QUERY_KEY, PluginsUnsupportedError, useInstalledPluginsQuery

import type { NeolixPluginsListResult } from "@synara/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTranslation } from "~/i18n";
import { ensureNativeApi } from "~/nativeApi";

export const NEOLIX_PLUGINS_QUERY_KEY = ["neolix", "plugins", "list"] as const;

/** Marks the host as too old for plugin management without depending on localized text. */
export class PluginsUnsupportedError extends Error {
  override name = "PluginsUnsupportedError";
}

export function useInstalledPluginsQuery(): UseQueryResult<NeolixPluginsListResult> {
  const { t } = useTranslation();
  return useQuery({
    queryKey: NEOLIX_PLUGINS_QUERY_KEY,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new PluginsUnsupportedError(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.list();
    },
    retry: false,
    staleTime: 2_000,
  });
}
