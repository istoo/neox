// FILE: PluginLogsDialog.tsx
// Purpose: Show a plugin process's recent stdout/stderr, which the daemon keeps per plugin
//          (`neolix.plugins.logs`). The old app surfaced the same feed from its plugin menu.
// Layer: Dialog component

import type { NeolixPlugin, NeolixPluginLogEntry } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";

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
import { useTranslation } from "~/i18n";
import { ensureNativeApi } from "~/nativeApi";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PluginLogsDialog(props: {
  readonly open: boolean;
  readonly plugin: NeolixPlugin | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const pluginId = props.plugin?.id ?? "";
  const name = props.plugin?.name?.trim() || pluginId;

  const query = useQuery({
    queryKey: ["neolix", "plugin-logs", pluginId],
    enabled: props.open && pluginId.length > 0,
    retry: false,
    refetchInterval: props.open ? 3_000 : false,
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) throw new Error(t("settings:plugins_unsupportedError"));
      return api.neolix.plugins.logs({ pluginId });
    },
  });

  const entries: readonly NeolixPluginLogEntry[] = query.data?.entries ?? [];

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings:plugins_logsTitle", { name })}</DialogTitle>
          <DialogDescription>{t("settings:plugins_logsDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[60vh] overflow-y-auto">
          {query.isLoading ? (
            <p className="text-ui text-muted-foreground">{t("settings:plugins_logsLoading")}</p>
          ) : query.isError ? (
            <p className="text-ui text-destructive">{errorMessage(query.error)}</p>
          ) : entries.length === 0 ? (
            <p className="text-ui text-muted-foreground">{t("settings:plugins_logsEmpty")}</p>
          ) : (
            <div className="divide-y divide-[color:var(--color-border)] font-mono text-ui-xs">
              {entries.map((entry) => (
                <div key={entry.sequence} className="flex gap-2 py-1.5">
                  <span className="shrink-0 text-muted-foreground/60">{entry.timestamp}</span>
                  <span
                    className={
                      entry.stream === "stderr"
                        ? "shrink-0 text-destructive"
                        : "shrink-0 text-muted-foreground"
                    }
                  >
                    {entry.stream}
                  </span>
                  <span className="min-w-0 break-words whitespace-pre-wrap text-foreground">
                    {entry.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching
              ? t("settings:plugins_logsRefreshing")
              : t("settings:plugins_logsRefresh")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)}>
            {t("settings:plugins_logsClose")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
