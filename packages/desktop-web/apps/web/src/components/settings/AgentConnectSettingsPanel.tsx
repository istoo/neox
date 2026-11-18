// FILE: AgentConnectSettingsPanel.tsx
// Purpose: Settings › Agents › Agent Connect. Each installed agent gets one row:
//          the connect switch, its gateway model, the models its own list hides,
//          the shell function, and (in Arrange mode) order and visibility.
//          Saved setups are the profiles section below the list.
// Layer: Settings panel

import type {
  AgentConnectEntry,
  AgentConnectModel,
  AgentConnectSetting,
  AgentConnectSnapshot,
} from "@synara/contracts";
import { Fragment, useCallback, useMemo, useState } from "react";

import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useAgentConnect } from "~/hooks/useAgentConnect";
import { useTranslation } from "~/i18n";
import { ArrowDownIcon, ArrowUpIcon } from "~/lib/icons";
import { readNativeApi } from "~/nativeApi";
import { PluginSlotPanels } from "~/plugins/PluginSlotPanels";

import {
  AgentConnectModelSelect,
  AgentConnectStatusLine,
} from "../agentConnect/AgentConnectControls";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsSelectControl } from "./SettingControls";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";
import {
  agentLabel,
  buildRows,
  canReapply,
  isConnectBlocked,
  modelLabel,
  modelWhenToggling,
  moveProvider,
  orderAgentRows,
  reapplyModel,
  splitConnectedRows,
  splitHiddenRows,
  toggleHiddenModel,
  toggleHiddenProvider,
  type AgentConnectRow,
} from "./agentConnect/agentConnect.logic";
import { AgentConnectProfilesSection } from "./agentConnect/AgentConnectProfilesSection";

interface ModelsEditor {
  readonly provider: string;
  readonly name: string;
  readonly hidden: readonly string[];
}

interface ShellPrompt {
  readonly provider: string;
  readonly name: string;
  readonly enabled: boolean;
}

