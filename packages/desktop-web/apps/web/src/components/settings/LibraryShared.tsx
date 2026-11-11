// FILE: LibraryShared.tsx
// Purpose: Shared building blocks for the Neox Library settings panels.
// Layer: Settings UI components

import type { LibraryAgentView } from "@synara/contracts";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { SettingsEmptyState } from "./SettingsPanelPrimitives";
import { cn } from "~/lib/utils";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { t, useTranslation } from "~/i18n";

export function LibraryAgentChips(props: {
  agents: ReadonlyArray<Pick<LibraryAgentView, "id" | "name">>;
  selected: ReadonlyArray<string>;
  onToggle?: (agent: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.agents.map((agent) => {
        const on = props.selected.includes(agent.id);
        return (
          <button
            key={agent.id}
            type="button"
            aria-pressed={on}
            disabled={props.disabled || !props.onToggle}
            onClick={() => props.onToggle?.(agent.id)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-ui-sm transition-colors",
              on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-secondary text-muted-foreground hover:text-foreground",
              (props.disabled || !props.onToggle) && "cursor-default opacity-80",
            )}
            title={t("settings:library_agentToggle", { agent: agent.name })}
          >
            {agent.name}
          </button>
        );
      })}
    </div>
  );
}

export function LibraryEmptyState(props: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-6">
      <p className="text-ui-lg font-medium text-foreground">{props.title}</p>
      <p className="text-ui text-muted-foreground">{props.description}</p>
      {props.actionLabel && props.onAction ? (
        <Button size="sm" variant="outline" onClick={props.onAction}>
          {props.actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

export function LibraryErrorState(props: { error: unknown; fallback: string }) {
  return (
    <SettingsEmptyState layout="status" tone="destructive">
      {props.error === null || props.error === undefined
        ? props.fallback
        : localizeLibraryError(props.error, t)}
    </SettingsEmptyState>
  );
}

export function LibraryEditorDialog(props: {
  open: boolean;
  title: string;
  description?: string | undefined;
  saveDisabled?: boolean | undefined;
  removeLabel?: string | undefined;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
  onRemove?: (() => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          {props.description ? <DialogDescription>{props.description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">{props.children}</div>
        </DialogPanel>
        <DialogFooter>
          {props.onRemove && props.removeLabel ? (
            <Button
              type="button"
              variant="destructive-outline"
              className="mr-auto"
              onClick={props.onRemove}
            >
              {props.removeLabel}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("settings:library_cancel")}
          </Button>
          <Button type="button" disabled={props.saveDisabled} onClick={props.onSave}>
            {t("settings:library_save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function LibraryField(props: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-ui-sm font-medium text-foreground">{props.label}</span>
      {props.hint ? (
        <span className="block text-ui-sm text-muted-foreground">{props.hint}</span>
      ) : null}
      {props.children}
    </label>
  );
}

export function LibraryAddButton(props: { label: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={props.onClick}>
      {props.label}
    </Button>
  );
}
