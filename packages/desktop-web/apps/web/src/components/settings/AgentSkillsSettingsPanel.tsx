// FILE: AgentSkillsSettingsPanel.tsx
// Purpose: Settings › Host › Orchestration skills. One row decides whether the
//          host has Neolix's bundled skills installed, a gear opens the skill
//          picker, and Update appears when the installed copy trails the bundle.
// Layer: Settings panel

import type { AgentSkillSelection, AgentSkillsSaveResult } from "@synara/contracts";
import { useCallback, useState } from "react";

import { useAgentSkills } from "~/hooks/useAgentSkills";
import { useHostFeatures } from "~/hooks/useHostFeatures";
import { HOST_FEATURES } from "~/lib/hostFeatures.logic";
import { useTranslation } from "~/i18n";
import { SettingsIcon } from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { showConfirmDialogFallback } from "~/confirmDialogFallback";

import { HostUpdateNotice } from "../hosts/HostUpdateNotice";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  formatUpdateMessage,
  hasSelectedSkills,
  areSkillsInstalled,
  isSkillSelected,
  maintenanceOperations,
  needsSkillUpdate,
  toggleAllSelection,
  toggleSkillSelection,
} from "./agentSkills/agentSkills.logic";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const SKILLS_DOCS_URL = "https://github.com/istoo/neox/tree/main/public-docs/skills.md";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Electron routes through the native sheet; a browser gets the DOM fallback. */
async function confirmAction(
  message: string,
  options: { confirmLabel: string; destructive?: boolean },
): Promise<boolean> {
  const api = readNativeApi();
  try {
    return api
      ? await api.dialogs.confirm(message, options)
      : await showConfirmDialogFallback(message, options);
  } catch {
    return false;
  }
}

export function AgentSkillsSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const hostFeatures = useHostFeatures();
  // One gate: the panel never asks an older host for skill state it cannot report.
  const skillsAvailable = hostFeatures.isAvailable(HOST_FEATURES.skillManagement);
  const skills = useAgentSkills({ enabled: active && skillsAvailable });
  const { status, isWorking, reconcile, uninstall, saveSelection } = skills;
  const [choosing, setChoosing] = useState(false);

  const reportFailure = useCallback((title: string, error: unknown) => {
    toastManager.add({ type: "error", title, description: errorMessage(error) });
  }, []);

  const update = useCallback(async () => {
    if (isWorking) return;
    const confirmed = await confirmAction(
      [
        t("settings:agentSkills_updateTitle"),
        formatUpdateMessage(maintenanceOperations(status), t),
      ].join("\n"),
      { confirmLabel: t("settings:agentSkills_actions_update") },
    );
    if (!confirmed) return;
    try {
      await reconcile();
    } catch (error) {
      reportFailure(t("settings:agentSkills_updateFailed"), error);
    }
  }, [isWorking, reconcile, reportFailure, status, t]);

  const uninstallSkills = useCallback(async () => {
    if (isWorking) return;
    const confirmed = await confirmAction(
      [t("settings:agentSkills_uninstallTitle"), t("settings:agentSkills_uninstallMessage")].join(
        "\n",
      ),
      { confirmLabel: t("settings:agentSkills_actions_uninstall"), destructive: true },
    );
    if (!confirmed) return;
    try {
      await uninstall();
    } catch (error) {
      reportFailure(t("settings:agentSkills_uninstallFailed"), error);
    }
  }, [isWorking, reportFailure, t, uninstall]);

  const toggle = useCallback(
    (next: boolean) => {
      if (next) {
        void reconcile().catch((error) =>
          reportFailure(t("settings:agentSkills_updateFailed"), error),
        );
      } else {
        void uninstallSkills();
      }
    },
    [reconcile, reportFailure, t, uninstallSkills],
  );

  const confirmRemovals = useCallback(
    (removals: readonly string[]) =>
      confirmAction(
        [
          t("settings:agentSkills_removeTitle"),
          t("settings:agentSkills_removeMessage", { skills: removals.join(", ") }),
        ].join("\n"),
        { confirmLabel: t("settings:agentSkills_actions_remove"), destructive: true },
      ),
    [t],
  );

  if (!active) return null;

  const docsLink = (
    <a
      className="text-ui-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      href={SKILLS_DOCS_URL}
      target="_blank"
      rel="noreferrer"
    >
      {t("settings:agentSkills_docs")}
    </a>
  );

  if (hostFeatures.featureStatus(HOST_FEATURES.skillManagement) === "unavailable") {
    return (
      <SettingsSectionShell title="settings:agentSkills_sectionTitle" action={docsLink}>
        <HostUpdateNotice />
      </SettingsSectionShell>
    );
  }

  const installed = areSkillsInstalled(status);
  const updateAvailable = needsSkillUpdate(status);

  let body;
  if (skills.error !== null && status === null) {
    body = (
      <SettingsEmptyState tone="destructive">
        <span>{t("settings:agentSkills_statusFailed")}</span>
        <Button size="xs" variant="outline" className="ml-2" onClick={() => void skills.refresh()}>
          {t("settings:host_refresh")}
        </Button>
      </SettingsEmptyState>
    );
  } else if (skills.isLoading && status === null) {
    body = <SettingsEmptyState layout="status">{t("settings:host_loading")}</SettingsEmptyState>;
  } else {
    body = (
      <SettingsCard>
        <SettingsRow
          id="setting-host-agent-skills"
          title={t("settings:agentSkills_sectionTitle")}
          description={
            updateAvailable
              ? t("settings:agentSkills_updateAvailable")
              : t("settings:agentSkills_description")
          }
          control={
            <>
              {updateAvailable ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={isWorking}
                  onClick={() => void update()}
                >
                  {isWorking
                    ? t("settings:agentSkills_actions_working")
                    : t("settings:agentSkills_actions_update")}
                </Button>
              ) : null}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("settings:agentSkills_choose")}
                disabled={status === null || isWorking}
                onClick={() => setChoosing(true)}
              >
                <SettingsIcon className="size-4" />
              </Button>
              <Switch
                checked={installed}
                disabled={
                  status === null || isWorking || (!installed && !hasSelectedSkills(status))
                }
                onCheckedChange={(checked) => toggle(checked === true)}
                aria-label={t("settings:agentSkills_sectionTitle")}
              />
            </>
          }
        />
      </SettingsCard>
    );
  }

  return (
    <SettingsSectionShell title="settings:agentSkills_sectionTitle" action={docsLink}>
      {body}
      {choosing && status !== null ? (
        <SkillSelectionDialog
          available={status.available}
          selection={status.selection}
          isSaving={isWorking}
          onSave={saveSelection}
          onConfirmRemovals={confirmRemovals}
          onClose={() => setChoosing(false)}
        />
      ) : null}
    </SettingsSectionShell>
  );
}

