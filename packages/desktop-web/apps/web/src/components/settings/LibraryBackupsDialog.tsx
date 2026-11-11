// FILE: LibraryBackupsDialog.tsx
// Purpose: Settings → Library → MCP → Backups. Browses the files every Library
//   write kept aside and restores one at a time.
// Layer: Settings UI components

import type { LibraryBackupSession, LibrarySnapshot } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";

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
import { toastManager } from "~/components/ui/toast";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/i18n";

export function LibraryBackupsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  library: LibrarySnapshot;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<LibraryBackupSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [restoredKey, setRestoredKey] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setSessions(null);
    setError(null);
    setPendingKey(null);
    setRestoredKey(null);
    void (async () => {
      try {
        const result = await neolixLibraryApi.listBackups();
        setSessions([...result.backups]);
      } catch (failure) {
        setError(localizeLibraryError(failure, t));
      }
    })();
  }, [props.open, t]);

  const agentNames = useMemo(() => {
    const map = new Map(props.library.agents.map((agent) => [agent.id, agent.name]));
    return (id: string) => map.get(id) ?? id;
  }, [props.library.agents]);

  const restore = async (entry: { stamp: string; agent: string; file: string }) => {
    const key = `${entry.stamp}:${entry.agent}:${entry.file}`;
    const confirmed = await ensureNativeApi().dialogs.confirm(
      t("settings:library_mcp_restoreConfirm", {
        file: entry.file,
        agent: agentNames(entry.agent),
      }),
      { confirmLabel: t("settings:library_mcp_restore") },
    );
    if (!confirmed) return;
    setPendingKey(key);
    setError(null);
    try {
      await neolixLibraryApi.restoreBackup(entry);
      props.onChanged();
      setRestoredKey(key);
      toastManager.add({ type: "success", title: t("settings:library_mcp_restored") });
    } catch (failure) {
      setError(localizeLibraryError(failure, t));
      toastManager.add({
        type: "error",
        title: t("settings:library_mcp_restoreFailed"),
        description: localizeLibraryError(failure, t),
      });
    }
    setPendingKey(null);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("settings:library_mcp_backupsTitle")}</DialogTitle>
          <DialogDescription>{t("settings:library_mcp_backupsIntro")}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {sessions === null ? (
            error ? null : (
              <p className="text-ui-sm text-muted-foreground">{t("settings:library_loading")}</p>
            )
          ) : sessions.length === 0 ? (
            <p className="text-ui-sm text-muted-foreground">
              {t("settings:library_mcp_backupsEmpty")}
            </p>
          ) : (
            <div className="max-h-96 space-y-4 overflow-y-auto">
              {sessions.map((session) => (
                <section key={session.stamp} className="space-y-1">
                  <h3 className="text-ui-sm font-medium text-foreground">{session.stamp}</h3>
                  {Object.entries(session.files).flatMap(([agent, files]) =>
                    files.map((file) => {
                      const key = `${session.stamp}:${agent}:${file.file}`;
                      return (
                        <div
                          key={key}
                          className="flex items-center gap-3 border-b border-border/40 px-1 py-2 last:border-b-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-ui font-medium text-foreground">
                              {file.file}
                            </p>
                            <p className="truncate text-ui-sm text-muted-foreground">
                              {file.target ??
                                t("settings:library_mcp_backupNoTarget", {
                                  agent: agentNames(agent),
                                })}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingKey === key || !file.target}
                            onClick={() =>
                              void restore({ stamp: session.stamp, agent, file: file.file })
                            }
                          >
                            {restoredKey === key
                              ? t("settings:library_mcp_restored")
                              : t("settings:library_mcp_restore")}
                          </Button>
                        </div>
                      );
                    }),
                  )}
                </section>
              ))}
            </div>
          )}
          {error ? <p className="text-ui-sm text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
