// FILE: PluginPanelSurface.tsx
// Purpose: Look up a declared plugin view and render it as a dock pane or a file tab body.
// Layer: Web plugin host
// Exports: PluginPanelSurface, PluginDockPane

import { Spinner } from "~/components/ui/spinner";

import { usePluginCatalog, useRunningPlugins } from "./catalog";
import { PluginNativeOnlyNotice, PluginViewHost } from "./PluginViewHost";

export function PluginPanelSurface(props: {
  readonly pluginId: string | null;
  readonly viewId: string | null;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly className?: string | undefined;
}) {
  const catalog = usePluginCatalog();
  const plugin = props.pluginId
    ? catalog.plugins.find((entry) => entry.id === props.pluginId)
    : undefined;
  const view = props.viewId
    ? plugin?.web?.views.find((entry) => entry.id === props.viewId)
    : undefined;
  if (!plugin || !view) {
    if (catalog.status === "loading" || catalog.status === "idle") {
      return (
        <div className={props.className ?? "flex h-full items-center justify-center"}>
          <Spinner />
        </div>
      );
    }
    return <PluginNativeOnlyNotice className={props.className} />;
  }
  return (
    <PluginViewHost
      plugin={plugin}
      viewId={view.id}
      params={props.params}
      className={props.className}
      fill
    />
  );
}

/** Right-dock pane: the plugin panel fills the tab body. */
export function PluginDockPane(props: {
  readonly pluginId: string | null;
  readonly viewId: string | null;
  readonly params: Readonly<Record<string, string>> | null;
}) {
  const plugins = useRunningPlugins();
  const running = props.pluginId ? plugins.some((plugin) => plugin.id === props.pluginId) : false;
  if (!running) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <PluginNativeOnlyNotice />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PluginPanelSurface
        pluginId={props.pluginId}
        viewId={props.viewId}
        params={props.params ?? undefined}
        className="min-h-0 flex-1"
      />
    </div>
  );
}
