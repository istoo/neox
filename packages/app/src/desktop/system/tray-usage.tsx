import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useDesktopSettings, type DesktopSettings } from "@/desktop/settings/desktop-settings";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useSettingsHostServerId } from "@/screens/settings/app/shared";
import {
  useGatewayQuota,
  useGatewayUsage,
  type GatewayUsageFilters,
} from "@/screens/settings/gateway/usage-data";
import { useUsageDisplay } from "@/usage/display";
import { cnyPerUsd, getDisplayPreferences } from "@/usage/currency";
import {
  trayUsageData,
  trayUsageLabel,
  trayUsageTooltip,
  type TrayUsageFormat,
  type TrayUsageWords,
} from "@neolix/protocol/tray-usage-model";

/**
 * Pushes the menu bar's allowance text, tooltip and Windows badge to the
 * desktop process (myna's trayusage_tray.go). The main process polls the
 * daemon too, for a tray-only launch; this reading is the richer one while a
 * window is up, and it carries the language and display preferences.
 */
export function TrayUsageSync() {
  const { settings, isLoading } = useDesktopSettings();
  const settingsServerId = useSettingsHostServerId();
  const localServerId = useLocalDaemonServerId();
  const serverId = settingsServerId ?? localServerId;
  const electron = getIsElectron();

  if (!electron || isLoading || settings.trayUsages.length === 0 || serverId === null) {
    return <ClearTrayUsage electron={electron} />;
  }
  return <ActiveTrayUsage serverId={serverId} settings={settings} />;
}

function ClearTrayUsage({ electron }: { electron: boolean }) {
  useEffect(() => {
    if (!electron) {
      return;
    }
    void invokeDesktopCommand("desktop_set_tray_usage", {
      label: "",
      tooltip: "Neox",
      // An explicit null clears the provider mark the main process drew; an
      // omitted logo would keep it (tray-manager merges the two readings).
      logoDataUrl: null,
    }).catch(() => undefined);
  }, [electron]);
  return null;
}

const EMPTY_FILTERS: GatewayUsageFilters = {};

function ActiveTrayUsage({ serverId, settings }: { serverId: string; settings: DesktopSettings }) {
  const { t, i18n } = useTranslation();
  const refreshMs = settings.trayUsageEvery * 60_000;
  const { quota } = useGatewayQuota({ serverId, trend: "off", refreshMs });
  const today = useGatewayUsage({
    serverId,
    period: "today",
    filters: EMPTY_FILTERS,
    refreshMs,
  });
  const week = useGatewayUsage({ serverId, period: "7d", filters: EMPTY_FILTERS, refreshMs });
  const { display } = useUsageDisplay([]);

  const data = useMemo(
    () =>
      trayUsageData(settings, quota?.accounts ?? [], {
        today: today.report,
        week: week.report,
      }),
    [quota, settings, today.report, week.report],
  );

  const locale = i18n.resolvedLanguage;
  const displayAs = display.displayAs;
  const label = useMemo(
    () => trayUsageLabel(data, settings, trayFormat(locale, displayAs)),
    [data, displayAs, locale, settings],
  );
  const tooltip = useMemo(
    () => trayUsageTooltip(data, settings, trayFormat(locale, displayAs), trayWords(t)),
    [data, displayAs, locale, settings, t],
  );
  useEffect(() => {
    void invokeDesktopCommand("desktop_set_tray_usage", {
      label,
      tooltip,
    }).catch(() => undefined);
  }, [label, tooltip]);

  // The main process polls on its own for a tray-only launch; mirror how the
  // reader reads figures and money so both readings agree.
  const currency = getDisplayPreferences().currency;
  const numberUnits = getDisplayPreferences().numberUnits;
  const rate = cnyPerUsd();
  useEffect(() => {
    void invokeDesktopCommand("desktop_set_tray_display", {
      displayAs,
      currency,
      numberUnits,
      cnyPerUsd: rate,
    }).catch(() => undefined);
  }, [currency, displayAs, numberUnits, rate]);

  return null;
}

function trayFormat(locale: string | undefined, displayAs: "used" | "remaining"): TrayUsageFormat {
  const preferences = getDisplayPreferences();
  return {
    locale,
    displayAs,
    currency: preferences.currency,
    numberUnits: preferences.numberUnits,
    cnyPerUsd: cnyPerUsd(),
  };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function trayWords(t: Translate): TrayUsageWords {
  return {
    todayIn: t("trayUsage.todayIn"),
    last7DaysIn: t("trayUsage.last7DaysIn"),
    tokens: (value) => t("trayUsage.tokens", { value }),
    requests: (value) => t("trayUsage.requests", { value }),
    used: t("trayUsage.used"),
    left: t("trayUsage.left"),
    resetsIn: (when) => t("trayUsage.resetsIn", { when }),
  };
}
