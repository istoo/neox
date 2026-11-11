import type { ToastCopyItem } from "~/components/ui/toast.logic";
import { t } from "~/i18n";

export type GroupDeletedNotice = {
  readonly description: string;
  readonly copyItems: ReadonlyArray<ToastCopyItem>;
};

// After a group is deleted the Library and the managed group folder may each
// be left on disk; report them in one notice so each path gets its own copy
// action.
export function buildGroupDeletedNotice(result: {
  readonly libraryLeftOnDiskPath: string | null;
  readonly workspaceLeftOnDiskPath: string | null;
}): GroupDeletedNotice | null {
  const keptParts: string[] = [];
  const copyItems: ToastCopyItem[] = [];

  if (result.libraryLeftOnDiskPath) {
    keptParts.push(t("chat:groupLibraryLeftOnDisk", { path: result.libraryLeftOnDiskPath }));
    copyItems.push({ label: t("chat:libraryPath"), text: result.libraryLeftOnDiskPath });
  }
  if (result.workspaceLeftOnDiskPath) {
    keptParts.push(t("chat:groupHubLeftOnDisk", { path: result.workspaceLeftOnDiskPath }));
    copyItems.push({ label: t("chat:hubFolderPath"), text: result.workspaceLeftOnDiskPath });
  }

  if (copyItems.length === 0) return null;
  return { description: keptParts.join(" "), copyItems };
}
