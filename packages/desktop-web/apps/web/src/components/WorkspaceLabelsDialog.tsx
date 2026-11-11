// FILE: WorkspaceLabelsDialog.tsx
// Purpose: Manage the Neox workspace label catalog — rename, recolor, delete, and seed a new
//          definition. Neox creates a label by assigning it to a workspace, so "new" needs a
//          seed workspace; the caller passes the active thread's workspace when there is one.
// Layer: Sidebar / workspace labels
// Exports: WorkspaceLabelsDialog

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { NeolixWorkspaceLabelColor } from "@synara/contracts";

import {
  AlertDialog,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogDescription,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  dialogFieldLabelClassName,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  neolixWorkspaceLabelsQueryKey,
  neolixWorkspaceLabelsQueryOptions,
  neolixWorkspacesQueryKey,
  workspaceLabelColorClass,
} from "~/lib/workspaceLabels";
import { PencilIcon, PlusIcon, TrashCanIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

const LABEL_COLORS: readonly NeolixWorkspaceLabelColor[] = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
];

interface Draft {
  /** The catalog name being edited; null when creating. */
  readonly name: string | null;
  readonly value: string;
  readonly color: NeolixWorkspaceLabelColor;
}

export function WorkspaceLabelsDialog({
  open,
  onOpenChange,
  createWorkspaceId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A workspace to seed a new label on; null hides the create action. */
  createWorkspaceId: string | null;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const labelsQuery = useQuery({ ...neolixWorkspaceLabelsQueryOptions(), enabled: open });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [affectedCount, setAffectedCount] = useState<number | null>(null);

  const labels = labelsQuery.data?.labels ?? [];
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: neolixWorkspaceLabelsQueryKey }),
      queryClient.invalidateQueries({ queryKey: neolixWorkspacesQueryKey }),
    ]);
  };

  const close = () => {
    setDraft(null);
    setError(null);
    setConfirmDelete(null);
    onOpenChange(false);
  };

  const startCreate = () => setDraft({ name: null, value: "", color: "violet" });

  const save = () => {
    if (!draft || pending) return;
    const name = draft.value.trim();
    if (!name) return;
    setPending(true);
    setError(null);
    void saveLabelDraft({
      draft,
      name,
      createWorkspaceId,
      labels,
      missingWorkspaceMessage: t("workspace:labels_needWorkspace"),
    })
      .then(refresh)
      .then(
        () => setDraft(null),
        (cause: unknown) => setError(errorMessage(cause)),
      )
      .finally(() => setPending(false));
  };

  const inspectAndConfirmDelete = (name: string) => {
    setError(null);
    void Promise.resolve()
      .then(() =>
        requireNeolixApi(t("workspace:labels_needWorkspace")).workspaces.inspectLabelDelete({
          name,
        }),
      )
      .then(
        (inspected) => {
          setAffectedCount(inspected.affectedWorkspaceCount);
          setConfirmDelete(name);
        },
        (cause: unknown) => setError(errorMessage(cause)),
      );
  };

  const remove = (name: string) => {
    setPending(true);
    setError(null);
    void Promise.resolve()
      .then(() =>
        requireNeolixApi(t("workspace:labels_needWorkspace")).workspaces.deleteLabel({ name }),
      )
      .then(refresh)
      .then(
        () => {
          setConfirmDelete(null);
          setAffectedCount(null);
          setDraft(null);
        },
        (cause: unknown) => setError(errorMessage(cause)),
      )
      .finally(() => setPending(false));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspace:labels_manageTitle")}</DialogTitle>
          <DialogDescription>{t("workspace:labels_manageDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {draft ? (
            <div className="space-y-3">
              <label className="block space-y-1.5">
                <span className={dialogFieldLabelClassName}>{t("workspace:labels_name")}</span>
                <Input
                  autoFocus
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void save();
                    }
                  }}
                  placeholder={t("workspace:labels_namePlaceholder")}
                  aria-label={t("workspace:labels_name")}
                />
              </label>
              <div className="space-y-1.5">
                <span className={dialogFieldLabelClassName}>{t("workspace:labels_color")}</span>
                <div className="flex flex-wrap gap-2">
                  {LABEL_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={t("workspace:labels_colorName", { value0: color })}
                      aria-pressed={draft.color === color}
                      className={cn(
                        "size-6 cursor-pointer rounded-full outline-none ring-offset-2 ring-offset-popover transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring/60",
                        workspaceLabelColorClass(color),
                        draft.color === color ? "ring-2 ring-foreground/60" : null,
                      )}
                      onClick={() => setDraft({ ...draft, color })}
                    />
                  ))}
                </div>
              </div>
              {error ? <p className="text-ui text-destructive">{error}</p> : null}
            </div>
          ) : (
            <div className="space-y-1">
              {labels.length === 0 ? (
                <p className="px-1 py-3 text-ui text-muted-foreground">
                  {t("workspace:labels_empty")}
                </p>
              ) : null}
              {labels.map((label) => (
                <div
                  key={label.name}
                  className="group/row flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2.5 shrink-0 rounded-full",
                      workspaceLabelColorClass(label.color),
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate text-ui">{label.name}</span>
                  <button
                    type="button"
                    aria-label={t("workspace:labels_editLabel", { value0: label.name })}
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                    onClick={() =>
                      setDraft({ name: label.name, value: label.name, color: label.color })
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={t("workspace:labels_deleteLabel", { value0: label.name })}
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
                    onClick={() => void inspectAndConfirmDelete(label.name)}
                  >
                    <TrashCanIcon className="size-3.5" />
                  </button>
                </div>
              ))}
              {createWorkspaceId ? (
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  onClick={startCreate}
                >
                  <PlusIcon className="size-3.5" />
                  {t("workspace:labels_create")}
                </button>
              ) : null}
              {error ? <p className="px-1 pt-2 text-ui text-destructive">{error}</p> : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {draft ? (
            <>
              <Button variant="outline" onClick={() => setDraft(null)} disabled={pending}>
                {t("common:form_cancel")}
              </Button>
              <Button
                onClick={() => void save()}
                disabled={pending || draft.value.trim().length === 0}
              >
                {t("computer:form_save")}
              </Button>
            </>
          ) : (
            <Button variant="outline" onClick={close}>
              {t("common:app_close")}
            </Button>
          )}
        </DialogFooter>
        <AlertDialog
          open={confirmDelete !== null}
          onOpenChange={(next) => !next && setConfirmDelete(null)}
        >
          <AlertDialogPopup className="max-w-sm">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("workspace:labels_deleteTitle", { value0: confirmDelete ?? "" })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("workspace:labels_deleteMessage", { value0: affectedCount ?? 0 })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)} disabled={pending}>
                {t("common:form_cancel")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => confirmDelete && void remove(confirmDelete)}
                disabled={pending}
              >
                {t("workspace:labels_delete")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </DialogPopup>
    </Dialog>
  );
}

