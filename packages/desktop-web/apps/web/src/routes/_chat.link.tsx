// FILE: _chat.link.tsx
// Purpose: Registers the device-code approval screen under the shared chat shell.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";
import { RouteUnavailableState } from "~/components/RouteUnavailableState";
import { useTranslation } from "~/i18n";

function LinkRouteView() {
  const { t } = useTranslation();
  // Neox 无 device-code link 后端：直接访问时给出明确说明，而不是静默跳到新对话。
  return (
    <RouteUnavailableState
      title={t("common:deviceLinkUnavailableTitle")}
      description={t("common:deviceLinkUnavailableDescription")}
    />
  );
}

export const Route = createFileRoute("/_chat/link")({
  component: LinkRouteView,
});
