import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LibraryHook } from "@neolix/protocol/library";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { AgentChips, LibraryEmpty, LibraryIntro, LibraryRowHeader } from "./library-ui";
import { LibraryEditorSheet } from "./library-editor";
import type { LibraryTabProps } from "./types";

const EVENTS = ["turn-end", "after-tool", "before-tool", "prompt", "session-start"] as const;
const MATCHERS = ["any", "shell", "edit"] as const;

type HookEvent = (typeof EVENTS)[number];
type HookMatcher = (typeof MATCHERS)[number];

function ChoiceChip<T extends string>({
  option,
  selected,
  onChange,
}: {
  option: { value: T; label: string };
  selected: boolean;
  onChange: (value: T) => void;
}) {
  const press = useCallback(() => onChange(option.value), [onChange, option.value]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const style = useMemo(() => [styles.choice, selected && styles.choiceSelected], [selected]);
  const labelStyle = useMemo(
    () => [styles.choiceLabel, selected && styles.choiceLabelSelected],
    [selected],
  );
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={press}
      style={style}
    >
      <Text style={labelStyle}>{option.label}</Text>
    </PressHighlight>
  );
}

function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => (
        <ChoiceChip
          key={option.value}
          option={option}
          selected={option.value === value}
          onChange={onChange}
        />
      ))}
    </View>
  );
}

function matcherOf(hook: LibraryHook): HookMatcher {
  if (hook.matcher === "shell" || hook.matcher === "edit") {
    return hook.matcher;
  }
  return "any";
}

function HookRow({
  hook,
  agents,
  disabled,
  onOpen,
  onToggleAgent,
}: {
  hook: LibraryHook;
  agents: { id: string; name: string }[];
  disabled: boolean;
  onOpen: (hook: LibraryHook) => void;
  onToggleAgent: (hook: LibraryHook, agent: string) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(hook), [hook, onOpen]);
  const toggle = useCallback((agent: string) => onToggleAgent(hook, agent), [hook, onToggleAgent]);
  return (
    <View style={settingsStyles.row}>
      <View style={[settingsStyles.rowContent, styles.rowBody]}>
        <PressHighlight onPress={disabled ? undefined : open} style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>{hook.name}</Text>
          <Text style={settingsStyles.rowHint}>
            {t(`settings.usePages.library.hooks.events.${hook.event}`)}
          </Text>
          <Text style={styles.mono} numberOfLines={1}>
            {hook.command}
          </Text>
        </PressHighlight>
        <AgentChips agents={agents} selected={hook.agents} disabled={disabled} onToggle={toggle} />
      </View>
    </View>
  );
}