function labelColor(
  name: string,
  labels: ReadonlyArray<{ name: string; color: NeolixWorkspaceLabelColor }>,
): NeolixWorkspaceLabelColor | null {
  return labels.find((label) => label.name === name)?.color ?? null;
}

// The async label calls live at module scope: React Compiler cannot lower try/finally or a
// throw inside try, and a throw before the component's try escaped as an unhandled rejection.
function requireNeolixApi(missingWorkspaceMessage: string) {
  const neolix = ensureNativeApi().neolix;
  if (!neolix) throw new Error(missingWorkspaceMessage);
  return neolix;
}

async function saveLabelDraft(input: {
  draft: Draft;
  name: string;
  createWorkspaceId: string | null;
  labels: ReadonlyArray<{ name: string; color: NeolixWorkspaceLabelColor }>;
  missingWorkspaceMessage: string;
}): Promise<void> {
  const { draft, name, createWorkspaceId, labels, missingWorkspaceMessage } = input;
  const neolix = requireNeolixApi(missingWorkspaceMessage);
  if (draft.name === null) {
    if (!createWorkspaceId) throw new Error(missingWorkspaceMessage);
    await neolix.workspaces.setLabel({
      workspaceId: createWorkspaceId,
      label: { name, color: draft.color },
      assigned: true,
    });
    return;
  }
  await neolix.workspaces.updateLabel({
    name: draft.name,
    ...(name === draft.name ? {} : { newName: name }),
    ...(draft.color === labelColor(draft.name, labels) ? {} : { color: draft.color }),
  });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
