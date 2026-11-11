/* eslint-disable react-perf/jsx-no-new-function-as-prop -- one settings page, not a hot list. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  BackupAutoConfigView as BackupAutoConfig,
  BackupEntryView as BackupEntry,
  SyncConfigView,
  SyncRemoteVersion,
  SyncStatusView,
} from "@neolix/protocol/messages";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { EditingTextInput as TextInput } from "@/components/ui/text-input";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSettingsHostServerId } from "./shared";
import { useBackupDownload } from "@/hooks/use-backup-download";
import { useFilePicker } from "@/hooks/use-file-picker";

/**
 * Settings › Sync and backup, after myna's page: a shared remote that keeps
 * the setup the same on every computer (WebDAV, S3 or GitHub), the parts
 * that travel, a restore and its undo, and sealed manual/automatic backups.
 * The daemon owns the files; this page only edits the setup and asks.
 */
export function SyncPage() {
  const { t } = useTranslation();
  const serverId = useSettingsHostServerId();
  const client = useHostRuntimeClient(serverId ?? "");
  const supported = useHostFeature(serverId, "sync");
  const downloadBackup = useBackupDownload(serverId);
  const { pickFiles } = useFilePicker();

  const [config, setConfig] = useState<SyncConfigView | null>(null);
  const [status, setStatus] = useState<SyncStatusView | null>(null);
  const [versions, setVersions] = useState<SyncRemoteVersion[] | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [auto, setAuto] = useState<BackupAutoConfig | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    if (!client || !supported) {
      return;
    }
    try {
      const [nextConfig, nextStatus, nextBackups, nextAuto] = await Promise.all([
        client.getSyncConfig(),
        client.getSyncStatus(),
        client.listBackups(),
        client.getBackupAuto(),
      ]);
      setConfig(nextConfig.config);
      setStatus(nextStatus.status);
      setBackups(nextBackups.backups);
      setAuto(nextAuto.config);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [client, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  const call = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy("");
    }
  }, []);

  if (!supported) {
    return (
      <SettingsSection title={t("settings.pages.sync.title")}>
        <SettingsCard>
          <SettingsRow
            label={t("settings.pages.sync.unavailable")}
            hint={t("settings.pages.sync.unavailableHint")}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <>
      <StatusSection
        status={status}
        busy={busy}
        onSync={() =>
          void call("sync", async () => {
            const result = await client!.runSync();
            setStatus(result.status);
            if (result.error) {
              setError(result.error);
            }
          })
        }
        onRestore={() =>
          void call("restore", async () => {
            const result = await client!.restoreSync();
            if (result.error || !result.status) {
              setError(result.error ?? "");
              return;
            }
            setStatus(result.status);
            await load();
          })
        }
        onUndo={() =>
          void call("undo", async () => {
            const result = await client!.undoSync();
            if (result.error || !result.status) {
              setError(result.error ?? "");
              return;
            }
            setStatus(result.status);
            await load();
          })
        }
        onDismiss={() =>
          void call("dismiss", async () => {
            await client!.dismissSyncNotice();
            await load();
          })
        }
        onListRemote={() =>
          void call("remote", async () => {
            const result = await client!.listSyncRemote();
            setVersions(result.versions);
            if (result.error) {
              setError(result.error);
            }
          })
        }
        onUpload={() =>
          void call("upload", async () => {
            const result = await client!.uploadSync();
            if (result.error || !result.status) {
              setError(result.error ?? "");
              return;
            }
            setStatus(result.status);
            await load();
          })
        }
        onFollow={() =>
          void call("follow", async () => {
            const result = await client!.followSync();
            if (result.error || !result.status) {
              setError(result.error ?? "");
              return;
            }
            setStatus(result.status);
            await load();
          })
        }
        versions={versions}
      />

      {config ? (
        <SetupSection
          config={config}
          busy={busy}
          onSave={(next) =>
            void call("save", async () => {
              const result = await client!.setSyncConfig(next);
              if (result.error || !result.config) {
                setError(result.error ?? "");
                return;
              }
              setConfig(result.config);
              setStatus(await client!.getSyncStatus().then((value) => value.status));
              setNotice(t("settings.pages.sync.saved"));
            })
          }
        />
      ) : null}

      <BackupSection
        backups={backups}
        auto={auto}
        busy={busy}
        onDownload={(name) => downloadBackup(name)}
        onExport={(passphrase, signIns) =>
          void call("export", async () => {
            const result = await client!.exportBackup({
              passphrase: passphrase.length > 0 ? passphrase : undefined,
              signIns,
            });
            if (result.error || !result.backup) {
              setError(result.error ?? "");
              return;
            }
            setNotice(t("settings.pages.sync.exported", { name: result.backup.name }));
            downloadBackup(result.backup.name);
            await load();
          })
        }
        onImport={(passphrase, signIns) =>
          void call("import", async () => {
            const picked = await pickFiles();
            if (!picked || picked.length === 0) {
              return;
            }
            const file = picked[0]!;
            const uploaded = await client!.uploadFile({
              fileName: file.fileName,
              mimeType: file.mimeType,
              bytes: await file.readBytes(),
            });
            const id = uploaded.file?.id;
            if (!id) {
              throw new Error(uploaded.error ?? "The file couldn't be uploaded");
            }
            const result = await client!.importBackup({
              id,
              passphrase: passphrase.length > 0 ? passphrase : undefined,
              signIns,
            });
            if (result.error) {
              setError(result.error);
              return;
            }
            setNotice(
              t("settings.pages.sync.imported", { parts: (result.parts ?? []).join(", ") }),
            );
            await load();
          })
        }
        onReveal={() =>
          void call("reveal", async () => {
            const result = await client!.revealBackups();
            if (!result.ok) {
              setError(result.error ?? "");
            }
          })
        }
        onRestore={(name) =>
          void call(`restore-backup-${name}`, async () => {
            const result = await client!.restoreBackup({ name });
            if (result.error) {
              setError(result.error);
              return;
            }
            setNotice(t("settings.pages.sync.restoredBackup"));
            await load();
          })
        }
        onDelete={(name) =>
          void call(`delete-backup-${name}`, async () => {
            await client!.deleteBackup(name);
            await load();
          })
        }
        onAutoChange={(next) =>
          void call("auto", async () => {
            setAuto((await client!.setBackupAuto(next)).config ?? next);
          })
        }
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
    </>
  );
}

