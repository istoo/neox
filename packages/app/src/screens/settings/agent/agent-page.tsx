import { Fragment, useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import { ChevronDown, ChevronRight, Puzzle } from "lucide-react-native";
import type { PluginListItem } from "@neolix/protocol/messages";
import type { AgentInstallEntry, AgentInstallRunResult } from "@neolix/protocol/agent-install";
import type { AcpProviderCatalogItem } from "@/hooks/use-acp-provider-catalog";
import {
  buildAcpProviderConfigPatch,
  getAcpProviderCatalog,
  useAcpProviderCatalog,
} from "@/hooks/use-acp-provider-catalog";
import { useAgentConnect } from "@/hooks/use-agent-connect";
import { useAgentInstalls } from "@/hooks/use-agent-installs";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useProviderSettingsStore } from "@/stores/provider-settings-store";
import { useToast } from "@/contexts/toast-api-context";
import { ProviderCatalogList } from "@/components/provider-catalog-list";
import { ProvidersSection } from "@/screens/settings/providers-section";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Button } from "@/components/ui/button";
import { pluginDisplayName, usePluginList } from "@/plugins/plugin-list";
import { buildModelsRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openAgentLink } from "@/utils/open-agent-link";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { AgentCliInstallList } from "./agent-cli-install";
import { AgentGuideCard } from "./agent-guide-card";
import { AgentProfiles } from "./agent-profiles";
import { AgentRow } from "./agent-row";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedPuzzle = withUnistyles(Puzzle);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ProviderRow {
  provider: string;
  label: string;
  enabled: boolean;
  source: "builtin" | "custom" | undefined;
  /** The host's own read of the agent's CLI, when it has one. */
  status?: "ready" | "loading" | "error" | "unavailable";
  /** An agent Neolix does not provide, only wires to the gateway. */
  external?: boolean;
  iconSlug?: string;
}

export interface AgentPageProps {
  serverId: string;
}

