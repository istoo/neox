import { useEffect } from "react";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useAppSettings } from "@/hooks/use-settings";

/**
 * The tray menu lives in the desktop process, which has no i18n runtime.
 * The renderer pushes the Settings language ("system" or a code) and the main
 * process resolves it, as myna's trayLang(pref, system) does
 * (magpie/internal/gui/traymenu.go).
 */
export function TrayLabelsSync() {
  const { settings, isLoading } = useAppSettings();
  const language = settings.language;

  useEffect(() => {
    if (!getIsElectron() || isLoading) {
      return;
    }
    const push = async () => {
      try {
        await invokeDesktopCommand("desktop_set_tray_language", { language });
      } catch {
        // An older desktop build keeps the system's language.
      }
    };
    void push();
  }, [isLoading, language]);

  return null;
}