export function AgentConnectSettingsPanel() {
  const { t } = useTranslation();
  const connect = useAgentConnect();
  const snapshot = connect.snapshot;
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const [managing, setManaging] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [modelsEditor, setModelsEditor] = useState<ModelsEditor | null>(null);
  const [shellPrompt, setShellPrompt] = useState<ShellPrompt | null>(null);

  const models = useMemo(() => snapshot?.models ?? [], [snapshot]);
  const hidden = useMemo(() => snapshot?.hidden ?? [], [snapshot]);
  const rows = useMemo(
    () => orderAgentRows(buildRows(snapshot?.entries ?? []), snapshot?.order),
    [snapshot],
  );
  const { shown, hidden: hiddenRows } = useMemo(
    () => splitHiddenRows(rows, hidden),
    [hidden, rows],
  );
  const { used, rest } = useMemo(() => splitConnectedRows(shown), [shown]);
  const order = useMemo(() => rows.map((row) => row.provider), [rows]);
  const visible = managing || showAll ? [...used, ...rest] : used;
  const hiddenOpen = managing || showHidden;
  const restCount = rest.length;

  const reportError = useCallback(
    (error: unknown) => {
      toastManager.add({
        type: "error",
        title: t("settings:agentConnect_updateFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    },
    [t],
  );

  const reportSnapshot = useCallback(
    (next: AgentConnectSnapshot | null) => {
      if (next?.error) {
        toastManager.add({
          type: "error",
          title: t("settings:agentConnect_updateFailed"),
          description: next.error,
        });
      }
      return next;
    },
    [t],
  );

  /** Runs one row's write with its own pending state; the snapshot is applied by the hook. */
  const runProvider = useCallback(
    async (provider: string, action: () => Promise<AgentConnectSnapshot | null>) => {
      setSavingProvider(provider);
      try {
        reportSnapshot(await action());
      } catch (error) {
        reportError(error);
      }
      setSavingProvider(null);
    },
    [reportError, reportSnapshot],
  );

  const saveLayout = useCallback(
    (nextOrder: readonly string[], nextHidden: readonly string[]) => {
      void connect
        .setLayout({ order: nextOrder, hidden: nextHidden })
        .then(reportSnapshot)
        .catch(reportError);
    },
    [connect, reportError, reportSnapshot],
  );

  const toggleConnected = useCallback(
    (entry: AgentConnectEntry, next: boolean) => {
      void runProvider(entry.provider, () =>
        connect.setConnected(entry.provider, next, modelWhenToggling(entry)),
      );
    },
    [connect, runProvider],
  );

  const selectModel = useCallback(
    (provider: string, model: string) => {
      void runProvider(provider, () => connect.setConnected(provider, true, model));
    },
    [connect, runProvider],
  );

  const reapply = useCallback(
    (entry: AgentConnectEntry) => {
      void runProvider(entry.provider, () =>
        connect.setConnected(entry.provider, true, reapplyModel(entry, models)),
      );
    },
    [connect, models, runProvider],
  );

  const saveModels = useCallback(
    (editor: ModelsEditor, nextHidden: string[]) => {
      setModelsEditor(null);
      void runProvider(editor.provider, () => connect.setModels(editor.provider, nextHidden));
    },
    [connect, runProvider],
  );

  const confirmShell = useCallback(
    (prompt: ShellPrompt) => {
      setShellPrompt(null);
      void runProvider(prompt.provider, () =>
        connect.setShellFunction(prompt.provider, prompt.enabled),
      );
    },
    [connect, runProvider],
  );

  const restartStale = useCallback(
    (provider: string, kind: "app" | "ide" | "daemon" | "cli") => {
      void runProvider(provider, () => connect.restartStale(provider, kind));
    },
    [connect, runProvider],
  );

  const copyLaunch = useCallback(
    (command: string) => {
      void copyTextToClipboard(command).then(() =>
        toastManager.add({
          type: "success",
          title: t("settings:agentConnect_launchCopied"),
        }),
      );
    },
    [t],
  );

  const openImportLink = useCallback(
    (link: string) => {
      const api = readNativeApi();
      if (!api) return;
      void api.shell.openExternal(link).catch(() =>
        copyTextToClipboard(link).then(() =>
          toastManager.add({
            type: "success",
            title: t("settings:agentConnect_linkCopied"),
          }),
        ),
      );
    },
    [t],
  );

  const runProfile = useCallback(
    async (action: () => Promise<AgentConnectSnapshot | null>, appliedName?: string) => {
      setSavingProfile(true);
      try {
        const next = reportSnapshot(await action());
        if (appliedName !== undefined && next?.error === null) {
          toastManager.add({
            type: "success",
            title: t("settings:agentConnect_profileApplied", { name: appliedName }),
          });
        }
      } catch (error) {
        reportError(error);
      }
      setSavingProfile(false);
    },
    [reportError, reportSnapshot, t],
  );

  const renderRow = useCallback(
    (row: AgentConnectRow, hiddenRow: boolean) => {
      const entry = row.entry;
      const label = agentLabel(entry, t);
      const saving = savingProvider === row.provider;
      const blocked = isConnectBlocked(entry, models, saving);
      const position = order.indexOf(row.provider);
      const shellInstalled = entry.shellInstalled;
      const launchCommand = entry.launchCommand ?? null;
      const importLink = entry.importLink ?? null;

      let actions;
      if (managing || hiddenRow) {
        actions = (
          <>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={position <= 0}
              aria-label={t("settings:agentConnect_moveUp", { name: label })}
              onClick={() => saveLayout(moveProvider(order, row.provider, -1), hidden)}
            >
              <ArrowUpIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={position < 0 || position >= order.length - 1}
              aria-label={t("settings:agentConnect_moveDown", { name: label })}
              onClick={() => saveLayout(moveProvider(order, row.provider, 1), hidden)}
            >
              <ArrowDownIcon className="size-3.5" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                saveLayout(order, toggleHiddenProvider(hidden, row.provider, !hiddenRow))
              }
            >
              {hiddenRow
                ? t("settings:agentConnect_showAgent", { name: label })
                : t("settings:agentConnect_hideAgent", { name: label })}
            </Button>
          </>
        );
      } else {
        actions = (
          <>
            {canReapply(entry) ? (
              <Button size="xs" variant="ghost" onClick={() => reapply(entry)}>
                {t("settings:agentConnect_reapply")}
              </Button>
            ) : null}
            {launchCommand === null ? null : (
              <Button size="xs" variant="ghost" onClick={() => copyLaunch(launchCommand)}>
                {t("settings:agentConnect_copyLaunch")}
              </Button>
            )}
            {importLink === null ? null : (
              <Button size="xs" variant="ghost" onClick={() => openImportLink(importLink)}>
                {t("settings:agentConnect_addViaLink")}
              </Button>
            )}
            {shellInstalled === undefined ? null : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setShellPrompt({
                    provider: row.provider,
                    name: label,
                    enabled: !shellInstalled,
                  })
                }
              >
                {shellInstalled
                  ? t("settings:agentConnect_shellRemove")
                  : t("settings:agentConnect_shellAdd")}
              </Button>
            )}
            {entry.models === undefined ? null : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setModelsEditor({
                    provider: row.provider,
                    name: label,
                    hidden: entry.models?.hidden ?? [],
                  })
                }
              >
                {entry.models.shown >= entry.models.listed
                  ? t("settings:agentConnect_modelsAll", { count: entry.models.listed })
                  : t("settings:agentConnect_modelsShowing", {
                      shown: entry.models.shown,
                      listed: entry.models.listed,
                    })}
              </Button>
            )}
            <AgentConnectModelSelect
              entry={entry}
              models={models}
              label={label}
              disabled={blocked}
              onSelectModel={(model) => selectModel(row.provider, model)}
            />
            <Switch
              checked={entry.connected}
              disabled={blocked}
              onCheckedChange={(checked) => toggleConnected(entry, Boolean(checked))}
              aria-label={t("settings:agentConnect_connectSwitch", { name: label })}
            />
          </>
        );
      }

      return (
        <SettingsListRow
          key={row.provider}
          align="start"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{label}</span>
              {entry.cliVersion === undefined ? null : (
                <span className="shrink-0 text-ui-xs text-muted-foreground">
                  {entry.cliVersion}
                </span>
              )}
            </span>
          }
          description={<AgentConnectStatusLine entry={entry} label={label} />}
          actions={actions}
        >
          <AgentConnectEntryExtras
            entry={entry}
            label={label}
            models={models}
            disabled={blocked}
            onSelectModel={selectModel}
            onSetField={(field, value) =>
              void runProvider(row.provider, () => connect.setField(row.provider, field, value))
            }
          />
          {(entry.staleCopies ?? []).map((copy) => (
            <div
              key={copy.kind}
              className="flex items-center gap-2 text-ui-sm text-muted-foreground"
            >
              <span className="text-amber-600 dark:text-amber-400">
                {t("settings:agentConnect_staleCopy", { kind: copy.kind })}
              </span>
              <button
                type="button"
                className="text-[var(--color-text-accent)] underline-offset-2 hover:underline"
                onClick={() => restartStale(row.provider, copy.kind)}
              >
                {t("settings:agentConnect_staleRestart")}
              </button>
            </div>
          ))}
        </SettingsListRow>
      );
    },
    [
      connect,
      copyLaunch,
      hidden,
      managing,
      models,
      openImportLink,
      order,
      reapply,
      restartStale,
      runProvider,
      saveLayout,
      savingProvider,
      selectModel,
      t,
      toggleConnected,
    ],
  );

  if (connect.isLoading && snapshot === null) {
    return (
      <p className="px-1 py-8 text-ui-sm text-muted-foreground">
        {t("settings:agentConnect_loading")}
      </p>
    );
  }

  if (connect.error !== null && snapshot === null) {
    return (
      <Alert variant="error">
        <AlertTitle>{t("settings:agentConnect_loadFailed")}</AlertTitle>
        <AlertDescription>
          <span>{connect.error.message}</span>
          <Button size="xs" variant="outline" onClick={() => void connect.refresh()}>
            {t("settings:agentConnect_retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-ui-sm leading-relaxed text-muted-foreground">
        {t("settings:agentConnect_intro")}
      </p>

      <SettingsSectionShell
        title="settings:navTab_agentConnect"
        action={
          <Button
            size="xs"
            variant={managing ? "secondary" : "outline"}
            onClick={() => setManaging((value) => !value)}
          >
            {managing ? t("settings:agentConnect_manageDone") : t("settings:agentConnect_manage")}
          </Button>
        }
      >
        {rows.length === 0 ? (
          <SettingsEmptyState>{t("settings:agentConnect_empty")}</SettingsEmptyState>
        ) : (
          <SettingsCard>
            {visible.map((row, index) => {
              const restStart = visible.length - restCount;
              return (
                <Fragment key={row.provider}>
                  {index === restStart && restCount > 0 && (showAll || managing) ? (
                    <p className="px-4 pt-3 pb-1 text-ui-sm text-muted-foreground">
                      {t("settings:agentConnect_notSetUp")}
                    </p>
                  ) : null}
                  {renderRow(row, false)}
                </Fragment>
              );
            })}
            {restCount > 0 && !managing ? (
              <div className="flex justify-center border-t border-[color:var(--color-border)] py-2">
                <Button size="xs" variant="ghost" onClick={() => setShowAll((value) => !value)}>
                  {showAll
                    ? t("settings:agentConnect_showLess")
                    : t("settings:agentConnect_showMore", { count: restCount })}
                </Button>
              </div>
            ) : null}
            {hiddenRows.length > 0 && !managing ? (
              <div className="flex justify-center border-t border-[color:var(--color-border)] py-2">
                <Button size="xs" variant="ghost" onClick={() => setShowHidden((value) => !value)}>
                  {hiddenOpen
                    ? t("settings:agentConnect_hideHidden", { count: hiddenRows.length })
                    : t("settings:agentConnect_showHidden", { count: hiddenRows.length })}
                </Button>
              </div>
            ) : null}
            {hiddenOpen ? hiddenRows.map((row) => renderRow(row, true)) : null}
          </SettingsCard>
        )}
      </SettingsSectionShell>

      <AgentConnectProfilesSection
        profiles={snapshot?.profiles ?? []}
        saving={savingProfile}
        onSave={(name) => void runProfile(() => connect.saveProfile(name))}
        onApply={(name) => void runProfile(() => connect.applyProfile(name), name)}
        onOverwrite={(name) => void runProfile(() => connect.saveProfile(name))}
        onDelete={(name) => void runProfile(() => connect.deleteProfile(name))}
        onRename={(name, to) => void runProfile(() => connect.renameProfile(name, to))}
      />

      {modelsEditor !== null ? (
        <ModelsDialog
          key={modelsEditor.provider}
          editor={modelsEditor}
          models={models}
          onClose={() => setModelsEditor(null)}
          onSave={(nextHidden) => saveModels(modelsEditor, nextHidden)}
        />
      ) : null}

      {shellPrompt !== null ? (
        <AlertDialog open onOpenChange={(open) => (open ? undefined : setShellPrompt(null))}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {shellPrompt.enabled
                  ? t("settings:agentConnect_shellAddTitle", { name: shellPrompt.name })
                  : t("settings:agentConnect_shellRemoveTitle", { name: shellPrompt.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {shellPrompt.enabled
                  ? t("settings:agentConnect_shellAddMessage", { name: shellPrompt.name })
                  : t("settings:agentConnect_shellRemoveMessage", { name: shellPrompt.name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                {t("settings:agentConnect_cancel")}
              </AlertDialogClose>
              <Button size="sm" onClick={() => confirmShell(shellPrompt)}>
                {shellPrompt.enabled
                  ? t("settings:agentConnect_shellConfirm")
                  : t("settings:agentConnect_shellConfirmRemove")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}

      <PluginSlotPanels slot="agents" />
    </div>
  );
}

/** An agent's own model roles (`fields`) and settings, one control each. */
function AgentConnectEntryExtras({
  entry,
  label,
  models,
  disabled,
  onSelectModel,
  onSetField,
}: {
  readonly entry: AgentConnectEntry;
  readonly label: string;
  readonly models: readonly AgentConnectModel[];
  readonly disabled: boolean;
  readonly onSelectModel: (provider: string, model: string) => void;
  readonly onSetField: (field: string, value: string) => void;
}) {
  const fields = entry.fields ?? [];
  const settings = entry.settings ?? [];
  if (fields.length === 0 && settings.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 pt-2">
      {fields.map((field) => (
        <span key={field.id} className="flex items-center gap-1.5">
          <span className="text-ui-sm text-muted-foreground">{field.label}</span>
          <AgentConnectModelSelect
            entry={{ ...entry, model: field.model }}
            models={models}
            label={`${label} · ${field.label}`}
            disabled={disabled}
            triggerClassName="w-36"
            onSelectModel={(model) => onSelectModel(`${entry.provider}#${field.id}`, model)}
          />
        </span>
      ))}
      {settings.map((setting) => (
        <AgentConnectSettingSelect
          key={setting.key}
          setting={setting}
          name={label}
          models={models}
          disabled={disabled}
          onChange={(value) => onSetField(setting.key, value)}
        />
      ))}
    </div>
  );
}

const AGENT_DEFAULT_VALUE = "__agent_default__";

function AgentConnectSettingSelect({
  setting,
  name,
  models,
  disabled,
  onChange,
}: {
  readonly setting: AgentConnectSetting;
  readonly name: string;
  readonly models: readonly AgentConnectModel[];
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const value = setting.value === "" ? AGENT_DEFAULT_VALUE : setting.value;
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-ui-sm text-muted-foreground">{setting.label}</span>
      <SettingsSelectControl
        value={value}
        disabled={disabled}
        ariaLabel={`${name} · ${setting.label}`}
        valueContent={
          setting.value === ""
            ? t("settings:agentConnect_defaultModel")
            : modelLabel(models, setting.value)
        }
        triggerClassName="w-36"
        onValueChange={(next) => onChange(next === AGENT_DEFAULT_VALUE ? "" : next)}
      >
        <SelectItem value={AGENT_DEFAULT_VALUE}>
          {t("settings:agentConnect_defaultModel")}
        </SelectItem>
        {(setting.options ?? []).map((option) => (
          <SelectItem key={option} value={option}>
            {modelLabel(models, option)}
          </SelectItem>
        ))}
      </SettingsSelectControl>
    </span>
  );
}

function ModelsDialog({
  editor,
  models,
  onClose,
  onSave,
}: {
  readonly editor: ModelsEditor;
  readonly models: readonly AgentConnectModel[];
  readonly onClose: () => void;
  readonly onSave: (hidden: string[]) => void;
}) {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState<readonly string[]>(editor.hidden);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("settings:agentConnect_modelsTitle", { name: editor.name })}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col divide-y divide-[color:var(--color-border)]">
            {models.map((model) => (
              <div key={model.id} className="flex items-center justify-between gap-3 py-2">
                <span className="truncate text-ui-sm">{model.label ?? model.id}</span>
                <Switch
                  checked={!hidden.includes(model.id)}
                  onCheckedChange={(checked) =>
                    setHidden((previous) => toggleHiddenModel(previous, model.id, Boolean(checked)))
                  }
                  aria-label={model.label ?? model.id}
                />
              </div>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("settings:agentConnect_modelsCancel")}
          </Button>
          <Button size="sm" onClick={() => onSave([...hidden])}>
            {t("settings:agentConnect_modelsSave")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
