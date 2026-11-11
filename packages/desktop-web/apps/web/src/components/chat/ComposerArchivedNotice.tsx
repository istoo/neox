// FILE: ComposerArchivedNotice.tsx
// Purpose: Composer strip for an archived chat opened directly (search, link, settings):
//          says it is archived and offers Unarchive in place, without a trip to Settings.
// Layer: Chat composer UI
// Exports: ComposerArchivedNotice

import { ArchiveIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { COMPOSER_INLINE_ACTION_PILL_CLASS_NAME } from "./composerPickerStyles";
import { COMPOSER_NOTICE_CONTENT_CLASS_NAME } from "./composerStackedPanelStyles";
import { useTranslation } from "~/i18n";

export function ComposerArchivedNotice({ onUnarchive }: { onUnarchive: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="composer-archived-notice"
      className={cn(
        COMPOSER_NOTICE_CONTENT_CLASS_NAME,
        "squircle flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[inherit] bg-muted/40",
      )}
    >
      <ArchiveIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 text-ui-sm text-muted-foreground">
        <span className="font-medium text-foreground">{t("chat:archivedNotice_title")}</span>
        <span className="block">{t("chat:archivedNotice_description")}</span>
      </span>
      <button
        type="button"
        className={cn(COMPOSER_INLINE_ACTION_PILL_CLASS_NAME, "text-ui-sm")}
        onClick={onUnarchive}
      >
        {t("workspace:detail_unarchive")}
      </button>
    </div>
  );
}
