import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  AgentInstallCommand,
  AgentInstallEntry,
  AgentInstallRunResult,
} from "@neolix/protocol/agent-install";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { useProviderIcon } from "@/components/provider-icons";
import { useToast } from "@/contexts/toast-api-context";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const ICON_SIZE = 20;

const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function viaLabelKey(via: AgentInstallCommand["via"]): string {
  switch (via) {
    case "brew":
      return "settings.usePages.agent.installVia.brew";
    case "npm":
      return "settings.usePages.agent.installVia.npm";
    case "powershell":
      return "settings.usePages.agent.installVia.powershell";
    case "script":
      return "settings.usePages.agent.installVia.script";
  }
}

interface AgentCliInstallListProps {
  serverId: string;
  entries: AgentInstallEntry[];
  /** Runs one catalog command on the daemon host. */
  onRun: (provider: string, commandId: string) => Promise<AgentInstallRunResult>;
  /** Called after a command succeeds, so the page can re-detect the agent. */
  onInstalled: (provider: string) => void;
}

/**
 * myna's 「安装其他 Agent」 list: the command-line programs a host can install,
 * each vendor's own command. Nothing runs until the reader confirms the exact
 * line, and the output of that run stays on the row.
 */
export function AgentCliInstallList({
  serverId,
  entries,
  onRun,
  onInstalled,
}: AgentCliInstallListProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [runningProvider, setRunningProvider] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, AgentInstallRunResult>>({});

  const start = useCallback(
    async (entry: AgentInstallEntry, command: AgentInstallCommand) => {
      if (runningProvider !== null) return;
      const confirmed = await confirmDialog({
        title: t("settings.usePages.agent.cliConfirmTitle", { name: entry.name }),
        message: t("settings.usePages.agent.cliConfirmMessage", { command: command.command }),
        confirmLabel: t("settings.usePages.agent.cliConfirm"),
      });
      if (!confirmed) return;
      setRunningProvider(entry.provider);
      try {
        const result = await onRun(entry.provider, command.id);
        setResults((previous) => ({ ...previous, [entry.provider]: result }));
        if (result.ok) {
          toast.show(t("settings.usePages.agent.cliInstalled", { name: entry.name }));
          onInstalled(entry.provider);
        } else {
          toast.error(result.error ?? t("settings.usePages.agent.cliFailed", { name: entry.name }));
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setRunningProvider(null);
      }
    },
    [onInstalled, onRun, runningProvider, t, toast],
  );

  if (entries.length === 0) {
    return <Text style={styles.emptyText}>{t("settings.usePages.agent.cliEmpty")}</Text>;
  }

  return (
    <View style={styles.list}>
      {entries.map((entry) => (
        <AgentCliInstallRow
          key={entry.provider}
          serverId={serverId}
          entry={entry}
          running={runningProvider === entry.provider}
          busy={runningProvider !== null}
          result={results[entry.provider] ?? null}
          onStart={start}
        />
      ))}
    </View>
  );
}

interface AgentCliInstallRowProps {
  serverId: string;
  entry: AgentInstallEntry;
  running: boolean;
  busy: boolean;
  result: AgentInstallRunResult | null;
  onStart: (entry: AgentInstallEntry, command: AgentInstallCommand) => Promise<void>;
}

function AgentCliInstallRow({
  serverId,
  entry,
  running,
  busy,
  result,
  onStart,
}: AgentCliInstallRowProps) {
  const { t } = useTranslation();
  const ProviderIcon = useProviderIcon(entry.provider, serverId);
  const ThemedProviderIcon = useMemo(() => withUnistyles(ProviderIcon), [ProviderIcon]);

  return (
    <View style={[settingsStyles.card, styles.row]} testID={`agent-cli-install-${entry.provider}`}>
      <View style={styles.identity}>
        <View style={styles.iconFrame}>
          <ThemedProviderIcon size={ICON_SIZE} uniProps={foregroundIconMapping} />
        </View>
        <View style={styles.details}>
          <Text style={styles.name} numberOfLines={1}>
            {entry.name}
          </Text>
          <Text style={styles.description}>{entry.description}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        {entry.commands.map((command) => (
          <InstallCommandButton
            key={command.id}
            entry={entry}
            command={command}
            running={running}
            disabled={busy}
            onStart={onStart}
          />
        ))}
        {entry.url !== null ? (
          <ExternalLink
            href={entry.url}
            label={t("settings.usePages.agent.cliOpenSite")}
            accessibilityLabel={t("settings.usePages.agent.cliOpenSiteFor", { name: entry.name })}
          />
        ) : null}
      </View>
      {running ? (
        <Text style={styles.statusText}>{t("settings.usePages.agent.cliRunning")}</Text>
      ) : null}
      {result === null || running ? null : <InstallResult result={result} />}
    </View>
  );
}

interface InstallCommandButtonProps {
  entry: AgentInstallEntry;
  command: AgentInstallCommand;
  running: boolean;
  disabled: boolean;
  onStart: (entry: AgentInstallEntry, command: AgentInstallCommand) => Promise<void>;
}

function InstallCommandButton({
  entry,
  command,
  running,
  disabled,
  onStart,
}: InstallCommandButtonProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    void onStart(entry, command);
  }, [command, entry, onStart]);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      loading={running}
      onPress={handlePress}
      accessibilityLabel={t("settings.usePages.agent.cliInstallWith", {
        name: entry.name,
        via: t(viaLabelKey(command.via)),
      })}
      testID={`agent-cli-install-${entry.provider}-${command.id}`}
    >
      {t(viaLabelKey(command.via))}
    </Button>
  );
}

function InstallResult({ result }: { result: AgentInstallRunResult }) {
  const { t } = useTranslation();
  return (
    <View style={styles.resultBox}>
      <Text style={result.ok ? styles.okText : styles.failText}>
        {result.ok
          ? t("settings.usePages.agent.cliResultSuccess")
          : (result.error ?? t("settings.usePages.agent.cliFailedShort"))}
      </Text>
      {result.output.length > 0 ? (
        <>
          <Text style={styles.outputLabel}>{t("settings.usePages.agent.cliOutput")}</Text>
          <ScrollView style={styles.outputScroll} testID="agent-cli-install-output">
            <Text selectable style={styles.output}>
              {result.output}
            </Text>
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  iconFrame: {
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  details: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  resultBox: {
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  okText: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
  },
  failText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  outputLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  outputScroll: {
    maxHeight: 160,
  },
  output: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
