import { QueryClientProvider } from "@tanstack/react-query";
import {
  NeolixApiProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@neolix/plugin/client/host";
import React, { type ReactNode } from "react";
import type { InstalledPlugin } from "./types";

/** Every plugin surface renders under its installation: one query cache, one Neolix client, RPCs. */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <NeolixApiProvider neolix={plugin.neolix}>
        <PluginRpcProvider invoke={plugin.invoke} subscribe={plugin.subscribe}>
          <PluginTranslationProvider runtime={plugin.i18n}>{children}</PluginTranslationProvider>
        </PluginRpcProvider>
      </NeolixApiProvider>
    </QueryClientProvider>
  );
}
