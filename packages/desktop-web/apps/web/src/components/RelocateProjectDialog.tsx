// FILE: RelocateProjectDialog.tsx
// Purpose: Reconnects an imported project to a restored/moved folder without recreating chats.
// Layer: Sidebar UI

import { useState } from "react";
import type { ProjectId } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";
import { relocateProjectFromClient } from "../lib/projectRelocation";
import { hasUnsavedWorkspaceEditors } from "../lib/workspaceEditorSession";
import { RenameDialog } from "./RenameDialog";
import { toastManager } from "./ui/toast";
import { useTranslation } from "~/i18n";

interface RelocateProjectOptions {
  readonly queryClient: ReturnType<typeof useQueryClient>;
  readonly projectId: ProjectId;
  readonly previousWorkspaceRoot: string;
  readonly workspaceRoot: string;
  readonly translate: ReturnType<typeof useTranslation>["t"];
}

async function relocateProject({
  queryClient,
  projectId,
  previousWorkspaceRoot,
  workspaceRoot,
  translate,
}: RelocateProjectOptions): Promise<void> {
  try {
    if (hasUnsavedWorkspaceEditors(queryClient)) {
      throw new Error("Save or discard unsaved file edits before changing a project path.");
    }
    await relocateProjectFromClient(ensureNativeApi().orchestration, {
      projectId,
      previousWorkspaceRoot,
      workspaceRoot,
    });
    toastManager.add({
      type: "success",
      title: translate("workspace:projectPathUpdated"),
      description: translate("workspace:continueInYourExistingThreadsABlockedThreadMay"),
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: translate("workspace:couldNotChangeProjectPath"),
      description:
        error instanceof Error ? error.message : translate("workspace:anUnknownErrorOccurred"),
    });
    throw error;
  }
}

export function RelocateProjectDialog(props: {
  projectId: ProjectId;
  workspaceRoot: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [originalWorkspaceRoot] = useState(props.workspaceRoot);
  return (
    <RenameDialog
      open
      title={t("workspace:changeProjectPath")}
      description={t("workspace:enterTheRestoredFolderSPathOnTheSynara")}
      initialValue={originalWorkspaceRoot}
      saveLabel={t("workspace:changePath")}
      onOpenChange={props.onOpenChange}
      onSave={(workspaceRoot) =>
        relocateProject({
          queryClient,
          projectId: props.projectId,
          previousWorkspaceRoot: originalWorkspaceRoot,
          workspaceRoot,
          translate: t,
        })
      }
    />
  );
}
