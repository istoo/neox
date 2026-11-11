import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LibraryFoundMcpServer, LibraryFoundSkill } from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import type { LibrarySnapshot, LibrarySyncResult } from "@neolix/protocol/library";

interface PickerRowProps {
  name: string;
  title: string;
  hint: string;
  selected: boolean;
  onToggle: (name: string) => void;
}

function PickerRow({ name, title, hint, selected, onToggle }: PickerRowProps) {
  const toggle = useCallback(() => onToggle(name), [name, onToggle]);
  return (
    <View style={settingsStyles.row}>
      <View style={styles.grow}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{hint}</Text>
      </View>
      <Switch value={selected} onValueChange={toggle} accessibilityLabel={title} />
    </View>
  );
}

function serverHint(server: LibraryFoundMcpServer): string {
  const where =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
      : (server.url ?? "");
  const secrets = [
    ...Object.keys(server.env ?? {}).map((key) => `env ${key}`),
    ...Object.keys(server.headers ?? {}).map((key) => `header ${key}`),
  ];
  const secretText = secrets.length > 0 ? ` · ${secrets.join(", ")}` : "";
  return `${server.transport} · ${where}${secretText}`;
}

function ServerList({
  servers,
  selected,
  agentNames,
  onToggle,
}: {
  servers: LibraryFoundMcpServer[];
  selected: ReadonlySet<string>;
  agentNames: (ids: string[]) => string;
  onToggle: (name: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View>
      {servers.map((server) => {
        const agents = agentNames(server.agents);
        const other = agentNames(server.otherAgents);
        const hint = other
          ? `${serverHint(server)} · ${t("settings.usePages.library.discover.otherAgents", { agents: other })}`
          : `${serverHint(server)} · ${agents}`;
        return (
          <PickerRow
            key={server.name}
            name={server.name}
            title={server.name}
            hint={hint}
            selected={selected.has(server.name)}
            onToggle={onToggle}
          />
        );
      })}
    </View>
  );
}

function SkillList({
  skills,
  selected,
  agentNames,
  onToggle,
}: {
  skills: LibraryFoundSkill[];
  selected: ReadonlySet<string>;
  agentNames: (ids: string[]) => string;
  onToggle: (name: string) => void;
}) {
  return (
    <View>
      {skills.map((skill) => (
        <PickerRow
          key={skill.name}
          name={skill.name}
          title={skill.name}
          hint={`${skill.description || skill.path} · ${agentNames(skill.agents)}`}
          selected={selected.has(skill.name)}
          onToggle={onToggle}
        />
      ))}
    </View>
  );
}

function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, clear };
}

