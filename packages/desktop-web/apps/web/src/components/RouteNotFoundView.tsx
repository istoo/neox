// FILE: RouteNotFoundView.tsx
// Purpose: The chat shell's answer to an unknown URL (a stale bookmark, a mistyped deep link):
//          a localized empty state with a way home, instead of the router's bare "Not Found".
// Layer: Shared app component

import { useNavigate } from "@tanstack/react-router";

import { useTranslation } from "~/i18n";
import { CHAT_BACKGROUND_CLASS_NAME } from "./chat/composerPickerStyles";
import { RouteInsetSurface } from "./RouteInsetSurface";
import { RouteSurfaceHeader } from "./RouteSurface";
import { Button } from "./ui/button";
import { SearchIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

export function RouteNotFoundView() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <RouteSurfaceHeader>
          <div className="min-w-0 flex-1" />
        </RouteSurfaceHeader>
        <main
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center"
          data-testid="route-not-found"
        >
          <SearchIcon aria-hidden="true" className="mb-3 size-8 text-muted-foreground" />
          <h1 className="text-ui-lg font-medium text-foreground">{t("common:pageNotFound")}</h1>
          <p className="max-w-xs text-ui leading-snug text-muted-foreground">
            {t("common:pageNotFoundDescription")}
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-4"
            onClick={() => void navigate({ to: "/", replace: true })}
          >
            {t("common:pageNotFoundBackHome")}
          </Button>
        </main>
      </div>
    </RouteInsetSurface>
  );
}