function StatusSection({
  status,
  busy,
  onSync,
  onRestore,
  onUndo,
  onDismiss,
  onListRemote,
  onUpload,
  onFollow,
  versions,
}: {
  status: SyncStatusView | null;
  busy: string;
  onSync: () => void;
  onRestore: () => void;
  onUndo: () => void;
  onDismiss: () => void;
  onListRemote: () => void;
  onUpload: () => void;
  onFollow: () => void;
  versions: SyncRemoteVersion[] | null;
}) {
  const { t } = useTranslation();
  const line = useMemo(() => {
    if (!status?.enabled) {
      return t("settings.pages.sync.offHint");
    }
    if (status.error) {
      return t("settings.pages.sync.syncError", { error: status.error });
    }
    if (status.last) {
      return t("settings.pages.sync.lastSynced", { when: new Date(status.last).toLocaleString() });
    }
    return t("settings.pages.sync.neverSynced");
  }, [status, t]);

  return (
    <SettingsSection title={t("settings.pages.sync.statusSection")}>
      <SettingsCard>
        <SettingsRow label={t("settings.pages.sync.title")} hint={line} error={undefined}>
          <View style={styles.actions}>
            {status?.enabled ? (
              <Button variant="outline" disabled={busy !== ""} onPress={onSync}>
                {busy === "sync"
                  ? t("settings.pages.sync.syncing")
                  : t("settings.pages.sync.syncNow")}
              </Button>
            ) : null}
            {status?.enabled ? (
              <Button variant="outline" disabled={busy !== ""} onPress={onListRemote}>
                {t("settings.pages.sync.remoteVersions")}
              </Button>
            ) : null}
            {status?.enabled ? (
              <Button variant="outline" disabled={busy !== ""} onPress={onRestore}>
                {t("settings.pages.sync.restoreFromServer")}
              </Button>
            ) : null}
          </View>
        </SettingsRow>
        <LocalRows status={status} busy={busy} onUpload={onUpload} onFollow={onFollow} />
        {status?.notice ? (
          <SettingsRow
            label={
              status.notice.restored
                ? t("settings.pages.sync.restored", { parts: status.notice.here.join(", ") })
                : t("settings.pages.sync.noticedHere", {
                    parts: status.notice.here.join(", ") || "—",
                  })
            }
            hint={
              status.notice.there.length > 0
                ? t("settings.pages.sync.noticedThere", { parts: status.notice.there.join(", ") })
                : t("settings.pages.sync.noticeNote")
            }
          >
            <View style={styles.actions}>
              {status.undo ? (
                <Button variant="outline" disabled={busy !== ""} onPress={onUndo}>
                  {t("settings.pages.sync.undo")}
                </Button>
              ) : null}
              <Button variant="outline" disabled={busy !== ""} onPress={onDismiss}>
                {t("settings.pages.sync.dismiss")}
              </Button>
            </View>
          </SettingsRow>
        ) : null}
        {versions
          ? versions.map((version) => (
              <SettingsRow
                key={version.part}
                label={version.part}
                hint={t("settings.pages.sync.versionLine", {
                  device: version.device,
                  when: new Date(version.takenAt).toLocaleString(),
                  files: version.files,
                })}
              />
            ))
          : null}
      </SettingsCard>
    </SettingsSection>
  );
}

