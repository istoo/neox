// FILE: _chat.plugin.$pluginId.$viewId.tsx
// Purpose: Renders a declared plugin web view as a full-page surface under the chat shell.
//          The dialog overlay stays for actions that open a view in place; this route is the
//          page-shaped destination the native app's plugin screens had.
// Layer: Route

import { createFileRoute } from "@tanstack/react-router";

import { appHistory } from "~/appNavigation";
import { IconButton } from "~/components/ui/icon-button";
import { Spinner } from "~/components/ui/spinner";
import { ArrowLeftIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";
import { usePluginCatalog } from "~/plugins/catalog";
import { PluginNativeOnlyNotice, PluginViewHost } from "~/plugins/PluginViewHost";

export const Route = createFileRoute("/_chat/plugin/$pluginId/$viewId")({
  component: PluginPageRoute,
});

function PluginPageRoute() {
  const { pluginId, viewId } = Route.useParams();
  const { t } = useTranslation();
  const catalog = usePluginCatalog();
  const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
  const view = plugin?.web?.views.find((entry) => entry.id === viewId);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t("chat:pluginBack")}
          onClick={() => appHistory.back()}
        >
          <ArrowLeftIcon className="size-4" />
        </IconButton>
        <span className="min-w-0 truncate text-ui-lg font-medium text-foreground">
          {view?.title ?? plugin?.name ?? pluginId}
        </span>
        {plugin && plugin.name ? (
          <span className="ml-auto min-w-0 truncate text-ui-sm text-muted-foreground">
            {plugin.name}
          </span>
        ) : null}
      </header>
      <div className="min-h-0 flex-1">
        {plugin && view ? (
          <PluginViewHost plugin={plugin} viewId={view.id} fill className="h-full" />
        ) : catalog.status === "loading" || catalog.status === "idle" ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : plugin && (plugin.web?.views.length ?? 0) === 0 ? (
          <PluginNativeOnlyNotice className="m-4" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
            <p className="text-ui-lg font-medium text-foreground">
              {t("settings:plugins_viewNotFoundTitle")}
            </p>
            <p className="text-ui text-muted-foreground">
              {t("settings:plugins_viewNotFoundDescription")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
