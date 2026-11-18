// Host-level settings that live in the Neox daemon rather than the Synara server contract:
// daemon identity and lifecycle, LAN sharing, session reads and telemetry, gateway trace
// export, quota alerts, terminal profiles, and speech.
//
// The daemon config document is shared by all of them; each panel patches only its own keys.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import type { ConfirmDialogOptions, NeolixHostUpdateProgressPhase } from "@synara/contracts";

import { useAppSettings } from "~/appSettings";
import { ProviderIcon } from "~/components/ProviderIcon";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { CopyTextButton } from "~/components/ui/copyTextButton";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";
import { EllipsisIcon, TerminalIcon } from "~/lib/icons";
import {
  deleteSpeechModel,
  downloadSpeechModel,
  getHostStatus,
  getLibraryGithubToken,
  getSessionReads,
  getWebPage,
  listSpeechModels,
  restartHost,
  setLibraryGithubToken,
  setSessionReads,
  setWebPage,
  updateHost,
  type NeolixWebPagePatch,
} from "~/lib/neolixHostApi";
import { ensureNativeApi } from "~/nativeApi";
import { onNeolixHostUpdateProgress } from "~/wsNativeApi";
import { isProviderKind } from "~/providerOrdering";
import { cn } from "~/lib/utils";
import { restartHostAndAwaitReplacement } from "~/lib/hostRestart";
import { speechModelDisplayLabel } from "~/lib/speechModelLabel";
import { localizeNetworkError } from "~/lib/errorLocalization";

import { useBuiltinFeatures } from "~/hooks/useBuiltinFeatures";

import { AgentSkillsSettingsPanel } from "./AgentSkillsSettingsPanel";
import { DesktopDaemonLifecycleSection } from "./DesktopDaemonSection";

import {
  formatBytes,
  type GatewayConfigWire,
  useGatewayConfig,
  useHostConfig,
  useHostStatus,
} from "./hostSettingsModel";
import { isCollectorEndpoint, parseDaemonPort } from "./hostSettingsValidation";
import {
  VoiceProviderDialog,
  type VoiceSiteId,
  type VoiceSiteKind,
  type VoiceSitePatch,
  type VoiceSiteSettings,
} from "./VoiceProviderDialog";
import { SettingsSegmentedControl } from "./SettingControls";
import {
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
} from "./SettingsPanelPrimitives";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SPEECH_MODEL_STATUS_KEYS: Record<string, string> = {
  installed: "settings:host_modelStatus_installed",
  not_installed: "settings:host_modelStatus_not_installed",
  downloading: "settings:host_modelStatus_downloading",
  extracting: "settings:host_modelStatus_extracting",
  failed: "settings:host_modelStatus_failed",
};

/** The daemon names a phase; the button shows the phase instead of a generic "Updating…". */
const DAEMON_UPDATE_PHASE_KEYS: Record<NeolixHostUpdateProgressPhase, string> = {
  starting: "settings:host_updatePhaseStarting",
  downloading: "settings:host_updatePhaseDownloading",
  installing: "settings:host_updatePhaseInstalling",
  complete: "settings:host_updatePhaseComplete",
};

/** The daemon reports a raw status id; an unknown future id is shown as-is. */
function speechModelStatusLabel(status: string, t: (key: string) => string): string {
  const key = SPEECH_MODEL_STATUS_KEYS[status];
  return key ? t(key) : status;
}

async function confirmAction(message: string, options: ConfirmDialogOptions): Promise<boolean> {
  try {
    return await ensureNativeApi().dialogs.confirm(message, options);
  } catch {
    return false;
  }
}

/** A text/number row that stages its value and writes on Save. */
function DraftRow({
  id,
  title,
  description,
  value,
  placeholder,
  type,
  wide,
  disabled,
  validate,
  onSave,
}: {
  id?: string;
  title: string;
  description: string;
  value: string;
  placeholder?: string;
  type?: "text" | "number";
  /** For URLs and paths, which do not fit the default short field. */
  wide?: boolean;
  disabled?: boolean;
  validate?: (value: string) => string | null;
  onSave: (value: string) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(value);
    setInputError(null);
  }, [value]);
  const dirty = draft !== value;
  return (
    <SettingsRow
      {...(id === undefined ? {} : { id })}
      title={title}
      description={description}
      status={inputError ? <span className="text-destructive">{inputError}</span> : undefined}
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            type={type ?? "text"}
            value={draft}
            disabled={disabled}
            placeholder={placeholder}
            aria-label={title}
            className={wide ? "sm:w-72" : "sm:w-48"}
            onChange={(event) => {
              setDraft(event.target.value);
              setInputError(null);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={!dirty || saving || disabled}
            onClick={() => {
              const problem = validate?.(draft.trim()) ?? null;
              if (problem !== null) {
                setInputError(problem);
                return;
              }
              setInputError(null);
              setSaving(true);
              void onSave(draft.trim()).finally(() => setSaving(false));
            }}
          >
            {t("settings:host_save")}
          </Button>
        </div>
      }
    />
  );
}

// ── Daemon ─────────────────────────────────────────────────────────────────

