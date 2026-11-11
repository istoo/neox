// FILE: AutomationsSettingsPanel.tsx
// Purpose: Settings › Scheduled tasks. Lists automations and edits the selected one in
//          place, reusing the existing automation list rows, create dialog, and detail view.
// Layer: Settings UI component

import type { AutomationDefinition } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { automationLifecycleState } from "~/lib/automationStatus";
import {
  AutomationCreateDialog,
  AutomationListRow,
  automationRowSubtitle,
  hasUnreadResult,
  useAutomationListClock,
} from "~/routes/-automations.list";
import { automationListRowIcon, useAutomations } from "~/routes/-automations.shared";
import { AutomationDetailView } from "~/routes/_chat.automations.$automationId";
import { CentralIcon } from "~/lib/central-icons";
import { PlusIcon } from "~/lib/icons";
import { Button } from "~/components/ui/button";
import { useTranslation } from "~/i18n";
import { SettingsCard, SettingsEmptyState, SettingsSectionShell } from "./SettingsPanelPrimitives";

function isEndedAutomation(definition: AutomationDefinition): boolean {
  if (automationLifecycleState(definition) === "done") return true;
  if (definition.enabled) return false;
  return (
    definition.disabledReason === "completion" ||
    definition.disabledReason === "max-iterations" ||
    definition.disabledReason === "failures"
  );
}

export function AutomationsSettingsPanel({
  automationId,
  onSelectAutomation,
}: {
  automationId: string | null;
  onSelectAutomation: (id: string | null) => void;
}) {
  const { t, formatLocale } = useTranslation();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, createMutation, runsByAutomationId } = useAutomations(
    (threadId) => void navigate({ to: "/$threadId", params: { threadId } }),
  );
  const now = useAutomationListClock();

  if (automationId !== null) {
    return (
      <AutomationDetailView
        automationId={automationId}
        onBack={() => onSelectAutomation(null)}
        embedded
      />
    );
  }

  const renderRow = (definition: AutomationDefinition) => {
    const latestRun = runsByAutomationId.get(definition.id)?.[0] ?? null;
    const icon = automationListRowIcon(definition, latestRun);
    return (
      <AutomationListRow
        key={definition.id}
        onClick={() => onSelectAutomation(definition.id)}
        dimmed={!definition.enabled}
        leading={<CentralIcon name={icon.name} className={icon.className} />}
        title={definition.name}
        detail={automationRowSubtitle(definition, latestRun, now, formatLocale)}
        meta={
          hasUnreadResult(latestRun) ? (
            <span
              aria-label={t("automation:list_newResult")}
              className="block size-1.5 rounded-full bg-[var(--color-text-accent)]"
            />
          ) : undefined
        }
      />
    );
  };

  const active = data.definitions.filter((definition) => !isEndedAutomation(definition));
  const ended = data.definitions.filter(isEndedAutomation);

  return (
    <div className="space-y-8">
      <SettingsSectionShell
        title="settings:scheduledTasks_listTitle"
        action={
          <Button type="button" size="xs" variant="outline" onClick={() => setCreateOpen(true)}>
            <PlusIcon className="size-3.5" />
            {t("settings:scheduledTasks_newTask")}
          </Button>
        }
      >
        {isLoading ? (
          <SettingsEmptyState>{t("automation:list_loading")}</SettingsEmptyState>
        ) : data.definitions.length === 0 ? (
          <SettingsEmptyState>
            <p className="font-medium text-foreground">{t("settings:scheduledTasks_emptyTitle")}</p>
            <p className="mt-1">{t("settings:scheduledTasks_emptyDescription")}</p>
          </SettingsEmptyState>
        ) : active.length === 0 ? (
          <SettingsEmptyState>{t("settings:scheduledTasks_noActive")}</SettingsEmptyState>
        ) : (
          <SettingsCard>{active.map(renderRow)}</SettingsCard>
        )}
      </SettingsSectionShell>

      {ended.length > 0 ? (
        <SettingsSectionShell title="settings:scheduledTasks_endedTitle">
          <SettingsCard>{ended.map(renderRow)}</SettingsCard>
        </SettingsSectionShell>
      ) : null}

      <AutomationCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        createAutomation={(input, onCreated) =>
          createMutation.mutate(input, { onSuccess: onCreated })
        }
        busy={createMutation.isPending}
      />
    </div>
  );
}
