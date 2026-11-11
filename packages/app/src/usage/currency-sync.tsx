import { useEffect } from "react";
import { useAppSettings } from "@/hooks/use-settings";
import { refreshFxRate, setDisplayPreferences } from "./currency";

/**
 * Keeps the cost formatters in step with the currency and units settings.
 * Mounted once above the screens; renders nothing.
 */
export function CurrencySync() {
  const { settings } = useAppSettings();
  useEffect(() => {
    setDisplayPreferences({
      currency: settings.currency,
      numberUnits: settings.numberUnits,
    });
    if (settings.currency === "cny") {
      void refreshFxRate();
    }
  }, [settings.currency, settings.numberUnits]);
  return null;
}