export function DiscoverSheet({
  visible,
  client,
  library,
  onClose,
  onLibrary,
  onSaved,
  onError,
}: {
  visible: boolean;
  client: DaemonClient;
  library: LibrarySnapshot;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [found, setFound] = useState<{
    servers: LibraryFoundMcpServer[];
    skills: LibraryFoundSkill[];
  } | null>(null);
  const [myna, setMyna] = useState<{
    available: boolean;
    dir: string;
    servers: LibraryFoundMcpServer[];
    skills: LibraryFoundSkill[];
  } | null>(null);
  const [pending, setPending] = useState(false);
  const agentServers = useSelection();
  const agentSkills = useSelection();
  const mynaServers = useSelection();
  const mynaSkills = useSelection();

  useEffect(() => {
    if (!visible) {
      setFound(null);
      setMyna(null);
      setPending(false);
      return;
    }
    void (async () => {
      try {
        const [discover, mynaView] = await Promise.all([
          client.discoverLibrary(),
          client.getMynaLibrary(),
        ]);
        setFound(discover.discover);
        setMyna(mynaView.myna);
      } catch (error) {
        onError(error);
      }
    })();
  }, [client, onError, visible]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.library.discover.title") }),
    [t],
  );

  const names = useMemo(() => {
    const map = new Map(library.agents.map((agent) => [agent.id, agent.name]));
    return (ids: string[]) => ids.map((id) => map.get(id) ?? id).join(", ");
  }, [library.agents]);

  const toggleServer = useCallback((name: string) => agentServers.toggle(name), [agentServers]);
  const toggleSkill = useCallback((name: string) => agentSkills.toggle(name), [agentSkills]);
  const toggleMynaServer = useCallback((name: string) => mynaServers.toggle(name), [mynaServers]);
  const toggleMynaSkill = useCallback((name: string) => mynaSkills.toggle(name), [mynaSkills]);

  const hasSelection =
    agentServers.selected.size > 0 ||
    agentSkills.selected.size > 0 ||
    mynaServers.selected.size > 0 ||
    mynaSkills.selected.size > 0;

  const runImport = useCallback(async () => {
    setPending(true);
    try {
      const problems: LibrarySyncResult["problems"] = [];
      const changed: string[] = [];
      let latest: LibrarySnapshot | null = null;
      if (agentServers.selected.size > 0 || agentSkills.selected.size > 0) {
        const result = await client.importLibraryDiscovered({
          servers: [...agentServers.selected],
          skills: [...agentSkills.selected],
        });
        latest = result.library;
        problems.push(...result.result.problems);
        changed.push(...result.result.changed);
      }
      if (mynaServers.selected.size > 0 || mynaSkills.selected.size > 0) {
        const result = await client.importMynaLibrary({
          servers: [...mynaServers.selected],
          skills: [...mynaSkills.selected],
        });
        latest = result.library;
        problems.push(...result.result.problems);
        changed.push(...result.result.changed);
      }
      if (latest) {
        onLibrary(latest);
        onSaved({ changed: [...new Set(changed)], problems });
      }
      onClose();
    } catch (error) {
      onError(error);
    } finally {
      setPending(false);
    }
  }, [
    agentServers.selected,
    agentSkills.selected,
    client,
    mynaServers.selected,
    mynaSkills.selected,
    onClose,
    onError,
    onLibrary,
    onSaved,
  ]);

  const importLabel = pending
    ? t("settings.usePages.library.discover.importing")
    : t("settings.usePages.library.discover.import");

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={onClose}>
      <View style={styles.body}>
        <Text style={styles.intro}>{t("settings.usePages.library.discover.intro")}</Text>
        {found === null || myna === null ? (
          <LoadingSpinner color={styles.spinnerColor.color} />
        ) : (
          <View style={styles.sections}>
            <Text style={settingsStyles.sectionHeaderTitle}>
              {t("settings.usePages.library.discover.servers")}
            </Text>
            {found.servers.length > 0 ? (
              <ServerList
                servers={found.servers}
                selected={agentServers.selected}
                agentNames={names}
                onToggle={toggleServer}
              />
            ) : (
              <Text style={styles.hint}>{t("settings.usePages.library.discover.empty")}</Text>
            )}
            <Text style={styles.secret}>{t("settings.usePages.library.discover.secretNote")}</Text>
            <Text style={settingsStyles.sectionHeaderTitle}>
              {t("settings.usePages.library.discover.skills")}
            </Text>
            {found.skills.length > 0 ? (
              <SkillList
                skills={found.skills}
                selected={agentSkills.selected}
                agentNames={names}
                onToggle={toggleSkill}
              />
            ) : (
              <Text style={styles.hint}>{t("settings.usePages.library.discover.empty")}</Text>
            )}

            <Text style={settingsStyles.sectionHeaderTitle}>
              {t("settings.usePages.library.discover.fromMyna")}
            </Text>
            {myna.available ? (
              <View style={styles.sections}>
                <Text style={styles.hint}>{myna.dir}</Text>
                <ServerList
                  servers={myna.servers}
                  selected={mynaServers.selected}
                  agentNames={names}
                  onToggle={toggleMynaServer}
                />
                <SkillList
                  skills={myna.skills}
                  selected={mynaSkills.selected}
                  agentNames={names}
                  onToggle={toggleMynaSkill}
                />
              </View>
            ) : (
              <Text style={styles.hint}>{t("settings.usePages.library.discover.mynaMissing")}</Text>
            )}
          </View>
        )}
        <View style={styles.actions}>
          <Button variant="secondary" style={styles.actionButton} onPress={onClose}>
            {t("settings.usePages.library.common.cancel")}
          </Button>
          <Button
            variant="default"
            style={styles.actionButton}
            onPress={runImport}
            disabled={pending || !hasSelection}
          >
            {importLabel}
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
  sections: {
    gap: theme.spacing[2],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  secret: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
  actionButton: {
    flex: 1,
  },
}));