export function HostDaemonSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { config, isLoading, error, saving, patch } = useHostConfig(active);
  const statusQuery = useHostStatus(active);
  // myna gates the Browser tools opt-in with Neolix tools behind the `tools` switch.
  const toolsOn = useBuiltinFeatures().isEnabled("tools");
  const [busy, setBusy] = useState<"restart" | "update" | null>(null);
  const [updatePhase, setUpdatePhase] = useState<NeolixHostUpdateProgressPhase | null>(null);

  // The daemon reports phases while it downloads and installs; the bridge forwards them.
  useEffect(() => {
    if (!active) return;
    return onNeolixHostUpdateProgress((progress) => setUpdatePhase(progress.phase));
  }, [active]);

  const restart = useCallback(async () => {
    const confirmed = await confirmAction(t("settings:host_restartConfirm"), {
      confirmLabel: t("settings:host_restart"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy("restart");
    const replacement = await restartHostAndAwaitReplacement({
      getStatus: getHostStatus,
      restart: () => restartHost(false),
    }).catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: t("settings:host_couldNotRestart"),
        description: errorMessage(cause),
      });
      return null;
    });
    setBusy(null);
    if (!replacement) return;
    toastManager.add({
      type: "success",
      title: t("settings:host_daemonRestartedTo", {
        version: replacement.version ?? t("settings:host_unknownVersion"),
      }),
    });
    void statusQuery.refetch();
  }, [statusQuery, t]);

  // debt: the daemon emits `daemon.update.progress` (starting/downloading/installing),
  // and the bridge forwards it through `subscribeUpdateProgress`; the button names the
  // phase while the request runs and the result carries the failure reason.
  const update = useCallback(async () => {
    const confirmed = await confirmAction(t("settings:host_updateConfirm"), {
      confirmLabel: t("settings:host_update"),
    });
    if (!confirmed) return;
    setBusy("update");
    setUpdatePhase(null);
    const result = await updateHost().catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: t("settings:host_couldNotUpdate"),
        description: errorMessage(cause),
      });
      return null;
    });
    if (result?.success) {
      // The daemon answers before it reloads itself; read the live version so the
      // toast reports what is actually running rather than only what was installed.
      const replacement = await getHostStatus().catch(() => null);
      const version = result.newVersion ?? replacement?.version ?? null;
      toastManager.add({
        type: "success",
        title: version
          ? t("settings:host_daemonUpdatedTo", { version })
          : t("settings:host_daemonUpdated"),
      });
      void statusQuery.refetch();
    } else if (result) {
      toastManager.add({
        type: "error",
        title: t("settings:host_daemonUpdateFailed"),
        description: result.error ?? t("settings:host_updateNotInstalled"),
      });
    }
    setBusy(null);
    setUpdatePhase(null);
  }, [statusQuery, t]);

  if (!active) return null;
  const status = statusQuery.data;

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_sectionHost")}>
        <SettingsRow
          title={t("settings:host_daemon")}
          description={t("settings:host_daemonDescription")}
          status={
            error
              ? t("settings:host_unavailableWith", { error })
              : status
                ? `${status.serverId} · ${status.version ?? t("settings:host_unknownVersion")}${
                    status.listen ? ` · ${status.listen}` : ""
                  }`
                : isLoading
                  ? t("settings:host_loading")
                  : t("settings:host_notConnected")
          }
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={statusQuery.isFetching}
              onClick={() => void statusQuery.refetch()}
            >
              {t("settings:host_refresh")}
            </Button>
          }
        />
        <DraftRow
          id="setting-host-append-system-prompt"
          title={t("settings:host_appendSystemPrompt")}
          description={t("settings:host_appendSystemPromptDescription")}
          value={config?.appendSystemPrompt ?? ""}
          placeholder={t("settings:host_optional")}
          disabled={isLoading || saving || config === undefined}
          onSave={(value) => patch({ appendSystemPrompt: value })}
        />
      </SettingsSection>

      <SettingsSection title={t("settings:host_daemonLifecycle")}>
        <SettingsRow
          id="setting-host-restart"
          title={t("settings:host_restartDaemon")}
          description={t("settings:host_restartDaemonDescription")}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null || status === undefined}
              onClick={() => void restart()}
            >
              {busy === "restart" ? t("settings:host_restarting") : t("settings:host_restart")}
            </Button>
          }
        />
        <SettingsRow
          id="setting-host-update"
          title={t("settings:host_updateDaemon")}
          description={t("settings:host_updateDaemonDescription")}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void update()}
            >
              {busy === "update"
                ? updatePhase
                  ? t(DAEMON_UPDATE_PHASE_KEYS[updatePhase])
                  : t("settings:host_updating")
                : t("settings:host_update")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings:host_workspacesAndSessions")}>
        <BooleanHostRow
          title={t("settings:host_archiveAfterMerge")}
          description={t("settings:host_archiveAfterMergeDescription")}
          value={config?.autoArchiveAfterMerge === true}
          disabled={config === undefined}
          onCheckedChange={(checked) => patch({ autoArchiveAfterMerge: checked })}
        />
        <BooleanHostRow
          title={t("settings:host_terminalAgentHooks")}
          description={t("settings:host_terminalAgentHooksDescription")}
          value={config?.enableTerminalAgentHooks === true}
          disabled={config === undefined}
          onCheckedChange={(checked) => patch({ enableTerminalAgentHooks: checked })}
        />
        <BooleanHostRow
          title={t("settings:host_idleRuntimeCleanup")}
          description={t("settings:host_idleRuntimeCleanupDescription")}
          value={config?.idleRuntimeCleanup === true}
          disabled={config === undefined}
          onCheckedChange={(checked) => patch({ idleRuntimeCleanup: checked })}
        />
        <BooleanHostRow
          title={t("settings:host_resumeOnStartup")}
          description={t("settings:host_resumeOnStartupDescription")}
          value={config?.resumeOnStartup === true}
          disabled={config === undefined}
          onCheckedChange={(checked) => patch({ resumeOnStartup: checked })}
        />
        <DraftRow
          title={t("settings:host_resumePrompt")}
          description={t("settings:host_resumePromptDescription")}
          value={config?.resumePrompt ?? ""}
          placeholder={t("settings:host_resumePromptPlaceholder")}
          disabled={isLoading || saving || config === undefined || config.resumeOnStartup !== true}
          onSave={(value) => patch({ resumePrompt: value })}
        />
      </SettingsSection>

      {toolsOn ? (
        <SettingsSection title={t("settings:browserTools")}>
          <BooleanHostRow
            id="setting-browser-tools"
            title={t("settings:browserTools")}
            description={t("settings:browserToolsDescription")}
            value={config?.browserTools?.enabled === true}
            disabled={config === undefined}
            onCheckedChange={(checked) => patch({ browserTools: { enabled: checked } })}
          />
        </SettingsSection>
      ) : null}

      <AgentSkillsSettingsPanel active={active} />

      <DesktopDaemonLifecycleSection active={active} />
    </div>
  );
}

function BooleanHostRow({
  id,
  title,
  description,
  value,
  disabled,
  status,
  onCheckedChange,
}: {
  id?: string;
  title: string;
  description: string;
  value: boolean;
  disabled?: boolean;
  status?: ReactNode;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SettingsRow
      {...(id === undefined ? {} : { id })}
      title={title}
      description={description}
      status={status}
      control={
        <Switch
          checked={value}
          disabled={disabled}
          onCheckedChange={(checked) => onCheckedChange(checked === true)}
          aria-label={title}
        />
      }
    />
  );
}

// ── Network ────────────────────────────────────────────────────────────────

