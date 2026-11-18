// FILE: HostUpdateNotice.tsx
// Purpose: The one "this needs a newer host" message. A missing `server_info.features` flag
//          renders this instead of the feature; there is no degraded path to fall back to.
// Layer: Shared UI

import { CircleAlertIcon } from "~/lib/icons";
import { useTranslation } from "~/i18n";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

export function HostUpdateNotice({
  compact = false,
  className,
}: {
  /** Panel chrome: tighter padding, for a section body rather than a page. */
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Alert
      variant="warning"
      size={compact ? "sm" : "default"}
      className={className}
      data-testid="host-update-notice"
    >
      <CircleAlertIcon aria-hidden />
      <AlertTitle>{t("common:hostFeature_updateHostTitle")}</AlertTitle>
      <AlertDescription>{t("common:hostFeature_updateHostDescription")}</AlertDescription>
    </Alert>
  );
}