/** Settings → Use → Agent: myna's 「接入」 page over Neolix's providers and gateway. */
export function AgentPage({ serverId }: AgentPageProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supportsHopliteProvider = useHostFeature(serverId, "hopliteProvider");
  const supportsProviderRemoval = useHostFeature(serverId, "providerRemoval");
  const { entries, isLoading, refresh } = useProvidersSnapshot(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const connect = useAgentConnect(serverId);
  const installs = useAgentInstalls(serverId);
  const { entries: catalogEntries } = useAcpProviderCatalog();
  const pluginList = usePluginList(serverId);
  const openProviderSettings = useProviderSettingsStore((state) => state.open);
  const [showAll, setShowAll] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showInstall, setShowInstall] = useState(false);
  const [managing, setManaging] = useState(false);
  const [savingProvider, setSavingProvider] = useState<string | null>(null);
  const [installingProviderId, setInstallingProviderId] = useState<string | null>(null);

  const connectByProvider = useMemo(
    () => new Map((connect.snapshot?.entries ?? []).map((entry) => [entry.provider, entry])),
    [connect.snapshot],
  );
  const models = useMemo(() => connect.snapshot?.models ?? [], [connect.snapshot]);
  const profiles = useMemo(() => connect.snapshot?.profiles ?? [], [connect.snapshot]);
  const hidden = useMemo(() => connect.snapshot?.hidden ?? [], [connect.snapshot]);

  const ownProviderRows = useMemo<ProviderRow[]>(
    () =>
      (entries ?? []).map((entry) => ({
        provider: entry.provider,
        label: entry.label ?? entry.provider,
        enabled: entry.enabled ?? true,
        source: entry.source,
        status: entry.status,
      })),
    [entries],
  );

  /** Agents the host detected that Neolix can wire to the gateway without providing them. */
  const externalRows = useMemo<ProviderRow[]>(
    () =>
      (connect.snapshot?.entries ?? [])
        .filter((entry) => entry.kind === "external")
        .map((entry): ProviderRow => {
          const row: ProviderRow = {
            provider: entry.provider,
            label: entry.name ?? entry.provider,
            enabled: true,
            source: undefined,
            external: true,
          };
          if (entry.icon !== undefined) row.iconSlug = entry.icon;
          return row;
        }),
    [connect.snapshot],
  );

  const providerRows = useMemo<ProviderRow[]>(
    () => [...ownProviderRows, ...externalRows],
    [externalRows, ownProviderRows],
  );

  /** The reader's order first, anything it does not name after, in snapshot order. */
  const orderedRows = useMemo(() => {
    const order = connect.snapshot?.order ?? [];
    const rank = new Map(order.map((id, index) => [id, index]));
    return providerRows
      .map((row, index) => ({ row, index }))
      .sort(
        (left, right) =>
          (rank.get(left.row.provider) ?? order.length) -
            (rank.get(right.row.provider) ?? order.length) || left.index - right.index,
      )
      .map((entry) => entry.row);
  }, [connect.snapshot, providerRows]);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);
  const shownRows = useMemo(
    () => orderedRows.filter((row) => !hiddenSet.has(row.provider)),
    [hiddenSet, orderedRows],
  );
  const hiddenRows = useMemo(
    () => orderedRows.filter((row) => hiddenSet.has(row.provider)),
    [hiddenSet, orderedRows],
  );
  const used = useMemo(
    () => shownRows.filter((row) => connectByProvider.get(row.provider)?.connected === true),
    [connectByProvider, shownRows],
  );
  const rest = useMemo(
    () => shownRows.filter((row) => connectByProvider.get(row.provider)?.connected !== true),
    [connectByProvider, shownRows],
  );
  const visible = managing || showAll ? [...used, ...rest] : used;
  const order = useMemo(() => orderedRows.map((row) => row.provider), [orderedRows]);

  const configOwned = useCallback(
    (providerId: string) =>
      Boolean(
        config?.providers?.[providerId] &&
        (config.providers[providerId].extends ||
          getAcpProviderCatalog().some(
            (entry) => entry.id === providerId && entry.bundledProvider,
          )),
      ),
    [config],
  );

  const openDetails = useCallback(
    (provider: string) => {
      openProviderSettings({ serverId, provider });
    },
    [openProviderSettings, serverId],
  );

  const openPlugins = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "plugins"));
  }, [serverId]);

  const openModelSources = useCallback(() => {
    router.push(buildModelsRoute({ serverId, view: "sources" }));
  }, [serverId]);
  const openInstall = useCallback(() => setShowInstall(true), []);

  const applySnapshotError = useCallback(
    (snapshot: { error: string | null } | null) => {
      if (snapshot?.error) toast.error(snapshot.error);
      return snapshot;
    },
    [toast],
  );

  /** Agents that change something outside their own config need a second look before the switch flips. */
  const confirmConnect = useCallback(
    async (provider: string, connected: boolean) => {
      if (!connected || provider !== "cursor-local") return true;
      return confirmDialog({
        title: t("settings.usePages.agent.cursorLocalConfirmTitle"),
        message: t("settings.usePages.agent.cursorLocalConfirmMessage"),
        confirmLabel: t("settings.usePages.agent.cliConfirm"),
      });
    },
    [t],
  );

  const setConnected = useCallback(
    (provider: string, connected: boolean, model: string | null) => {
      void (async () => {
        if (!(await confirmConnect(provider, connected))) return;
        setSavingProvider(provider);
        void connect
          .setConnected(provider, connected, model)
          .then(applySnapshotError)
          .finally(() => setSavingProvider(null));
      })();
    },
    [applySnapshotError, confirmConnect, connect],
  );

  /** A guide step's click connects the agent on its own first model (myna's guideConnect). */
  const connectFromGuide = useCallback(
    (provider: string) => setConnected(provider, true, null),
    [setConnected],
  );

  const selectModel = useCallback(
    (provider: string, model: string) => {
      void (async () => {
        if (!(await confirmConnect(provider, true))) return;
        setSavingProvider(provider);
        void connect
          .setConnected(provider, true, model)
          .then(applySnapshotError)
          .finally(() => setSavingProvider(null));
      })();
    },
    [applySnapshotError, confirmConnect, connect],
  );

  /** One of the agent's own fields: a write to its config, with no reconnect. */
  const setField = useCallback(
    (provider: string, field: string, value: string) => {
      setSavingProvider(provider);
      void connect
        .setField(provider, field, value)
        .then(applySnapshotError)
        .finally(() => setSavingProvider(null));
    },
    [applySnapshotError, connect],
  );

  const toggleShellFunction = useCallback(
    async (provider: string, enabled: boolean) => {
      const label = externalRows.find((row) => row.provider === provider)?.label ?? provider;
      const confirmed = await confirmDialog({
        title: enabled
          ? t("settings.usePages.agent.addShellFunctionTitle", { name: label })
          : t("settings.usePages.agent.removeShellFunctionTitle", { name: label }),
        message: enabled
          ? t("settings.usePages.agent.addShellFunctionMessage", { name: label })
          : t("settings.usePages.agent.removeShellFunctionMessage", { name: label }),
        confirmLabel: enabled
          ? t("settings.usePages.agent.addShellFunction")
          : t("settings.usePages.agent.removeShellFunction"),
      });
      if (!confirmed) return;
      setSavingProvider(provider);
      void connect
        .setShellFunction(provider, enabled)
        .then(applySnapshotError)
        .finally(() => setSavingProvider(null));
    },
    [applySnapshotError, connect, externalRows, t],
  );

  const setModels = useCallback(
    (provider: string, ids: string[]) => {
      setSavingProvider(provider);
      void connect
        .setModels(provider, ids)
        .then(applySnapshotError)
        .finally(() => setSavingProvider(null));
    },
    [applySnapshotError, connect],
  );

  const restartStale = useCallback(
    (provider: string, kind: "app" | "ide" | "daemon" | "cli") => {
      setSavingProvider(provider);
      void connect
        .restartStale(provider, kind)
        .then(applySnapshotError)
        .finally(() => setSavingProvider(null));
    },
    [applySnapshotError, connect],
  );

  const reapply = useCallback(
    (provider: string) => {
      setSavingProvider(provider);
      // Keep the model when the gateway still serves it; otherwise the write
      // picks the gateway's first model.
      const current = connectByProvider.get(provider)?.model ?? null;
      const model =
        current !== null && models.some((entry) => entry.id === current) ? current : null;
      void connect
        .setConnected(provider, true, model)
        .then(applySnapshotError)
        .finally(() => setSavingProvider(null));
    },
    [applySnapshotError, connect, connectByProvider, models],
  );

  const copyLaunch = useCallback(
    (_provider: string, command: string, label: string) => {
      void copyToClipboard(command).then(() => {
        toast.show(t("settings.usePages.agent.launchCopied", { name: label }));
        return undefined;
      });
    },
    [t, toast],
  );

  // The agent's own app takes Neolix from this link; where the platform can't
  // open it, the link goes to the clipboard for the reader to open.
  const openImportLink = useCallback(
    (_provider: string, link: string, label: string) => {
      void openAgentLink(link)
        .catch(() => false)
        .then((opened) => {
          if (opened) return undefined;
          return copyToClipboard(link).then(() => {
            toast.show(t("settings.usePages.agent.importLinkCopied", { name: label }));
            return undefined;
          });
        });
    },
    [t, toast],
  );

  const saveLayout = useCallback(
    (nextOrder: string[], hiddenIds: string[]) => {
      void connect.setLayout({ order: nextOrder, hidden: hiddenIds }).then(applySnapshotError);
    },
    [applySnapshotError, connect],
  );

  const moveProvider = useCallback(
    (provider: string, direction: -1 | 1) => {
      const from = order.indexOf(provider);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= order.length) return;
      const next = [...order];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      saveLayout(next, hidden);
    },
    [hidden, order, saveLayout],
  );

  const hideToggle = useCallback(
    (provider: string, shouldHide: boolean) => {
      const next = shouldHide ? [...hidden, provider] : hidden.filter((id) => id !== provider);
      saveLayout(order, next);
    },
    [hidden, order, saveLayout],
  );

  const toggleEnabled = useCallback(
    (provider: string, enabled: boolean) => {
      setSavingProvider(provider);
      void patchConfig({ providers: { [provider]: { enabled } } })
        .catch((error: unknown) => {
          Alert.alert(
            t("settings.usePages.agent.updateErrorTitle"),
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => setSavingProvider(null));
    },
    [patchConfig, t],
  );

  const removeProvider = useCallback(
    async (provider: string, label: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.usePages.agent.removeConfirmTitle", { name: label }),
        message: t("settings.usePages.agent.removeConfirmMessage"),
        confirmLabel: t("settings.usePages.agent.removeProvider"),
        destructive: true,
      });
      if (!confirmed) return;
      setSavingProvider(provider);
      try {
        await patchConfig({ removeProviders: [provider] });
      } catch (error) {
        Alert.alert(
          t("settings.usePages.agent.removeErrorTitle"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setSavingProvider(null);
      }
    },
    [patchConfig, t],
  );

  const removeProviderRow = useCallback(
    (provider: string, label: string) => {
      void removeProvider(provider, label);
    },
    [removeProvider],
  );

  const saveProfile = useCallback(
    (name: string) => {
      void connect.saveProfile(name).then(applySnapshotError);
    },
    [applySnapshotError, connect],
  );
  const applyProfile = useCallback(
    (name: string) => {
      void connect.applyProfile(name).then((snapshot) => {
        if (snapshot && snapshot.error === null) {
          toast.show(t("settings.usePages.agent.profileApplied", { name }));
        }
        return applySnapshotError(snapshot);
      });
    },
    [applySnapshotError, connect, t, toast],
  );
  const deleteProfile = useCallback(
    (name: string) => {
      void connect.deleteProfile(name).then(applySnapshotError);
    },
    [applySnapshotError, connect],
  );
  const renameProfile = useCallback(
    (name: string, to: string) => {
      void connect.renameProfile(name, to).then(applySnapshotError);
    },
    [applySnapshotError, connect],
  );

  const installedProviders = useMemo(
    () => new Set((entries ?? []).map((entry) => entry.provider)),
    [entries],
  );

  const externalDetected = useMemo(
    () =>
      new Set(
        (connect.snapshot?.entries ?? [])
          .filter((entry) => entry.kind === "external")
          .map((entry) => entry.provider),
      ),
    [connect.snapshot],
  );

  /** myna's install list: the CLIs Neolix can drive, minus the detected ones. */
  const cliInstallable = useMemo(
    () =>
      installs.entries.filter(
        (entry) => !installedProviders.has(entry.provider) && !externalDetected.has(entry.provider),
      ),
    [externalDetected, installedProviders, installs.entries],
  );

  const installable = useMemo(
    () => (catalogEntries ?? []).filter((entry) => !installedProviders.has(entry.id)),
    [catalogEntries, installedProviders],
  );

  /** An installed CLI shows up once the host's provider snapshot is re-read. */
  const installed = useCallback(
    (provider: string) => {
      void refresh([provider]);
      // An external agent is detected by the agent-connect snapshot, so
      // re-read it too; that is what moves the row out of the install list.
      void connect.refresh();
    },
    [connect, refresh],
  );

  const install = useCallback(
    async (entry: AcpProviderCatalogItem) => {
      if (installingProviderId !== null) return;
      const confirmed = await confirmDialog({
        title: t("settings.usePages.agent.installConfirmTitle", { name: entry.title }),
        message: t("settings.usePages.agent.installConfirmMessage"),
        confirmLabel: t("settings.usePages.agent.installConfirm"),
      });
      if (!confirmed) return;
      setInstallingProviderId(entry.id);
      try {
        await patchConfig(buildAcpProviderConfigPatch(entry, supportsHopliteProvider));
        await refresh([entry.id]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setInstallingProviderId(null);
      }
    },
    [installingProviderId, patchConfig, refresh, supportsHopliteProvider, t, toast],
  );

  const renderRow = useCallback(
    (row: ProviderRow, index: number, hiddenRow: boolean) => {
      const position = order.indexOf(row.provider);
      return (
        <AgentRow
          key={row.provider}
          serverId={serverId}
          provider={row.provider}
          label={row.label}
          providerEnabled={row.enabled}
          providerMissing={row.status === "unavailable"}
          external={row.external === true}
          {...(row.iconSlug === undefined ? {} : { iconSlug: row.iconSlug })}
          connect={connectByProvider.get(row.provider) ?? null}
          models={models}
          saving={savingProvider === row.provider}
          canRemove={
            supportsProviderRemoval && row.source === "custom" && configOwned(row.provider)
          }
          isFirst={index === 0}
          manage={managing || hiddenRow}
          hiddenRow={hiddenRow}
          canMoveUp={position > 0}
          canMoveDown={position >= 0 && position < order.length - 1}
          onOpenDetails={openDetails}
          onSetConnected={setConnected}
          onSelectModel={selectModel}
          onSetModels={setModels}
          onSetField={setField}
          onRestartStale={restartStale}
          onToggleEnabled={toggleEnabled}
          onRemove={removeProviderRow}
          onReapply={reapply}
          onMove={moveProvider}
          onHideToggle={hideToggle}
          onCopyLaunch={copyLaunch}
          onToggleShellFunction={toggleShellFunction}
          onOpenImportLink={openImportLink}
        />
      );
    },
    [
      configOwned,
      connectByProvider,
      copyLaunch,
      hideToggle,
      openImportLink,
      managing,
      models,
      moveProvider,
      openDetails,
      order,
      reapply,
      removeProviderRow,
      savingProvider,
      selectModel,
      setField,
      setModels,
      restartStale,
      serverId,
      setConnected,
      supportsProviderRemoval,
      toggleEnabled,
      toggleShellFunction,
    ],
  );

  const toggleShowAll = useCallback(() => setShowAll((value) => !value), []);
  const toggleShowHidden = useCallback(() => setShowHidden((value) => !value), []);
  const toggleInstall = useCallback(() => setShowInstall((value) => !value), []);
  const toggleManaging = useCallback(() => setManaging((value) => !value), []);

  // Plugins that register agent providers, named as the Plugins page names
  // them; a built-in plugin may not be in that list, so its id is prettified.
  const pluginNames = useMemo(
    () =>
      (connect.snapshot?.pluginProviders ?? [])
        .filter((entry) => entry.providers.length > 0)
        .map((entry) => providerPluginName(entry.pluginId, pluginList.data ?? [])),
    [connect.snapshot, pluginList.data],
  );

  if (!isConnected) {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("settings.providers.unavailable")}</Text>
      </View>
    );
  }

  // A host that predates the agent-connect RPCs keeps the plain provider list.
  if (!connect.supported) {
    return <ProvidersSection serverId={serverId} />;
  }

  const hasAgents = providerRows.length > 0;
  return (
    <View>
      <Text style={styles.intro}>{t("settings.usePages.agent.intro")}</Text>
      {connect.snapshot !== null && hasAgents ? (
        <AgentGuideCard
          serverId={serverId}
          entries={connect.snapshot.entries}
          models={connect.snapshot.models}
          onConnect={connectFromGuide}
        />
      ) : null}
      <AgentListCard
        loading={connect.isLoading || (isLoading && providerRows.length === 0)}
        connectError={connect.snapshot === null ? (connect.error?.message ?? null) : null}
        visible={visible}
        hiddenRows={hiddenRows}
        hiddenOpen={managing || showHidden}
        restCount={rest.length}
        showAll={showAll}
        managing={managing}
        renderRow={renderRow}
        onToggleShowAll={toggleShowAll}
        onToggleShowHidden={toggleShowHidden}
        onToggleManaging={toggleManaging}
        onAddSource={hasAgents ? undefined : openModelSources}
        onInstallAgent={hasAgents ? undefined : openInstall}
      />
      {cliInstallable.length + installable.length > 0 ? (
        <InstallSection
          serverId={serverId}
          cliEntries={cliInstallable}
          installable={installable}
          open={showInstall}
          installingProviderId={installingProviderId}
          onToggle={toggleInstall}
          onInstall={install}
          onRunInstall={installs.run}
          onInstalled={installed}
        />
      ) : null}
      {pluginNames.length > 0 ? <PluginsRow names={pluginNames} onPress={openPlugins} /> : null}
      <AgentProfiles
        profiles={profiles}
        saving={false}
        onSave={saveProfile}
        onApply={applyProfile}
        onOverwrite={saveProfile}
        onDelete={deleteProfile}
        onRename={renameProfile}
      />
    </View>
  );
}

