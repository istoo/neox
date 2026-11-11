// FILE: SaveAgentProfileDialog.tsx
// Purpose: Name and note the composer's current provider/model/mode/options as a new agent
//          profile, stored host-wide in the daemon config.
// Layer: Chat composer presentation
// Exports: SaveAgentProfileDialog

import { type FormEvent, useId, useState } from "react";

import { useTranslation } from "~/i18n";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  dialogFieldLabelClassName,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

export function SaveAgentProfileDialog(props: {
  open: boolean;
  /** Rendered summary of the values that will be captured. */
  summary: string;
  onOpenChange: (open: boolean) => void;
  onSave: (name: string, notes: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [wasOpen, setWasOpen] = useState(props.open);
  if (wasOpen !== props.open) {
    setWasOpen(props.open);
    if (props.open) {
      setName("");
      setNotes("");
      setSubmitAttempted(false);
      setSubmitting(false);
    }
  }

  const nameError = submitAttempted && name.trim().length === 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    if (name.trim().length === 0) return;
    setSubmitting(true);
    const saved = await props.onSave(name.trim(), notes.trim());
    setSubmitting(false);
    if (saved) props.onOpenChange(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={(next) => !submitting && props.onOpenChange(next)}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("chat:agentProfiles_saveDialogTitle")}</DialogTitle>
          <DialogDescription>{t("chat:agentProfiles_saveDialogDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id={formId} className="space-y-3" onSubmit={submit} noValidate>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_nameLabel")}
              </span>
              <Input
                size="sm"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("settings:agentProfiles_namePlaceholder")}
                spellCheck={false}
                autoFocus
                aria-invalid={nameError}
              />
              {nameError ? (
                <span className="block text-ui-sm text-destructive">
                  {t("chat:agentProfiles_nameRequired")}
                </span>
              ) : null}
            </label>
            <div className="rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] px-3 py-2 text-ui-sm text-muted-foreground">
              {props.summary}
            </div>
            <label className="block space-y-1">
              <span className={dialogFieldLabelClassName}>
                {t("settings:agentProfiles_notesLabel")}
              </span>
              <Textarea
                size="sm"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder={t("settings:agentProfiles_notesPlaceholder")}
              />
            </label>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={submitting}
            onClick={() => props.onOpenChange(false)}
          >
            {t("settings:agentProfiles_cancel")}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={submitting}>
            {t("settings:agentProfiles_save")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
