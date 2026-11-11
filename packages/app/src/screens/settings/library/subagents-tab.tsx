import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LibrarySubagent } from "@neolix/protocol/library";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { AgentChips, LibraryEmpty, LibraryIntro, LibraryRowHeader } from "./library-ui";
import { LibraryEditorSheet } from "./library-editor";
import type { LibraryTabProps } from "./types";

function SubagentRow({
  subagent,
  agents,
  disabled,
  onOpen,
  onToggleAgent,
}: {
  subagent: LibrarySubagent;
  agents: { id: string; name: string }[];
  disabled: boolean;
  onOpen: (subagent: LibrarySubagent) => void;
  onToggleAgent: (subagent: LibrarySubagent, agent: string) => void;
}) {
  const open = useCallback(() => onOpen(subagent), [onOpen, subagent]);
  const toggle = useCallback(
    (agent: string) => onToggleAgent(subagent, agent),
    [onToggleAgent, subagent],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={[settingsStyles.rowContent, styles.rowBody]}>
        <PressHighlight onPress={disabled ? undefined : open} style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>{subagent.name}</Text>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {subagent.description}
          </Text>
        </PressHighlight>
        <AgentChips
          agents={agents}
          selected={subagent.agents}
          disabled={disabled}
          onToggle={toggle}
        />
      </View>
    </View>
  );
}

export function SubagentsTab({
  library,
  client,
  onLibrary,
  onSaved,
  onError,
  disabled,
}: LibraryTabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ subagent: LibrarySubagent | null } | null>(null);

  const agents = useMemo(
    () => library.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [library.agents],
  );

  const toggleAgent = useCallback(
    (subagent: LibrarySubagent, agent: string) => {
      const next = subagent.agents.includes(agent)
        ? subagent.agents.filter((entry) => entry !== agent)
        : [...subagent.agents, agent];
      void (async () => {
        try {
          const result = await client.setLibrarySubagentAgents(subagent.name, next);
          onLibrary(result.library);
          onSaved(result.result);
        } catch (error) {
          onError(error);
        }
      })();
    },
    [client, onError, onLibrary, onSaved],
  );

  const save = useCallback(
    async (input: { oldName: string | null; subagent: LibrarySubagent }) => {
      const result = await client.saveLibrarySubagent(
        input.subagent,
        input.oldName ? { oldName: input.oldName } : {},
      );
      onLibrary(result.library);
      onSaved(result.result);
      setEditing(null);
    },
    [client, onLibrary, onSaved],
  );

  const remove = useCallback(
    async (name: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.usePages.library.common.remove"),
        message: t("settings.usePages.library.subagents.removeConfirm", { name }),
        confirmLabel: t("settings.usePages.library.common.remove"),
        cancelLabel: t("settings.usePages.library.common.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const result = await client.removeLibrarySubagent(name);
        onLibrary(result.library);
        onSaved(result.result);
        setEditing(null);
      } catch (error) {
        onError(error);
      }
    },
    [client, onError, onLibrary, onSaved, t],
  );

  const openNewSubagent = useCallback(() => setEditing({ subagent: null }), []);
  const openSubagent = useCallback((subagent: LibrarySubagent) => setEditing({ subagent }), []);
  const closeEditor = useCallback(() => setEditing(null), []);

  const skillNames = useMemo(() => library.skills.map((skill) => skill.name), [library.skills]);
  const serverNames = useMemo(() => library.mcp.map((server) => server.name), [library.mcp]);

  return (
    <View>
      <LibraryIntro>{t("settings.usePages.library.subagents.intro")}</LibraryIntro>
      <LibraryRowHeader label={t("settings.usePages.library.tabs.subagents")} />
      {library.subagents.length === 0 ? (
        <SettingsCard>
          <LibraryEmpty
            title={t("settings.usePages.library.subagents.emptyTitle")}
            text={t("settings.usePages.library.subagents.emptyText")}
            actionLabel={t("settings.usePages.library.subagents.add")}
            onAction={openNewSubagent}
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {library.subagents.map((subagent) => (
            <SubagentRow
              key={subagent.name}
              subagent={subagent}
              agents={agents}
              disabled={disabled}
              onOpen={openSubagent}
              onToggleAgent={toggleAgent}
            />
          ))}
        </SettingsCard>
      )}
      {library.subagents.length > 0 ? (
        <View style={styles.footer}>
          <Button variant="outline" onPress={openNewSubagent} disabled={disabled}>
            {t("settings.usePages.library.subagents.add")}
          </Button>
        </View>
      ) : null}

      {editing ? (
        <SubagentEditor
          key={editing.subagent?.name ?? "new"}
          subagent={editing.subagent}
          agents={agents}
          skills={skillNames}
          servers={serverNames}
          onClose={closeEditor}
          onSave={save}
          onRemove={remove}
        />
      ) : null}
    </View>
  );
}

function draftIncomplete(name: string, description: string, prompt: string): boolean {
  return name.trim().length === 0 || description.trim().length === 0 || prompt.trim().length === 0;
}

function SubagentNameFields({
  skills,
  servers,
  selectedSkills,
  selectedServers,
  onToggleSkill,
  onToggleServer,
}: {
  skills: string[];
  servers: string[];
  selectedSkills: string[];
  selectedServers: string[];
  onToggleSkill: (value: string) => void;
  onToggleServer: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {skills.length > 0 ? (
        <Field label={t("settings.usePages.library.subagents.skills")}>
          <NameChips options={skills} selected={selectedSkills} onToggle={onToggleSkill} />
        </Field>
      ) : null}
      {servers.length > 0 ? (
        <Field label={t("settings.usePages.library.subagents.mcp")}>
          <NameChips options={servers} selected={selectedServers} onToggle={onToggleServer} />
        </Field>
      ) : null}
    </>
  );
}

