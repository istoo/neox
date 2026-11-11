// FILE: LibrarySubagentsPanel.tsx
// Purpose: Settings → Subagents. Named prompts stored by Neox's Library.
// Layer: Settings UI components

import type { LibraryMutationResult, LibrarySubagent } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
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

function NameChips(props: {
  options: ReadonlyArray<string>;
  selected: ReadonlyArray<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.options.map((option) => {
        const on = props.selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            aria-pressed={on}
            onClick={() => props.onToggle(option)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-ui-sm",
              on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-secondary text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function toggleValue(
  setter: (update: (current: string[]) => string[]) => void,
  value: string,
): void {
  setter((current) =>
    current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
  );
}

export function LibrarySubagentsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const libraryQuery = useNeolixLibrary();
  const [editing, setEditing] = useState<LibrarySubagent | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [servers, setServers] = useState<string[]>([]);
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
    setPrompt("");
    setSkills([]);
    setServers([]);
    setAgents([]);
  };
  const openSubagent = (subagent: LibrarySubagent) => {
    setEditing(subagent);
    setName(subagent.name);
    setDescription(subagent.description);
    setPrompt(subagent.prompt);
    setSkills([...(subagent.skills ?? [])]);
    setServers([...(subagent.mcp ?? [])]);
    setAgents([...subagent.agents]);
  };

  const save = async () => {
    const subagent: LibrarySubagent = {
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      agents,
      skills,
      mcp: servers,
    };
    const saved = await apply(() =>
      neolixLibraryApi.saveSubagent({
        subagent,
        ...(editing?.name ? { oldName: editing.name } : {}),
      }),
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
    const saved = await apply(() => neolixLibraryApi.removeSubagent({ name: editing.name }));
    if (saved) setEditing(undefined);
  };

  const toggleAgent = (subagent: LibrarySubagent, agent: string) => {
    const next = subagent.agents.includes(agent)
      ? subagent.agents.filter((entry) => entry !== agent)
      : [...subagent.agents, agent];
    void apply(() => neolixLibraryApi.setSubagentAgents({ name: subagent.name, agents: next }));
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="settings:library_subagents_title">
        {library.subagents.length === 0 ? (
          <LibraryEmptyState
            title={t("settings:library_subagents_emptyTitle")}
            description={t("settings:library_subagents_emptyText")}
            actionLabel={t("settings:library_add")}
            onAction={openNew}
          />
        ) : (
          library.subagents.map((subagent) => (
            <SettingsRow
              key={subagent.name}
              title={subagent.name}
              description={subagent.description}
              onClick={() => openSubagent(subagent)}
              control={
                <LibraryAgentChips
                  agents={library.agents}
                  selected={subagent.agents}
                  onToggle={(agent) => toggleAgent(subagent, agent)}
                />
              }
            />
          ))
        )}
      </SettingsSection>
      {library.subagents.length > 0 ? (
        <LibraryAddButton label={t("settings:library_add")} onClick={openNew} />
      ) : null}

      <LibraryEditorDialog
        open={editing !== undefined}
        title={
          editing
            ? t("settings:library_subagents_editTitle")
            : t("settings:library_subagents_newTitle")
        }
        saveDisabled={
          name.trim().length === 0 || description.trim().length === 0 || prompt.trim().length === 0
        }
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
        <LibraryField label={t("settings:library_subagents_prompt")}>
          <Textarea
            value={prompt}
            className="min-h-40 resize-y font-mono text-ui-sm"
            onChange={(event) => setPrompt(event.target.value)}
          />
        </LibraryField>
        {library.skills.length > 0 ? (
          <LibraryField label={t("settings:library_subagents_skills")}>
            <NameChips
              options={library.skills.map((skill) => skill.name)}
              selected={skills}
              onToggle={(value) => toggleValue(setSkills, value)}
            />
          </LibraryField>
        ) : null}
        {library.mcp.length > 0 ? (
          <LibraryField label={t("settings:library_subagents_mcp")}>
            <NameChips
              options={library.mcp.map((server) => server.name)}
              selected={servers}
              onToggle={(value) => toggleValue(setServers, value)}
            />
          </LibraryField>
        ) : null}
        <LibraryField label={t("settings:library_agents")}>
          <LibraryAgentChips
            agents={library.agents}
            selected={agents}
            onToggle={(agent) => toggleValue(setAgents, agent)}
          />
        </LibraryField>
      </LibraryEditorDialog>
    </div>
  );
}
