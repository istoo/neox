import { useTranslation } from "~/i18n";
// FILE: EnvironmentActionsSection.tsx
// Purpose: Environment panel section that lists the active project's actions (scripts).
//          This is where the first action gets created now that the chat top bar's
//          "Add action" button became the New thread button: the header only runs actions,
//          this section owns their full list plus add/edit/delete.
// Layer: Environment panel section

import type { ProjectScript, ResolvedKeybindingsConfig } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { IconButton } from "~/components/ui/icon-button";
import { PlusIcon, SettingsIcon } from "~/lib/icons";
import { isServiceProjectScript, projectScriptPortText } from "~/projectScripts";

import { Textarea } from "../../ui/textarea";

import {
  ProjectActionDialog,
  ScriptIcon,
  type NewProjectScriptInput,
} from "../ProjectActionDialog";
import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentCollapsibleSection,
} from "./EnvironmentRow";

export interface EnvironmentActionsSectionProps {
  readonly scripts: readonly ProjectScript[];
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly onRunScript: (script: ProjectScript) => void;
  /** Why actions cannot run yet; undefined when they are available. */
  readonly runDisabledReason?: string | undefined;
  readonly onAddScript: (input: NewProjectScriptInput) => Promise<void> | void;
  readonly onUpdateScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void> | void;
  readonly onDeleteScript: (scriptId: string) => Promise<void> | void;
  /** `neox.json` worktree lifecycle commands; omitted on non-project threads. */
  readonly worktree?: { readonly setup: string; readonly teardown: string };
  readonly onSaveWorktree?: (input: {
    readonly setup: string;
    readonly teardown: string;
  }) => Promise<void> | void;
}

export function EnvironmentActionsSection({
  scripts,
  keybindings,
  onRunScript,
  runDisabledReason,
  onAddScript,
  onUpdateScript,
  onDeleteScript,
  worktree,
  onSaveWorktree,
}: EnvironmentActionsSectionProps) {
  const { t } = useTranslation();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingScriptId, setEditingScriptId] = useState<string | null>(null);
  const editingScript = useMemo(
    () =>
      editingScriptId ? (scripts.find((script) => script.id === editingScriptId) ?? null) : null,
    [editingScriptId, scripts],
  );

  const openAddDialog = () => {
    setEditingScriptId(null);
    setDialogOpen(true);
  };
  const openEditDialog = (script: ProjectScript) => {
    setEditingScriptId(script.id);
    setDialogOpen(true);
  };
  const handleSave = useCallback(
    async (input: NewProjectScriptInput) => {
      if (editingScriptId) {
        await onUpdateScript(editingScriptId, input);
        return;
      }
      await onAddScript(input);
    },
    [editingScriptId, onAddScript, onUpdateScript],
  );

  return (
    <>
      <EnvironmentSectionDivider />
      {/* Keep action management out of the panel until explicitly expanded. */}
      <EnvironmentCollapsibleSection label={t("workspace:actions")} defaultOpen={false}>
        <div className="flex justify-end pr-2">
          <IconButton
            label={t("workspace:scripts_addActionTitle")}
            tooltip={t("workspace:scripts_addActionTitle")}
            onClick={openAddDialog}
          >
            <PlusIcon className="size-3.5" />
          </IconButton>
        </div>
        {scripts.length === 0 ? (
          <p className="px-2 pb-1 text-ui-sm leading-snug text-[var(--color-text-foreground-secondary)]">
            {t("workspace:noProjectActions")}
          </p>
        ) : (
          scripts.map((script) => (
            <div key={script.id} className="group/action relative">
              <EnvironmentRow
                icon={<ScriptIcon icon={script.icon} className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
                label={<span className="truncate">{script.name}</span>}
                trailing={
                  <>
                    {script.runOnWorktreeCreate ? (
                      <span className="text-[var(--color-text-foreground-secondary)]">
                        {t("workspace:projectActionSetup")}
                      </span>
                    ) : null}
                    {isServiceProjectScript(script) ? (
                      <span className="text-[var(--color-text-foreground-secondary)]">
                        {projectScriptPortText(script)
                          ? t("workspace:scripts_serviceWithPort", {
                              port: projectScriptPortText(script),
                            })
                          : t("workspace:scripts_service")}
                      </span>
                    ) : null}
                    <span
                      aria-hidden
                      className="hidden w-7 group-focus-within/action:block group-hover/action:block sm:w-6"
                    />
                  </>
                }
                aria-label={t("workspace:run", { value0: script.name })}
                disabled={runDisabledReason !== undefined}
                title={runDisabledReason}
                onClick={() => onRunScript(script)}
              />
              <IconButton
                label={t("workspace:edit", { value0: script.name })}
                tooltip={t("workspace:editProjectAction")}
                className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity group-hover/action:opacity-100 focus-visible:opacity-100"
                onClick={() => openEditDialog(script)}
              >
                <SettingsIcon className="size-3.5" />
              </IconButton>
            </div>
          ))
        )}
      </EnvironmentCollapsibleSection>

      <ProjectActionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        scripts={scripts}
        keybindings={keybindings}
        editingScript={editingScript}
        onSave={handleSave}
        onDelete={onDeleteScript}
      />
      {worktree && onSaveWorktree ? (
        <WorktreeLifecycleSection worktree={worktree} onSave={onSaveWorktree} />
      ) : null}
    </>
  );
}

/**
 * Setup runs after a worktree is created; teardown runs before it is removed. Both are
 * passed straight through to `neox.json`, matching the app's project settings screen.
 */
function WorktreeLifecycleSection(props: {
  worktree: { readonly setup: string; readonly teardown: string };
  onSave: (input: { readonly setup: string; readonly teardown: string }) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState(props.worktree.setup);
  const [teardown, setTeardown] = useState(props.worktree.teardown);
  const [saving, setSaving] = useState(false);

  // The project shell re-reads after a save; follow it without clobbering an in-progress edit
  // when the incoming values are the ones this form just submitted.
  useEffect(() => {
    setSetup(props.worktree.setup);
    setTeardown(props.worktree.teardown);
  }, [props.worktree.setup, props.worktree.teardown]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await props.onSave({ setup, teardown });
    } finally {
      setSaving(false);
    }
  }, [props.onSave, setup, teardown]);

  return (
    <>
      <EnvironmentSectionDivider />
      <EnvironmentCollapsibleSection
        label={t("workspace:projectWorktreeLifecycle")}
        defaultOpen={false}
      >
        <div className="flex flex-col gap-2 px-2 pb-2">
          <label className="flex flex-col gap-1 text-ui-sm leading-snug">
            <span className="text-[var(--color-text-foreground-secondary)]">
              {t("workspace:worktreeSetupCommand")}
            </span>
            <Textarea
              aria-label={t("workspace:worktreeSetupCommand")}
              placeholder="npm install"
              value={setup}
              onChange={(event) => setSetup(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-ui-sm leading-snug">
            <span className="text-[var(--color-text-foreground-secondary)]">
              {t("workspace:worktreeTeardownCommand")}
            </span>
            <Textarea
              aria-label={t("workspace:worktreeTeardownCommand")}
              placeholder="docker compose down"
              value={teardown}
              onChange={(event) => setTeardown(event.target.value)}
            />
          </label>
          <div className="flex justify-end">
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? t("workspace:savingProjectSetup") : t("workspace:saveProjectSetup")}
            </Button>
          </div>
        </div>
      </EnvironmentCollapsibleSection>
    </>
  );
}
