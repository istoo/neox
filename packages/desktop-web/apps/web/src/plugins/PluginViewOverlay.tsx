// FILE: PluginViewOverlay.tsx
// Purpose: Renders the currently opened plugin view as a dialog. Mounted once by the chat shell so
//          any contribution can open a view without owning a route.
// Layer: Web plugin host
// Exports: PluginViewOverlay

import { useNavigate } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Maximize2 } from "~/lib/icons";
import { useTranslation } from "~/i18n";

import { usePluginCatalog } from "./catalog";
import { closePluginView, usePluginViewTarget } from "./viewStore";
import { PluginNativeOnlyNotice, PluginViewHost } from "./PluginViewHost";

export function PluginViewOverlay() {
  const target = usePluginViewTarget();
  const catalog = usePluginCatalog();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const plugin = target ? catalog.plugins.find((entry) => entry.id === target.pluginId) : undefined;
  const view = target ? plugin?.web?.views.find((entry) => entry.id === target.viewId) : undefined;
  const openFullPage = () => {
    if (!target) return;
    closePluginView();
    void navigate({
      to: "/plugin/$pluginId/$viewId",
      params: { pluginId: target.pluginId, viewId: target.viewId },
    });
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) closePluginView();
      }}
    >
      <DialogPopup className="h-[min(80vh,52rem)] max-w-4xl" showCloseButton>
        <DialogHeader>
          <DialogTitle>
            {view?.title ?? plugin?.name ?? target?.pluginId ?? t("common:pluginViewTitle")}
          </DialogTitle>
          {target && plugin && view ? (
            <Button variant="outline" size="sm" onClick={openFullPage}>
              <Maximize2 className="size-3.5" />
              {t("chat:pluginOpenFullPage")}
            </Button>
          ) : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {target && plugin && view ? (
            <PluginViewHost
              plugin={plugin}
              viewId={view.id}
              params={target.params}
              className="h-full"
              minHeight={320}
            />
          ) : (
            <PluginNativeOnlyNotice />
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