function SubagentEditor({
  subagent,
  agents,
  skills,
  servers,
  onClose,
  onSave,
  onRemove,
}: {
  subagent: LibrarySubagent | null;
  agents: { id: string; name: string }[];
  skills: string[];
  servers: string[];
  onClose: () => void;
  onSave: (input: { oldName: string | null; subagent: LibrarySubagent }) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(subagent?.name ?? "");
  const [description, setDescription] = useState(subagent?.description ?? "");
  const [prompt, setPrompt] = useState(subagent?.prompt ?? "");
  const [selectedSkills, setSelectedSkills] = useState<string[]>(subagent?.skills ?? []);
  const [selectedServers, setSelectedServers] = useState<string[]>(subagent?.mcp ?? []);
  const [selectedAgents, setSelectedAgents] = useState<string[]>(subagent?.agents ?? []);

  const toggleIn = useCallback(
    (setter: (update: (current: string[]) => string[]) => void, value: string) => {
      setter((current) =>
        current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
      );
    },
    [],
  );

  const toggleAgent = useCallback(
    (agent: string) => toggleIn(setSelectedAgents, agent),
    [toggleIn],
  );
  const toggleSkill = useCallback(
    (skill: string) => toggleIn(setSelectedSkills, skill),
    [toggleIn],
  );
  const toggleServer = useCallback(
    (server: string) => toggleIn(setSelectedServers, server),
    [toggleIn],
  );

  const save = useCallback(
    () =>
      onSave({
        oldName: subagent?.name ?? null,
        subagent: {
          name,
          description,
          prompt,
          agents: selectedAgents,
          skills: selectedSkills,
          mcp: selectedServers,
        },
      }),
    [
      description,
      name,
      onSave,
      prompt,
      selectedAgents,
      selectedServers,
      selectedSkills,
      subagent?.name,
    ],
  );

  const removeCurrent = useCallback(() => {
    if (subagent) {
      void onRemove(subagent.name);
    }
  }, [onRemove, subagent]);

  return (
    <LibraryEditorSheet
      visible
      title={
        subagent
          ? t("settings.usePages.library.subagents.editorEdit")
          : t("settings.usePages.library.subagents.editorAdd")
      }
      onClose={onClose}
      onSave={save}
      removeLabel={subagent ? t("settings.usePages.library.common.remove") : undefined}
      onRemove={subagent ? removeCurrent : undefined}
      saveDisabled={draftIncomplete(name, description, prompt)}
    >
      <Field label={t("settings.usePages.library.subagents.name")}>
        <FormTextInput
          initialValue={name}
          onChangeText={setName}
          placeholder={t("settings.usePages.library.subagents.namePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("settings.usePages.library.subagents.description")}>
        <FormTextInput
          initialValue={description}
          onChangeText={setDescription}
          placeholder={t("settings.usePages.library.subagents.descriptionPlaceholder")}
        />
      </Field>
      <Field label={t("settings.usePages.library.subagents.prompt")}>
        <FormTextInput
          initialValue={prompt}
          onChangeText={setPrompt}
          placeholder={t("settings.usePages.library.subagents.promptPlaceholder")}
          multiline
          style={styles.textArea}
        />
      </Field>
      <SubagentNameFields
        skills={skills}
        servers={servers}
        selectedSkills={selectedSkills}
        selectedServers={selectedServers}
        onToggleSkill={toggleSkill}
        onToggleServer={toggleServer}
      />
      <Field
        label={t("settings.usePages.library.subagents.agents")}
        hint={t("settings.usePages.library.subagents.agentsHint")}
      >
        <AgentChips agents={agents} selected={selectedAgents} onToggle={toggleAgent} />
      </Field>
    </LibraryEditorSheet>
  );
}

function NameChips({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => (
        <NameChip
          key={option}
          name={option}
          selected={selected.includes(option)}
          onToggle={onToggle}
        />
      ))}
    </View>
  );
}

function NameChip({
  name,
  selected,
  onToggle,
}: {
  name: string;
  selected: boolean;
  onToggle: (value: string) => void;
}) {
  const press = useCallback(() => onToggle(name), [name, onToggle]);
  const accessibilityState = useMemo(() => ({ checked: selected }), [selected]);
  const style = useMemo(() => [styles.choice, selected && styles.choiceSelected], [selected]);
  const labelStyle = useMemo(
    () => [styles.choiceLabel, selected && styles.choiceLabelSelected],
    [selected],
  );
  return (
    <PressHighlight
      accessibilityRole="switch"
      accessibilityState={accessibilityState}
      onPress={press}
      style={style}
    >
      <Text style={labelStyle}>{name}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowBody: {
    gap: theme.spacing[2],
  },
  rowText: {
    flex: 1,
  },
  footer: {
    marginTop: theme.spacing[3],
    marginLeft: theme.spacing[1],
    alignItems: "flex-start",
  },
  textArea: {
    minHeight: 160,
    textAlignVertical: "top",
  },
  choiceRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  choice: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  choiceSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface3,
  },
  choiceLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  choiceLabelSelected: {
    color: theme.colors.foreground,
  },
}));
