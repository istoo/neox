// FILE: LibraryInstructionsPanel.tsx
// Purpose: Settings → Instructions. Shared instruction sets and the per-agent
//   toggles backed by Neox's Library.
// Layer: Settings UI components

import type {
  LibraryAgentInstructionsView,
  LibraryInstructionSetView,
  LibraryMutationResult,
} from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { applyLibraryMutation, useNeolixLibrary } from "~/lib/neolixLibraryQuery";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { useTranslation } from "~/i18n";
import {
  LibraryAddButton,
  LibraryEditorDialog,
  LibraryEmptyState,
  LibraryErrorState,
  LibraryField,
} from "./LibraryShared";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

type EditorTarget = { kind: "new" } | { kind: "edit"; set: LibraryInstructionSetView };

function slugForSet(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return /^[a-z0-9]/.test(slug) ? slug : `set-${Date.now().toString(36)}`;
}

export function LibraryInstructionsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const libraryQuery = useNeolixLibrary();
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [agentEditor, setAgentEditor] = useState<LibraryAgentInstructionsView | null>(null);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [agentText, setAgentText] = useState("");

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

  const view = library.instructions;
  const openNew = () => {
    setEditing({ kind: "new" });
    setName("");
    setText("");
  };
  const openSet = (set: LibraryInstructionSetView) => {
    setEditing({ kind: "edit", set });
    setName(
      set.name || (set.id === "default" ? t("settings:library_instructions_defaultSet") : ""),
    );
    setText(set.text);
  };
  const openAgent = (row: LibraryAgentInstructionsView) => {
    setAgentEditor(row);
    setAgentText(row.extra);
  };

  const saveSet = async () => {
    if (!editing) return;
    const trimmedName = name.trim();
    let saved = false;
    if (editing.kind === "new") {
      const id = slugForSet(trimmedName);
      saved = await apply(() =>
        neolixLibraryApi.saveInstructions({
          create: { id, name: trimmedName },
          texts: { [id]: text },
        }),
      );
    } else {
      const { set } = editing;
      const currentName =
        set.name || (set.id === "default" ? t("settings:library_instructions_defaultSet") : "");
      saved = await apply(() =>
        neolixLibraryApi.saveInstructions({
          texts: { [set.id]: text },
          ...(trimmedName !== currentName ? { rename: { id: set.id, name: trimmedName } } : {}),
        }),
      );
    }
    if (saved) setEditing(null);
  };

  const saveAgent = async () => {
    if (!agentEditor) return;
    const saved = await apply(() =>
      neolixLibraryApi.saveInstructions({ extra: { [agentEditor.agent]: agentText } }),
    );
    if (saved) setAgentEditor(null);
  };

  const runAgentAction = async (change: { importOwn?: string[]; rewrite?: string[] }) => {
    if (!agentEditor) return;
    const saved = await apply(() => neolixLibraryApi.saveInstructions(change));
    if (saved) setAgentEditor(null);
  };

  const toggleAgent = (row: LibraryAgentInstructionsView) => {
    const agents = view.agents.filter((entry) => entry.on).map((entry) => entry.agent);
    const next = agents.includes(row.agent)
      ? agents.filter((entry) => entry !== row.agent)
      : [...agents, row.agent];
    void apply(() => neolixLibraryApi.saveInstructions({ agents: next }));
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="settings:library_instructions_shared">
        {view.sets.length === 0 ? (
          <LibraryEmptyState
            title={t("settings:library_instructions_emptyTitle")}
            description={t("settings:library_instructions_emptyText")}
            actionLabel={t("settings:library_add")}
            onAction={openNew}
          />
        ) : (
          view.sets.map((set) => {
            const displayName =
              set.id === "default" && set.name.length === 0
                ? t("settings:library_instructions_defaultSet")
                : set.name;
            const preview =
              set.text.trim().length === 0
                ? t("settings:library_instructions_emptySet")
                : (set.text.trim().split("\n")[0] ?? "");
            return (
              <SettingsRow
                key={set.id}
                title={displayName}
                description={preview}
                onClick={() => openSet(set)}
                status={set.active ? t("settings:library_instructions_inUse") : undefined}
                control={
                  set.active ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(event) => {
                        event.stopPropagation();
                        void apply(() => neolixLibraryApi.saveInstructions({ activate: set.id }));
                      }}
                    >
                      {t("settings:library_instructions_use")}
                    </Button>
                  )
                }
              />
            );
          })
        )}
      </SettingsSection>
      {view.sets.length > 0 ? (
        <LibraryAddButton label={t("settings:library_add")} onClick={openNew} />
      ) : null}

      <SettingsSectionShell
        title="settings:library_instructions_agents"
        action={
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              void apply(async () => {
                const result = await neolixLibraryApi.sync();
                return result;
              })
            }
          >
            {t("settings:library_sync")}
          </Button>
        }
      >
        <SettingsCard>
          {view.agents.map((row) => (
            <SettingsRow
              key={row.agent}
              title={row.name}
              description={row.path}
              onClick={() => openAgent(row)}
              status={
                row.edited
                  ? t("settings:library_instructions_edited")
                  : row.own > 0
                    ? t("settings:library_instructions_ownLines", { count: row.own })
                    : row.override
                      ? t("settings:library_instructions_override", { path: row.override })
                      : undefined
              }
              control={
                <Switch
                  checked={row.on}
                  onCheckedChange={() => toggleAgent(row)}
                  aria-label={row.name}
                />
              }
            />
          ))}
        </SettingsCard>
      </SettingsSectionShell>

      <LibraryEditorDialog
        open={editing !== null}
        title={
          editing?.kind === "new"
            ? t("settings:library_instructions_newSetTitle")
            : t("settings:library_instructions_editSetTitle")
        }
        saveDisabled={name.trim().length === 0}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        onSave={() => void saveSet()}
      >
        <LibraryField label={t("settings:library_instructions_name")}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </LibraryField>
        <LibraryField label={t("settings:library_instructions_text")}>
          <Textarea
            value={text}
            className="min-h-48 resize-y font-mono text-ui-sm"
            onChange={(event) => setText(event.target.value)}
          />
        </LibraryField>
      </LibraryEditorDialog>

      <LibraryEditorDialog
        open={agentEditor !== null}
        title={
          agentEditor
            ? t("settings:library_instructions_editAgentTitle", { agent: agentEditor.name })
            : ""
        }
        description={t("settings:library_instructions_editAgentHint")}
        onOpenChange={(open) => (open ? undefined : setAgentEditor(null))}
        onSave={() => void saveAgent()}
      >
        <LibraryField label={t("settings:library_instructions_agentExtra")}>
          <Textarea
            value={agentText}
            className="min-h-40 resize-y font-mono text-ui-sm"
            onChange={(event) => setAgentText(event.target.value)}
          />
        </LibraryField>
        {agentEditor?.override ? (
          <p className="text-ui-sm text-warning">
            {t("settings:library_instructions_overrideWarning", {
              path: agentEditor.override,
            })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              agentEditor ? void runAgentAction({ importOwn: [agentEditor.agent] }) : undefined
            }
          >
            {t("settings:library_instructions_moveOwn")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              agentEditor ? void runAgentAction({ rewrite: [agentEditor.agent] }) : undefined
            }
          >
            {t("settings:library_instructions_rewrite")}
          </Button>
        </div>
      </LibraryEditorDialog>
    </div>
  );
}