export function HooksTab({
  library,
  client,
  onLibrary,
  onSaved,
  onError,
  disabled,
}: LibraryTabProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<{ hook: LibraryHook | null } | null>(null);

  const agents = useMemo(
    () => library.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [library.agents],
  );

  const toggleAgent = useCallback(
    (hook: LibraryHook, agent: string) => {
      const next = hook.agents.includes(agent)
        ? hook.agents.filter((entry) => entry !== agent)
        : [...hook.agents, agent];
      void (async () => {
        try {
          const result = await client.setLibraryHookAgents(hook.name, next);
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
    async (input: { oldName: string | null; hook: LibraryHook }) => {
      const result = await client.saveLibraryHook(
        input.hook,
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
        message: name,
        confirmLabel: t("settings.usePages.library.common.remove"),
        cancelLabel: t("settings.usePages.library.common.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const result = await client.removeLibraryHook(name);
        onLibrary(result.library);
        onSaved(result.result);
        setEditing(null);
      } catch (error) {
        onError(error);
      }
    },
    [client, onError, onLibrary, onSaved, t],
  );

  const openNewHook = useCallback(() => setEditing({ hook: null }), []);
  const openHook = useCallback((hook: LibraryHook) => setEditing({ hook }), []);
  const closeEditor = useCallback(() => setEditing(null), []);

  return (
    <View>
      <LibraryIntro>{t("settings.usePages.library.hooks.intro")}</LibraryIntro>
      <LibraryRowHeader label={t("settings.usePages.library.tabs.hooks")} />
      {library.hooks.length === 0 ? (
        <SettingsCard>
          <LibraryEmpty
            title={t("settings.usePages.library.hooks.emptyTitle")}
            text={t("settings.usePages.library.hooks.emptyText")}
            actionLabel={t("settings.usePages.library.hooks.add")}
            onAction={openNewHook}
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {library.hooks.map((hook) => (
            <HookRow
              key={hook.name}
              hook={hook}
              agents={agents}
              disabled={disabled}
              onOpen={openHook}
              onToggleAgent={toggleAgent}
            />
          ))}
        </SettingsCard>
      )}
      {library.hooks.length > 0 ? (
        <View style={styles.footer}>
          <Button variant="outline" onPress={openNewHook} disabled={disabled}>
            {t("settings.usePages.library.hooks.add")}
          </Button>
        </View>
      ) : null}

      {editing ? (
        <HookEditor
          key={editing.hook?.name ?? "new"}
          hook={editing.hook}
          agents={agents}
          onClose={closeEditor}
          onSave={save}
          onRemove={remove}
        />
      ) : null}
    </View>
  );
}

function isToolEvent(event: HookEvent): boolean {
  return event === "after-tool" || event === "before-tool";
}

function hookBody(
  event: HookEvent,
  matcher: HookMatcher,
  description: string,
  timeout: string,
): Partial<LibraryHook> {
  const body: Partial<LibraryHook> = {};
  if (description.trim().length > 0) {
    body.description = description;
  }
  if (isToolEvent(event) && matcher !== "any") {
    body.matcher = matcher;
  }
  const seconds = timeout.trim().length > 0 ? Number.parseInt(timeout, 10) : undefined;
  if (seconds && Number.isFinite(seconds)) {
    body.timeout = seconds;
  }
  return body;
}

function HookTimingFields({
  event,
  matcher,
  eventOptions,
  matcherOptions,
  onEvent,
  onMatcher,
}: {
  event: HookEvent;
  matcher: HookMatcher;
  eventOptions: { value: HookEvent; label: string }[];
  matcherOptions: { value: HookMatcher; label: string }[];
  onEvent: (event: HookEvent) => void;
  onMatcher: (matcher: HookMatcher) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("settings.usePages.library.hooks.event")}>
        <ChoiceChips options={eventOptions} value={event} onChange={onEvent} />
      </Field>
      {isToolEvent(event) ? (
        <Field label={t("settings.usePages.library.hooks.matcher")}>
          <ChoiceChips options={matcherOptions} value={matcher} onChange={onMatcher} />
        </Field>
      ) : null}
    </>
  );
}

function HookEditor({
  hook,
  agents,
  onClose,
  onSave,
  onRemove,
}: {
  hook: LibraryHook | null;
  agents: { id: string; name: string }[];
  onClose: () => void;
  onSave: (input: { oldName: string | null; hook: LibraryHook }) => Promise<void>;
  onRemove: (name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(hook?.name ?? "");
  const [description, setDescription] = useState(hook?.description ?? "");
  const [event, setEvent] = useState<HookEvent>((hook?.event as HookEvent) ?? "turn-end");
  const [matcher, setMatcher] = useState<HookMatcher>(hook ? matcherOf(hook) : "any");
  const [command, setCommand] = useState(hook?.command ?? "");
  const [timeout, setTimeoutValue] = useState(hook?.timeout ? String(hook.timeout) : "");
  const [selected, setSelected] = useState<string[]>(hook?.agents ?? []);

  const eventOptions = useMemo(
    () =>
      EVENTS.map((value) => ({
        value,
        label: t(`settings.usePages.library.hooks.events.${value}`),
      })),
    [t],
  );
  const matcherOptions = useMemo(
    () =>
      MATCHERS.map((value) => ({
        value,
        label: t(`settings.usePages.library.hooks.matchers.${value}`),
      })),
    [t],
  );

  const toggleAgent = useCallback((agent: string) => {
    setSelected((current) =>
      current.includes(agent) ? current.filter((entry) => entry !== agent) : [...current, agent],
    );
  }, []);

  const save = useCallback(
    () =>
      onSave({
        oldName: hook?.name ?? null,
        hook: {
          name,
          event,
          command,
          agents: selected,
          ...hookBody(event, matcher, description, timeout),
        },
      }),
    [command, description, event, hook?.name, matcher, name, onSave, selected, timeout],
  );

  const removeCurrent = useCallback(() => {
    if (hook) {
      void onRemove(hook.name);
    }
  }, [hook, onRemove]);

  return (
    <LibraryEditorSheet
      visible
      title={
        hook
          ? t("settings.usePages.library.hooks.editorEdit")
          : t("settings.usePages.library.hooks.editorAdd")
      }
      onClose={onClose}
      onSave={save}
      removeLabel={hook ? t("settings.usePages.library.common.remove") : undefined}
      onRemove={hook ? removeCurrent : undefined}
      saveDisabled={name.trim().length === 0 || command.trim().length === 0}
    >
      <Field label={t("settings.usePages.library.hooks.name")}>
        <FormTextInput
          initialValue={name}
          onChangeText={setName}
          placeholder={t("settings.usePages.library.hooks.namePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("settings.usePages.library.hooks.description")}>
        <FormTextInput
          initialValue={description}
          onChangeText={setDescription}
          placeholder={t("settings.usePages.library.hooks.descriptionPlaceholder")}
        />
      </Field>
      <HookTimingFields
        event={event}
        matcher={matcher}
        eventOptions={eventOptions}
        matcherOptions={matcherOptions}
        onEvent={setEvent}
        onMatcher={setMatcher}
      />
      <Field label={t("settings.usePages.library.hooks.command")}>
        <FormTextInput
          initialValue={command}
          onChangeText={setCommand}
          placeholder={t("settings.usePages.library.hooks.commandPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("settings.usePages.library.hooks.timeout")}>
        <FormTextInput
          initialValue={timeout}
          onChangeText={setTimeoutValue}
          placeholder={t("settings.usePages.library.hooks.timeoutPlaceholder")}
          keyboardType="number-pad"
        />
      </Field>
      <Field
        label={t("settings.usePages.library.hooks.agents")}
        hint={t("settings.usePages.library.hooks.agentsHint")}
      >
        <AgentChips agents={agents} selected={selected} onToggle={toggleAgent} />
      </Field>
    </LibraryEditorSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowBody: {
    gap: theme.spacing[2],
  },
  rowText: {
    flex: 1,
  },
  mono: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    marginTop: 2,
  },
  footer: {
    marginTop: theme.spacing[3],
    marginLeft: theme.spacing[1],
    alignItems: "flex-start",
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