/** An IPv4/IPv6 address or CIDR range, as myna's allow list takes them. */
function isIpOrCidr(value: string): boolean {
  const [address = "", bits] = value.split("/");
  const ipv6 = address.includes(":");
  if (bits !== undefined) {
    if (!/^\d{1,3}$/.test(bits) || Number(bits) > (ipv6 ? 128 : 32)) {
      return false;
    }
  }
  if (ipv6) {
    return true;
  }
  const parts = address.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin === value.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}

/** The gateway config is an open document; a list field is only usable when it is one. */
function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** A list of strings edited one value at a time: add, remove, keep order. */
function HostStringListRows({
  id,
  title,
  description,
  addLabel,
  removeLabel,
  placeholder,
  values,
  validate,
  invalidMessage,
  duplicateMessage,
  disabled,
  onChange,
}: {
  id?: string;
  title: string;
  description: string;
  addLabel: string;
  removeLabel: string;
  placeholder: string;
  values: readonly string[];
  validate: (value: string) => boolean;
  invalidMessage: string;
  duplicateMessage?: string;
  disabled: boolean;
  onChange: (next: string[]) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const value = draft.trim();
    if (!value) return;
    if (!validate(value)) {
      setError(invalidMessage);
      return;
    }
    if (values.includes(value)) {
      setError(duplicateMessage ?? null);
      return;
    }
    setError(null);
    setDraft("");
    void onChange([...values, value]);
  };
  return (
    <>
      <SettingsRow
        {...(id === undefined ? {} : { id })}
        title={title}
        description={description}
        status={error ? <span className="text-destructive">{error}</span> : undefined}
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              value={draft}
              disabled={disabled}
              placeholder={placeholder}
              className="sm:w-56"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            <Button size="xs" variant="outline" disabled={disabled || !draft.trim()} onClick={add}>
              {addLabel}
            </Button>
          </div>
        }
      />
      {values.map((value) => (
        <SettingsListRow
          key={value}
          title={<span className="font-mono text-ui-sm text-foreground">{value}</span>}
          actions={
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => void onChange(values.filter((entry) => entry !== value))}
            >
              {removeLabel}
            </Button>
          }
        />
      ))}
    </>
  );
}

const WEB_PAGE_QUERY_KEY = ["neolix-web-page"] as const;

function BrowserAccessSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const pageQuery = useQuery({
    queryKey: WEB_PAGE_QUERY_KEY,
    queryFn: getWebPage,
    enabled: active,
    staleTime: 5_000,
    retry: false,
  });
  const page = pageQuery.data?.page;
  const pagePort = page?.port;
  const [portDraft, setPortDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (pagePort !== undefined) setPortDraft(String(pagePort));
  }, [pagePort]);

  const update = useCallback(
    async (patch: NeolixWebPagePatch) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await setWebPage(patch);
        if (result.page) queryClient.setQueryData(WEB_PAGE_QUERY_KEY, { page: result.page });
        if (result.error !== undefined) setError(localizeNetworkError(result.error, t));
      } catch (cause) {
        setError(localizeNetworkError(cause, t));
      }
      setBusy(false);
    },
    [busy, queryClient, t],
  );

  let body: ReactNode;
  if (pageQuery.isLoading) {
    body = <SettingsRow title={t("settings:host_pageStarting")} description="" />;
  } else if (pageQuery.error || !page) {
    body = (
      <SettingsRow
        title={t("settings:host_pageUnavailable")}
        description={pageQuery.error ? errorMessage(pageQuery.error) : ""}
      />
    );
  } else {
    const links = (page.mode === "lan" ? [page.link, ...page.network] : [page.link]).filter(
      (link): link is string => link !== null && link.length > 0,
    );
    const status = error ?? (page.error ? localizeNetworkError(page.error, t) : null);
    body = (
      <>
        <SettingsRow
          title={t("settings:host_openInBrowser")}
          description={t("settings:host_openInBrowserDescription", { port: page.port })}
          control={
            <SettingsSegmentedControl<"off" | "local" | "lan">
              ariaLabel={t("settings:host_openInBrowser")}
              value={page.mode}
              disabled={busy}
              onValueChange={(mode) => void update({ mode })}
              options={[
                { value: "off", label: "settings:host_pageOff" },
                { value: "local", label: "settings:host_pageLocal" },
                { value: "lan", label: "settings:host_pageLan" },
              ]}
            />
          }
        />
        {page.mode === "off" ? null : (
          <>
            <SettingsRow
              id="setting-network-page-key"
              title={t("settings:host_pageLink")}
              description={
                status
                  ? status
                  : page.serving
                    ? t("settings:host_pageServed")
                    : t("settings:host_pageStarting")
              }
              status={status ? <span className="text-destructive">{status}</span> : undefined}
              control={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void update({ newKey: true })}
                >
                  {t("settings:host_pageNewKey")}
                </Button>
              }
            />
            {links.map((link) => (
              <SettingsListRow
                key={link}
                title={
                  <code className="block truncate font-mono text-ui-sm text-foreground">
                    {link.replace(/\?k=.*/, "?k=…")}
                  </code>
                }
                actions={
                  <CopyTextButton text={link} label={t("settings:host_pageCopy")} iconOnly />
                }
              />
            ))}
            <SettingsRow
              title={t("settings:host_pagePort")}
              description={t("settings:host_pagePortDescription")}
              control={
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <Input
                    value={portDraft}
                    disabled={busy}
                    inputMode="numeric"
                    aria-label={t("settings:host_pagePort")}
                    className="sm:w-32"
                    onChange={(event) => setPortDraft(event.target.value)}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      const port = parseDaemonPort(portDraft);
                      if (port === null) {
                        setError(t("settings:host_pagePortInvalid"));
                        return;
                      }
                      void update({ port });
                    }}
                  >
                    {t("settings:host_save")}
                  </Button>
                </div>
              }
            />
            {page.mode === "lan" && page.tls !== true ? (
              <SettingsRow
                title={t("settings:host_pageUnencrypted")}
                description={t("settings:host_pageUnencryptedDescription")}
              />
            ) : null}
          </>
        )}
      </>
    );
  }

  return <SettingsSection title={t("settings:host_browserAccess")}>{body}</SettingsSection>;
}

const GITHUB_TOKEN_QUERY_KEY = ["neolix-github-token"] as const;

