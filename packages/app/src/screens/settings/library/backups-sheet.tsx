import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LibraryBackupSession } from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { settingsStyles } from "@/styles/settings";
import type { LibrarySnapshot } from "@neolix/protocol/library";

interface BackupRowProps {
  session: string;
  agent: string;
  agentName: string;
  file: string;
  target: string | null;
  pendingKey: string | null;
  restoredKey: string | null;
  onRestore: (entry: { stamp: string; agent: string; file: string }, key: string) => void;
}

function BackupRow({
  session,
  agent,
  agentName,
  file,
  target,
  pendingKey,
  restoredKey,
  onRestore,
}: BackupRowProps) {
  const { t } = useTranslation();
  const key = `${session}:${agent}:${file}`;
  const restore = useCallback(
    () => onRestore({ stamp: session, agent, file }, key),
    [agent, file, key, onRestore, session],
  );
  const pending = pendingKey === key;
  const done = restoredKey === key;
  return (
    <View style={settingsStyles.row}>
      <View style={styles.grow}>
        <Text style={settingsStyles.rowTitle}>{file}</Text>
        <Text style={settingsStyles.rowHint}>
          {target ?? t("settings.usePages.library.backupBrowser.noTarget", { agent: agentName })}
        </Text>
      </View>
      <Button variant="outline" onPress={restore} disabled={pending || !target}>
        {done
          ? t("settings.usePages.library.common.saved")
          : t("settings.usePages.library.backupBrowser.restore")}
      </Button>
    </View>
  );
}

function SessionView({
  session,
  agentNames,
  pendingKey,
  restoredKey,
  onRestore,
}: {
  session: LibraryBackupSession;
  agentNames: (id: string) => string;
  pendingKey: string | null;
  restoredKey: string | null;
  onRestore: (entry: { stamp: string; agent: string; file: string }, key: string) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={settingsStyles.sectionHeaderTitle}>{session.stamp}</Text>
      {Object.entries(session.files).map(([agent, files]) =>
        files.map((file) => (
          <BackupRow
            key={`${agent}:${file.file}`}
            session={session.stamp}
            agent={agent}
            agentName={agentNames(agent)}
            file={file.file}
            target={file.target}
            pendingKey={pendingKey}
            restoredKey={restoredKey}
            onRestore={onRestore}
          />
        )),
      )}
    </View>
  );
}

export function BackupsSheet({
  visible,
  client,
  library,
  onClose,
  onLibrary,
  onError,
  onOpenFolder,
}: {
  visible: boolean;
  client: DaemonClient;
  library: LibrarySnapshot;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onError: (error: unknown) => void;
  onOpenFolder: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<LibraryBackupSession[] | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [restoredKey, setRestoredKey] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) {
      setSessions(null);
      setPendingKey(null);
      setRestoredKey(null);
      return;
    }
    void (async () => {
      try {
        const result = await client.getLibraryBackups();
        setSessions(result.backups);
      } catch (error) {
        onError(error);
      }
    })();
  }, [client, onError, visible]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.library.backupBrowser.title") }),
    [t],
  );

  const agentNames = useMemo(() => {
    const map = new Map(library.agents.map((agent) => [agent.id, agent.name]));
    return (id: string) => map.get(id) ?? id;
  }, [library.agents]);

  const restore = useCallback(
    (entry: { stamp: string; agent: string; file: string }, key: string) => {
      setPendingKey(key);
      void (async () => {
        try {
          const result = await client.restoreLibraryBackup(entry);
          onLibrary(result.library);
          setRestoredKey(key);
        } catch (error) {
          onError(error);
        } finally {
          setPendingKey(null);
        }
      })();
    },
    [client, onError, onLibrary],
  );

  let content: ReactNode;
  if (sessions === null) {
    content = <LoadingSpinner color={styles.spinnerColor.color} />;
  } else if (sessions.length === 0) {
    content = (
      <Text style={styles.intro}>{t("settings.usePages.library.backupBrowser.empty")}</Text>
    );
  } else {
    content = (
      <View style={styles.list}>
        {sessions.map((session) => (
          <SessionView
            key={session.stamp}
            session={session}
            agentNames={agentNames}
            pendingKey={pendingKey}
            restoredKey={restoredKey}
            onRestore={restore}
          />
        ))}
      </View>
    );
  }

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.intro}>{t("settings.usePages.library.backupBrowser.intro")}</Text>
        {content}
        <View style={styles.actions}>
          <Button variant="outline" onPress={onOpenFolder}>
            {t("settings.usePages.library.backupBrowser.openFolder")}
          </Button>
          <Button variant="secondary" onPress={onClose}>
            {t("settings.usePages.library.common.cancel")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  grow: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
  intro: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  list: {
    gap: theme.spacing[4],
  },
  section: {
    gap: theme.spacing[1],
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
