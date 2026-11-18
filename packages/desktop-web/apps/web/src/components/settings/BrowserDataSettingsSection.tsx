// FILE: BrowserDataSettingsSection.tsx
// Purpose: Old desktop UI's browser-data section for the forked web UI: clear
//          the shared browser profile's cookies, cache and auth state, and expose
//          the saved-logins entry when a vault backend is present.
// Layer: Settings UI component

import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";

import { SettingsCard, SettingsListRow, SettingsSectionShell } from "./SettingsPanelPrimitives";

export function BrowserDataSettingsSection() {
  const { t } = useTranslation();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [clearing, setClearing] = useState(false);

  if (!bridge?.browser?.clearProfile) return null;
  const clearProfile = bridge.browser.clearProfile;

  const clear = async () => {
    if (clearing) return;
    const confirmed = await bridge.confirm(t("settings:confirmClearBrowserData"));
    if (!confirmed) return;
    setClearing(true);
    try {
      // The forked renderer keeps every browser in the one shared profile, so []
      // is all it has to name. The main process also enumerates leftover
      // `persist:neolix-browser-<id>` partitions from the retired native app and
      // clears those in the same pass.
      await clearProfile([]);
      toastManager.add({ type: "success", title: t("settings:browserDataCleared") });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:browserDataClearFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
    setClearing(false);
  };

  const hasVault = Boolean(bridge.browser.vault);
  return (
    <SettingsSectionShell title="settings:browserData">
      <SettingsCard>
        <SettingsListRow
          title={t("settings:browserData")}
          description={t("settings:browserDataDescription")}
          actions={
            <Button size="xs" variant="outline" disabled={clearing} onClick={() => void clear()}>
              {clearing ? t("settings:clearingBrowserData") : t("settings:clearBrowserData")}
            </Button>
          }
        />
        {hasVault ? (
          <SettingsListRow
            title={t("computer:savedLogins")}
            description={t("settings:browserDataSavedLoginsDescription")}
            actions={
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  window.dispatchEvent(new Event("synara:open-browser-vault"));
                }}
              >
                {t("common:open", { title: t("computer:savedLogins") })}
              </Button>
            }
          />
        ) : null}
      </SettingsCard>
    </SettingsSectionShell>
  );
}
