// FILE: AgentConnectProfilesSection.tsx
// Purpose: Saved Agent Connect setups (myna's profiles): save the switches and
//          models as they stand, then apply, overwrite, rename or delete one.
// Layer: Settings UI components

import type { AgentConnectProfile } from "@synara/contracts";
import { useCallback, useState } from "react";

import { useTranslation } from "~/i18n";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { SettingsCard, SettingsListRow, SettingsSectionShell } from "../SettingsPanelPrimitives";

interface AgentConnectProfilesSectionProps {
  readonly profiles: readonly AgentConnectProfile[];
  readonly saving: boolean;
  readonly onSave: (name: string) => void;
  readonly onApply: (name: string) => void;
  readonly onOverwrite: (name: string) => void;
  readonly onDelete: (name: string) => void;
  readonly onRename: (name: string, to: string) => void;
}

export function AgentConnectProfilesSection({
  profiles,
  saving,
  onSave,
  onApply,
  onOverwrite,
  onDelete,
  onRename,
}: AgentConnectProfilesSectionProps) {
  const { t } = useTranslation();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<AgentConnectProfile | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);

  const startNaming = useCallback(() => {
    setName("");
    setNaming(true);
  }, []);
  const submitName = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onSave(trimmed);
    setNaming(false);
    setName("");
  }, [name, onSave]);
  const startRename = useCallback((profile: AgentConnectProfile) => {
    setRenaming(profile);
    setRenameTo(profile.name);
  }, []);
  const submitRename = useCallback(() => {
    if (renaming === null) return;
    const trimmed = renameTo.trim();
    if (trimmed.length > 0 && trimmed !== renaming.name) onRename(renaming.name, trimmed);
    setRenaming(null);
  }, [onRename, renameTo, renaming]);

  return (
    <SettingsSectionShell
      title="settings:agentConnect_profilesTitle"
      action={
        <Button size="xs" variant="outline" disabled={saving} onClick={startNaming}>
          {t("settings:agentConnect_saveProfile")}
        </Button>
      }
    >
      {naming ? (
        <SettingsCard>
          <SettingsListRow
            title={t("settings:agentConnect_profileNamePlaceholder")}
            actions={
              <>
                <Button
                  size="sm"
                  disabled={name.trim().length === 0 || saving}
                  onClick={submitName}
                >
                  {t("settings:agentConnect_profileSave")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
                  {t("settings:agentConnect_profileCancel")}
                </Button>
              </>
            }
          >
            <Input
              autoFocus
              value={name}
              placeholder={t("settings:agentConnect_profileNamePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitName();
              }}
            />
          </SettingsListRow>
        </SettingsCard>
      ) : null}

      {profiles.length === 0 && !naming ? (
        <p className="px-1 text-ui-sm text-muted-foreground">
          {t("settings:agentConnect_profilesHint")}
        </p>
      ) : profiles.length > 0 ? (
        <SettingsCard>
          {profiles.map((profile) => (
            <SettingsListRow
              key={profile.name}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{profile.name}</span>
                  {profile.inUse === true ? (
                    <span className="shrink-0 rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-ui-xs text-emerald-600 dark:text-emerald-400">
                      {t("settings:agentConnect_profileInUse")}
                    </span>
                  ) : null}
                </span>
              }
              actions={
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saving}
                    onClick={() => onApply(profile.name)}
                  >
                    {t("settings:agentConnect_profileApply")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => setOverwriteTarget(profile.name)}
                  >
                    {t("settings:agentConnect_profileUpdate")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => startRename(profile)}
                  >
                    {t("settings:agentConnect_profileRename")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={saving}
                    onClick={() => setDeleteTarget(profile.name)}
                  >
                    {t("settings:agentConnect_profileDelete")}
                  </Button>
                </>
              }
            />
          ))}
        </SettingsCard>
      ) : null}

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("settings:agentConnect_profileRename")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              autoFocus
              value={renameTo}
              placeholder={t("settings:agentConnect_profileNamePlaceholder")}
              onChange={(event) => setRenameTo(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitRename();
              }}
            />
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>
              {t("settings:agentConnect_profileCancel")}
            </Button>
            <Button
              size="sm"
              disabled={renameTo.trim().length === 0 || saving}
              onClick={submitRename}
            >
              {t("settings:agentConnect_profileSave")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:agentConnect_profileDeleteTitle", { name: deleteTarget ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:agentConnect_profileDeleteMessage")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={saving} render={<Button variant="outline" size="sm" />}>
              {t("settings:agentConnect_profileCancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={saving}
              onClick={() => {
                if (deleteTarget !== null) onDelete(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              {t("settings:agentConnect_profileDelete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={overwriteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setOverwriteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:agentConnect_profileUpdateTitle", { name: overwriteTarget ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:agentConnect_profileUpdateMessage")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={saving} render={<Button variant="outline" size="sm" />}>
              {t("settings:agentConnect_profileCancel")}
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={saving}
              onClick={() => {
                if (overwriteTarget !== null) onOverwrite(overwriteTarget);
                setOverwriteTarget(null);
              }}
            >
              {t("settings:agentConnect_profileUpdate")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSectionShell>
  );
}