interface AgentListCardProps {
  loading: boolean;
  connectError: string | null;
  visible: ProviderRow[];
  hiddenRows: ProviderRow[];
  hiddenOpen: boolean;
  restCount: number;
  showAll: boolean;
  managing: boolean;
  renderRow: (row: ProviderRow, index: number, hiddenRow: boolean) => ReactNode;
  onToggleShowAll: () => void;
  onToggleShowHidden: () => void;
  onToggleManaging: () => void;
  /** Empty state: open the Models & quota page's model sources. */
  onAddSource?: () => void;
  /** Empty state: reveal the agent install section. */
  onInstallAgent?: () => void;
}

function AgentListCard({
  loading,
  connectError,
  visible,
  hiddenRows,
  hiddenOpen,
  restCount,
  showAll,
  managing,
  renderRow,
  onToggleShowAll,
  onToggleShowHidden,
  onToggleManaging,
  onAddSource,
  onInstallAgent,
}: AgentListCardProps) {
  const { t } = useTranslation();
  return (
    <View style={settingsStyles.card} testID="agent-connect-list">
      {loading ? <Text style={styles.emptyText}>{t("settings.providers.loading")}</Text> : null}
      {connectError !== null ? <Text style={styles.emptyText}>{connectError}</Text> : null}
      {!loading && connectError === null && visible.length === 0 && hiddenRows.length === 0 ? (
        <AgentListEmptyState onAddSource={onAddSource} onInstallAgent={onInstallAgent} />
      ) : null}
      {visible.map((row, index) => {
        const restStart = visible.length - restCount;
        return (
          <Fragment key={row.provider}>
            {index === restStart && restCount > 0 && (showAll || managing) ? (
              <Text style={styles.foldCaption}>{t("settings.usePages.agent.notSetUp")}</Text>
            ) : null}
            {renderRow(row, index, false)}
          </Fragment>
        );
      })}
      {restCount > 0 && !managing ? (
        <PressHighlight
          onPress={onToggleShowAll}
          accessibilityRole="button"
          accessibilityLabel={
            showAll
              ? t("settings.usePages.agent.showLess")
              : t("settings.usePages.agent.showMore", { count: restCount })
          }
          style={styles.foldButton}
        >
          <Text style={styles.foldText}>
            {showAll
              ? t("settings.usePages.agent.showLess")
              : t("settings.usePages.agent.showMore", { count: restCount })}
          </Text>
          <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
        </PressHighlight>
      ) : null}
      {hiddenRows.length > 0 ? (
        <PressHighlight
          onPress={managing ? undefined : onToggleShowHidden}
          accessibilityRole="button"
          accessibilityLabel={
            hiddenOpen
              ? t("settings.usePages.agent.hideHidden", { count: hiddenRows.length })
              : t("settings.usePages.agent.showHidden", { count: hiddenRows.length })
          }
          style={styles.foldButton}
        >
          <Text style={styles.foldText}>
            {hiddenOpen
              ? t("settings.usePages.agent.hideHidden", { count: hiddenRows.length })
              : t("settings.usePages.agent.showHidden", { count: hiddenRows.length })}
          </Text>
          {managing ? null : <ThemedChevronDown size={14} uniProps={mutedIconMapping} />}
        </PressHighlight>
      ) : null}
      {hiddenOpen
        ? hiddenRows.map((row, index) => renderRow(row, visible.length + index, true))
        : null}
      <View style={styles.footer}>
        <PressHighlight
          onPress={onToggleManaging}
          accessibilityRole="button"
          accessibilityLabel={
            managing ? t("settings.usePages.agent.manageDone") : t("settings.usePages.agent.manage")
          }
          style={styles.footerButton}
        >
          <Text style={styles.footText}>
            {managing
              ? t("settings.usePages.agent.manageDone")
              : t("settings.usePages.agent.manage")}
          </Text>
        </PressHighlight>
      </View>
    </View>
  );
}

