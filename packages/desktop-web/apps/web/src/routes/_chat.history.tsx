import { createFileRoute, Navigate } from "@tanstack/react-router";

import { HistoryPage } from "~/components/history/HistoryPage";
import { useReplacedPluginPage } from "~/plugins/pageReplacement";

export const Route = createFileRoute("/_chat/history")({
  component: HistoryRoute,
});

/** A plugin page taking History's place keeps the built-in route as a redirect. */
function HistoryRoute() {
  const replacement = useReplacedPluginPage("sessions");
  if (replacement) {
    return (
      <Navigate
        to="/plugin/$pluginId/$viewId"
        params={{ pluginId: replacement.pluginId, viewId: replacement.contribution.view }}
        replace
      />
    );
  }
  return <HistoryPage />;
}
