// FILE: ExternalMcpSettingsPanel.tsx
// Purpose: Settings → MCP Connections. Neox has no scoped external-agent
//   integrations, so this panel shows the daemon's built-in MCP endpoint and
//   the "give agents Neox tools" switch instead.
// Layer: Settings UI components

import type { LibraryNeolixToolsResult } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { useTranslation } from "~/i18n";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const NEOLIX_TOOLS_QUERY_KEY = ["neolix", "library", "neolixTools"] as const;

export function ExternalMcpSettingsPanel(props: { active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const toolsQuery = useQuery({
    queryKey: NEOLIX_TOOLS_QUERY_KEY,
    queryFn: () => neolixLibraryApi.getNeolixTools(),
    enabled: props.active,
    staleTime: 10_000,
  });

  const updateMutation = useMutation({
    mutationFn: (input: { injectIntoAgents?: boolean; enabled?: boolean }) =>
      neolixLibraryApi.setNeolixTools(input),
    onSuccess: (result: LibraryNeolixToolsResult) => {
      queryClient.setQueryData(NEOLIX_TOOLS_QUERY_KEY, result);
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: t("settings:library_saveFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  const copyAddress = useCallback(
    (address: string) => {
      void copyTextToClipboard(address).then(
        () => toastManager.add({ type: "success", title: t("settings:library_copied") }),
        (error: unknown) =>
          toastManager.add({
            type: "error",
            title: t("settings:library_copyFailed"),
            description: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    [t],
  );

  if (!props.active) return null;

  // A daemon without the status/config RPCs has no equivalent to show.
  if (toolsQuery.isError) return null;

  const tools = toolsQuery.data;
  if (!tools) {
    return <p className="text-ui text-muted-foreground">{t("settings:library_loading")}</p>;
  }

  // The server switch comes first: the endpoint only exists while it is on, and the daemon
  // only gives agents Neox tools through that server (bootstrap: mcpEnabled && inject).
  return (
    <div className="space-y-8">
      <SettingsSection title="settings:library_neolixTools_address">
        <SettingsRow
          title="settings:library_neolixTools_enabled"
          description={t("settings:library_neolixTools_enabledHint")}
          control={
            <Switch
              checked={tools.enabled}
              aria-label={t("settings:library_neolixTools_enabled")}
              onCheckedChange={(checked) => updateMutation.mutate({ enabled: Boolean(checked) })}
            />
          }
        />
        {tools.enabled && tools.address ? (
          <SettingsRow
            title="settings:library_neolixTools_addressTitle"
            description={t("settings:library_neolixTools_addressHint")}
            status={
              <code className="break-all text-ui-sm text-muted-foreground">{tools.address}</code>
            }
            control={
              <Button size="sm" variant="outline" onClick={() => copyAddress(tools.address!)}>
                {t("settings:library_copy")}
              </Button>
            }
          />
        ) : null}
        <SettingsRow
          title="settings:library_neolixTools_inject"
          description={t("settings:library_neolixTools_injectHint")}
          status={
            tools.enabled ? undefined : (
              <span className="text-muted-foreground">
                {t("settings:library_neolixTools_injectNeedsServer")}
              </span>
            )
          }
          control={
            <Switch
              checked={tools.enabled && tools.injectIntoAgents}
              disabled={!tools.enabled}
              aria-label={t("settings:library_neolixTools_inject")}
              onCheckedChange={(checked) =>
                updateMutation.mutate({ injectIntoAgents: Boolean(checked) })
              }
            />
          }
        />
      </SettingsSection>
    </div>
  );
}
