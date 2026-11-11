import { create } from "zustand";
import type { GatewayUsageView } from "@/screens/settings/gateway/usage-page";
import type { PluginsView } from "@/screens/settings/plugins-page";
import type { LibraryView } from "@/screens/settings/library/library-page";

/**
 * The subpage open on a settings page that has tabs. Myna mirrors a page's
 * tabs under its sidebar item, so the sidebar and the page share this one
 * value instead of each keeping its own.
 */
interface SettingsSubviewState {
  usage: GatewayUsageView;
  plugins: PluginsView | null;
  library: LibraryView;
  /** A market server the Library page opens its sheet for, from another page. */
  libraryServer: string | null;
  /** The provider the Usage page asked the Providers page to open. */
  gatewayProvider: string | null;
  setUsage: (view: GatewayUsageView) => void;
  setGatewayProvider: (providerId: string | null) => void;
  setPlugins: (view: PluginsView) => void;
  setLibrary: (view: LibraryView) => void;
  setLibraryServer: (name: string | null) => void;
}

export const useSettingsSubviewStore = create<SettingsSubviewState>((set) => ({
  usage: "overview",
  // null leaves the plugin page on the tab it remembers for this viewer.
  plugins: null,
  library: "instructions",
  libraryServer: null,
  gatewayProvider: null,
  setUsage: (usage) => set({ usage }),
  setGatewayProvider: (gatewayProvider) => set({ gatewayProvider }),
  setPlugins: (plugins) => set({ plugins }),
  setLibrary: (library) => set({ library }),
  setLibraryServer: (libraryServer) => set({ libraryServer }),
}));
