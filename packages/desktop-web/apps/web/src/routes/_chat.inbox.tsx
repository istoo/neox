import { createFileRoute } from "@tanstack/react-router";

import { INBOX_ON } from "~/betaFeatures";
import InboxView from "~/components/inbox/InboxView";
import { RouteUnavailableState } from "~/components/RouteUnavailableState";
import { useTranslation } from "~/i18n";

function InboxRouteView() {
  const { t } = useTranslation();
  if (!INBOX_ON) {
    return (
      <RouteUnavailableState
        title={t("common:inboxUnavailableTitle")}
        description={t("common:inboxUnavailableDescription")}
      />
    );
  }
  return <InboxView />;
}

export const Route = createFileRoute("/_chat/inbox")({
  component: InboxRouteView,
});