function GithubTokenSection({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: GITHUB_TOKEN_QUERY_KEY,
    queryFn: getLibraryGithubToken,
    enabled: active,
    staleTime: 10_000,
    retry: false,
  });
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = query.data?.configured === true;
  const rejected = query.data?.rejected === true;

  const write = async (token: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await setLibraryGithubToken(token);
      queryClient.setQueryData(GITHUB_TOKEN_QUERY_KEY, {
        configured: result.configured,
        rejected: false,
      });
      setDraft("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
    setBusy(false);
  };

  const status: ReactNode = error ? (
    <span className="text-destructive">{error}</span>
  ) : query.isLoading ? (
    t("settings:host_loading")
  ) : query.error ? (
    t("settings:unavailable")
  ) : rejected ? (
    t("settings:host_githubTokenRejected")
  ) : configured ? (
    t("settings:host_githubTokenConfigured")
  ) : (
    t("settings:host_githubTokenNotConfigured")
  );

  return (
    <SettingsSection title={t("settings:host_githubSection")}>
      <SettingsRow
        id="setting-network-github-token"
        title={t("settings:host_githubToken")}
        description={t("settings:host_githubTokenDescription")}
        status={status}
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Input
              type="password"
              value={draft}
              disabled={busy}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder={t("settings:host_githubTokenPlaceholder")}
              className="sm:w-56"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && draft.trim()) void write(draft.trim());
              }}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !draft.trim()}
              onClick={() => void write(draft.trim())}
            >
              {t("settings:host_save")}
            </Button>
            {configured ? (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void write("")}>
                {t("settings:host_clear")}
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}

export function HostNetworkSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { config, isLoading, saving, patch } = useHostConfig(active);
  const gateway = useGatewayConfig(active);
  const statusQuery = useHostStatus(active);
  const network = config?.network;
  const container = statusQuery.data?.container === true;
  const gatewayConfig = gateway.config;
  const gatewayDisabled = gatewayConfig === undefined || gateway.isLoading;
  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_localNetwork")}>
        <BooleanHostRow
          title={t("settings:host_shareOnLan")}
          description={t("settings:host_shareOnLanDescription")}
          value={network?.lan === true}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) => patch({ network: { lan: checked } })}
        />
        <DraftRow
          id="setting-network-port"
          title={t("settings:host_port")}
          description={t("settings:host_portDescription")}
          value={String(network?.port ?? "")}
          placeholder="6768"
          type="number"
          disabled={isLoading || saving || config === undefined}
          validate={(value) =>
            parseDaemonPort(value) === null ? t("settings:host_portInvalid") : null
          }
          onSave={(value) => {
            const port = parseDaemonPort(value);
            if (port === null) return Promise.resolve(false);
            return patch({ network: { port } });
          }}
        />
        {container ? (
          <SettingsRow
            title={t("settings:host_inContainer")}
            description={t("settings:host_inContainerDescription")}
            status={statusQuery.data?.listen ?? "—"}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection title={t("settings:host_addresses")}>
        <SettingsRow
          title={t("settings:host_listeningOn")}
          description={t("settings:host_listeningOnDescription")}
          status={network?.listen || (network?.lanUrls?.length ? network.lanUrls.join(", ") : "—")}
        />
      </SettingsSection>
      <SettingsSection title={t("settings:host_webPages")}>
        <HostStringListRows
          id="setting-network-allow-ips"
          title={t("settings:host_allowIPs")}
          description={t("settings:host_allowIPsDescription")}
          addLabel={t("settings:host_add")}
          removeLabel={t("settings:host_remove")}
          placeholder="192.168.1.0/24"
          values={stringList(gatewayConfig?.allowIPs)}
          validate={isIpOrCidr}
          invalidMessage={t("settings:host_allowIPsInvalid")}
          duplicateMessage={t("settings:host_allowIPsDuplicate")}
          disabled={gatewayDisabled}
          onChange={(next) =>
            gatewayConfig
              ? gateway.save({ ...gatewayConfig, allowIPs: next })
              : Promise.resolve(null)
          }
        />
        <HostStringListRows
          title={t("settings:host_corsOrigins")}
          description={t("settings:host_corsOriginsDescription")}
          addLabel={t("settings:host_add")}
          removeLabel={t("settings:host_remove")}
          placeholder="http://localhost:3000"
          values={stringList(gatewayConfig?.corsOrigins)}
          validate={isHttpOrigin}
          invalidMessage={t("settings:host_corsOriginsInvalid")}
          disabled={gatewayDisabled}
          onChange={(next) =>
            gatewayConfig
              ? gateway.save({ ...gatewayConfig, corsOrigins: next })
              : Promise.resolve(null)
          }
        />
      </SettingsSection>
      <BrowserAccessSection active={active} />
      <GithubTokenSection active={active} />
    </div>
  );
}

// ── Privacy ────────────────────────────────────────────────────────────────

/** The gateway config without the legacy "open sign-in pages" inverse switch. */
function withoutSignInLinkOnly(config: GatewayConfigWire): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  delete next.codexSignInLinkOnly;
  return next;
}

