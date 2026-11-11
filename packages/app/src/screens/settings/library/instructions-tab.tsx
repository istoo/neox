import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { SettingsCard } from "@/components/settings";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import type { LibraryInstructionsView } from "@neolix/protocol/library";
import { AgentIcon, LibraryIntro, LibraryRowHeader } from "./library-ui";
import { LibraryEditorSheet } from "./library-editor";
import { AgentInstructionsSheet } from "./agent-instructions-sheet";
import type { LibraryTabProps } from "./types";

type SetView = LibraryInstructionsView["sets"][number];
type AgentView = LibraryInstructionsView["agents"][number];

type EditorTarget = { kind: "new" } | { kind: "edit"; set: SetView };

function slugForSet(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return /^[a-z0-9]/.test(slug) ? slug : `set-${Date.now().toString(36)}`;
}

function SetRow({
  view,
  disabled,
  onEdit,
  onActivate,
}: {
  view: SetView;
  disabled: boolean;
  onEdit: (set: SetView) => void;
  onActivate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const name =
    view.id === "default" && view.name.length === 0
      ? t("settings.usePages.library.instructions.defaultSet")
      : view.name;
  const preview =
    view.text.trim().length === 0
      ? t("settings.usePages.library.instructions.emptySet")
      : view.text.trim().split("\n")[0];
  const edit = useCallback(() => onEdit(view), [onEdit, view]);
  const activate = useCallback(() => onActivate(view.id), [onActivate, view.id]);
  return (
    <View style={settingsStyles.row}>
      <PressHighlight onPress={disabled ? undefined : edit} style={styles.grow}>
        <Text style={settingsStyles.rowTitle}>{name}</Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {preview}
        </Text>
      </PressHighlight>
      {view.active ? (
        <StatusBadge label={t("settings.usePages.library.instructions.inUse")} variant="success" />
      ) : (
        <Button variant="outline" onPress={activate} disabled={disabled}>
          {t("settings.usePages.library.instructions.use")}
        </Button>
      )}
    </View>
  );
}

function AgentRow({
  view,
  disabled,
  onToggle,
  onEdit,
}: {
  view: AgentView;
  disabled: boolean;
  onToggle: (agentId: string) => void;
  onEdit: (view: AgentView) => void;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(() => onToggle(view.agent), [onToggle, view.agent]);
  const edit = useCallback(() => onEdit(view), [onEdit, view]);
  return (
    <View style={settingsStyles.row}>
      <PressHighlight
        onPress={disabled ? undefined : edit}
        style={[settingsStyles.rowContent, styles.agentRow]}
      >
        <AgentIcon agent={view.agent} size={20} />
        <View style={styles.grow}>
          <View style={styles.nameRow}>
            <Text style={settingsStyles.rowTitle}>{view.name}</Text>
            {view.own > 0 ? (
              <StatusBadge
                size="xs"
                label={t("settings.usePages.library.instructions.ownLines", { count: view.own })}
              />
            ) : null}
            {view.edited ? (
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("settings.usePages.library.instructions.edited")}
              />
            ) : null}
          </View>
          <Text style={styles.path} numberOfLines={1}>
            {view.path}
          </Text>
          {view.override ? (
            <Text style={settingsStyles.rowHint}>
              {t("settings.usePages.library.instructions.override", { path: view.override })}
            </Text>
          ) : null}
        </View>
      </PressHighlight>
      <Switch
        value={view.on}
        onValueChange={toggle}
        disabled={disabled}
        accessibilityLabel={view.name}
      />
    </View>
  );
}

export function InstructionsTab({
  library,
  client,
  onLibrary,
  onSaved,
  onError,
  disabled,
}: LibraryTabProps) {
  const { t } = useTranslation();
  const view = library.instructions;
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [agentEditor, setAgentEditor] = useState<AgentView | null>(null);

  const activate = useCallback(
    (id: string) => {
      void (async () => {
        try {
          const result = await client.saveLibraryInstructions({ activate: id });
          onLibrary(result.library);
          onSaved(result.result);
        } catch (error) {
          onError(error);
        }
      })();
    },
    [client, onError, onLibrary, onSaved],
  );

  const toggleAgent = useCallback(
    (agent: string) => {
      const agents = view.agents.filter((row) => row.on).map((row) => row.agent);
      const next = agents.includes(agent)
        ? agents.filter((entry) => entry !== agent)
        : [...agents, agent];
      void (async () => {
        try {
          const result = await client.saveLibraryInstructions({ agents: next });
          onLibrary(result.library);
          onSaved(result.result);
        } catch (error) {
          onError(error);
        }
      })();
    },
    [client, onError, onLibrary, onSaved, view.agents],
  );

  const openAgentEditor = useCallback((row: AgentView) => setAgentEditor(row), []);
  const closeAgentEditor = useCallback(() => setAgentEditor(null), []);
  const openNewSet = useCallback(() => setEditing({ kind: "new" }), []);
  const openSet = useCallback((set: SetView) => setEditing({ kind: "edit", set }), []);
  const closeEditor = useCallback(() => setEditing(null), []);

  const saveEditor = useCallback(
    async (name: string, text: string) => {
      if (!editing) {
        return;
      }
      if (editing.kind === "new") {
        const id = slugForSet(name);
        const result = await client.saveLibraryInstructions({
          create: { id, name },
          texts: { [id]: text },
        });
        onLibrary(result.library);
        onSaved(result.result);
      } else {
        const { set } = editing;
        const defaultName = t("settings.usePages.library.instructions.defaultSet");
        const currentName = set.name || (set.id === "default" ? defaultName : set.name);
        const result = await client.saveLibraryInstructions({
          texts: { [set.id]: text },
          ...(name.trim() !== currentName ? { rename: { id: set.id, name } } : {}),
        });
        onLibrary(result.library);
        onSaved(result.result);
      }
      setEditing(null);
    },
    [client, editing, onLibrary, onSaved, t],
  );

  return (
    <View>
      <LibraryIntro>{t("settings.usePages.library.instructions.intro")}</LibraryIntro>

      <LibraryRowHeader label={t("settings.usePages.library.instructions.shared")} />
      <SettingsCard>
        {view.sets.map((set) => (
          <SetRow
            key={set.id}
            view={set}
            disabled={disabled}
            onEdit={openSet}
            onActivate={activate}
          />
        ))}
      </SettingsCard>
      <View style={styles.footerActions}>
        <Button variant="outline" onPress={openNewSet} disabled={disabled}>
          {t("settings.usePages.library.instructions.newSet")}
        </Button>
      </View>

      <View style={styles.agentsHeader}>
        <LibraryRowHeader
          label={t("settings.usePages.library.instructions.agentsHeader")}
          note={t("settings.usePages.library.instructions.agentsHint")}
        />
      </View>
      <SettingsCard>
        {view.agents.map((agent) => (
          <AgentRow
            key={agent.agent}
            view={agent}
            disabled={disabled}
            onToggle={toggleAgent}
            onEdit={openAgentEditor}
          />
        ))}
      </SettingsCard>

      {agentEditor ? (
        <AgentInstructionsSheet
          key={agentEditor.agent}
          view={agentEditor}
          client={client}
          onClose={closeAgentEditor}
          onLibrary={onLibrary}
          onSaved={onSaved}
          onError={onError}
        />
      ) : null}

      {editing ? (
        <SetEditor
          key={editing.kind === "new" ? "new" : editing.set.id}
          title={
            editing.kind === "new"
              ? t("settings.usePages.library.instructions.newSetTitle")
              : t("settings.usePages.library.instructions.editSetTitle")
          }
          initialName={
            editing.kind === "new"
              ? ""
              : editing.set.name ||
                (editing.set.id === "default"
                  ? t("settings.usePages.library.instructions.defaultSet")
                  : "")
          }
          initialText={editing.kind === "new" ? "" : editing.set.text}
          onClose={closeEditor}
          onSave={saveEditor}
        />
      ) : null}
    </View>
  );
}

function SetEditor({
  title,
  initialName,
  initialText,
  onClose,
  onSave,
}: {
  title: string;
  initialName: string;
  initialText: string;
  onClose: () => void;
  onSave: (name: string, text: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [text, setText] = useState(initialText);

  const save = useCallback(() => onSave(name.trim(), text), [name, onSave, text]);

  return (
    <LibraryEditorSheet
      visible
      title={title}
      onClose={onClose}
      onSave={save}
      saveDisabled={name.trim().length === 0}
    >
      <Field label={t("settings.usePages.library.instructions.name")}>
        <FormTextInput
          initialValue={initialName}
          resetKey="open"
          onChangeText={setName}
          placeholder={t("settings.usePages.library.instructions.namePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("settings.usePages.library.instructions.name")}
        />
      </Field>
      <Field label={t("settings.usePages.library.instructions.text")}>
        <FormTextInput
          initialValue={initialText}
          resetKey="open"
          onChangeText={setText}
          placeholder={t("settings.usePages.library.instructions.textPlaceholder")}
          multiline
          style={styles.textArea}
          accessibilityLabel={t("settings.usePages.library.instructions.text")}
        />
      </Field>
    </LibraryEditorSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  grow: {
    flex: 1,
  },
  agentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  path: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  footerActions: {
    marginTop: theme.spacing[3],
    marginLeft: theme.spacing[1],
    alignItems: "flex-start",
  },
  agentsHeader: {
    marginTop: theme.spacing[6],
  },
  textArea: {
    minHeight: 180,
    textAlignVertical: "top",
  },
}));
