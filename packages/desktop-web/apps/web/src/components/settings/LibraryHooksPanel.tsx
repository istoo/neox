// FILE: LibraryHooksPanel.tsx
// Purpose: Settings → Hooks. Lifecycle hooks stored by Neox's Library.
// Layer: Settings UI components

import type { LibraryHook, LibraryMutationResult } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { applyLibraryMutation, useNeolixLibrary } from "~/lib/neolixLibraryQuery";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";
import {
  LibraryAddButton,
  LibraryAgentChips,
  LibraryEditorDialog,
  LibraryEmptyState,
  LibraryErrorState,
  LibraryField,
} from "./LibraryShared";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const EVENTS = ["turn-end", "after-tool", "before-tool", "prompt", "session-start"] as const;
const MATCHERS = ["any", "shell", "edit"] as const;

type HookEvent = (typeof EVENTS)[number];
type HookMatcher = (typeof MATCHERS)[number];

const EVENT_KEYS: Record<HookEvent, string> = {
  "turn-end": "settings:library_hook_event_turnEnd",
  "after-tool": "settings:library_hook_event_afterTool",
  "before-tool": "settings:library_hook_event_beforeTool",
  prompt: "settings:library_hook_event_prompt",
  "session-start": "settings:library_hook_event_sessionStart",
};

const MATCHER_KEYS: Record<HookMatcher, string> = {
  any: "settings:library_hook_matcher_any",
  shell: "settings:library_hook_matcher_shell",
  edit: "settings:library_hook_matcher_edit",
};

function isToolEvent(event: HookEvent): boolean {
  return event === "after-tool" || event === "before-tool";
}

function matcherOf(hook: LibraryHook): HookMatcher {
  return hook.matcher === "shell" || hook.matcher === "edit" ? hook.matcher : "any";
}

function ChoiceChips<T extends string>(props: {
  options: ReadonlyArray<T>;
  value: T;
  label: (value: T) => string;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === props.value}
          onClick={() => props.onChange(option)}
          className={cn(
            "rounded-full border px-2.5 py-1 text-ui-sm",
            option === props.value
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-border bg-secondary text-muted-foreground hover:text-foreground",
          )}
        >
          {props.label(option)}
        </button>
      ))}
    </div>
  );
}

