import { useCallback, useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LibraryRtkGain, LibraryRtkStatus } from "@neolix/protocol/library";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { AgentIcon, LibraryIntro, LibraryRowHeader } from "./library-ui";
import type { LibraryTabProps } from "./types";

export function RtkTab({ client, onError, disabled }: LibraryTabProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<LibraryRtkStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [gain, setGain] = useState<LibraryRtkGain | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await client.getLibraryRtk();
        if (!cancelled) {
          setStatus(result.rtk);
        }
        if (result.rtk.installed) {
          const gained = await client.getLibraryRtkGain();
          if (!cancelled) {
            setGain(gained.gain);
          }
        }
      } catch (error) {
        if (!cancelled) {
          onError(error);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, onError]);

  const toggle = useCallback(
    (agent: string) => {
      if (!status) {
        return;
      }
      const current = status.agents.find((entry) => entry.id === agent);
      setBusy(agent);
      void (async () => {
        try {
          const result = await client.setLibraryRtk(agent, !current?.on);
          setStatus(result.rtk);
        } catch (error) {
          onError(error);
        } finally {
          setBusy(null);
        }
      })();
    },
    [client, onError, status],
  );

  const runInstaller = useCallback(
    (action: "install" | "upgrade") => {
      if (!status) {
        return;
      }
      const command = action === "install" ? status.installCommand : status.upgradeCommand;
      void (async () => {
        const confirmed = await confirmDialog({
          title:
            action === "install"
              ? t("settings.usePages.library.rtk.install")
              : t("settings.usePages.library.rtk.upgrade"),
          message: t("settings.usePages.library.rtk.runConfirm", { command: command ?? "rtk" }),
          confirmLabel: t("settings.usePages.library.common.save"),
          cancelLabel: t("settings.usePages.library.common.cancel"),
        });
        if (!confirmed) {
          return;
        }
        setBusy("installer");
        try {
          const result = await client.runLibraryRtk(action);
          setStatus(result.rtk);
          if (result.rtk.installed) {
            const gained = await client.getLibraryRtkGain();
            setGain(gained.gain);
          }
        } catch (error) {
          onError(error);
        } finally {
          setBusy(null);
        }
      })();
    },
    [client, onError, status, t],
  );
  const install = useCallback(() => runInstaller("install"), [runInstaller]);
  const upgrade = useCallback(() => runInstaller("upgrade"), [runInstaller]);

  const installIn = useCallback(
    (distro: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("settings.usePages.library.rtk.install"),
          message: t("settings.usePages.library.rtk.runConfirm", {
            command: `wsl.exe -d ${distro}`,
          }),
          confirmLabel: t("settings.usePages.library.common.save"),
          cancelLabel: t("settings.usePages.library.common.cancel"),
        });
        if (!confirmed) {
          return;
        }
        setBusy(`distro:${distro}`);
        try {
          const result = await client.runLibraryRtk("install", { distro });
          setStatus(result.rtk);
        } catch (error) {
          onError(error);
        } finally {
          setBusy(null);
        }
      })();
    },
    [client, onError, t],
  );

  const getRtk = useCallback(() => {
    if (status) {
      void Linking.openURL(status.url);
    }
  }, [status]);

  return (
    <View>
      <LibraryIntro>{t("settings.usePages.library.rtk.intro")}</LibraryIntro>
      <LibraryRowHeader
        label="RTK"
        note={
          status?.version
            ? t("settings.usePages.library.rtk.version", { version: status.version })
            : undefined
        }
      />
      <SettingsCard>
        <RtkCard
          status={status}
          busy={busy}
          disabled={disabled}
          onToggle={toggle}
          onGetRtk={getRtk}
          onInstall={install}
          onUpgrade={upgrade}
          onInstallIn={installIn}
        />
      </SettingsCard>
      {status?.installed ? (
        <View style={styles.noteRow}>
          <Text style={styles.note}>{t("settings.usePages.library.rtk.agentsHint")}</Text>
          <Text style={styles.note}>{t("settings.usePages.library.rtk.restart")}</Text>
        </View>
      ) : null}
      {status?.pathHint ? (
        <Text style={styles.note}>
          {t("settings.usePages.library.rtk.pathHint", { path: status.pathHint })}
        </Text>
      ) : null}
      {status?.installed && gain ? <GainCard gain={gain} /> : null}
    </View>
  );
}

function RtkAgentRow({
  agent,
  busy,
  disabled,
  onToggle,
}: {
  agent: LibraryRtkStatus["agents"][number];
  busy: boolean;
  disabled: boolean;
  onToggle: (agent: string) => void;
}) {
  const toggle = useCallback(() => onToggle(agent.id), [agent.id, onToggle]);
  const accessibilityLabel = agent.name;
  return (
    <View style={settingsStyles.row}>
      <View style={[settingsStyles.rowContent, styles.agentRow]}>
        <AgentIcon agent={agent.id} size={20} />
        <Text style={settingsStyles.rowTitle}>{agent.name}</Text>
        {busy ? <LoadingSpinner color={styles.spinnerColor.color} /> : null}
      </View>
      <Switch
        value={agent.on}
        onValueChange={toggle}
        disabled={disabled}
        accessibilityLabel={accessibilityLabel}
      />
    </View>
  );
}