export function HostPrivacySettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { config, isLoading, saving, patch } = useHostConfig(active);
  const gateway = useGatewayConfig(active);
  const { settings, updateSettings } = useAppSettings();
  const readsQuery = useQuery({
    queryKey: ["neolix-session-reads"],
    queryFn: getSessionReads,
    enabled: active,
    staleTime: 10_000,
  });
  const reads = readsQuery.data?.reads ?? null;

  const changeReads = useCallback(
    async (input: { all?: boolean; agents?: Record<string, boolean> }) => {
      try {
        await setSessionReads(input);
        await readsQuery.refetch();
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: t("settings:host_couldNotChangeSessionReads"),
          description: errorMessage(cause),
        });
      }
    },
    [readsQuery, t],
  );

  if (!active) return null;
  const telemetry = config?.telemetry;
  const gatewayConfig = gateway.config;
  const discovery =
    (gatewayConfig?.accountDiscovery ?? gatewayConfig?.codexAccountDiscovery) !== false;
  const openSignInPages = gatewayConfig?.codexSignInLinkOnly !== true;
  const gatewayDisabled = gatewayConfig === undefined || gateway.isLoading;

  const changeDiscovery = async (next: boolean) => {
    if (!gatewayConfig || next === discovery) return;
    if (!next) {
      const sure = await confirmAction(t("settings:host_discoveryOffMessage"), {
        confirmLabel: t("common:confirm_turnOff"),
        destructive: true,
      });
      if (!sure) return;
    }
    await gateway.save({ ...gatewayConfig, accountDiscovery: next });
  };

  const changeOpenSignInPages = async (open: boolean) => {
    if (!gatewayConfig || open === openSignInPages) return;
    await gateway.save(
      open ? withoutSignInLinkOnly(gatewayConfig) : { ...gatewayConfig, codexSignInLinkOnly: true },
    );
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_signIns")}>
        <BooleanHostRow
          id="setting-privacy-subscription-accounts"
          title={t("settings:host_subscriptionAccounts")}
          description={t("settings:host_subscriptionAccountsDescription")}
          value={discovery}
          disabled={gatewayDisabled}
          onCheckedChange={(checked) => void changeDiscovery(checked)}
        />
        <BooleanHostRow
          title={t("settings:host_openSignInPages")}
          description={t("settings:host_openSignInPagesDescription")}
          value={openSignInPages}
          disabled={gatewayDisabled}
          onCheckedChange={(checked) => void changeOpenSignInPages(checked)}
        />
      </SettingsSection>

      <SettingsSection title={t("settings:host_sessionAccess")}>
        <SettingsRow
          id="setting-privacy-read-sessions"
          title={t("settings:host_readAgentSessions")}
          description={t("settings:host_readAgentSessionsDescription")}
          status={
            readsQuery.isLoading
              ? t("settings:host_loading")
              : reads
                ? undefined
                : t("settings:unavailable")
          }
          control={
            <Switch
              checked={reads?.all === true}
              disabled={readsQuery.isLoading || reads === null}
              onCheckedChange={(checked) => void changeReads({ all: checked === true })}
              aria-label={t("settings:host_readAgentSessions")}
            />
          }
        />
        {reads?.found.map((entry) => (
          <SettingsListRow
            key={entry.agent}
            title={entry.name}
            actions={
              <Switch
                checked={entry.on}
                onCheckedChange={(checked) =>
                  void changeReads({ agents: { [entry.agent]: checked === true } })
                }
                aria-label={t("settings:host_readSessionsAria", { name: entry.name })}
              />
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection title={t("settings:host_sharing")}>
        <BooleanHostRow
          title={t("settings:host_hideAccounts")}
          description={t("settings:host_hideAccountsDescription")}
          value={settings.maskAccounts}
          disabled={false}
          onCheckedChange={(checked) => updateSettings({ maskAccounts: checked })}
        />
        <BooleanHostRow
          title={t("settings:host_sendUsageData")}
          description={t("settings:host_sendUsageDataDescription")}
          value={telemetry?.enabled === true}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) =>
            patch({
              telemetry: {
                enabled: checked,
                // Turning sharing off forgets the narrower choice too.
                ...(checked ? {} : { shareUsage: false }),
                decidedAt: new Date().toISOString(),
              },
            })
          }
        />
        <BooleanHostRow
          title={t("settings:host_shareUsageDetails")}
          description={t("settings:host_shareUsageDetailsDescription")}
          value={telemetry?.shareUsage === true}
          disabled={telemetry?.enabled !== true}
          onCheckedChange={(checked) =>
            patch({ telemetry: { shareUsage: checked, decidedAt: new Date().toISOString() } })
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings:host_masking")}>
        <SettingsRow
          title={t("settings:host_maskingTitle")}
          description={t("settings:host_maskingDescription")}
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/settings",
                  search: { section: "gateway", gatewayTab: "masking" },
                })
              }
            >
              {t("settings:host_openMasking")}
            </Button>
          }
        />
      </SettingsSection>
    </div>
  );
}

// ── Observability ──────────────────────────────────────────────────────────

export function HostObservabilitySettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { config, isLoading, error, save } = useGatewayConfig(active);
  const [otel, setOtel] = useState<{
    enabled: boolean;
    endpoint: string;
    metrics: boolean;
    bodies: boolean;
    bodiesWhole: boolean;
    sessions: boolean;
  } | null>(null);
  const [otelError, setOtelError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!config) return;
    const current = config.otel ?? {};
    setOtel({
      enabled: current.enabled === true,
      endpoint: current.endpoint ?? "",
      metrics: current.metrics === true,
      bodies: current.bodies === true,
      bodiesWhole: current.bodiesWhole === true,
      sessions: current.sessions === true,
    });
  }, [config]);

  const write = useCallback(
    async (next: Partial<NonNullable<typeof otel>>): Promise<boolean> => {
      if (!config || !otel) return false;
      const previous = otel;
      const merged = { ...otel, ...next };
      const endpoint = merged.endpoint.trim();
      setOtel(merged);
      setBusy(true);
      // An empty endpoint is absent, not an empty string the schema rejects;
      // fields this panel does not edit (headers) are kept as they are.
      const current = { ...config.otel };
      delete current.endpoint;
      const wire = {
        ...current,
        enabled: merged.enabled,
        ...(endpoint ? { endpoint } : {}),
        metrics: merged.metrics,
        bodies: merged.bodies,
        bodiesWhole: merged.bodiesWhole,
        sessions: merged.sessions,
      };
      const saved = await save({ ...config, otel: wire });
      setBusy(false);
      if (!saved) {
        setOtel(previous);
        return false;
      }
      setOtelError(null);
      return true;
    },
    [config, otel, save],
  );

  const changeEnabled = (checked: boolean) => {
    if (!otel) return;
    if (!checked) {
      setOtelError(null);
      void write({ enabled: false });
      return;
    }
    const endpoint = otel.endpoint.trim();
    if (endpoint.length === 0) {
      setOtelError(t("settings:host_otelEndpointRequired"));
      return;
    }
    if (!isCollectorEndpoint(endpoint)) {
      setOtelError(t("settings:host_otelEndpointInvalid"));
      return;
    }
    setOtelError(null);
    void write({ enabled: true });
  };

  if (!active) return null;
  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_traceExport")}>
        {otel === null ? (
          <SettingsEmptyState layout="status">
            {error
              ? t("settings:host_unavailableWith", { error })
              : isLoading
                ? t("settings:host_loading")
                : t("settings:host_noGatewayConfig")}
          </SettingsEmptyState>
        ) : (
          <>
            <BooleanHostRow
              id="setting-observability-export-traces"
              title={t("settings:host_exportTraces")}
              description={t("settings:host_exportTracesDescription")}
              value={otel.enabled}
              disabled={busy}
              status={otelError ? <span className="text-destructive">{otelError}</span> : undefined}
              onCheckedChange={changeEnabled}
            />
            <DraftRow
              id="setting-observability-collector-endpoint"
              title={t("settings:host_collectorEndpoint")}
              description={t("settings:host_collectorEndpointDescription")}
              value={otel.endpoint}
              placeholder="http://127.0.0.1:4318/v1/traces"
              wide
              disabled={busy}
              validate={(value) => {
                const endpoint = value.trim();
                if (endpoint.length === 0) {
                  return otel.enabled ? t("settings:host_otelEndpointRequired") : null;
                }
                return isCollectorEndpoint(endpoint)
                  ? null
                  : t("settings:host_otelEndpointInvalid");
              }}
              onSave={(value) => write({ endpoint: value })}
            />
            <BooleanHostRow
              title={t("settings:host_histograms")}
              description={t("settings:host_histogramsDescription")}
              value={otel.metrics}
              disabled={!otel.enabled || busy}
              onCheckedChange={(checked) => void write({ metrics: checked })}
            />
            <BooleanHostRow
              title={t("settings:host_attachBodies")}
              description={t("settings:host_attachBodiesDescription")}
              value={otel.bodies}
              disabled={!otel.enabled || busy}
              onCheckedChange={(checked) => void write({ bodies: checked })}
            />
            <BooleanHostRow
              title={t("settings:host_bodiesWhole")}
              description={t("settings:host_bodiesWholeDescription")}
              value={otel.bodiesWhole}
              disabled={!otel.enabled || !otel.bodies || busy}
              onCheckedChange={(checked) => void write({ bodiesWhole: checked })}
            />
            <BooleanHostRow
              title={t("settings:host_traceLocalAgents")}
              description={t("settings:host_traceLocalAgentsDescription")}
              value={otel.sessions}
              disabled={!otel.enabled || busy}
              onCheckedChange={(checked) => void write({ sessions: checked })}
            />
          </>
        )}
      </SettingsSection>
    </div>
  );
}

