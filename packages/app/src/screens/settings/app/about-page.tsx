import { useCallback, useMemo, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { THIRD_PARTY_NOTICES } from "@neolix/protocol/generated/third-party-notices";
import { CommunityLinks } from "@/components/community-links";
import { isElectronRuntime } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { useDesktopAppUpdater } from "@/desktop/updates/use-desktop-app-updater";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { useHostRuntimeIsConnected, useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useSettings } from "@/hooks/use-settings";
import {
  EditingTextInput as TextInput,
  type EditingTextInputHandle,
} from "@/components/ui/text-input";
import { UPDATE_CHECK_MINUTES, useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { openChangelog } from "@/changelog";
import { CommandLineRow, useCommandLineSetting } from "@/desktop/components/integrations-section";
import { openExternalUrl } from "@/utils/open-external-url";
import { confirmDialog } from "@/utils/confirm-dialog";
import { resolveAppVersion } from "@/utils/app-version";
import { settingsStyles } from "@/styles/settings";
import type { HostProfile } from "@/types/host-connection";
import * as Clipboard from "expo-clipboard";
import { parseGatewayListen } from "@/screens/settings/gateway/overview-data";
import { useDaemonStatus, useSettingsHostServerId } from "./shared";

function normalizeVersion(version: string | null | undefined): string | null {
  const trimmed = version?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^v/i, "");
}

function getUpdateButtonLabel(
  t: TFunction,
  isInstalling: boolean,
  latestVersion: string | null | undefined,
): string {
  if (isInstalling) return t("settings.about.updates.installing");
  if (latestVersion) {
    return t("settings.about.updates.updateTo", {
      version: formatVersionWithPrefix(latestVersion),
    });
  }
  return t("settings.about.updates.update");
}

function HostVersionRow({
  host,
  showBorder,
  clientVersion,
}: {
  host: HostProfile;
  showBorder: boolean;
  clientVersion: string | null;
}) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const normalizedHost = normalizeVersion(daemonVersion);
  const normalizedClient = normalizeVersion(clientVersion);
  const isMismatch =
    normalizedHost !== null && normalizedClient !== null && normalizedHost !== normalizedClient;

  let valueText: string;
  if (!isConnected) {
    valueText = t("settings.about.offline");
  } else if (normalizedHost) {
    valueText = formatVersionWithPrefix(normalizedHost);
  } else {
    valueText = "—";
  }

  const valueStyle = useMemo(
    () => [styles.aboutValue, isMismatch && styles.aboutVersionMismatch],
    [isMismatch],
  );
  const rowStyle = useMemo(
    () => [settingsStyles.row, showBorder && settingsStyles.rowBorder],
    [showBorder],
  );

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        {isMismatch ? (
          <Text style={settingsStyles.rowHint}>{t("settings.about.versionDiffers")}</Text>
        ) : null}
      </View>
      <Text style={valueStyle}>{valueText}</Text>
    </View>
  );
}

