// FILE: LibraryRtkPanel.tsx
// Purpose: Settings → RTK. Install/upgrade status and per-agent switches from
//   Neox's Library.
// Layer: Settings UI components

import type { LibraryRtkGain, LibraryRtkStatus } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";
import { LibraryErrorState } from "./LibraryShared";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const RTK_QUERY_KEY = ["neolix", "library", "rtk"] as const;
const RTK_GAIN_QUERY_KEY = ["neolix", "library", "rtk", "gain"] as const;

export function LibraryRtkPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const statusQuery = useQuery({
    queryKey: RTK_QUERY_KEY,
    queryFn: () => neolixLibraryApi.getRtk(),
    staleTime: 10_000,
  });
  const status = statusQuery.data?.rtk;
  const gainQuery = useQuery({
    queryKey: RTK_GAIN_QUERY_KEY,
    queryFn: () => neolixLibraryApi.getRtkGain(),
    enabled: status?.installed === true,
    staleTime: 60_000,
  });

  const applyStatus = useCallback(
    (next: LibraryRtkStatus) => {
      queryClient.setQueryData(RTK_QUERY_KEY, { rtk: next });
      void queryClient.invalidateQueries({ queryKey: RTK_GAIN_QUERY_KEY });
    },
    [queryClient],
  );

  const run = useCallback(
    async (key: string, action: () => Promise<LibraryRtkStatus>) => {
      setBusy(key);
      try {
        applyStatus(await action());
        toastManager.add({ type: "success", title: t("settings:library_saved") });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:library_saveFailed"),
          description: localizeLibraryError(error, t),
        });
      }
      setBusy(null);
    },
    [applyStatus, t],
  );

  if (statusQuery.isLoading) {
    return <p className="text-ui text-muted-foreground">{t("settings:library_loading")}</p>;
  }
  if (statusQuery.isError || !status) {
    return (
      <LibraryErrorState error={statusQuery.error} fallback={t("settings:library_loadFailed")} />
    );
  }

  const installable = !status.installed && (status.distros?.length ?? 0) === 0;
  const openUrl = () => {
    void ensureNativeApi().shell.openExternal(status.url);
  };

  return (
    <div className="space-y-8">
      <SettingsSectionShell
        title="settings:library_rtk_title"
        action={
          status.version ? (
            <span className="text-ui-sm text-muted-foreground">
              {t("settings:library_rtk_version", { version: status.version })}
            </span>
          ) : null
        }
      >
        <SettingsCard>
          {installable ? (
            <div className="flex flex-col items-start gap-2 px-4 py-5">
              <p className="text-ui-lg font-medium text-foreground">
                {t("settings:library_rtk_notInstalled")}
              </p>
              <div className="flex flex-wrap gap-2">
                {status.installCommand ? (
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void run("install", async () => {
                        const result = await neolixLibraryApi.runRtk({ action: "install" });
                        return result.rtk;
                      })
                    }
                  >
                    {t("settings:library_rtk_install")}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={openUrl}>
                  {t("settings:library_rtk_getRtk")}
                </Button>
              </div>
              {status.installCommand ? (
                <code className="text-ui-sm text-muted-foreground">{status.installCommand}</code>
              ) : null}
            </div>
          ) : null}

          {status.upgradeCommand ? (
            <SettingsRow
              title={t("settings:library_rtk_upgrade")}
              description={status.upgradeCommand}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void run("upgrade", async () => {
                      const result = await neolixLibraryApi.runRtk({ action: "upgrade" });
                      return result.rtk;
                    })
                  }
                >
                  {t("settings:library_rtk_upgrade")}
                </Button>
              }
            />
          ) : null}

          {status.distros?.map((distro) => (
            <SettingsRow
              key={distro.distro}
              title={distro.distro}
              description={
                distro.installed
                  ? (distro.version ?? distro.path ?? "")
                  : t("settings:library_rtk_notInstalled")
              }
              control={
                distro.installed ? null : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(`distro:${distro.distro}`, async () => {
                        const result = await neolixLibraryApi.runRtk({
                          action: "install",
                          distro: distro.distro,
                        });
                        return result.rtk;
                      })
                    }
                  >
                    {t("settings:library_rtk_install")}
                  </Button>
                )
              }
            />
          ))}

          {status.agents.map((agent) => (
            <SettingsRow
              key={agent.id}
              title={agent.name}
              description={agent.distro ?? ""}
              control={
                <Switch
                  checked={agent.on}
                  disabled={busy !== null}
                  aria-label={agent.name}
                  onCheckedChange={() =>
                    void run(agent.id, async () => {
                      const result = await neolixLibraryApi.setRtk({
                        agent: agent.id,
                        on: !agent.on,
                      });
                      return result.rtk;
                    })
                  }
                />
              }
            />
          ))}
        </SettingsCard>
      </SettingsSectionShell>

      {status.installed ? (
        <p className="text-ui-sm text-muted-foreground">{t("settings:library_rtk_agentsHint")}</p>
      ) : null}
      {status.pathHint ? (
        <p className="text-ui-sm text-muted-foreground">
          {t("settings:library_rtk_pathHint", { path: status.pathHint })}
        </p>
      ) : null}
      {status.installed && gainQuery.data ? <GainCard gain={gainQuery.data.gain} /> : null}
    </div>
  );
}

function GainCard({ gain }: { gain: LibraryRtkGain }) {
  const { t } = useTranslation();
  const days = gain.days.slice(-14);
  const max = Math.max(1, ...days.map((day) => day.value));
  return (
    <SettingsSection title="settings:library_rtk_gain">
      {gain.total !== null ? (
        <p className="px-4 pt-4 text-ui text-foreground">
          {t("settings:library_rtk_gainTotal", { total: gain.total })}
        </p>
      ) : null}
      {days.length === 0 ? (
        <div className="space-y-3 px-4 py-4">
          <p className="text-ui-sm text-muted-foreground">{t("settings:library_rtk_gainEmpty")}</p>
          {gain.raw ? (
            <details className="text-ui-xs text-muted-foreground">
              <summary className="cursor-pointer select-none">
                {t("settings:library_rtk_rawReport")}
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-[color:var(--color-border)] bg-[var(--color-background-surface)] p-3 whitespace-pre-wrap break-words">
                {gain.raw}
              </pre>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="flex min-h-24 items-end gap-1 px-4 py-4">
          {days.map((day) => (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
              <div
                className="w-full rounded-sm bg-primary/70"
                style={{ height: Math.max(2, (day.value / max) * 64) }}
              />
              <span className="text-ui-xs text-muted-foreground">{day.date.slice(5)}</span>
            </div>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