/** The server's unreadable file, and the agent fields this computer keeps. */
function LocalRows({
  status,
  busy,
  onUpload,
  onFollow,
}: {
  status: SyncStatusView | null;
  busy: string;
  onUpload: () => void;
  onFollow: () => void;
}) {
  const { t } = useTranslation();
  const [confirmingUpload, setConfirmingUpload] = useState(false);
  return (
    <>
      {status?.serverFile?.replace ? (
        <SettingsRow
          label={t("settings.pages.sync.uploadSetup")}
          hint={
            confirmingUpload
              ? t("settings.pages.sync.uploadSetupConfirm")
              : t("settings.pages.sync.uploadSetupHint")
          }
        >
          <View style={styles.actions}>
            {confirmingUpload ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy !== ""}
                  onPress={() => {
                    setConfirmingUpload(false);
                    onUpload();
                  }}
                >
                  {t("settings.pages.sync.upload")}
                </Button>
                <Button variant="outline" onPress={() => setConfirmingUpload(false)}>
                  {t("settings.pages.sync.cancel")}
                </Button>
              </>
            ) : (
              <Button variant="outline" onPress={() => setConfirmingUpload(true)}>
                {t("settings.pages.sync.uploadOpen")}
              </Button>
            )}
          </View>
        </SettingsRow>
      ) : null}
      {status?.own && status.own.length > 0 ? (
        <SettingsRow
          label={t("settings.pages.sync.keptHere")}
          hint={t("settings.pages.sync.keptHereHint", {
            fields: status.own
              .map((own) =>
                t("settings.pages.sync.keptField", {
                  agent: own.agent,
                  field: t(`settings.pages.sync.field.${own.field}`),
                }),
              )
              .join(", "),
          })}
        >
          <Button variant="outline" disabled={busy !== ""} onPress={onFollow}>
            {busy === "follow"
              ? t("settings.pages.sync.following")
              : t("settings.pages.sync.follow")}
          </Button>
        </SettingsRow>
      ) : null}
    </>
  );
}

const PART_NAMES = ["sources", "settings", "profiles", "models", "library", "usage"] as const;