/**
 * Draft form state only. The saved selection, the convergence across agent
 * skill directories, and the resulting status all belong to the host.
 */
function SkillSelectionDialog({
  available,
  selection,
  isSaving,
  onSave,
  onConfirmRemovals,
  onClose,
}: {
  readonly available: readonly string[];
  readonly selection: AgentSkillSelection;
  readonly isSaving: boolean;
  readonly onSave: (
    selection: AgentSkillSelection,
    confirmedRemovals?: readonly string[],
  ) => Promise<AgentSkillsSaveResult>;
  readonly onConfirmRemovals: (removals: readonly string[]) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<AgentSkillSelection>(selection);
  const [saveError, setSaveError] = useState<string | null>(null);
  const allSkills = draft.mode === "all";

  const handleSave = useCallback(async () => {
    setSaveError(null);
    try {
      // The host refuses a save that would delete directories it was not told
      // about, and answers with the names it found when it looked. Asking it is
      // the only way the question and the deletion cannot drift apart.
      const attempt = await onSave(draft);
      if (attempt.confirmationRequired) {
        const confirmed = await onConfirmRemovals(attempt.confirmationRequired.removals);
        if (!confirmed) return;
        const retry = await onSave(draft, attempt.confirmationRequired.removals);
        // Something changed the directories again while the dialog was up.
        // Ask about the new list rather than deleting it unannounced.
        if (retry.confirmationRequired) {
          setSaveError(t("settings:agentSkills_saveFailed"));
          return;
        }
      }
      onClose();
    } catch {
      setSaveError(t("settings:agentSkills_saveFailed"));
    }
  }, [draft, onClose, onConfirmRemovals, onSave, t]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : isSaving ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("settings:agentSkills_choose")}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <SettingsCard>
            <SettingsRow
              title={t("settings:agentSkills_chooseAll")}
              description={t("settings:agentSkills_chooseAllHint")}
              control={
                <Switch
                  checked={allSkills}
                  disabled={isSaving}
                  onCheckedChange={(checked) =>
                    setDraft(toggleAllSelection(checked === true, available))
                  }
                  aria-label={t("settings:agentSkills_chooseAll")}
                />
              }
            />
          </SettingsCard>

          <div className="space-y-2">
            <h3 className="text-ui-sm font-medium text-muted-foreground">
              {t("settings:agentSkills_chooseList")}
            </h3>
            <SettingsCard>
              {available.length === 0 ? (
                <SettingsEmptyState layout="status">
                  {t("settings:agentSkills_chooseEmpty")}
                </SettingsEmptyState>
              ) : (
                available.map((name) => (
                  <SettingsRow
                    key={name}
                    title={name}
                    description=""
                    control={
                      <Switch
                        checked={isSkillSelected(draft, name)}
                        disabled={allSkills || isSaving}
                        onCheckedChange={() =>
                          setDraft((current) => toggleSkillSelection(current, name))
                        }
                        aria-label={name}
                      />
                    }
                  />
                ))
              )}
            </SettingsCard>
          </div>

          {saveError === null ? null : <p className="text-ui-sm text-destructive">{saveError}</p>}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={isSaving} onClick={onClose}>
            {t("common:form_cancel")}
          </Button>
          <Button size="sm" disabled={isSaving} onClick={() => void handleSave()}>
            {isSaving
              ? t("settings:agentSkills_actions_saving")
              : t("settings:agentSkills_actions_save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