export function LibraryHooksPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const libraryQuery = useNeolixLibrary();
  const [editing, setEditing] = useState<LibraryHook | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [event, setEvent] = useState<HookEvent>("turn-end");
  const [matcher, setMatcher] = useState<HookMatcher>("any");
  const [command, setCommand] = useState("");
  const [timeoutValue, setTimeoutValue] = useState("");
  const [agents, setAgents] = useState<string[]>([]);

  const apply = useCallback(
    async (run: () => Promise<LibraryMutationResult>) => {
      try {
        const result = await run();
        applyLibraryMutation(queryClient, result);
        toastManager.add({ type: "success", title: t("settings:library_saved") });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:library_saveFailed"),
          description: localizeLibraryError(error, t),
        });
        return false;
      }
    },
    [queryClient, t],
  );

  const library = libraryQuery.data?.library;
  if (libraryQuery.isLoading) {
    return <p className="text-ui text-muted-foreground">{t("settings:library_loading")}</p>;
  }
  if (libraryQuery.isError || !library) {
    return (
      <LibraryErrorState error={libraryQuery.error} fallback={t("settings:library_loadFailed")} />
    );
  }

  const openNew = () => {
    setEditing(null);
    setName("");
    setDescription("");
    setEvent("turn-end");
    setMatcher("any");
    setCommand("");
    setTimeoutValue("");
    setAgents([]);
  };
  const openHook = (hook: LibraryHook) => {
    setEditing(hook);
    setName(hook.name);
    setDescription(hook.description ?? "");
    setEvent(
      (EVENTS as readonly string[]).includes(hook.event) ? (hook.event as HookEvent) : "turn-end",
    );
    setMatcher(matcherOf(hook));
    setCommand(hook.command);
    setTimeoutValue(hook.timeout ? String(hook.timeout) : "");
    setAgents([...hook.agents]);
  };

  const save = async () => {
    const seconds = Number.parseInt(timeoutValue.trim(), 10);
    const hook: LibraryHook = {
      name: name.trim(),
      event,
      command: command.trim(),
      agents,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(isToolEvent(event) && matcher !== "any" ? { matcher } : {}),
      ...(Number.isFinite(seconds) && seconds > 0 ? { timeout: seconds } : {}),
    };
    const saved = await apply(() =>
      neolixLibraryApi.saveHook({ hook, ...(editing?.name ? { oldName: editing.name } : {}) }),
    );
    if (saved) setEditing(undefined);
  };

  const remove = async () => {
    if (!editing) return;
    const confirmed = await ensureNativeApi().dialogs.confirm(
      t("settings:library_removeConfirm", { name: editing.name }),
      { confirmLabel: t("common:delete"), destructive: true },
    );
    if (!confirmed) return;
    const saved = await apply(() => neolixLibraryApi.removeHook({ name: editing.name }));
    if (saved) setEditing(undefined);
  };

  const toggleAgent = (hook: LibraryHook, agent: string) => {
    const next = hook.agents.includes(agent)
      ? hook.agents.filter((entry) => entry !== agent)
      : [...hook.agents, agent];
    void apply(() => neolixLibraryApi.setHookAgents({ name: hook.name, agents: next }));
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="settings:library_hooks_title">
        {library.hooks.length === 0 ? (
          <LibraryEmptyState
            title={t("settings:library_hooks_emptyTitle")}
            description={t("settings:library_hooks_emptyText")}
            actionLabel={t("settings:library_add")}
            onAction={openNew}
          />
        ) : (
          library.hooks.map((hook) => (
            <SettingsRow
              key={hook.name}
              title={hook.name}
              description={t(EVENT_KEYS[hook.event as HookEvent] ?? "settings:library_hooks_title")}
              status={<code className="text-ui-sm text-muted-foreground">{hook.command}</code>}
              onClick={() => openHook(hook)}
              control={
                <LibraryAgentChips
                  agents={library.agents}
                  selected={hook.agents}
                  onToggle={(agent) => toggleAgent(hook, agent)}
                />
              }
            />
          ))
        )}
      </SettingsSection>
      {library.hooks.length > 0 ? (
        <LibraryAddButton label={t("settings:library_add")} onClick={openNew} />
      ) : null}

      <LibraryEditorDialog
        open={editing !== undefined}
        title={
          editing ? t("settings:library_hooks_editTitle") : t("settings:library_hooks_newTitle")
        }
        saveDisabled={name.trim().length === 0 || command.trim().length === 0}
        removeLabel={editing ? t("settings:library_remove") : undefined}
        onRemove={editing ? () => void remove() : undefined}
        onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
        onSave={() => void save()}
      >
        <LibraryField label={t("settings:library_name")}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </LibraryField>
        <LibraryField label={t("settings:library_description")}>
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </LibraryField>
        <LibraryField label={t("settings:library_hooks_event")}>
          <ChoiceChips
            options={EVENTS}
            value={event}
            label={(value) => t(EVENT_KEYS[value])}
            onChange={setEvent}
          />
        </LibraryField>
        {isToolEvent(event) ? (
          <LibraryField label={t("settings:library_hooks_matcher")}>
            <ChoiceChips
              options={MATCHERS}
              value={matcher}
              label={(value) => t(MATCHER_KEYS[value])}
              onChange={setMatcher}
            />
          </LibraryField>
        ) : null}
        <LibraryField label={t("settings:library_hooks_command")}>
          <Input value={command} onChange={(event) => setCommand(event.target.value)} />
        </LibraryField>
        <LibraryField label={t("settings:library_hooks_timeout")}>
          <Input
            inputMode="numeric"
            value={timeoutValue}
            onChange={(event) => setTimeoutValue(event.target.value)}
          />
        </LibraryField>
        <LibraryField label={t("settings:library_agents")}>
          <LibraryAgentChips
            agents={library.agents}
            selected={agents}
            onToggle={(agent) =>
              setAgents((current) =>
                current.includes(agent)
                  ? current.filter((entry) => entry !== agent)
                  : [...current, agent],
              )
            }
          />
        </LibraryField>
      </LibraryEditorDialog>
    </div>
  );
}
