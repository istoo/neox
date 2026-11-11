// FILE: DiffTruncationWarning.tsx
// Purpose: Shared warning for repository diff surfaces backed by size-bounded patch reads.
// Layer: Web diff presentation

import type { HTMLAttributes } from "react";

import { TriangleAlertIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { useTranslation } from "~/i18n";

export const DEFAULT_DIFF_TRUNCATION_MESSAGE =
  "Neox stopped reading at the diff size limit. Some files or changes may be missing.";

export function DiffTruncationWarning({
  className,
  children: childrenProp,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const children = childrenProp === undefined ? DEFAULT_DIFF_TRUNCATION_MESSAGE : childrenProp;
  const { t } = useTranslation();

  return (
    <Alert {...props} variant="warning" size="sm" className={cn("shrink-0", className)}>
      <TriangleAlertIcon aria-hidden="true" />
      <AlertTitle>{t("common:partialDiff")}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
