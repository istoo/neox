// FILE: AgentConnectControls.tsx
// Purpose: The two pieces both Agent Connect surfaces share: the status line
//          under an agent's name and the gateway-model picker.
// Layer: Shared UI components

import type { AgentConnectEntry, AgentConnectModel } from "@synara/contracts";

import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import { SettingsSelectControl } from "~/components/settings/SettingControls";
import {
  agentConnectStatus,
  modelLabel,
  type AgentConnectStatusTone,
} from "~/components/settings/agentConnect/agentConnect.logic";
import { SelectItem } from "~/components/ui/select";

const TONE_CLASS_NAME: Readonly<Record<AgentConnectStatusTone, string>> = {
  on: "bg-emerald-500",
  off: "bg-muted-foreground/50",
  bad: "bg-destructive",
};

export function AgentConnectStatusLine({
  entry,
  label,
}: {
  readonly entry: AgentConnectEntry | null;
  readonly label: string;
}) {
  const { t } = useTranslation();
  const status = agentConnectStatus(entry, label);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", TONE_CLASS_NAME[status.tone])}
      />
      <span className="truncate">{t(status.key, status.params)}</span>
    </span>
  );
}

/**
 * The row's model menu. A null model is the agent's own last pick, so the
 * trigger says so while the menu itself lists only gateway models.
 */
export function AgentConnectModelSelect({
  entry,
  models,
  label,
  disabled,
  onSelectModel,
  triggerClassName = "w-40 max-w-full",
}: {
  readonly entry: AgentConnectEntry | null;
  readonly models: readonly AgentConnectModel[];
  readonly label: string;
  readonly disabled: boolean;
  readonly onSelectModel: (model: string) => void;
  readonly triggerClassName?: string;
}) {
  const { t } = useTranslation();
  if (models.length === 0) {
    return (
      <span className="text-ui-sm text-muted-foreground">
        {t("settings:agentConnect_noModels")}
      </span>
    );
  }
  const fallback = models[0]?.id ?? "";
  const value = entry?.model ?? fallback;
  return (
    <SettingsSelectControl
      value={value}
      disabled={disabled}
      onValueChange={onSelectModel}
      ariaLabel={t("settings:agentConnect_chooseModel", { name: label })}
      valueContent={
        entry?.model === null || entry?.model === undefined
          ? t("settings:agentConnect_defaultModel")
          : modelLabel(models, entry.model)
      }
      triggerClassName={triggerClassName}
    >
      {models.map((model) => (
        <SelectItem key={model.id} value={model.id}>
          {model.label ?? model.id}
        </SelectItem>
      ))}
    </SettingsSelectControl>
  );
}