function RtkDistroRow({
  distro,
  busy,
  disabled,
  onInstallIn,
}: {
  distro: NonNullable<LibraryRtkStatus["distros"]>[number];
  busy: string | null;
  disabled: boolean;
  onInstallIn: (distro: string) => void;
}) {
  const { t } = useTranslation();
  const install = useCallback(() => onInstallIn(distro.distro), [distro.distro, onInstallIn]);
  return (
    <View style={settingsStyles.row}>
      <View style={styles.agentRow}>
        <Text style={settingsStyles.rowTitle}>{distro.distro}</Text>
        <Text style={settingsStyles.rowHint}>
          {distro.installed
            ? (distro.version ?? distro.path ?? "")
            : t("settings.usePages.library.rtk.notInstalled")}
        </Text>
      </View>
      {distro.installed ? null : (
        <Button variant="outline" onPress={install} disabled={disabled || busy !== null}>
          {t("settings.usePages.library.rtk.install")}
        </Button>
      )}
    </View>
  );
}

function RtkCard({
  status,
  busy,
  disabled,
  onToggle,
  onGetRtk,
  onInstall,
  onUpgrade,
  onInstallIn,
}: {
  status: LibraryRtkStatus | null;
  busy: string | null;
  disabled: boolean;
  onToggle: (agent: string) => void;
  onGetRtk: () => void;
  onInstall: () => void;
  onUpgrade: () => void;
  onInstallIn: (distro: string) => void;
}) {
  const { t } = useTranslation();
  if (!status) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner color={styles.spinnerColor.color} />
      </View>
    );
  }
  if (!status.installed && (status.distros?.length ?? 0) === 0) {
    return (
      <View style={styles.missing}>
        <Text style={settingsStyles.rowTitle}>
          {t("settings.usePages.library.rtk.notInstalled")}
        </Text>
        <View style={styles.installRow}>
          {status.installCommand ? (
            <Button variant="default" onPress={onInstall}>
              {t("settings.usePages.library.rtk.install")}
            </Button>
          ) : null}
          <Button variant="outline" onPress={onGetRtk}>
            {t("settings.usePages.library.rtk.getRtk")}
          </Button>
        </View>
        {status.installCommand ? (
          <Text style={settingsStyles.rowHint}>{status.installCommand}</Text>
        ) : null}
      </View>
    );
  }
  return (
    <>
      {status.upgradeCommand ? (
        <View style={settingsStyles.row}>
          <View style={styles.installRow}>
            <Button variant="outline" onPress={onUpgrade}>
              {t("settings.usePages.library.rtk.upgrade")}
            </Button>
          </View>
        </View>
      ) : null}
      {status.distros?.map((distro) => (
        <RtkDistroRow
          key={distro.distro}
          distro={distro}
          busy={busy}
          disabled={disabled}
          onInstallIn={onInstallIn}
        />
      ))}
      {status.agents.map((agent) => (
        <RtkAgentRow
          key={agent.id}
          agent={agent}
          busy={busy === agent.id}
          disabled={disabled || busy !== null}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    padding: theme.spacing[6],
    alignItems: "center",
  },
  missing: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    alignItems: "flex-start",
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  noteRow: {
    marginTop: theme.spacing[3],
    marginLeft: theme.spacing[1],
    gap: theme.spacing[1],
    alignItems: "flex-start",
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  installRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  gain: {
    marginTop: theme.spacing[4],
    gap: theme.spacing[2],
  },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
    minHeight: 90,
  },
  barColumn: {
    flex: 1,
    alignItems: "center",
    gap: theme.spacing[1],
  },
  bar: {
    width: "100%",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
  },
  barLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

function GainCard({ gain }: { gain: LibraryRtkGain }) {
  const { t } = useTranslation();
  const days = gain.days.slice(-14);
  const max = Math.max(1, ...days.map((day) => day.value));
  return (
    <View style={styles.gain}>
      <LibraryRowHeader label={t("settings.usePages.library.rtk.gain")} />
      {gain.total !== null ? (
        <Text style={settingsStyles.rowTitle}>
          {t("settings.usePages.library.rtk.gainTotal", { total: gain.total })}
        </Text>
      ) : null}
      {days.length === 0 ? (
        <Text style={styles.note}>{gain.raw || t("settings.usePages.library.rtk.gainEmpty")}</Text>
      ) : (
        <View style={styles.chart}>
          {days.map((day) => (
            <View key={day.date} style={styles.barColumn}>
              <View style={[styles.bar, { height: Math.max(2, (day.value / max) * 64) }]} />
              <Text style={styles.barLabel}>{day.date.slice(5)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