function SetupSection({
  config,
  busy,
  onSave,
}: {
  config: SyncConfigView;
  busy: string;
  onSave: (next: {
    enabled: boolean;
    url: string;
    user: string;
    password?: string;
    passphrase?: string;
    endpoint?: string;
    region?: string;
    branch?: string;
    keys: boolean;
    parts: SyncConfigView["parts"];
    intervalMinutes: number;
  }) => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(config.url);
  const [user, setUser] = useState(config.user);
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [region, setRegion] = useState(config.region);
  const [branch, setBranch] = useState(config.branch);
  const [keys, setKeys] = useState(config.keys);
  const [parts, setParts] = useState(config.parts);
  const [intervalMinutes, setIntervalMinutes] = useState(config.intervalMinutes);

  useEffect(() => {
    setUrl(config.url);
    setUser(config.user);
    setEndpoint(config.endpoint);
    setRegion(config.region);
    setBranch(config.branch);
    setKeys(config.keys);
    setParts(config.parts);
    setIntervalMinutes(config.intervalMinutes);
  }, [config]);

  const intervalOptions: SegmentedControlOption<string>[] = [
    { value: "-1", label: t("settings.pages.sync.manual") },
    { value: "3", label: t("settings.pages.sync.minutes", { n: 3 }) },
    { value: "15", label: t("settings.pages.sync.minutes", { n: 15 }) },
    { value: "30", label: t("settings.pages.sync.minutes", { n: 30 }) },
    { value: "60", label: t("settings.pages.sync.hour") },
  ];

  return (
    <SettingsSection title={t("settings.pages.sync.setupSection")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.pages.sync.address")}
          hint={t("settings.pages.sync.addressHint")}
        >
          <TextInput
            key={config.url}
            initialValue={config.url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.pages.sync.user")} hint={t("settings.pages.sync.userHint")}>
          <TextInput
            key={`user-${config.user}`}
            initialValue={config.user}
            onChangeText={setUser}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.sync.endpoint")}
          hint={t("settings.pages.sync.endpointHint")}
        >
          <TextInput
            key={`endpoint-${config.endpoint}`}
            initialValue={config.endpoint}
            onChangeText={setEndpoint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.sync.region")}
          hint={t("settings.pages.sync.regionHint")}
        >
          <TextInput
            key={`region-${config.region}`}
            initialValue={config.region}
            onChangeText={setRegion}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.sync.branch")}
          hint={t("settings.pages.sync.branchHint")}
        >
          <TextInput
            key={`branch-${config.branch}`}
            initialValue={config.branch}
            onChangeText={setBranch}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.sync.password")}
          hint={
            config.passwordSet
              ? t("settings.pages.sync.passwordSaved")
              : t("settings.pages.sync.passwordHint")
          }
        >
          <TextInput
            initialValue=""
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.sync.passphrase")}
          hint={
            config.passphraseSet
              ? t("settings.pages.sync.passphraseSaved")
              : t("settings.pages.sync.passphraseHint")
          }
        >
          <TextInput
            initialValue=""
            onChangeText={setPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("settings.pages.sync.keys")}
          hint={t("settings.pages.sync.keysHint")}
          value={keys}
          onValueChange={setKeys}
        />
        {PART_NAMES.map((part) => (
          <SettingsSwitch
            key={part}
            label={t(`settings.pages.sync.part.${part}`)}
            value={parts[part] !== false}
            onValueChange={(value) => setParts({ ...parts, [part]: value })}
          />
        ))}
        <SettingsRow label={t("settings.pages.sync.interval")}>
          <SegmentedControl
            options={intervalOptions}
            value={String(intervalMinutes)}
            onValueChange={(value) => setIntervalMinutes(Number(value))}
          />
        </SettingsRow>
        <SettingsRow label={t("settings.pages.sync.save")} hint={t("settings.pages.sync.saveHint")}>
          <Button
            disabled={busy !== "" || url.trim().length === 0}
            onPress={() =>
              onSave({
                enabled: true,
                url,
                user,
                password: password.length > 0 ? password : undefined,
                passphrase: passphrase.length > 0 ? passphrase : undefined,
                endpoint: endpoint.length > 0 ? endpoint : undefined,
                region: region.length > 0 ? region : undefined,
                branch: branch.length > 0 ? branch : undefined,
                keys,
                parts,
                intervalMinutes,
              })
            }
          >
            {busy === "save" ? t("settings.pages.sync.saving") : t("settings.pages.sync.save")}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function BackupSection({
  backups,
  auto,
  busy,
  onExport,
  onImport,
  onReveal,
  onDownload,
  onRestore,
  onDelete,
  onAutoChange,
}: {
  backups: BackupEntry[];
  auto: BackupAutoConfig | null;
  busy: string;
  onExport: (passphrase: string, signIns: boolean) => void;
  onImport: (passphrase: string, signIns: boolean) => void;
  onReveal: () => void;
  onDownload: (name: string) => void;
  onRestore: (name: string) => void;
  onDelete: (name: string) => void;
  onAutoChange: (next: BackupAutoConfig) => void;
}) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [exportSignIns, setExportSignIns] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importSignIns, setImportSignIns] = useState(true);
  const [editingFolder, setEditingFolder] = useState(false);
  const [folder, setFolder] = useState(auto?.dir ?? "");
  return (
    <SettingsSection title={t("settings.pages.sync.backupSection")}>
      <SettingsCard>
        <SettingsRow
          label={t("settings.pages.sync.exportPassphrase")}
          hint={t("settings.pages.sync.exportPassphraseHint")}
        >
          <TextInput
            initialValue=""
            onChangeText={setPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("settings.pages.sync.exportSignIns")}
          hint={t("settings.pages.sync.exportSignInsHint")}
          value={exportSignIns}
          onValueChange={setExportSignIns}
        />
        <SettingsRow
          label={t("settings.pages.sync.export")}
          hint={t("settings.pages.sync.exportHint")}
        >
          <Button
            variant="outline"
            disabled={busy !== ""}
            onPress={() => onExport(passphrase, exportSignIns)}
          >
            {busy === "export"
              ? t("settings.pages.sync.exporting")
              : t("settings.pages.sync.export")}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t("settings.pages.sync.importPassphrase")}
          hint={t("settings.pages.sync.importPassphraseHint")}
        >
          <TextInput
            initialValue=""
            onChangeText={setImportPassphrase}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("settings.pages.sync.importSignIns")}
          hint={t("settings.pages.sync.importSignInsHint")}
          value={importSignIns}
          onValueChange={setImportSignIns}
        />
        <SettingsRow
          label={t("settings.pages.sync.import")}
          hint={t("settings.pages.sync.importHint")}
        >
          <Button
            variant="outline"
            disabled={busy !== ""}
            onPress={() => onImport(importPassphrase, importSignIns)}
          >
            {busy === "import"
              ? t("settings.pages.sync.importing")
              : t("settings.pages.sync.importOpen")}
          </Button>
        </SettingsRow>
        {auto ? (
          <>
            <SettingsSwitch
              label={t("settings.pages.sync.autoEnabled")}
              hint={t("settings.pages.sync.autoHint", {
                hours: auto.everyHours,
                keep: auto.keep,
              })}
              value={auto.enabled}
              onValueChange={(enabled) => onAutoChange({ ...auto, enabled })}
            />
            <SettingsSwitch
              label={t("settings.pages.sync.signInsInBackups")}
              hint={
                auto.signIns
                  ? t("settings.pages.sync.signInsInBackupsOn")
                  : t("settings.pages.sync.signInsInBackupsHint")
              }
              value={auto.signIns === true}
              onValueChange={(signIns) => onAutoChange({ ...auto, signIns })}
            />
            <SettingsRow
              label={t("settings.pages.sync.backupFolder")}
              hint={auto.folder ?? auto.dir ?? ""}
            >
              <View style={styles.actions}>
                <Button variant="outline" onPress={() => setEditingFolder(true)}>
                  {t("settings.pages.sync.changeFolder")}
                </Button>
                <Button variant="outline" onPress={onReveal}>
                  {t("settings.pages.sync.showFolder")}
                </Button>
                {auto.dir ? (
                  <Button
                    variant="outline"
                    disabled={busy !== ""}
                    onPress={() => onAutoChange({ ...auto, dir: "" })}
                  >
                    {t("settings.pages.sync.defaultFolder")}
                  </Button>
                ) : null}
              </View>
            </SettingsRow>
            {editingFolder ? (
              <SettingsRow
                label={t("settings.pages.sync.folderPath")}
                hint={t("settings.pages.sync.folderPathHint")}
              >
                <View style={styles.actions}>
                  <TextInput
                    key={`folder-${auto.dir}`}
                    initialValue={auto.dir ?? ""}
                    onChangeText={setFolder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.input}
                  />
                  <Button
                    variant="outline"
                    disabled={busy !== ""}
                    onPress={() => {
                      onAutoChange({ ...auto, dir: folder.trim() });
                      setEditingFolder(false);
                    }}
                  >
                    {t("settings.pages.sync.save")}
                  </Button>
                </View>
              </SettingsRow>
            ) : null}
          </>
        ) : null}
        {backups.length === 0 ? (
          <SettingsRow label={t("settings.pages.sync.noBackups")} />
        ) : (
          backups.map((backup) => (
            <SettingsRow
              key={backup.name}
              label={backup.name}
              hint={t("settings.pages.sync.backupLine", {
                size: formatSize(backup.size),
                when: new Date(backup.at).toLocaleString(),
              })}
            >
              <View style={styles.actions}>
                <Button
                  variant="outline"
                  disabled={busy !== ""}
                  onPress={() => onDownload(backup.name)}
                >
                  {t("settings.pages.sync.saveFile")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy !== ""}
                  onPress={() => onRestore(backup.name)}
                >
                  {t("settings.pages.sync.restore")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy !== ""}
                  onPress={() => onDelete(backup.name)}
                >
                  {t("settings.pages.sync.delete")}
                </Button>
              </View>
            </SettingsRow>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  input: {
    minWidth: 220,
  },
  error: {
    color: theme.colors.statusDanger,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  notice: {
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
}));