function InstallSection({
  serverId,
  cliEntries,
  installable,
  open,
  installingProviderId,
  onToggle,
  onInstall,
  onRunInstall,
  onInstalled,
}: {
  serverId: string;
  cliEntries: AgentInstallEntry[];
  installable: AcpProviderCatalogItem[];
  open: boolean;
  installingProviderId: string | null;
  onToggle: () => void;
  onInstall: (entry: AcpProviderCatalogItem) => Promise<void>;
  onRunInstall: (provider: string, commandId: string) => Promise<AgentInstallRunResult>;
  onInstalled: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const count = cliEntries.length + installable.length;
  return (
    <View style={styles.install}>
      <PressHighlight
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={t("settings.usePages.agent.installHead", { count })}
        style={styles.installHead}
      >
        <Text style={settingsStyles.sectionHeaderTitle}>
          {t("settings.usePages.agent.installHead", { count })}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
      </PressHighlight>
      {open ? (
        <View style={styles.installBody}>
          <Text style={styles.installNote}>{t("settings.usePages.agent.installNote")}</Text>
          {cliEntries.length > 0 ? (
            <View style={styles.installGroup}>
              <Text style={settingsStyles.sectionHeaderTitle}>
                {t("settings.usePages.agent.cliGroupTitle")}
              </Text>
              <AgentCliInstallList
                serverId={serverId}
                entries={cliEntries}
                onRun={onRunInstall}
                onInstalled={onInstalled}
              />
            </View>
          ) : null}
          {installable.length > 0 ? (
            <View style={styles.installGroup}>
              <Text style={settingsStyles.sectionHeaderTitle}>
                {t("settings.usePages.agent.acpGroupTitle")}
              </Text>
              <ProviderCatalogList
                serverId={serverId}
                installingProviderId={installingProviderId}
                onInstall={onInstall}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function providerPluginName(pluginId: string, plugins: PluginListItem[]): string {
  const listed = plugins.find((plugin) => plugin.id === pluginId);
  if (listed) return pluginDisplayName(listed);
  const words = pluginId.replace(/-provider$/, "").replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function PluginsRow({ names, onPress }: { names: string[]; onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <PressHighlight
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t("settings.usePages.agent.moreInPlugins")}
      style={[settingsStyles.card, styles.pluginsCard]}
    >
      <View style={settingsStyles.row}>
        <View style={styles.pluginsIdentity}>
          <ThemedPuzzle size={15} uniProps={mutedIconMapping} />
          <Text style={settingsStyles.rowTitle}>{t("settings.usePages.agent.moreInPlugins")}</Text>
          <Text style={styles.pluginsNames} numberOfLines={1}>
            {names.join(t("settings.usePages.agent.listSeparator"))}
          </Text>
        </View>
        <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
      </View>
    </PressHighlight>
  );
}

function AgentListEmptyState({
  onAddSource,
  onInstallAgent,
}: {
  onAddSource?: () => void;
  onInstallAgent?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{t("settings.usePages.agent.noAgents")}</Text>
      <Text style={styles.emptyText}>{t("settings.usePages.agent.noAgentsHint")}</Text>
      {onAddSource || onInstallAgent ? (
        <View style={styles.emptyActions}>
          {onAddSource ? (
            <Button variant="secondary" size="sm" onPress={onAddSource} testID="agents-add-source">
              {t("settings.usePages.agent.emptyAddSource")}
            </Button>
          ) : null}
          {onInstallAgent ? (
            <Button
              variant="outline"
              size="sm"
              onPress={onInstallAgent}
              testID="agents-install-agent"
            >
              {t("settings.usePages.agent.emptyInstall")}
            </Button>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  intro: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    marginBottom: theme.spacing[3],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    padding: theme.spacing[3],
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: theme.spacing[4],
  },
  emptyActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  foldCaption: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  foldButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  foldText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  footText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  install: {
    marginTop: theme.spacing[6],
  },
  installHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: theme.spacing[1],
    marginBottom: theme.spacing[2],
  },
  installBody: {
    gap: theme.spacing[2],
  },
  installGroup: {
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  installNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pluginsCard: {
    marginTop: theme.spacing[3],
  },
  pluginsIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  pluginsNames: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 0,
  },
}));
