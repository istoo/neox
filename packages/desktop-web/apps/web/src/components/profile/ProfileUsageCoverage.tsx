// FILE: ProfileUsageCoverage.tsx
// Purpose: Disclose missing provider telemetry beside profile rankings and exports.
// Layer: web profile feature.

import type { ProviderKind } from "@synara/contracts";
import { formatProviderLabel } from "@synara/profile-ui/formatting";
import { useTranslation } from "~/i18n";

export function ProfileUsageCoverage({
  unavailableProviders,
  className: classNameProp,
}: {
  readonly unavailableProviders: ReadonlyArray<ProviderKind>;
  readonly className?: string;
}) {
  const className = classNameProp ?? "text-ui leading-snug text-muted-foreground";
  const { t } = useTranslation();

  if (unavailableProviders.length === 0) {
    return null;
  }
  return (
    <p className={className}>
      {t("common:tokenUsageIsUnavailableOrZeroFor")}{" "}
      {unavailableProviders.map(formatProviderLabel).join(", ")}
      {t("common:percentagesReflectTrackedTokensOnlyTheirTurnsStillCount")}
    </p>
  );
}