// ── Quota ──────────────────────────────────────────────────────────────────

export function HostQuotaSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { config, isLoading, saving, patch } = useHostConfig(active);
  const { settings, updateSettings } = useAppSettings();
  const usageAlertOn = (config?.usageAlertPercent ?? 0) > 0;
  const balanceAlertOn = (config?.balanceAlert ?? 0) > 0;
  const resetHours = settings.resetReminderHours ?? 0;
  if (!active) return null;
  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_alerts")}>
        <BooleanHostRow
          id="setting-quota-read-usage"
          title={t("settings:host_readProviderUsage")}
          description={t("settings:host_readProviderUsageDescription")}
          value={config?.usage?.enabled === true}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) => patch({ usage: { enabled: checked } })}
        />
        <BooleanHostRow
          id="setting-quota-window-alert"
          title={t("settings:host_notifyWindowUsed")}
          description={t("settings:host_notifyWindowUsedDescription")}
          value={usageAlertOn}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) => patch({ usageAlertPercent: checked ? 80 : 0 })}
        />
        {usageAlertOn ? (
          <DraftRow
            title={t("settings:host_notifyWindowUsedAt")}
            description={t("settings:host_notifyWindowUsedAtDescription")}
            value={String(config?.usageAlertPercent ?? 80)}
            type="number"
            disabled={isLoading || saving || config === undefined}
            onSave={(value) => {
              const percent = Number(value);
              if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
                toastManager.add({
                  type: "error",
                  title: t("settings:host_percentInvalid"),
                });
                return Promise.resolve(false);
              }
              return patch({ usageAlertPercent: percent });
            }}
          />
        ) : null}
        <BooleanHostRow
          id="setting-quota-balance-alert"
          title={t("settings:host_notifyBalance")}
          description={t("settings:host_notifyBalanceDescription")}
          value={balanceAlertOn}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) => patch({ balanceAlert: checked ? 5 : 0 })}
        />
        {balanceAlertOn ? (
          <DraftRow
            title={t("settings:host_notifyBalanceAt")}
            description={t("settings:host_notifyBalanceAtDescription")}
            value={String(config?.balanceAlert ?? 5)}
            type="number"
            disabled={isLoading || saving || config === undefined}
            onSave={(value) => {
              const balance = Number(value);
              if (!Number.isFinite(balance) || balance <= 0) {
                toastManager.add({
                  type: "error",
                  title: t("settings:host_balanceInvalid"),
                });
                return Promise.resolve(false);
              }
              return patch({ balanceAlert: balance });
            }}
          />
        ) : null}
        <SettingsRow
          id="setting-quota-reset-reminder"
          title={t("settings:host_resetReminder")}
          description={t("settings:host_resetReminderDescription")}
          control={
            <SettingsSegmentedControl
              value={String(resetHours)}
              onValueChange={(value) => updateSettings({ resetReminderHours: Number(value) })}
              ariaLabel={t("settings:host_resetReminder")}
              options={[0, 12, 24, 48].map((hours) => ({
                value: String(hours),
                label:
                  hours === 0 ? t("settings:host_off") : t("settings:host_hoursShort", { hours }),
              }))}
            />
          }
        />
      </SettingsSection>
    </div>
  );
}

// ── Terminals ──────────────────────────────────────────────────────────────

const PROMPT_SENTINEL = "{{{prompt}}}";

/** The daemon's built-ins, shown until the host's own list is written. */
const DEFAULT_TERMINAL_PROFILES = [
  { id: "claude", name: "Claude Code", command: "claude", args: [PROMPT_SENTINEL], icon: "claude" },
  { id: "codex", name: "Codex", command: "codex", args: [PROMPT_SENTINEL], icon: "codex" },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: [`--prompt=${PROMPT_SENTINEL}`],
    icon: "opencode",
  },
  { id: "pi", name: "Pi", command: "pi", args: [PROMPT_SENTINEL], icon: "pi" },
] as const;

function parseArgs(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  return trimmed ? trimmed.split(/\s+/).filter(Boolean) : undefined;
}

