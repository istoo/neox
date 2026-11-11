// FILE: ProviderExtrasSettings.tsx
// Purpose: Provider list gaps the Synara panel has no surface for: config-owned
//          ACP providers (add/remove) and the daemon's one-click CLI installers.
// Layer: Settings UI component.
// Exports: ProviderExtrasSettings

import type { NeolixAgentInstallEntry, NeolixAgentInstallRunResult } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { getHostConfig, patchHostConfig } from "~/lib/neolixHostApi";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { tWithDefault, useTranslation } from "~/i18n";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsListRow, SettingsSection, SettingsSectionShell } from "./SettingsPanelPrimitives";

interface AcpProviderConfig {
  readonly extends?: string;
  readonly label?: string;
  readonly description?: string;
  readonly command?: readonly string[];
}

const ACP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function ProviderExtrasSettings({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [addOpen, setAddOpen] = useState(false);
  const [running, setRunning] = useState<{
    entry: NeolixAgentInstallEntry;
    commandId: string;
  } | null>(null);
  const [installResult, setInstallResult] = useState<{
    entry: NeolixAgentInstallEntry;
    result: NeolixAgentInstallRunResult;
  } | null>(null);

  const configQuery = useQuery({
    queryKey: ["neolix-host-config"],
    queryFn: getHostConfig,
    enabled: active,
    staleTime: 5_000,
  });
  const installsQuery = useQuery({
    queryKey: ["neolix-provider-installs"],
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!api.neolix) return { entries: [] as NeolixAgentInstallEntry[] };
      return api.neolix.plugins.listInstalls();
    },
    enabled: active,
    staleTime: 60_000,
    retry: false,
  });

  const providers =
    (configQuery.data?.config as { providers?: Record<string, AcpProviderConfig> } | undefined)
      ?.providers ?? {};
  const acpProviders = Object.entries(providers).filter(
    ([, config]) => config && config.extends === "acp",
  );

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["neolix-host-config"] });
    await queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    await refreshProviderStatuses().catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: ["neolix-provider-installs"] });
  };

  const removeProvider = async (id: string, label: string) => {
    if (
      !(await ensureNativeApi().dialogs.confirm(
        t("settings:providers_removeConfirm", { value0: label }),
        { confirmLabel: t("common:confirm_remove"), destructive: true },
      ))
    )
      return;
    try {
      await patchHostConfig({ removeProviders: [id] });
      await refresh();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("settings:providers_removeFailed"),
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  const runInstall = async () => {
    if (!running) return;
    const api = ensureNativeApi();
    if (!api.neolix) return;
    try {
      const result = await api.neolix.plugins.runInstall({
        provider: running.entry.provider,
        commandId: running.commandId,
      });
      setInstallResult({ entry: running.entry, result });
      setRunning(null);
      await refresh();
    } catch (cause) {
      setInstallResult({
        entry: running.entry,
        result: {
          provider: running.entry.provider,
          ok: false,
          exitCode: null,
          output: "",
          error: cause instanceof Error ? cause.message : String(cause),
        },
      });
      setRunning(null);
    }
  };

  if (!active) return null;
  const entries = installsQuery.data?.entries ?? [];

  return (
    <>
      <SettingsSectionShell
        title={t("settings:providers_acpSection")}
        action={
          <Button size="xs" shape="capsule" variant="subtle" onClick={() => setAddOpen(true)}>
            {t("settings:providers_addAcp")}
          </Button>
        }
      >
        {acpProviders.length === 0 ? (
          <SettingsListRow
            title={
              <span className="font-normal text-muted-foreground">
                {t("settings:providers_noAcp")}
              </span>
            }
            description={t("settings:providers_noAcpDescription")}
          />
        ) : (
          acpProviders.map(([id, config]) => (
            <SettingsListRow
              key={id}
              title={config.label?.trim() || id}
              description={
                <span className="block">
                  <span className="block font-mono text-ui-xs">{id}</span>
                  {config.description ? <span>{config.description}</span> : null}
                  {config.command?.length ? (
                    <span className="block font-mono text-ui-xs">{config.command.join(" ")}</span>
                  ) : null}
                </span>
              }
              actions={
                <Button
                  size="xs"
                  shape="capsule"
                  variant="destructive-outline"
                  onClick={() => void removeProvider(id, config.label?.trim() || id)}
                >
                  {t("settings:providers_remove")}
                </Button>
              }
            />
          ))
        )}
      </SettingsSectionShell>

      {entries.length > 0 ? (
        <SettingsSection title={t("settings:providers_installSection")}>
          {entries.map((entry) => (
            <SettingsListRow
              key={entry.provider}
              title={entry.name}
              description={
                <span className="block">
                  {entry.description ? (
                    <span className="block">
                      {tWithDefault(
                        `settings:providers_installDescription_${entry.provider}`,
                        entry.description,
                      )}
                    </span>
                  ) : null}
                  {entry.commands.map((command) => (
                    <code key={command.id} className="mt-1 block font-mono text-ui-xs">
                      {command.command}
                    </code>
                  ))}
                </span>
              }
              actions={
                <div className="flex flex-wrap items-center gap-1.5">
                  {entry.commands.map((command) => (
                    <Button
                      key={command.id}
                      size="xs"
                      shape="capsule"
                      variant="subtle"
                      onClick={() => setRunning({ entry, commandId: command.id })}
                    >
                      {t(`settings:providers_installVia_${command.via}`)}
                    </Button>
                  ))}
                  {entry.url ? (
                    <Button
                      size="xs"
                      shape="capsule"
                      variant="ghost"
                      render={<a href={entry.url} target="_blank" rel="noreferrer" />}
                    >
                      {t("settings:providers_installDocs")}
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))}
        </SettingsSection>
      ) : null}

      <AddAcpProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={() => {
          setAddOpen(false);
          void refresh();
        }}
      />

      <Dialog open={running !== null} onOpenChange={(open) => !open && setRunning(null)}>
        {running ? (
          <DialogPopup className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("settings:providers_runInstallTitle", { value0: running.entry.name })}
              </DialogTitle>
              <DialogDescription>{t("settings:providers_runInstallDescription")}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-ui-xs whitespace-pre-wrap">
                {running.entry.commands.find((command) => command.id === running.commandId)
                  ?.command ?? ""}
              </pre>
            </DialogPanel>
            <DialogFooter>
              <Button shape="capsule" variant="subtle" onClick={() => setRunning(null)}>
                {t("common:form_cancel")}
              </Button>
              <Button shape="capsule" onClick={() => void runInstall()}>
                {t("settings:providers_runInstall")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>

      <Dialog
        open={installResult !== null}
        onOpenChange={(open) => !open && setInstallResult(null)}
      >
        {installResult ? (
          <DialogPopup className="max-w-lg">
            <DialogHeader>
              <DialogTitle>
                {installResult.result.ok
                  ? t("settings:providers_installSucceeded", { value0: installResult.entry.name })
                  : t("settings:providers_installFailed", { value0: installResult.entry.name })}
              </DialogTitle>
              <DialogDescription>
                {installResult.result.error ??
                  t("settings:providers_installExit", {
                    value0: String(installResult.result.exitCode ?? "—"),
                  })}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <pre className="max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-ui-xs whitespace-pre-wrap">
                {installResult.result.output || t("settings:providers_installNoOutput")}
              </pre>
            </DialogPanel>
            <DialogFooter>
              <Button shape="capsule" onClick={() => setInstallResult(null)}>
                {t("common:form_close")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>
    </>
  );
}

function AddAcpProviderDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const idField = useId();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [env, setEnv] = useState("");
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      const providerId = id.trim();
      if (!ACP_ID_PATTERN.test(providerId)) {
        throw new Error(t("settings:providers_acpIdInvalid"));
      }
      const parts = command.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) throw new Error(t("settings:providers_acpCommandRequired"));
      let parsedEnv: Record<string, string> | undefined;
      if (env.trim()) {
        let value: unknown;
        try {
          value = JSON.parse(env);
        } catch {
          // The raw SyntaxError is engine English ("Unexpected token…"); say what is expected.
          throw new Error(t("settings:providers_acpEnvInvalid"));
        }
        if (
          typeof value !== "object" ||
          value === null ||
          Array.isArray(value) ||
          !Object.values(value).every((entry) => typeof entry === "string")
        )
          throw new Error(t("settings:providers_acpEnvInvalid"));
        parsedEnv = value as Record<string, string>;
      }
      const patch = {
        providers: {
          [providerId]: {
            extends: "acp",
            label: label.trim() || providerId,
            description: description.trim(),
            command: parts,
            ...(parsedEnv ? { env: parsedEnv } : {}),
          },
        },
      };
      return patchHostConfig(patch);
    },
    onSuccess: () => {
      setId("");
      setLabel("");
      setDescription("");
      setCommand("");
      setEnv("");
      setError(null);
      onSaved();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : t("settings:providers_acpAddFailed"));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings:providers_addAcp")}</DialogTitle>
          <DialogDescription>{t("settings:providers_addAcpDescription")}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <label htmlFor={idField} className="block text-ui-sm">
            <span className="mb-1 block text-muted-foreground">
              {t("settings:providers_acpId")}
            </span>
            <Input
              id={idField}
              value={id}
              placeholder="my-agent-acp"
              onChange={(event) => setId(event.target.value)}
            />
          </label>
          <label className="block text-ui-sm">
            <span className="mb-1 block text-muted-foreground">
              {t("settings:providers_acpLabel")}
            </span>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="block text-ui-sm">
            <span className="mb-1 block text-muted-foreground">
              {t("settings:providers_acpCommand")}
            </span>
            <Input
              value={command}
              placeholder="npx -y @vendor/agent@1.0.0 --acp"
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <label className="block text-ui-sm">
            <span className="mb-1 block text-muted-foreground">
              {t("settings:providers_acpDescription")}
            </span>
            <Input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <label className="block text-ui-sm">
            <span className="mb-1 block text-muted-foreground">
              {t("settings:providers_acpEnv")}
            </span>
            <Input
              type="password"
              value={env}
              placeholder={'{"API_KEY":"…"}'}
              onChange={(event) => setEnv(event.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button shape="capsule" variant="subtle" onClick={() => onOpenChange(false)}>
            {t("common:form_cancel")}
          </Button>
          <Button shape="capsule" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {t("settings:providers_acpAdd")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