function ConnectedHostsSection({ clientVersion }: { clientVersion: string | null }) {
  const { t } = useTranslation();
  const hosts = useHosts();
  if (hosts.length === 0) {
    return null;
  }
  return (
    <SettingsSection title={t("settings.about.connectedHosts")}>
      <SettingsCard>
        {hosts.map((host, index) => (
          <HostVersionRow
            key={host.serverId}
            host={host}
            showBorder={index > 0}
            clientVersion={clientVersion}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function DesktopUpdateRows() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useSettings();
  const {
    statusText,
    availableUpdate,
    errorMessage,
    noticeMessage,
    isChecking,
    isInstalling,
    checkForUpdates,
    installUpdate,
  } = useDesktopAppUpdater();

  const releaseChannelOptions = useMemo(
    () => [
      { value: "stable" as const, label: t("settings.about.releaseChannel.stable") },
      { value: "beta" as const, label: t("settings.about.releaseChannel.beta") },
    ],
    [t],
  );
  const handleReleaseChannelChange = useCallback(
    (releaseChannel: "stable" | "beta") => {
      void updateSettings({ releaseChannel });
    },
    [updateSettings],
  );
  const handleCheckForUpdates = useCallback(() => void checkForUpdates(), [checkForUpdates]);
  const handleInstallUpdate = useCallback(() => {
    void confirmDialog({
      title: t("settings.about.updates.installTitle"),
      message: t("settings.about.updates.installMessage"),
      confirmLabel: t("settings.about.updates.installConfirm"),
      cancelLabel: t("common.actions.cancel"),
    })
      .then((confirmed) => {
        if (!confirmed) {
          return;
        }
        void installUpdate();
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to open app update confirmation", error);
        Alert.alert(
          t("settings.about.updates.alertTitle"),
          t("settings.about.updates.alertMessage"),
        );
      });
  }, [installUpdate, t]);

  const isUpdateReady = availableUpdate?.readyToInstall === true;
  const readyUpdateVersion = isUpdateReady ? availableUpdate?.latestVersion : null;
  const { settings: desktopSettings, updateSettings: updateDesktopSettings } = useDesktopSettings();
  const intervalOptions = useMemo(
    () =>
      UPDATE_CHECK_MINUTES.map((minutes) => ({
        value: String(minutes),
        label:
          minutes < 60
            ? t("settings.pages.about.updateEveryMinutes", { count: minutes })
            : t("settings.pages.about.updateEveryHours", { count: minutes / 60 }),
      })),
    [t],
  );
  const toggleAutoCheck = useCallback(
    (autoCheckUpdates: boolean) => void updateDesktopSettings({ autoCheckUpdates }),
    [updateDesktopSettings],
  );
  const changeInterval = useCallback(
    (value: string) => void updateDesktopSettings({ updateCheckMinutes: Number(value) }),
    [updateDesktopSettings],
  );
  const toggleAutoDownload = useCallback(
    (autoDownloadUpdates: boolean) => void updateDesktopSettings({ autoDownloadUpdates }),
    [updateDesktopSettings],
  );
  const toggleAutoRestart = useCallback(
    (autoRestartOnUpdate: boolean) => void updateDesktopSettings({ autoRestartOnUpdate }),
    [updateDesktopSettings],
  );
  const toggleUpdateButton = useCallback(
    (enabled: boolean) => void updateDesktopSettings({ noUpdatePill: !enabled }),
    [updateDesktopSettings],
  );
  const [mirrorDraft, setMirrorDraft] = useState(desktopSettings.updateMirror);
  const [mirrorError, setMirrorError] = useState<string | null>(null);
  const mirrorInput = useRef<EditingTextInputHandle>(null);
  const commitMirror = useCallback(() => {
    const value = (mirrorInput.current?.getText() ?? mirrorDraft).trim().replace(/\/+$/, "");
    if (value !== "" && !isHttpUrl(value)) {
      setMirrorError(t("settings.pages.about.updateMirrorInvalid"));
      return;
    }
    setMirrorError(null);
    if (value !== desktopSettings.updateMirror) {
      void updateDesktopSettings({ updateMirror: value });
    }
  }, [desktopSettings.updateMirror, mirrorDraft, t, updateDesktopSettings]);

  return (
    <>
      <SettingsRow
        label={t("settings.about.releaseChannel.label")}
        hint={t("settings.about.releaseChannel.description")}
      >
        <SegmentedControl
          value={settings.releaseChannel}
          onValueChange={handleReleaseChannelChange}
          options={releaseChannelOptions}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.about.updates.label")}
        hint={
          noticeMessage ??
          (readyUpdateVersion
            ? `${statusText} · ${t("settings.about.updates.readyToInstall", {
                version: formatVersionWithPrefix(readyUpdateVersion),
              })}`
            : statusText)
        }
        error={errorMessage ?? undefined}
      >
        <View style={styles.updateActions}>
          <Button
            variant="outline"
            onPress={handleCheckForUpdates}
            disabled={isChecking || isInstalling}
          >
            {isChecking ? t("settings.about.updates.checking") : t("settings.about.updates.check")}
          </Button>
          <Button
            variant="default"
            onPress={handleInstallUpdate}
            disabled={isChecking || isInstalling || !isUpdateReady}
          >
            {getUpdateButtonLabel(t, isInstalling, readyUpdateVersion)}
          </Button>
        </View>
      </SettingsRow>
      <SettingsSwitch
        label={t("updateButton.label")}
        hint={t("updateButton.hint")}
        value={!desktopSettings.noUpdatePill}
        onValueChange={toggleUpdateButton}
      />
      <SettingsSwitch
        label={t("settings.pages.about.updateAutoCheck")}
        hint={t("settings.pages.about.updateAutoCheckHint")}
        value={desktopSettings.autoCheckUpdates}
        onValueChange={toggleAutoCheck}
      />
      {desktopSettings.autoCheckUpdates ? (
        <SettingsRow label={t("settings.pages.about.updateEvery")}>
          <SegmentedControl
            options={intervalOptions}
            value={String(desktopSettings.updateCheckMinutes)}
            onValueChange={changeInterval}
          />
        </SettingsRow>
      ) : null}
      <SettingsSwitch
        label={t("settings.pages.about.autoDownload")}
        hint={t("settings.pages.about.autoDownloadHint")}
        value={desktopSettings.autoDownloadUpdates}
        onValueChange={toggleAutoDownload}
      />
      <SettingsSwitch
        label={t("settings.pages.about.updateAutoRestart")}
        hint={t("settings.pages.about.updateAutoRestartHint")}
        value={desktopSettings.autoRestartOnUpdate}
        onValueChange={toggleAutoRestart}
      />
      <SettingsRow
        label={t("settings.pages.about.updateMirror")}
        hint={t("settings.pages.about.updateMirrorHint")}
        error={mirrorError ?? undefined}
      >
        <TextInput
          ref={mirrorInput}
          initialValue={mirrorDraft}
          onChangeText={setMirrorDraft}
          onBlur={commitMirror}
          onSubmitEditing={commitMirror}
          placeholder="https://mirror.example/"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          style={styles.mirrorInput}
          accessibilityLabel={t("settings.pages.about.updateMirror")}
        />
      </SettingsRow>
    </>
  );
}

/**
 * myna's Settings › About › Open-source licenses (gui/api.go:126): the
 * notices every build carries. Generated from package-lock.json by
 * scripts/generate-third-party-notices.mjs; `neolix licenses` prints the same.
 */
function LicensesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.about.thirdPartyLicenses") }),
    [t],
  );
  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      scrollable
      desktopMaxWidth={640}
      testID="third-party-licenses"
    >
      <Text selectable style={styles.licensesText}>
        {THIRD_PARTY_NOTICES}
      </Text>
    </AdaptiveModalSheet>
  );
}

/**
 * myna's Settings › Uninstall (gui/uninstall.go:35): the app's half of
 * runUninstall — agents are put back, opening at login is turned off, and
 * the folder is deleted once the app has quit.
 */
function UninstallRow() {
  const { t } = useTranslation();
  const [isPending, setIsPending] = useState(false);

  const handleUninstall = useCallback(() => {
    const run = async () => {
      let confirmed = false;
      try {
        confirmed = await confirmDialog({
          title: t("settings.about.uninstallConfirmTitle"),
          message: t("settings.about.uninstallConfirmMessage"),
          confirmLabel: t("settings.about.uninstall"),
          cancelLabel: t("common.actions.cancel"),
        });
      } catch (error) {
        console.error("[Settings] Failed to open the uninstall confirmation", error);
        return;
      }
      if (!confirmed) {
        return;
      }
      setIsPending(true);
      try {
        await invokeDesktopCommand("desktop_uninstall");
      } catch (error) {
        setIsPending(false);
        Alert.alert(
          t("settings.about.uninstall"),
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    void run();
  }, [t]);

  return (
    <SettingsRow label={t("settings.about.uninstall")} hint={t("settings.about.uninstallHint")}>
      <Button variant="outline" onPress={handleUninstall} disabled={isPending}>
        {t("settings.about.uninstall")}
      </Button>
    </SettingsRow>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * myna's About rows for the gateway's address: where every agent is pointed,
 * the statusLine command for Claude Code on another computer, and the public
 * address a tunnel gives it.
 */
function GatewayAboutRows() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const status = useDaemonStatus(serverId);
  const parsed = parseGatewayListen(status?.listen ?? null);
  const gatewayUrl = parsed.thisComputerUrl ?? parsed.networkUrl ?? parsed.listen ?? "";
  const publicUrl = status?.publicUrl ?? "";
  const remoteUrl = publicUrl.length > 0 ? publicUrl : gatewayUrl;
  const statusline =
    remoteUrl.length === 0
      ? ""
      : `curl -fsS -m 1 -H 'Authorization: Bearer <gateway key>' --data-binary @- ${remoteUrl}/v1/myna/statusline || true`;
  const copyGateway = useCallback(() => void Clipboard.setStringAsync(gatewayUrl), [gatewayUrl]);
  const copyStatusline = useCallback(() => void Clipboard.setStringAsync(statusline), [statusline]);
  const copyPublic = useCallback(() => void Clipboard.setStringAsync(publicUrl), [publicUrl]);
  if (status === null) {
    return null;
  }
  return (
    <>
      {gatewayUrl.length > 0 ? (
        <SettingsRow
          label={t("settings.about.gatewayUrl")}
          hint={t("settings.about.gatewayUrlHint")}
          testID="settings-about-gateway-url"
        >
          <Text style={styles.aboutValue} numberOfLines={1}>
            {gatewayUrl}
          </Text>
          <Button variant="outline" size="sm" onPress={copyGateway}>
            {t("common.actions.copy")}
          </Button>
        </SettingsRow>
      ) : null}
      {statusline.length > 0 && publicUrl.length > 0 ? (
        <SettingsRow
          label={t("settings.about.statuslineRemote")}
          hint={t("settings.about.statuslineRemoteHint")}
          testID="settings-about-statusline"
        >
          <Text style={styles.aboutCommand} numberOfLines={3}>
            {statusline}
          </Text>
          <Button variant="outline" size="sm" onPress={copyStatusline}>
            {t("common.actions.copy")}
          </Button>
        </SettingsRow>
      ) : null}
      {publicUrl.length > 0 && publicUrl !== gatewayUrl ? (
        <SettingsRow
          label={t("settings.about.publicAddress")}
          hint={t("settings.about.publicAddressHint")}
          testID="settings-about-public-address"
        >
          <Text style={styles.aboutValue} numberOfLines={1}>
            {publicUrl}
          </Text>
          <Button variant="outline" size="sm" onPress={copyPublic}>
            {t("common.actions.copy")}
          </Button>
        </SettingsRow>
      ) : null}
    </>
  );
}

/**
 * myna's About rows for this computer's files (app.js:19903-19908): the folder
 * the host keeps its setup in, and its log, each with the path, a copy, and
 * Open. The host omits the log when it writes none.
 */
function ConfigPathsRows() {
  const { t } = useTranslation();
  const toast = useToast();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId, "daemonPaths");
  const status = useDaemonStatus(serverId);
  const configDir = status?.configDir ?? "";
  const logPath = status?.logPath ?? "";
  const open = useCallback(
    (target: "config" | "log") => {
      if (client === null || !supported) {
        return;
      }
      void client
        .revealDaemonPath(target)
        .then((result) => {
          if (!result.ok) {
            toast.show(result.error ?? t("settings.about.pathOpenFailed"));
          }
          return undefined;
        })
        .catch(() => toast.show(t("settings.about.pathOpenFailed")));
    },
    [client, supported, t, toast],
  );
  const openConfig = useCallback(() => open("config"), [open]);
  const openLog = useCallback(() => open("log"), [open]);
  const copyConfig = useCallback(() => void Clipboard.setStringAsync(configDir), [configDir]);
  const copyLog = useCallback(() => void Clipboard.setStringAsync(logPath), [logPath]);
  if (status === null || configDir.length === 0) {
    return null;
  }
  return (
    <>
      <SettingsRow
        label={t("settings.about.configFolder")}
        hint={t("settings.about.configFolderHint")}
        testID="settings-about-config-folder"
      >
        <Text style={styles.aboutValue} numberOfLines={1}>
          {configDir}
        </Text>
        <Button variant="outline" size="sm" onPress={copyConfig}>
          {t("common.actions.copy")}
        </Button>
        <Button variant="outline" onPress={openConfig}>
          {t("settings.pages.actions.open")}
        </Button>
      </SettingsRow>
      {logPath.length > 0 ? (
        <SettingsRow
          label={t("settings.about.log")}
          hint={t("settings.about.logHint")}
          testID="settings-about-log"
        >
          <Text style={styles.aboutValue} numberOfLines={1}>
            {logPath}
          </Text>
          <Button variant="outline" size="sm" onPress={copyLog}>
            {t("common.actions.copy")}
          </Button>
          <Button variant="outline" onPress={openLog}>
            {t("settings.pages.actions.open")}
          </Button>
        </SettingsRow>
      ) : null}
    </>
  );
}

/**
 * myna's About › Command line (app.js:19910): the same `neolix` CLI switch as
 * Settings › Integrations, with one shared hook behind both.
 */
function AboutCommandLineRow() {
  const { available, row } = useCommandLineSetting();
  if (!available) {
    return null;
  }
  return <CommandLineRow {...row} />;
}

/**
 * Settings › About: the version, the changelog, desktop updates and release
 * channel, the connected hosts' versions, and Neolix's community links. Myna's
 * update-mirror and update-check-interval rows have no Neolix equivalent and
 * are recorded in the mapping table.
 */
export function AboutPage() {
  const { t } = useTranslation();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const isDesktopApp = isElectronRuntime();
  const [licensesOpen, setLicensesOpen] = useState(false);
  const openLicenses = useCallback(() => setLicensesOpen(true), []);
  const closeLicenses = useCallback(() => setLicensesOpen(false), []);
  const openWebsite = useCallback(() => void openExternalUrl("https://github.com/istoo/neox"), []);
  return (
    <>
      <SettingsSection title={t("settings.about.title")}>
        <SettingsCard>
          <SettingsRow label={t("settings.about.appVersion")} hint={t("settings.about.thisDevice")}>
            <Text style={styles.aboutValue}>{appVersionText}</Text>
          </SettingsRow>
          <SettingsRow label={t("changelog.title")} hint={t("settings.about.whatsNewHint")}>
            <Button variant="outline" onPress={openChangelog}>
              {t("settings.pages.actions.open")}
            </Button>
          </SettingsRow>
          <SettingsRow
            label={t("settings.about.thirdPartyLicenses")}
            hint={t("settings.about.thirdPartyLicensesHint")}
          >
            <Button variant="outline" onPress={openLicenses}>
              {t("settings.pages.actions.open")}
            </Button>
          </SettingsRow>
          <ConfigPathsRows />
          {isDesktopApp ? <AboutCommandLineRow /> : null}
          <GatewayAboutRows />
          <SettingsRow
            label={t("settings.about.website")}
            hint={t("settings.about.websiteHint")}
            testID="settings-about-website"
          >
            <Text style={styles.aboutValue}>github.com/istoo/neox</Text>
            <Button variant="outline" onPress={openWebsite}>
              {t("settings.pages.actions.open")}
            </Button>
          </SettingsRow>
          {isDesktopApp ? (
            <>
              <DesktopUpdateRows />
              <UninstallRow />
            </>
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <ConnectedHostsSection clientVersion={appVersion} />
      <View style={styles.community}>
        <CommunityLinks />
      </View>
      <LicensesSheet visible={licensesOpen} onClose={closeLicenses} />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  aboutValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  aboutCommand: {
    flexShrink: 1,
    maxWidth: 420,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  aboutVersionMismatch: {
    color: theme.colors.palette.amber[500],
  },
  updateActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  mirrorInput: {
    minWidth: 240,
  },
  community: {
    marginTop: theme.spacing[4],
  },
  licensesText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
}));