function newProfileId(): string {
  return `profile_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

/** Terminal profiles store the daemon's provider ids; the web icon set calls Claude `claudeAgent`. */
function terminalProfileIcon(icon: string | undefined): ReactNode {
  const kind = icon === "claude" ? "claudeAgent" : icon;
  return kind && isProviderKind(kind) ? (
    <ProviderIcon provider={kind} className="size-4" />
  ) : (
    <TerminalIcon className="size-4 text-muted-foreground" aria-hidden />
  );
}

interface ProfileDraftState {
  readonly id: string | null;
  readonly name: string;
  readonly command: string;
  readonly args: string;
}

export function HostTerminalSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { config, isLoading, saving, patch } = useHostConfig(active);
  const [draft, setDraft] = useState<ProfileDraftState | null>(null);
  const profiles = useMemo(() => config?.terminalProfiles ?? DEFAULT_TERMINAL_PROFILES, [config]);

  if (!active) return null;

  const save = async (
    next: ReadonlyArray<{
      id: string;
      name: string;
      command: string;
      args?: ReadonlyArray<string>;
      icon?: string;
    }>,
  ) => {
    const saved = await patch({ terminalProfiles: next });
    if (saved) setDraft(null);
    return saved;
  };

  const commitDraft = () => {
    if (!draft) return;
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!name || !command) {
      toastManager.add({ type: "error", title: t("settings:host_profileNeedsNameCommand") });
      return;
    }
    const args = parseArgs(draft.args);
    if (draft.id === null) {
      void save([...profiles, { id: newProfileId(), name, command, ...(args ? { args } : {}) }]);
      return;
    }
    void save(
      profiles.map((profile) =>
        profile.id === draft.id ? { ...profile, name, command, args: args ?? [] } : profile,
      ),
    );
  };

  const move = (id: string, delta: number) => {
    const index = profiles.findIndex((profile) => profile.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= profiles.length) return;
    const next = [...profiles];
    const [entry] = next.splice(index, 1);
    if (!entry) return;
    next.splice(target, 0, entry);
    void save(next);
  };

  const remove = async (profile: { readonly id: string; readonly name: string }) => {
    const confirmed = await confirmAction(
      t("settings:host_removeProfileConfirm", { name: profile.name }),
      { confirmLabel: t("common:confirm_remove"), destructive: true },
    );
    if (!confirmed) return;
    void save(profiles.filter((entry) => entry.id !== profile.id));
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_terminalProfiles")}>
        {profiles.map((profile, index) => (
          <SettingsListRow
            key={profile.id}
            leading={terminalProfileIcon(profile.icon)}
            title={profile.name}
            description={
              <span className="font-mono text-ui-sm">
                {[profile.command, ...(profile.args ?? [])].join(" ")}
              </span>
            }
            actions={
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={saving}
                  onClick={() =>
                    setDraft({
                      id: profile.id,
                      name: profile.name,
                      command: profile.command,
                      args: (profile.args ?? []).join(" "),
                    })
                  }
                >
                  {t("settings:host_edit")}
                </Button>
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        disabled={saving}
                        aria-label={t("settings:hostData_moreActions", { title: profile.name })}
                      />
                    }
                  >
                    <EllipsisIcon />
                  </MenuTrigger>
                  <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-36">
                    <MenuItem disabled={index === 0} onClick={() => move(profile.id, -1)}>
                      {t("settings:host_up")}
                    </MenuItem>
                    <MenuItem
                      disabled={index === profiles.length - 1}
                      onClick={() => move(profile.id, 1)}
                    >
                      {t("settings:host_down")}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => void remove(profile)}>
                      {t("settings:host_remove")}
                    </MenuItem>
                  </ComposerPickerMenuPopup>
                </Menu>
              </div>
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title={
          draft?.id === null || draft === null
            ? t("settings:host_addProfile")
            : t("settings:host_editProfile")
        }
      >
        <form
          className="space-y-3 p-4"
          onSubmit={(event) => {
            // Enter in any field saves, like every other settings editor.
            event.preventDefault();
            if (!saving) commitDraft();
          }}
        >
          <p className="text-ui-sm text-muted-foreground">
            {t("settings:host_profileEditorDescription")}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-ui-sm">
              <span className="text-muted-foreground">{t("settings:host_name")}</span>
              <Input
                value={draft?.name ?? ""}
                placeholder="Claude Code"
                disabled={draft === null}
                onChange={(event) =>
                  setDraft((previous) =>
                    previous ? { ...previous, name: event.target.value } : previous,
                  )
                }
              />
            </label>
            <label className="space-y-1 text-ui-sm">
              <span className="text-muted-foreground">{t("settings:host_command")}</span>
              <Input
                value={draft?.command ?? ""}
                placeholder="claude"
                className="font-mono"
                disabled={draft === null}
                onChange={(event) =>
                  setDraft((previous) =>
                    previous ? { ...previous, command: event.target.value } : previous,
                  )
                }
              />
            </label>
            <label className="space-y-1 text-ui-sm">
              <span className="text-muted-foreground">{t("settings:host_arguments")}</span>
              <Input
                value={draft?.args ?? ""}
                placeholder="{{{prompt}}}"
                className="font-mono"
                disabled={draft === null}
                onChange={(event) =>
                  setDraft((previous) =>
                    previous ? { ...previous, args: event.target.value } : previous,
                  )
                }
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            {draft === null ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={isLoading || saving}
                onClick={() => setDraft({ id: null, name: "", command: "", args: "" })}
              >
                {t("settings:host_add")}
              </Button>
            ) : (
              <>
                <Button type="submit" size="xs" variant="outline" disabled={saving}>
                  {saving ? t("settings:host_saving") : t("settings:host_save")}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setDraft(null)}
                >
                  {t("common:form_cancel")}
                </Button>
              </>
            )}
          </div>
        </form>
      </SettingsSection>
    </div>
  );
}

// ── Voice ──────────────────────────────────────────────────────────────────

export function HostVoiceSettingsPanel({ active }: { readonly active: boolean }) {
  const { t } = useTranslation();
  const { config, isLoading, saving, patch } = useHostConfig(active);
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({
    queryKey: ["neolix-speech-models"],
    queryFn: listSpeechModels,
    enabled: active,
    refetchInterval: active ? 5_000 : false,
  });
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [editingSite, setEditingSite] = useState<VoiceSiteId | null>(null);

  const runModelAction = useCallback(
    async (
      modelId: string,
      action: () => Promise<unknown>,
      messages: { success: string; failure: string },
    ) => {
      setBusyModel(modelId);
      try {
        await action();
        toastManager.add({ type: "success", title: messages.success });
        await queryClient.invalidateQueries({ queryKey: ["neolix-speech-models"] });
        await queryClient.invalidateQueries({ queryKey: ["neolix-host-config"] });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: messages.failure,
          description: errorMessage(cause),
        });
      }
      setBusyModel(null);
    },
    [queryClient],
  );

  if (!active) return null;
  const features = config?.features;
  const models = modelsQuery.data?.models ?? [];

  const siteSummary = (
    siteId: VoiceSiteId,
    kind: VoiceSiteKind,
    site: VoiceSiteSettings | undefined,
  ): string => {
    if (!site) return t("settings:voice_unknown");
    if (site.provider === "openai") {
      const envKey = config?.envOverrides?.[`features.${siteId}.apiKey`];
      const model = site.model ?? (kind === "stt" ? "whisper-1" : "tts-1");
      return `${t("settings:voice_providerOpenAi")} · ${
        !site.hasApiKey && !envKey ? t("settings:voice_missingKey") : model
      }`;
    }
    if (site.provider === "local") {
      const selected = site.model
        ? models.find((model) => model.id === site.model)
        : models.find((model) => model.kind === kind && model.isDefault);
      return `${t("settings:voice_providerLocal")}${selected ? ` · ${selected.label}` : ""}`;
    }
    return site.provider ?? t("settings:voice_unknown");
  };

  const siteTitle = (siteId: VoiceSiteId): string => {
    switch (siteId) {
      case "dictation.stt":
        return t("settings:voice_siteDictation");
      case "voiceMode.stt":
        return t("settings:voice_siteVoiceModeStt");
      case "voiceMode.tts":
        return t("settings:voice_siteVoiceModeTts");
    }
  };

  const siteRow = (
    siteId: VoiceSiteId,
    kind: VoiceSiteKind,
    site: VoiceSiteSettings | undefined,
  ) => {
    // A provider this page does not know may come from a newer host; leave it unedited.
    const known =
      site?.provider === undefined || site.provider === "local" || site.provider === "openai";
    return (
      <SettingsListRow
        title={siteTitle(siteId)}
        description={siteSummary(siteId, kind, site)}
        actions={
          <Button
            size="xs"
            variant="outline"
            disabled={saving || config === undefined || !known}
            onClick={() => setEditingSite(siteId)}
          >
            {t("settings:host_edit")}
          </Button>
        }
      />
    );
  };

  const saveSite = (siteId: VoiceSiteId, nextPatch: VoiceSitePatch) => {
    const next =
      siteId === "dictation.stt"
        ? { features: { dictation: { stt: nextPatch } } }
        : siteId === "voiceMode.stt"
          ? { features: { voiceMode: { stt: nextPatch } } }
          : { features: { voiceMode: { tts: nextPatch } } };
    void patch(next).then((ok) => {
      if (!ok) return;
      setEditingSite(null);
      void queryClient.invalidateQueries({ queryKey: ["neolix-speech-models"] });
    });
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings:host_speech")}>
        <BooleanHostRow
          title={t("settings:host_dictation")}
          description={t("settings:host_dictationDescription")}
          value={features?.dictation?.enabled === true}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) => patch({ features: { dictation: { enabled: checked } } })}
        />
        {siteRow("dictation.stt", "stt", features?.dictation?.stt)}
        <BooleanHostRow
          title={t("settings:host_voiceMode")}
          description={t("settings:host_voiceModeDescription")}
          value={features?.voiceMode?.enabled === true}
          disabled={isLoading || saving || config === undefined}
          onCheckedChange={(checked) => patch({ features: { voiceMode: { enabled: checked } } })}
        />
        {siteRow("voiceMode.stt", "stt", features?.voiceMode?.stt)}
        {siteRow("voiceMode.tts", "tts", features?.voiceMode?.tts)}
      </SettingsSection>
      <SettingsSection title={t("settings:host_localModels")}>
        {modelsQuery.isLoading ? (
          <SettingsEmptyState layout="status">{t("settings:host_loading")}</SettingsEmptyState>
        ) : modelsQuery.data?.models.length ? (
          modelsQuery.data.models.map((model) => (
            <SettingsListRow
              key={model.id}
              title={speechModelDisplayLabel(model.label, t)}
              description={`${model.kind.toUpperCase()} · ${formatBytes(model.downloadSizeBytes)} · ${speechModelStatusLabel(model.status, t)}`}
              actions={
                model.status === "installed" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={model.inUse || busyModel !== null}
                    onClick={() =>
                      void runModelAction(model.id, () => deleteSpeechModel(model.id), {
                        success: t("settings:host_modelDeleted", { model: model.id }),
                        failure: t("settings:host_couldNotDeleteModel", { model: model.id }),
                      })
                    }
                  >
                    {t("settings:host_delete")}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={model.status === "downloading" || busyModel !== null}
                    onClick={() =>
                      void runModelAction(model.id, () => downloadSpeechModel(model.id), {
                        success: t("settings:host_modelDownloading", { model: model.id }),
                        failure: t("settings:host_couldNotDownloadModel", { model: model.id }),
                      })
                    }
                  >
                    {t("settings:host_download")}
                  </Button>
                )
              }
            />
          ))
        ) : (
          <SettingsEmptyState layout="status">
            {t("settings:host_noLocalModels")}
          </SettingsEmptyState>
        )}
      </SettingsSection>
      <p className={cn("text-ui-sm text-muted-foreground")}>{t("settings:host_voiceFootnote")}</p>
      {editingSite !== null ? (
        <VoiceProviderDialog
          key={editingSite}
          siteId={editingSite}
          kind={editingSite === "voiceMode.tts" ? "tts" : "stt"}
          site={
            editingSite === "dictation.stt"
              ? features?.dictation?.stt
              : editingSite === "voiceMode.stt"
                ? features?.voiceMode?.stt
                : features?.voiceMode?.tts
          }
          envOverrides={config?.envOverrides ?? {}}
          models={models}
          saving={saving}
          title={siteTitle(editingSite)}
          onClose={() => setEditingSite(null)}
          onSave={(nextPatch) => saveSite(editingSite, nextPatch)}
        />
      ) : null}
    </div>
  );
}
