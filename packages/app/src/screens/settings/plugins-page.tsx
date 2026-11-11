import { formatPluginInstallation } from "@neolix/protocol/plugin-source-reference";
import { BUILTIN_PROVIDER_IDS } from "@neolix/protocol/provider-manifest";
import type { PublishedPlugin } from "@neolix/protocol/plugin-registry";
import type {
  PluginListItem,
  PluginLogEntry,
  PluginMarketSearchHit,
  PluginReadmeSource,
} from "@neolix/protocol/messages";
import { PluginSettingsButton } from "@/plugins/settings";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Image, ScrollView, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Download,
  MoreHorizontal,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  BUILTIN_FEATURE_IDS,
  GATEWAY_CALLS_PAGE_OPTIONS,
  type BuiltinFeatureId,
} from "@neolix/protocol/plugin-features";
import {
  builtinFeatureHasSurface,
  builtinFeatureText,
  useBuiltinFeatures,
} from "@/plugins/builtin-features";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFetchQuery } from "@/data/query";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { resolvePluginPageState } from "@/screens/settings/plugins-page-state";
import { openPluginInstallForm } from "@/screens/settings/plugin-install-form-model";
import { pluginRegistry, useInstalledPlugins } from "@/plugins/registry";
import { pluginDisplayName, usePluginList } from "@/plugins/plugin-list";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";

const PLUGIN_WRITE_DOCS_URL =
  "https://github.com/istoo/neox/tree/main/public-docs/plugins/index.md";
const MIRROR_STORAGE_KEY = "@neolix:plugin-market-mirror";
const VIEW_STORAGE_KEY = "@neolix:plugin-view";
const SEARCH_DEBOUNCE_MS = 350;
const BUILTIN_PROVIDER_ID_SET: ReadonlySet<string> = new Set(BUILTIN_PROVIDER_IDS);

export type PluginsView = "builtin" | "discover" | "installed";

/** The plugin page's subpages, in the order the header and the sidebar show them. */
export const PLUGINS_VIEWS: readonly PluginsView[] = ["builtin", "discover", "installed"];

/** Narrow a route or sidebar id to a plugin subpage. */
export function isPluginsView(value: string): value is PluginsView {
  return value === "builtin" || value === "discover" || value === "installed";
}

/** How many configured (non-built-in) plugins the host reports. */
export function pluginInstalledCount(plugins: readonly PluginListItem[] | undefined): number {
  return plugins?.length ?? 0;
}

/** How many built-in plugins the host reports. */
export function pluginBuiltinCount(builtinIds: readonly string[] | undefined): number {
  return builtinIds?.length ?? 0;
}

/** How many plugins the publish registry lists. */
export function pluginMarketCount(plugins: readonly PublishedPlugin[] | undefined): number {
  return plugins?.length ?? 0;
}

type PluginRowAction = "reload" | "enable" | "disable" | "remove";

interface PluginMutationVariables {
  action: string;
  pluginId?: string;
  sourceKey?: string;
  run: () => Promise<string>;
}

interface MarketCardItem {
  source: string;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  version?: string;
  weeklyDownloads?: number;
  installs?: number;
  category?: string;
  categories: string[];
  replaces: string[];
  repository?: string;
  readmeSource?: PluginReadmeSource;
  providers?: string[];
  signedIn?: boolean;
  notSignedIn?: boolean;
  installed: boolean;
  installedOff: boolean;
  installedPluginId?: string;
  trustedRegistry: boolean;
}

const BUILTIN_NAMES: Record<string, string> = {
  "antigravity-provider": "Antigravity",
  "claude-usage-source": "Claude",
  "codex-usage-source": "Codex",
  "copilot-usage-source": "GitHub Copilot",
  "cursor-usage-source": "Cursor",
  "grok-usage-source": "Grok",
  "hoplite-provider": "Hoplite",
  "kimi-usage-source": "Kimi",
  "minimax-usage-source": "MiniMax",
  "muse-provider": "Muse Code",
  "opencode-go-usage-source": "OpenCode Go",
  "worktree-include": "Worktree include",
  "zai-usage-source": "Z.AI",
};

type BuiltinKind = "providers" | "usageSources" | "worktree" | "other";

const BUILTIN_DESCRIPTION_KEYS: Record<BuiltinKind, string> = {
  providers: "settings.plugins.builtin.providerKind",
  usageSources: "settings.plugins.builtin.usageKind",
  worktree: "settings.plugins.builtin.worktreeKind",
  other: "settings.plugins.builtin.otherKind",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluginRowAction(action: string | undefined): PluginRowAction | undefined {
  if (action === "reload" || action === "enable" || action === "disable" || action === "remove") {
    return action;
  }
  return undefined;
}

function pluginInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

function isHttpsUrl(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("https://");
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${value >= 10_000_000 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${value >= 10_000 ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
  }
  return String(value);
}

function registryVersion(plugin: PublishedPlugin): string {
  return plugin.artifact.kind === "npm"
    ? `v${plugin.artifact.version}`
    : plugin.artifact.commit.slice(0, 7);
}

function translationAt(
  translations: Record<string, { name?: string; description?: string }> | undefined,
  language: string,
): { name?: string; description?: string } | undefined {
  if (!translations) return undefined;
  return translations[language] ?? translations[language.split("-")[0] ?? ""];
}

function localizedName(plugin: PublishedPlugin, language: string): string {
  return translationAt(plugin.translations, language)?.name ?? plugin.name;
}

function localizedDescription(plugin: PublishedPlugin, language: string): string {
  return translationAt(plugin.translations, language)?.description ?? plugin.description;
}

function categoryLabel(
  categories: readonly MarketCategory[] | undefined,
  slug: string,
  language: string,
): string {
  const category = categories?.find((entry) => entry.slug === slug);
  if (!category) return slug;
  return translationAt(category.translations, language)?.name ?? category.label;
}

function providerSignInState(
  providers: readonly string[] | undefined,
  statuses: ReadonlyMap<string, string>,
): { signedIn: boolean; notSignedIn: boolean } {
  if (!providers?.length) return { signedIn: false, notSignedIn: false };
  const states = providers.map((provider) => statuses.get(provider));
  if (states.some((state) => state === undefined)) return { signedIn: false, notSignedIn: false };
  const signedIn = states.some((state) => state === "ready");
  return { signedIn, notSignedIn: !signedIn };
}

function builtinReplacements(plugin: PluginListItem | undefined): string[] {
  return (plugin?.providers ?? []).filter((provider) => BUILTIN_PROVIDER_ID_SET.has(provider));
}

function registryPackageName(plugin: PublishedPlugin): string | undefined {
  return plugin.artifact.kind === "npm" ? plugin.artifact.package : undefined;
}

function installedRegistryId(plugin: PluginListItem): string | undefined {
  const identity = plugin.installation?.identity;
  if (!identity || identity.kind === "directory") return undefined;
  return identity.registry?.id;
}

function installedForRegistry(
  plugins: readonly PluginListItem[] | undefined,
  registryId: string,
): PluginListItem | undefined {
  return plugins?.find((plugin) => installedRegistryId(plugin) === registryId);
}

function installedForNpm(
  plugins: readonly PluginListItem[] | undefined,
  packageName: string,
): PluginListItem | undefined {
  return plugins?.find(
    (plugin) =>
      plugin.npm?.packageName === packageName ||
      plugin.name === packageName ||
      plugin.id === packageName,
  );
}

function pluginMatchesQuery(plugin: PluginListItem, term: string): boolean {
  if (!term) return true;
  return [plugin.name, plugin.id, plugin.description, plugin.npm?.packageName]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function registryMatchesQuery(
  plugin: PublishedPlugin,
  term: string,
  categories: readonly MarketCategory[] | undefined,
  language: string,
): boolean {
  if (!term) return true;
  const fields = [
    localizedName(plugin, language),
    localizedDescription(plugin, language),
    plugin.name,
    plugin.description,
    plugin.id,
    plugin.author.name,
    plugin.author.github,
    ...plugin.categories.map((slug) => categoryLabel(categories, slug, language)),
  ];
  return fields
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function npmMatchesQuery(hit: PluginMarketSearchHit, term: string): boolean {
  if (!term) return true;
  return [hit.name, hit.package, hit.description, hit.publisher]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .includes(term);
}

function builtinKind(id: string): BuiltinKind {
  if (id.endsWith("-provider")) return "providers";
  if (id.endsWith("-usage-source")) return "usageSources";
  if (id === "worktree-include") return "worktree";
  return "other";
}

function builtinName(id: string): string {
  const known = BUILTIN_NAMES[id];
  if (known) return known;
  return id
    .replace(/-(provider|usage-source)$/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function builtinSubject(id: string): string {
  return builtinName(id.replace(/-(provider|usage-source)$/, ""));
}

function PluginLogo({ uri, name, large = false }: { uri?: string; name: string; large?: boolean }) {
  const boxStyle = large ? styles.logoLarge : styles.logo;
  const source = useMemo(() => ({ uri: uri ?? "" }), [uri]);
  if (isHttpsUrl(uri)) {
    return <Image source={source} style={boxStyle} accessibilityIgnoresInvertColors />;
  }
  return (
    <View style={boxStyle}>
      {name ? (
        <Text style={large ? styles.logoLetterLarge : styles.logoLetter}>
          {pluginInitial(name)}
        </Text>
      ) : (
        <Puzzle size={large ? 20 : 17} color={styles.logoIcon.color} />
      )}
    </View>
  );
}

function PluginActionsMenu({
  plugin,
  pending,
  pendingAction,
  onAction,
  onOpenLogs,
  supportsLogs,
}: {
  plugin: PluginListItem;
  pending: boolean;
  pendingAction?: PluginRowAction;
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(plugin: PluginListItem): void;
  supportsLogs: boolean;
}) {
  const { t } = useTranslation();
  const reload = useCallback(() => onAction("reload", plugin), [onAction, plugin]);
  const remove = useCallback(() => onAction("remove", plugin), [onAction, plugin]);
  const openLogs = useCallback(() => onOpenLogs(plugin), [onOpenLogs, plugin]);
  const removeIcon = useMemo(() => <Trash2 size={16} color={styles.dangerIcon.color} />, []);
  const menuLabel = t("settings.plugins.actions.menu", { name: pluginDisplayName(plugin) });

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={menuLabel}
        disabled={pending}
        hitSlop={8}
        style={styles.menuButton}
      >
        <MoreHorizontal size={18} color={styles.menuIcon.color} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={220} sheetTitle={menuLabel}>
        {supportsLogs ? (
          <DropdownMenuItem onSelect={openLogs} disabled={pending}>
            {t("settings.plugins.logs.action")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={reload}
          disabled={pending || !plugin.enabled}
          status={pendingAction === "reload" ? "pending" : "idle"}
          pendingLabel={t("settings.plugins.actions.reloading")}
        >
          {t("settings.plugins.actions.reload")}
        </DropdownMenuItem>
        <DropdownMenuItem
          destructive
          leading={removeIcon}
          onSelect={remove}
          disabled={pending}
          status={pendingAction === "remove" ? "pending" : "idle"}
          pendingLabel={t("settings.plugins.actions.removing")}
        >
          {t("settings.plugins.actions.remove")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PluginRow({
  plugin,
  serverId,
  clientError,
  pending,
  pendingAction,
  onAction,
  onOpenLogs,
  supportsLogs,
  providerStatus,
  first,
}: {
  plugin: PluginListItem;
  serverId: string;
  clientError?: string;
  pending: boolean;
  pendingAction?: PluginRowAction;
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(plugin: PluginListItem): void;
  supportsLogs: boolean;
  providerStatus: ReadonlyMap<string, string>;
  first: boolean;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(
    (enabled: boolean) => onAction(enabled ? "enable" : "disable", plugin),
    [onAction, plugin],
  );
  const status = clientError ? "failed" : plugin.status;
  let badgeVariant: "success" | "error" | "muted" = "muted";
  if (status === "running") badgeVariant = "success";
  else if (status === "failed") badgeVariant = "error";
  const statusLabel = t(`settings.plugins.status.${status}`);
  const statusBadge = useMemo(
    () => <StatusBadge label={statusLabel} variant={badgeVariant} size="xs" />,
    [badgeVariant, statusLabel],
  );
  const name = pluginDisplayName(plugin);
  // A display name hides the id that the CLI and plugin routes use, so show it beneath.
  const shownId = name === plugin.id ? null : plugin.id;
  const version = plugin.npm?.version;
  const signIn = providerSignInState(plugin.providers, providerStatus);
  const replaces = builtinReplacements(plugin);
  const toggleLabel = `${name}: ${t(
    plugin.enabled ? "settings.plugins.actions.disable" : "settings.plugins.actions.enable",
  )}`;
  const rowStyle = useMemo(() => [styles.pluginRow, first ? null : styles.rowBorder], [first]);
  return (
    <View style={rowStyle} testID={`plugin-row-${plugin.id}`}>
      <PluginLogo uri={plugin.icon} name={name} />
      <View style={styles.pluginInfo}>
        <View style={styles.pluginTitleRow}>
          <Text style={styles.pluginName} numberOfLines={1}>
            {name}
          </Text>
          {version ? <Text style={styles.version}>v{version}</Text> : null}
          {statusBadge}
          {signIn.signedIn ? (
            <StatusBadge
              label={t("settings.plugins.market.signedIn")}
              variant="success"
              size="xs"
            />
          ) : null}
          {signIn.notSignedIn ? (
            <StatusBadge
              label={t("settings.plugins.market.notSignedIn")}
              variant="warning"
              size="xs"
            />
          ) : null}
          {replaces.length ? <MetaChip>{t("settings.plugins.market.replaces")}</MetaChip> : null}
          {plugin.providers?.length ? (
            <MetaChip>
              {t("settings.plugins.market.serves", { names: plugin.providers.join(", ") })}
            </MetaChip>
          ) : null}
        </View>
        {shownId ? <Text style={styles.pluginSource}>{shownId}</Text> : null}
        {plugin.description ? (
          <Text style={styles.pluginDescription} numberOfLines={2}>
            {plugin.description}
          </Text>
        ) : null}
        {plugin.installation ? (
          <Text style={styles.pluginSource} numberOfLines={1}>
            {formatPluginInstallation(plugin.installation)}
          </Text>
        ) : null}
        {(clientError ?? plugin.error) ? (
          <Text accessibilityRole="alert" style={settingsStyles.rowError}>
            {clientError ?? plugin.error}
          </Text>
        ) : null}
      </View>
      <View style={styles.pluginControls} accessibilityLabel={`${name} ${statusLabel}`}>
        <PluginSettingsButton serverId={serverId} pluginId={plugin.id} />
        <Switch
          value={plugin.enabled}
          onValueChange={toggle}
          disabled={pending}
          accessibilityLabel={toggleLabel}
        />
        <PluginActionsMenu
          plugin={plugin}
          pending={pending}
          pendingAction={pendingAction}
          onAction={onAction}
          onOpenLogs={onOpenLogs}
          supportsLogs={supportsLogs}
        />
      </View>
    </View>
  );
}

function PluginLogsSheet({
  client,
  plugin,
  serverId,
  onClose,
}: {
  client: NonNullable<ReturnType<typeof useHostRuntimeClient>>;
  plugin: PluginListItem;
  serverId: string;
  onClose(): void;
}) {
  const pluginId = plugin.id;
  const { t } = useTranslation();
  const logs = useFetchQuery({
    queryKey: ["plugin-logs", serverId, pluginId],
    queryFn: () => client.getPluginLogs(pluginId),
    dataShape: "list",
    staleTimeMs: 0,
  });
  const refresh = useCallback(() => {
    void logs.refetch();
  }, [logs]);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.plugins.logs.title", { name: pluginDisplayName(plugin) }),
      actions: (
        <Button variant="outline" onPress={refresh} disabled={logs.isFetching}>
          {logs.isFetching
            ? t("settings.plugins.logs.refreshing")
            : t("settings.plugins.logs.refresh")}
        </Button>
      ),
    }),
    [logs.isFetching, plugin, refresh, t],
  );

  let content = <Text style={styles.logsState}>{t("settings.plugins.logs.loading")}</Text>;
  if (logs.isError) {
    content = (
      <Alert
        size="sm"
        variant="error"
        title={t("settings.plugins.logs.errorTitle")}
        description={errorMessage(logs.error)}
      >
        <Button variant="outline" onPress={refresh}>
          {t("settings.plugins.logs.refresh")}
        </Button>
      </Alert>
    );
  } else if (!logs.isLoading) {
    content = logs.data?.length ? (
      <View style={styles.logList}>
        {logs.data.map((entry: PluginLogEntry) => (
          <View key={entry.sequence} style={styles.logEntry}>
            <Text style={entry.stream === "stderr" ? styles.logStderr : styles.logStdout}>
              {entry.timestamp} {entry.stream}
            </Text>
            <Text style={styles.logMessage}>{entry.message}</Text>
          </View>
        ))}
      </View>
    ) : (
      <Text style={styles.logsState}>{t("settings.plugins.logs.empty")}</Text>
    );
  }

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="plugin-logs-sheet">
      {content}
    </AdaptiveModalSheet>
  );
}

function MetaChip({ icon, children }: { icon?: "download"; children: string }) {
  return (
    <View style={styles.metaChip}>
      {icon === "download" ? <Download size={11} color={styles.metaChipIcon.color} /> : null}
      <Text style={styles.metaChipText} numberOfLines={1}>
        {children}
      </Text>
    </View>
  );
}

function MarketCard({
  item,
  pending,
  busy,
  wide,
  onInstall,
  onSelect,
}: {
  item: MarketCardItem;
  pending: boolean;
  busy: boolean;
  wide: boolean;
  onInstall(source: string): void;
  onSelect(item: MarketCardItem): void;
}) {
  const { t } = useTranslation();
  const handleInstall = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      onInstall(item.source);
    },
    [item.source, onInstall],
  );
  const handleSelect = useCallback(() => onSelect(item), [item, onSelect]);
  const cardStyle = useMemo(() => [styles.card, wide ? styles.cardHalf : styles.cardFull], [wide]);
  let actionLabel = t("settings.plugins.discover.install");
  let actionDisabled = pending || busy;
  if (item.installed) {
    actionLabel = item.installedOff
      ? t("settings.plugins.discover.installedOff")
      : t("settings.plugins.discover.installed");
    actionDisabled = true;
  } else if (pending) {
    actionLabel = t("settings.plugins.discover.installing");
  }
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={item.name}
      onPress={handleSelect}
      style={cardStyle}
      testID={`plugin-market-card-${item.source}`}
    >
      <View style={styles.cardTop}>
        <PluginLogo uri={item.icon} name={item.name} />
        <View style={styles.cardWho}>
          <Text style={styles.cardName} numberOfLines={1}>
            {item.name}
          </Text>
          <View style={styles.cardAuthorRow}>
            {item.trustedRegistry ? (
              <ShieldCheck size={12} color={styles.metaChipIcon.color} />
            ) : null}
            <Text style={styles.cardAuthor} numberOfLines={1}>
              {item.author ?? item.source}
            </Text>
          </View>
        </View>
        <Button variant="secondary" onPress={handleInstall} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      </View>
      {item.description ? (
        <Text style={styles.cardSummary} numberOfLines={2}>
          {item.description}
        </Text>
      ) : null}
      <View style={styles.cardMeta}>
        {item.category ? <MetaChip>{item.category}</MetaChip> : null}
        {item.signedIn ? (
          <StatusBadge label={t("settings.plugins.market.signedIn")} variant="success" size="xs" />
        ) : null}
        {item.notSignedIn ? (
          <StatusBadge
            label={t("settings.plugins.market.notSignedIn")}
            variant="warning"
            size="xs"
          />
        ) : null}
        {item.weeklyDownloads !== undefined ? (
          <MetaChip icon="download">
            {t("settings.plugins.discover.weekly", { n: formatCount(item.weeklyDownloads) })}
          </MetaChip>
        ) : null}
        {item.weeklyDownloads === undefined && item.installs !== undefined ? (
          <MetaChip icon="download">
            {t("settings.plugins.discover.installs", { n: formatCount(item.installs) })}
          </MetaChip>
        ) : null}
        {item.version ? <MetaChip>{item.version}</MetaChip> : null}
        {item.replaces.length ? <MetaChip>{t("settings.plugins.market.replaces")}</MetaChip> : null}
        {item.providers?.length ? (
          <MetaChip>
            {t("settings.plugins.market.serves", { names: item.providers.join(", ") })}
          </MetaChip>
        ) : null}
      </View>
    </PressHighlight>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function MarketDetailSheet({
  item,
  pending,
  busy,
  onClose,
  onInstall,
  onRemove,
  readme,
  readmeLoading,
  readmeError,
}: {
  item: MarketCardItem;
  pending: boolean;
  busy: boolean;
  onClose(): void;
  onInstall(source: string): void;
  onRemove(item: MarketCardItem): void;
  readme?: string;
  readmeLoading: boolean;
  readmeError: unknown;
}) {
  const { t } = useTranslation();
  const handleInstall = useCallback(() => onInstall(item.source), [item.source, onInstall]);
  const handleRemove = useCallback(() => onRemove(item), [item, onRemove]);
  const header = useMemo<SheetHeader>(() => {
    const action = item.installed ? (
      <Button variant="outline" onPress={handleRemove} disabled={busy}>
        {t("settings.plugins.actions.remove")}
      </Button>
    ) : (
      <Button onPress={handleInstall} disabled={pending || busy}>
        {pending
          ? t("settings.plugins.discover.installing")
          : t("settings.plugins.discover.install")}
      </Button>
    );
    return { title: item.name, actions: action };
  }, [busy, handleInstall, handleRemove, item.installed, item.name, pending, t]);
  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="plugin-detail-sheet">
      <View style={styles.detailBody}>
        <View style={styles.detailHead}>
          <PluginLogo uri={item.icon} name={item.name} large />
          <View style={styles.cardWho}>
            <Text style={styles.detailName}>{item.name}</Text>
            <Text style={styles.cardAuthor}>{item.author ?? item.source}</Text>
          </View>
        </View>
        {item.description ? (
          <View style={styles.detailSection}>
            <Text style={styles.detailSectionTitle}>
              {t("settings.plugins.market.detailAbout")}
            </Text>
            <Text style={styles.detailDescription}>{item.description}</Text>
          </View>
        ) : null}
        <View style={styles.detailSection}>
          <DetailRow label={t("settings.plugins.market.detailSource")} value={item.source} />
          {item.version ? (
            <DetailRow label={t("settings.plugins.market.detailVersion")} value={item.version} />
          ) : null}
          {item.author ? (
            <DetailRow label={t("settings.plugins.market.detailAuthor")} value={item.author} />
          ) : null}
          {item.categories.length ? (
            <DetailRow
              label={t("settings.plugins.market.detailCategories")}
              value={item.categories.join(", ")}
            />
          ) : null}
          {item.weeklyDownloads !== undefined ? (
            <DetailRow
              label={t("settings.plugins.market.detailDownloads")}
              value={String(item.weeklyDownloads)}
            />
          ) : null}
          {item.installs !== undefined ? (
            <DetailRow
              label={t("settings.plugins.market.detailInstalls")}
              value={String(item.installs)}
            />
          ) : null}
          {item.providers?.length ? (
            <DetailRow
              label={t("settings.plugins.market.detailProviders")}
              value={item.providers.join(", ")}
            />
          ) : null}
        </View>
        {item.replaces.length ? (
          <View style={styles.detailSection}>
            <Text style={styles.detailSectionTitle}>{t("settings.plugins.market.replaces")}</Text>
            <Text style={styles.detailDescription}>{item.replaces.join(", ")}</Text>
          </View>
        ) : null}
        {readmeLoading ? (
          <Text style={styles.detailDescription}>{t("settings.plugins.discover.loading")}</Text>
        ) : null}
        {readmeError ? (
          <Text style={styles.detailDescription}>{errorMessage(readmeError)}</Text>
        ) : null}
        {readme ? (
          <View style={styles.detailSection}>
            <MarkdownRenderer text={readme} compact />
          </View>
        ) : null}
        {item.repository ? (
          <ExternalLink
            href={item.repository}
            label={t("settings.plugins.market.detailRepository")}
            testID="plugin-detail-repository"
          />
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function DiscoverIntro() {
  const { t } = useTranslation();
  return (
    <View style={styles.intro}>
      <Text style={styles.introTitle}>{t("settings.plugins.discover.introTitle")}</Text>
      <Text style={styles.introBody}>{t("settings.plugins.discover.introBody")}</Text>
      <View style={styles.introMoreRow}>
        <Text style={styles.introBody}>{t("settings.plugins.discover.introMore")}</Text>
        <ExternalLink
          href={PLUGIN_WRITE_DOCS_URL}
          label={t("settings.plugins.discover.writePlugin")}
          testID="plugin-write-docs-link"
        />
      </View>
      <View style={styles.trustRow}>
        <ShieldCheck size={13} color={styles.metaChipIcon.color} />
        <Text style={styles.trustText}>{t("settings.plugins.discover.trust")}</Text>
      </View>
    </View>
  );
}

function BuiltinRow({ id, first }: { id: string; first: boolean }) {
  const { t } = useTranslation();
  const kind = builtinKind(id);
  const name = builtinName(id);
  const description = t(BUILTIN_DESCRIPTION_KEYS[kind], { name: builtinSubject(id) });
  const rowStyle = useMemo(() => [styles.builtinRow, first ? null : styles.rowBorder], [first]);
  return (
    <View style={rowStyle} testID={`plugin-builtin-${id}`}>
      <PluginLogo name={name} />
      <View style={styles.pluginInfo}>
        <Text style={styles.pluginName}>{name}</Text>
        <Text style={styles.pluginDescription}>{description}</Text>
        <Text style={styles.pluginSource}>{id}</Text>
      </View>
      <StatusBadge label={t("settings.plugins.builtin.alwaysOn")} size="xs" />
    </View>
  );
}

/** myna's gateway schema: the choices for callsPage, as segments. */
const CALLS_PAGE_OPTIONS = GATEWAY_CALLS_PAGE_OPTIONS.map((value) => ({
  value: String(value),
  label: String(value),
}));

function BuiltinFeatureRow({
  id,
  enabled,
  inUse,
  first,
  callsPage,
  onCallsPageChange,
  onToggle,
}: {
  id: BuiltinFeatureId;
  enabled: boolean;
  inUse: number;
  first: boolean;
  callsPage?: number;
  onCallsPageChange?: (value: number) => void;
  onToggle(id: BuiltinFeatureId, enabled: boolean): void;
}) {
  const { t, i18n } = useTranslation();
  const copy = builtinFeatureText(id, i18n.language);
  const rowStyle = useMemo(() => [styles.builtinRow, first ? null : styles.rowBorder], [first]);
  const toggle = useCallback(() => onToggle(id, !enabled), [enabled, id, onToggle]);
  const changeCallsPage = useCallback(
    (value: string) => onCallsPageChange?.(Number(value)),
    [onCallsPageChange],
  );
  const inUseLabel = inUse > 0 ? t("settings.plugins.builtin.featureInUse", { n: inUse }) : null;
  const unmappedLabel =
    inUse === 0 && !builtinFeatureHasSurface(id)
      ? t("settings.plugins.builtin.featureUnmapped")
      : null;
  return (
    <View style={rowStyle} testID={`plugin-feature-${id}`}>
      <View style={styles.pluginInfo}>
        <Text style={styles.pluginName}>{copy.name}</Text>
        <Text style={styles.pluginDescription}>{copy.description}</Text>
        {inUseLabel ? <Text style={styles.pluginSource}>{inUseLabel}</Text> : null}
        {unmappedLabel ? <Text style={styles.pluginSource}>{unmappedLabel}</Text> : null}
        {callsPage !== undefined && onCallsPageChange ? (
          <View style={styles.callsPage}>
            <Text style={styles.pluginSource}>{t("settings.plugins.builtin.callsPage")}</Text>
            <SegmentedControl
              size="sm"
              options={CALLS_PAGE_OPTIONS}
              value={String(callsPage)}
              onValueChange={changeCallsPage}
              testID={`plugin-feature-calls-page-${id}`}
            />
          </View>
        ) : null}
      </View>
      <Switch
        value={enabled}
        onValueChange={toggle}
        disabled={inUse > 0}
        accessibilityLabel={copy.name}
        testID={`plugin-feature-switch-${id}`}
      />
    </View>
  );
}

function InstalledTab({
  pageState,
  plugins,
  serverId,
  error,
  query,
  onRetry,
  mutation,
  onAction,
  onOpenLogs,
  supportsLogs,
  providerStatus,
  clientErrorFor,
  configEnabled,
  onToggleGlobal,
}: {
  pageState: ReturnType<typeof resolvePluginPageState>;
  plugins: readonly PluginListItem[] | undefined;
  serverId: string;
  query: string;
  error: unknown;
  onRetry(): void;
  mutation: {
    isPending: boolean;
    variables?: PluginMutationVariables;
  };
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(plugin: PluginListItem): void;
  supportsLogs: boolean;
  providerStatus: ReadonlyMap<string, string>;
  clientErrorFor(pluginId: string): string | undefined;
  configEnabled: boolean;
  onToggleGlobal(enabled: boolean): void;
}) {
  const { t } = useTranslation();
  const pending = mutation.isPending;
  const pendingAction = pluginRowAction(mutation.variables?.action);
  let content = <Alert size="sm" title={t("settings.plugins.states.loading")} />;
  if (pageState === "error") {
    content = (
      <Alert
        size="sm"
        variant="error"
        title={t("settings.plugins.states.errorTitle")}
        description={errorMessage(error)}
      >
        <Button variant="outline" onPress={onRetry}>
          {t("settings.plugins.states.retry")}
        </Button>
      </Alert>
    );
  } else if (pageState === "empty") {
    content = (
      <View style={styles.empty}>
        <Text style={settingsStyles.rowHint}>{t("settings.plugins.states.empty")}</Text>
      </View>
    );
  } else if (pageState === "ready" && (plugins?.length ?? 0) === 0 && query.trim()) {
    content = (
      <Text style={styles.emptyText}>
        {t("settings.plugins.discover.noResults", { query: query.trim() })}
      </Text>
    );
  } else if (pageState === "ready") {
    content = (
      <View style={styles.pluginList}>
        {plugins?.map((plugin, index) => {
          const clientError = clientErrorFor(plugin.id);
          const rowPending = pending && mutation.variables?.pluginId === plugin.id;
          return (
            <PluginRow
              key={plugin.id}
              serverId={serverId}
              plugin={plugin}
              clientError={clientError}
              pending={pending}
              pendingAction={rowPending ? pendingAction : undefined}
              onAction={onAction}
              onOpenLogs={onOpenLogs}
              supportsLogs={supportsLogs}
              providerStatus={providerStatus}
              first={index === 0}
            />
          );
        })}
      </View>
    );
  }

  return (
    <View>
      <Alert
        size="sm"
        variant="warning"
        title={t("settings.plugins.trustedTitle")}
        description={t("settings.plugins.trustedDescription")}
      />
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.plugins.globalTitle")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.plugins.globalHint")}</Text>
          </View>
          <Switch
            value={configEnabled}
            onValueChange={onToggleGlobal}
            disabled={pending}
            accessibilityLabel={t("settings.plugins.globalTitle")}
          />
        </View>
      </View>
      {content}
    </View>
  );
}

interface MarketCategory {
  slug: string;
  label: string;
  description?: string;
  translations?: Record<string, { name?: string; description?: string }>;
}

function buildRegistryGroups(input: {
  plugins: readonly PublishedPlugin[];
  categories: readonly MarketCategory[];
  downloads?: Record<string, number>;
  installed: readonly PluginListItem[] | undefined;
  term: string;
  language: string;
  providerStatus: ReadonlyMap<string, string>;
}): {
  groups: Map<string, MarketCardItem[]>;
  count: number;
  categories: readonly MarketCategory[];
} {
  const groups = new Map<string, MarketCardItem[]>();
  let count = 0;
  for (const plugin of input.plugins) {
    if (!registryMatchesQuery(plugin, input.term, input.categories, input.language)) continue;
    count += 1;
    const slug = plugin.categories[0] ?? "";
    const installed = installedForRegistry(input.installed, plugin.id);
    const signIn = providerSignInState(installed?.providers, input.providerStatus);
    const item: MarketCardItem = {
      source: plugin.id,
      name: localizedName(plugin, input.language),
      description: localizedDescription(plugin, input.language),
      author: plugin.author.name ?? plugin.author.github,
      icon: plugin.icon,
      version: registryVersion(plugin),
      weeklyDownloads: input.downloads?.[plugin.id],
      installs: plugin.installs,
      category: slug ? categoryLabel(input.categories, slug, input.language) : undefined,
      categories: plugin.categories.map((entry) =>
        categoryLabel(input.categories, entry, input.language),
      ),
      replaces: [...new Set([...(plugin.replaces ?? []), ...builtinReplacements(installed)])],
      repository: plugin.repository.url,
      readmeSource: { kind: "registry", id: plugin.id },
      providers: installed?.providers,
      signedIn: signIn.signedIn,
      notSignedIn: signIn.notSignedIn,
      installed: Boolean(installed),
      installedOff: installed?.enabled === false,
      installedPluginId: installed?.id,
      trustedRegistry: true,
    };
    const group = groups.get(slug);
    if (group) group.push(item);
    else groups.set(slug, [item]);
  }
  const known = new Set(input.categories.map((category) => category.slug));
  const extras = [...groups.keys()]
    .filter((slug) => slug && !known.has(slug))
    .map((slug) => ({ slug, label: slug }));
  return { groups, count, categories: [...input.categories, ...extras] };
}

function buildNpmCards(input: {
  hits: readonly PluginMarketSearchHit[];
  installed: readonly PluginListItem[] | undefined;
  term: string;
  registryPackages: ReadonlySet<string>;
  providerStatus: ReadonlyMap<string, string>;
}): MarketCardItem[] {
  return input.hits
    .filter((hit) => !input.registryPackages.has(hit.package) && npmMatchesQuery(hit, input.term))
    .map((hit) => {
      const installed = installedForNpm(input.installed, hit.package);
      const signIn = providerSignInState(installed?.providers, input.providerStatus);
      return {
        source: `npm:${hit.package}`,
        name: hit.name,
        description: hit.description,
        author: hit.publisher,
        version: hit.version ? `v${hit.version}` : undefined,
        weeklyDownloads: hit.weeklyDownloads,
        categories: [],
        replaces: builtinReplacements(installed),
        readmeSource: { kind: "npm", package: hit.package },
        providers: installed?.providers,
        signedIn: signIn.signedIn,
        notSignedIn: signIn.notSignedIn,
        installed: Boolean(installed),
        installedOff: installed?.enabled === false,
        installedPluginId: installed?.id,
        trustedRegistry: false,
      };
    });
}

function RegistrySections({
  groups,
  categories,
  wide,
  language,
  installPendingSource,
  installBusy,
  onInstall,
  onSelect,
}: {
  groups: Map<string, MarketCardItem[]>;
  categories: readonly MarketCategory[];
  wide: boolean;
  language: string;
  installPendingSource?: string;
  installBusy: boolean;
  onInstall(source: string): void;
  onSelect(item: MarketCardItem): void;
}) {
  const { t } = useTranslation();
  const other = groups.get("");
  const ordered = categories.filter((category) => groups.has(category.slug));
  return (
    <>
      {ordered.map((category) => (
        <SettingsSection
          key={category.slug}
          title={translationAt(category.translations, language)?.name ?? category.label}
          info={
            translationAt(category.translations, language)?.description ??
            category.description ??
            category.label
          }
        >
          <View style={styles.grid}>
            {(groups.get(category.slug) ?? []).map((item) => (
              <MarketCard
                key={item.source}
                wide={wide}
                pending={installPendingSource === item.source}
                busy={installBusy}
                onInstall={onInstall}
                onSelect={onSelect}
                item={item}
              />
            ))}
          </View>
        </SettingsSection>
      ))}
      {other?.length ? (
        <SettingsSection title={t("settings.plugins.discover.otherGroup")}>
          <View style={styles.grid}>
            {other.map((item) => (
              <MarketCard
                key={item.source}
                wide={wide}
                pending={installPendingSource === item.source}
                busy={installBusy}
                onInstall={onInstall}
                onSelect={onSelect}
                item={item}
              />
            ))}
          </View>
        </SettingsSection>
      ) : null}
    </>
  );
}

function NpmSection({
  searchTerm,
  searchLoading,
  searchError,
  items,
  wide,
  installPendingSource,
  installBusy,
  onInstall,
  onSelect,
}: {
  searchTerm: string;
  searchLoading: boolean;
  searchError: unknown;
  items: readonly MarketCardItem[];
  wide: boolean;
  installPendingSource?: string;
  installBusy: boolean;
  onInstall(source: string): void;
  onSelect(item: MarketCardItem): void;
}) {
  const { t } = useTranslation();
  const longEnough = searchTerm.length >= 2;
  const idle = longEnough && !searchLoading && !searchError;
  return (
    <SettingsSection
      title={t("settings.plugins.discover.onNpm")}
      info={t("settings.plugins.discover.onNpmHint")}
    >
      {longEnough ? null : (
        <Text style={styles.emptyText}>{t("settings.plugins.discover.npmHint")}</Text>
      )}
      {longEnough && searchLoading ? (
        <Alert size="sm" title={t("settings.plugins.discover.loading")} />
      ) : null}
      {longEnough && searchError ? (
        <Alert
          size="sm"
          variant="error"
          title={t("settings.plugins.discover.errorTitle")}
          description={errorMessage(searchError)}
        />
      ) : null}
      {idle && items.length === 0 ? (
        <Text style={styles.emptyText}>{t("settings.plugins.discover.npmEmpty")}</Text>
      ) : null}
      {items.length ? (
        <View style={styles.grid}>
          {items.map((item) => (
            <MarketCard
              key={item.source}
              wide={wide}
              pending={installPendingSource === item.source}
              busy={installBusy}
              onInstall={onInstall}
              onSelect={onSelect}
              item={item}
            />
          ))}
        </View>
      ) : null}
    </SettingsSection>
  );
}

function DiscoverTab({
  marketSupported,
  market,
  plugins,
  query,
  searchHits,
  searchLoading,
  searchError,
  installPendingSource,
  installBusy,
  language,
  providerStatus,
  onInstall,
  onSelect,
  onRetry,
}: {
  marketSupported: boolean;
  market: {
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    data?: {
      registry: { name: string; url: string };
      categories: MarketCategory[];
      plugins: PublishedPlugin[];
      weeklyDownloads?: Record<string, number>;
    };
    refetch(): void;
  };
  plugins: readonly PluginListItem[] | undefined;
  query: string;
  searchHits: readonly PluginMarketSearchHit[] | undefined;
  searchLoading: boolean;
  searchError: unknown;
  installPendingSource?: string;
  installBusy: boolean;
  language: string;
  providerStatus: ReadonlyMap<string, string>;
  onInstall(source: string): void;
  onSelect(item: MarketCardItem): void;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const wide = !compact;
  const term = query.trim().toLowerCase();
  const registry = useMemo(
    () =>
      buildRegistryGroups({
        plugins: market.data?.plugins ?? [],
        categories: market.data?.categories ?? [],
        downloads: market.data?.weeklyDownloads,
        installed: plugins,
        term,
        language,
        providerStatus,
      }),
    [language, market.data, plugins, providerStatus, term],
  );
  const registryPackages = useMemo(
    () =>
      new Set(
        (market.data?.plugins ?? []).flatMap((plugin) => {
          const name = registryPackageName(plugin);
          return name ? [name] : [];
        }),
      ),
    [market.data],
  );
  const npmItems = useMemo(
    () =>
      buildNpmCards({
        hits: searchHits ?? [],
        installed: plugins,
        term,
        registryPackages,
        providerStatus,
      }),
    [plugins, providerStatus, registryPackages, searchHits, term],
  );
  if (!marketSupported) {
    return <Alert size="md" variant="warning" title={t("settings.plugins.states.updateTitle")} />;
  }
  if (market.isLoading) {
    return (
      <View>
        <DiscoverIntro />
        <Alert size="sm" title={t("settings.plugins.discover.loading")} />
      </View>
    );
  }
  if (market.isError) {
    return (
      <View>
        <DiscoverIntro />
        <Alert
          size="sm"
          variant="error"
          title={t("settings.plugins.discover.errorTitle")}
          description={errorMessage(market.error)}
        >
          <Button variant="outline" onPress={onRetry}>
            {t("settings.plugins.discover.retry")}
          </Button>
        </Alert>
      </View>
    );
  }
  const searchTerm = query.trim();
  const showNpm = searchTerm.length > 0;
  let emptyLabel: string | null = null;
  if (registry.count === 0) {
    emptyLabel = showNpm
      ? t("settings.plugins.discover.noResults", { query: searchTerm })
      : t("settings.plugins.discover.empty");
  }
  return (
    <View>
      <DiscoverIntro />
      {emptyLabel ? <Text style={styles.emptyText}>{emptyLabel}</Text> : null}
      <RegistrySections
        groups={registry.groups}
        categories={registry.categories}
        wide={wide}
        language={language}
        installPendingSource={installPendingSource}
        installBusy={installBusy}
        onInstall={onInstall}
        onSelect={onSelect}
      />
      {showNpm ? (
        <NpmSection
          searchTerm={searchTerm}
          searchLoading={searchLoading}
          searchError={searchError}
          items={npmItems}
          wide={wide}
          installPendingSource={installPendingSource}
          installBusy={installBusy}
          onInstall={onInstall}
          onSelect={onSelect}
        />
      ) : null}
    </View>
  );
}

function BuiltinTab({
  supported,
  builtin,
  serverId,
}: {
  supported: boolean;
  serverId: string;
  builtin: {
    isLoading: boolean;
    isError: boolean;
    error: unknown;
    data?: string[];
    refetch(): void;
  };
}) {
  const { t } = useTranslation();
  const { isEnabled, setEnabled, useCounts, gatewayCallsPage, setGatewayCallsPage } =
    useBuiltinFeatures(serverId);
  const toggleFeature = useCallback(
    (id: BuiltinFeatureId, enabled: boolean) => setEnabled(id, enabled),
    [setEnabled],
  );
  if (!supported) {
    return <Alert size="md" variant="warning" title={t("settings.plugins.states.updateTitle")} />;
  }
  const ids = builtin.data ?? [];
  const groups: Record<BuiltinKind, string[]> = {
    providers: [],
    usageSources: [],
    worktree: [],
    other: [],
  };
  for (const id of ids) groups[builtinKind(id)].push(id);
  const sections: { kind: BuiltinKind; title: string }[] = [
    { kind: "providers", title: t("settings.plugins.builtin.kindProviders") },
    { kind: "usageSources", title: t("settings.plugins.builtin.kindUsageSources") },
    { kind: "worktree", title: t("settings.plugins.builtin.kindWorktree") },
    { kind: "other", title: t("settings.plugins.builtin.kindOther") },
  ];
  return (
    <View>
      <SettingsSection title={t("settings.plugins.builtin.featuresTitle")}>
        <Text style={styles.emptyText}>{t("settings.plugins.builtin.featuresHint")}</Text>
        <View style={styles.pluginList}>
          {BUILTIN_FEATURE_IDS.map((id, index) => (
            <BuiltinFeatureRow
              key={id}
              id={id}
              enabled={isEnabled(id)}
              inUse={useCounts[id]}
              first={index === 0}
              callsPage={id === "gateway" ? gatewayCallsPage : undefined}
              onCallsPageChange={id === "gateway" ? setGatewayCallsPage : undefined}
              onToggle={toggleFeature}
            />
          ))}
        </View>
      </SettingsSection>
      <Text style={styles.emptyText}>{t("settings.plugins.builtin.hint")}</Text>
      {builtin.isLoading ? <Alert size="sm" title={t("settings.plugins.states.loading")} /> : null}
      {builtin.isError ? (
        <Alert
          size="sm"
          variant="error"
          title={t("settings.plugins.states.errorTitle")}
          description={errorMessage(builtin.error)}
        >
          <Button variant="outline" onPress={builtin.refetch}>
            {t("settings.plugins.states.retry")}
          </Button>
        </Alert>
      ) : null}
      {sections.map((section) =>
        groups[section.kind].length ? (
          <SettingsSection key={section.kind} title={section.title}>
            <View style={styles.pluginList}>
              {groups[section.kind].map((id, index) => (
                <BuiltinRow key={id} id={id} first={index === 0} />
              ))}
            </View>
          </SettingsSection>
        ) : null,
      )}
    </View>
  );
}

function PluginsHeader({
  view,
  installedCount,
  query,
  mirror,
  showSearch,
  resetKey,
  onViewChange,
  onQueryChange,
  onMirrorChange,
  onRefresh,
}: {
  view: PluginsView;
  installedCount: number;
  query: string;
  mirror: boolean;
  showSearch: boolean;
  resetKey: number;
  onViewChange(view: PluginsView): void;
  onQueryChange(value: string): void;
  onMirrorChange(value: boolean): void;
  onRefresh(): void;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () => [
      {
        value: "builtin" as const,
        label: t("settings.plugins.views.builtin"),
        testID: "plugin-tab-builtin",
      },
      {
        value: "discover" as const,
        label: t("settings.plugins.views.discover"),
        testID: "plugin-tab-discover",
      },
      {
        value: "installed" as const,
        label:
          installedCount > 0
            ? `${t("settings.plugins.views.installed")} · ${installedCount}`
            : t("settings.plugins.views.installed"),
        testID: "plugin-tab-installed",
      },
    ],
    [installedCount, t],
  );
  return (
    <View style={styles.header}>
      <SegmentedControl
        options={options}
        value={view}
        onValueChange={onViewChange}
        size="sm"
        testID="plugin-views"
      />
      <View style={styles.headerTools}>
        {showSearch ? (
          <View style={styles.mirrorRow}>
            <Text style={styles.mirrorLabel}>{t("settings.plugins.header.mirror")}</Text>
            <Switch
              value={mirror}
              onValueChange={onMirrorChange}
              accessibilityLabel={t("settings.plugins.header.mirror")}
              testID="plugin-mirror-switch"
            />
          </View>
        ) : null}
        {showSearch ? (
          <View style={styles.searchField}>
            <Search size={14} color={styles.metaChipIcon.color} />
            <FormTextInput
              initialValue={query}
              resetKey={resetKey}
              onChangeText={onQueryChange}
              placeholder={t("settings.plugins.header.search")}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={200}
              accessibilityLabel={t("settings.plugins.header.search")}
              testID="plugin-search-input"
              style={styles.searchInput}
            />
          </View>
        ) : null}
        <ToolbarButton
          label={t("settings.plugins.header.refresh")}
          onPress={onRefresh}
          testID="plugin-refresh"
        >
          <RefreshCw size={16} color={styles.menuIcon.color} />
        </ToolbarButton>
      </View>
    </View>
  );
}

function InstallFooter({
  supported,
  form,
  state,
  pending,
  onInstall,
}: {
  supported: boolean;
  form: ReturnType<typeof openPluginInstallForm>;
  state: { canSubmit: boolean; resetKey: number };
  pending: boolean;
  onInstall(): void;
}) {
  const { t } = useTranslation();
  if (!supported) {
    return (
      <Alert size="sm" variant="warning" title={t("settings.plugins.states.sourceUpdateTitle")} />
    );
  }
  return (
    <View style={styles.footer} testID="plugin-install-footer">
      <Text style={styles.footerLabel}>{t("settings.plugins.footer.haveOne")}</Text>
      <View style={styles.footerInput}>
        <FormTextInput
          initialValue=""
          resetKey={state.resetKey}
          onChangeText={form.setSource}
          placeholder={t("settings.plugins.footer.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!pending}
          accessibilityLabel={t("settings.plugins.footer.placeholder")}
          testID="plugin-install-input"
        />
      </View>
      <Button onPress={onInstall} disabled={!state.canSubmit || pending}>
        {pending ? t("settings.plugins.footer.installing") : t("settings.plugins.footer.install")}
      </Button>
    </View>
  );
}

function usePluginsPageData(input: {
  serverId: string;
  view: PluginsView;
  mirror: boolean;
  debouncedQuery: string;
  refreshNonce: number;
}) {
  const client = useHostRuntimeClient(input.serverId);
  const connected = useHostRuntimeIsConnected(input.serverId);
  const supported = useHostFeature(input.serverId, "pluginManagement");
  // COMPAT(pluginMarket): added in v0.15.0, remove gate after 2027-11-05.
  const marketSupported = useHostFeature(input.serverId, "pluginMarket");
  // COMPAT(pluginBuiltinList): added in v0.15.0, remove gate after 2027-11-05.
  const builtinSupported = useHostFeature(input.serverId, "pluginBuiltinList");
  // COMPAT(pluginSourceInstallation): added in v0.8.0; remove gate after 2027-03-16 once daemon floor supports source identifiers.
  const sourceInstallSupported = useHostFeature(input.serverId, "pluginSourceInstallation");
  // COMPAT(pluginLogs): added in v0.4.0, remove gate after 2027-08-16.
  const logsSupported = useHostFeature(input.serverId, "pluginLogs");
  const hostReady = Boolean(client && connected && supported);
  const market = useFetchQuery({
    queryKey: ["plugin-market", input.serverId, input.refreshNonce] as const,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.getPluginMarket();
    },
    enabled: hostReady && marketSupported && input.view === "discover",
    dataShape: "value",
    staleTimeMs: 5 * 60_000,
  });
  const builtin = useFetchQuery({
    queryKey: ["plugin-builtins", input.serverId, input.refreshNonce] as const,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listBuiltinPlugins();
    },
    enabled: hostReady && builtinSupported && input.view === "builtin",
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  const search = useFetchQuery({
    queryKey: ["plugin-market-search", input.serverId, input.debouncedQuery, input.mirror] as const,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.searchPluginMarket(input.debouncedQuery, { mirror: input.mirror });
    },
    enabled:
      hostReady && marketSupported && input.view === "discover" && input.debouncedQuery.length >= 2,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  return {
    client,
    connected,
    supported,
    marketSupported,
    builtinSupported,
    sourceInstallSupported,
    logsSupported,
    market,
    builtin,
    search,
  };
}

export interface PluginsViewCounts {
  builtin: number;
  discover: number;
  installed: number;
}

/**
 * The counts the plugin page shows beside each subpage. A sidebar mirroring the page can call
 * this; the queries share the page's keys, so opening the page reuses these results.
 */
export function usePluginsViewCounts(serverId: string): PluginsViewCounts {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "pluginManagement");
  const marketSupported = useHostFeature(serverId, "pluginMarket");
  const builtinSupported = useHostFeature(serverId, "pluginBuiltinList");
  const ready = Boolean(client && connected && supported);
  const plugins = usePluginList(serverId);
  const market = useFetchQuery({
    queryKey: ["plugin-market", serverId, 0] as const,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.getPluginMarket();
    },
    enabled: ready && marketSupported,
    dataShape: "value",
    staleTimeMs: 5 * 60_000,
  });
  const builtin = useFetchQuery({
    queryKey: ["plugin-builtins", serverId, 0] as const,
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listBuiltinPlugins();
    },
    enabled: ready && builtinSupported,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  return useMemo(
    () => ({
      builtin: pluginBuiltinCount(builtin.data),
      discover: pluginMarketCount(market.data?.plugins),
      installed: pluginInstalledCount(plugins.data),
    }),
    [builtin.data, market.data, plugins.data],
  );
}

function PluginsPageBody({
  view,
  installedCount,
  query,
  mirror,
  searchResetKey,
  feedback,
  fillViewport,
  onViewChange,
  onQueryChange,
  onMirrorChange,
  onRefresh,
  installedPageState,
  installedPlugins,
  installedError,
  installedQuery,
  onRetryInstalled,
  mutation,
  onAction,
  onOpenLogs,
  supportsLogs,
  providerStatus,
  clientErrorFor,
  configEnabled,
  onToggleGlobal,
  marketSupported,
  market,
  plugins,
  searchHits,
  searchLoading,
  searchError,
  installPendingSource,
  installBusy,
  language,
  onInstall,
  onSelectMarket,
  onRetryMarket,
  sourceInstallSupported,
  installForm,
  installState,
  footerPending,
  onInstallForm,
  builtinSupported,
  builtin,
  client,
  logsPlugin,
  serverId,
  onCloseLogs,
  detailItem,
  onCloseDetail,
  onRemoveDetail,
  readme,
  readmeLoading,
  readmeError,
}: {
  view: PluginsView;
  installedCount: number;
  query: string;
  mirror: boolean;
  searchResetKey: number;
  feedback: { kind: "success" | "error"; message: string } | null;
  fillViewport: boolean;
  onViewChange(view: PluginsView): void;
  onQueryChange(value: string): void;
  onMirrorChange(value: boolean): void;
  onRefresh(): void;
  installedPageState: ReturnType<typeof resolvePluginPageState>;
  installedPlugins: readonly PluginListItem[] | undefined;
  installedError: unknown;
  installedQuery: string;
  onRetryInstalled(): void;
  mutation: { isPending: boolean; variables?: PluginMutationVariables };
  onAction(action: PluginRowAction, plugin: PluginListItem): void;
  onOpenLogs(plugin: PluginListItem): void;
  supportsLogs: boolean;
  providerStatus: ReadonlyMap<string, string>;
  clientErrorFor(pluginId: string): string | undefined;
  configEnabled: boolean;
  onToggleGlobal(enabled: boolean): void;
  marketSupported: boolean;
  market: Parameters<typeof DiscoverTab>[0]["market"];
  plugins: readonly PluginListItem[] | undefined;
  searchHits: readonly PluginMarketSearchHit[] | undefined;
  searchLoading: boolean;
  searchError: unknown;
  installPendingSource?: string;
  installBusy: boolean;
  language: string;
  onInstall(source: string): void;
  onSelectMarket(item: MarketCardItem): void;
  onRetryMarket(): void;
  sourceInstallSupported: boolean;
  installForm: ReturnType<typeof openPluginInstallForm>;
  installState: { canSubmit: boolean; resetKey: number };
  footerPending: boolean;
  onInstallForm(): void;
  builtinSupported: boolean;
  builtin: Parameters<typeof BuiltinTab>[0]["builtin"];
  client: ReturnType<typeof useHostRuntimeClient>;
  logsPlugin: PluginListItem | null;
  serverId: string;
  onCloseLogs(): void;
  detailItem: MarketCardItem | null;
  onCloseDetail(): void;
  onRemoveDetail(item: MarketCardItem): void;
  readme?: string;
  readmeLoading: boolean;
  readmeError: unknown;
}) {
  const header = (
    <PluginsHeader
      view={view}
      installedCount={installedCount}
      query={query}
      mirror={mirror}
      showSearch={view !== "builtin"}
      resetKey={searchResetKey}
      onViewChange={onViewChange}
      onQueryChange={onQueryChange}
      onMirrorChange={onMirrorChange}
      onRefresh={onRefresh}
    />
  );
  const feedbackAlert = feedback ? (
    <Alert
      size="sm"
      variant={feedback.kind}
      title={feedback.message}
      testID="plugin-management-feedback"
    />
  ) : null;
  const footer = (
    <InstallFooter
      supported={sourceInstallSupported}
      form={installForm}
      state={installState}
      pending={footerPending}
      onInstall={onInstallForm}
    />
  );
  const tabs = (
    <>
      {view === "installed" ? (
        <InstalledTab
          pageState={installedPageState}
          plugins={installedPlugins}
          serverId={serverId}
          error={installedError}
          query={installedQuery}
          onRetry={onRetryInstalled}
          mutation={mutation}
          onAction={onAction}
          onOpenLogs={onOpenLogs}
          supportsLogs={supportsLogs}
          providerStatus={providerStatus}
          clientErrorFor={clientErrorFor}
          configEnabled={configEnabled}
          onToggleGlobal={onToggleGlobal}
        />
      ) : null}
      {view === "discover" ? (
        <DiscoverTab
          marketSupported={marketSupported}
          market={market}
          plugins={plugins}
          query={query}
          searchHits={searchHits}
          searchLoading={searchLoading}
          searchError={searchError}
          installPendingSource={installPendingSource}
          installBusy={installBusy}
          language={language}
          providerStatus={providerStatus}
          onInstall={onInstall}
          onSelect={onSelectMarket}
          onRetry={onRetryMarket}
        />
      ) : null}
      {view === "builtin" ? (
        <BuiltinTab supported={builtinSupported} builtin={builtin} serverId={serverId} />
      ) : null}
    </>
  );
  const overlays = (
    <>
      {client && logsPlugin ? (
        <PluginLogsSheet
          client={client}
          plugin={logsPlugin}
          serverId={serverId}
          onClose={onCloseLogs}
        />
      ) : null}
      {detailItem ? (
        <MarketDetailSheet
          item={detailItem}
          pending={detailItem.installed ? false : installPendingSource === detailItem.source}
          busy={mutation.isPending}
          onClose={onCloseDetail}
          onInstall={onInstall}
          onRemove={onRemoveDetail}
          readme={readme}
          readmeLoading={readmeLoading}
          readmeError={readmeError}
        />
      ) : null}
    </>
  );
  if (fillViewport) {
    return (
      <View style={styles.fill}>
        <ScrollView
          style={styles.fillScroll}
          contentContainerStyle={styles.fillContent}
          testID="plugin-fill-scroll"
        >
          {header}
          {feedbackAlert}
          {tabs}
        </ScrollView>
        {view === "discover" ? footer : null}
        {overlays}
      </View>
    );
  }
  return (
    <View>
      {header}
      {feedbackAlert}
      {tabs}
      {view === "discover" ? footer : null}
      {overlays}
    </View>
  );
}

export function HostPluginsPage({
  serverId,
  view: controlledView,
  fillViewport = false,
  onViewChange,
}: {
  serverId: string;
  /** Controlled subpage, for a sidebar mirroring the page's tabs. */
  view?: PluginsView;
  /**
   * Render as a scrolling body plus a footer pinned below it. The host must place the page in a
   * bounded, non-scrolling container; `PageLayout`'s own ScrollView cannot host this.
   */
  fillViewport?: boolean;
  onViewChange?(view: PluginsView): void;
}) {
  const { t, i18n } = useTranslation();
  // COMPAT(pluginReadme): added in v0.15.0, remove gate after 2027-11-05.
  const readmeSupported = useHostFeature(serverId, "pluginReadme");
  const { config, patchConfig } = useDaemonConfig(serverId);
  useInstalledPlugins();
  const [activeView, setActiveView] = useState<PluginsView>("discover");
  const view = controlledView ?? activeView;
  const [searchResetKey, setSearchResetKey] = useState(0);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [mirror, setMirror] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [installForm] = useState(openPluginInstallForm);
  const installState = useSyncExternalStore(
    installForm.subscribe,
    installForm.getState,
    installForm.getState,
  );
  const [logsPlugin, setLogsPlugin] = useState<PluginListItem | null>(null);
  const [detailItem, setDetailItem] = useState<MarketCardItem | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(
    null,
  );
  const plugins = usePluginList(serverId);
  const providersSnapshot = useProvidersSnapshot(serverId);
  const providerStatus = useMemo(
    () =>
      new Map(
        (providersSnapshot.entries ?? []).map((entry) => [entry.provider, entry.status] as const),
      ),
    [providersSnapshot.entries],
  );
  const refetchPlugins = plugins.refetch;
  const {
    client,
    connected,
    supported,
    marketSupported,
    builtinSupported,
    sourceInstallSupported,
    logsSupported,
    market,
    builtin,
    search,
  } = usePluginsPageData({ serverId, view, mirror, debouncedQuery, refreshNonce });
  const readme = useFetchQuery({
    queryKey: ["plugin-readme", serverId, detailItem?.readmeSource, i18n.language] as const,
    queryFn: async () => {
      if (!client || !detailItem?.readmeSource) throw new Error("Plugin README is unavailable");
      return client.getPluginReadme(detailItem.readmeSource, i18n.language);
    },
    enabled: Boolean(client && detailItem?.readmeSource && readmeSupported),
    dataShape: "value",
    staleTimeMs: 10 * 60_000,
  });

  useEffect(() => {
    AsyncStorage.getItem(MIRROR_STORAGE_KEY)
      .then((value) => {
        if (value === "1") setMirror(true);
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(VIEW_STORAGE_KEY)
      .then((value) => {
        if (value && isPluginsView(value)) setActiveView(value);
        return undefined;
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!controlledView) return;
    setQuery("");
    setSearchResetKey((key) => key + 1);
    AsyncStorage.setItem(VIEW_STORAGE_KEY, controlledView).catch(() => undefined);
  }, [controlledView]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const refresh = useCallback(async () => {
    if (!client) return;
    setRefreshNonce((nonce) => nonce + 1);
    await refetchPlugins();
  }, [client, refetchPlugins]);
  const retry = useCallback(() => {
    void refetchPlugins();
  }, [refetchPlugins]);

  useEffect(() => {
    return () => installForm.close();
  }, [installForm]);

  useEffect(() => {
    if (!client || !connected || !supported) return;
    const observation = client.observeEvents(["status.plugin_catalog_changed"]);
    observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "status" && message.payload.status === "plugin_catalog_changed")
          void refresh();
      },
    });
    return () => {
      void observation
        .release()
        .catch((error) => console.warn("[Plugins] Failed to release settings feed", error));
    };
  }, [client, connected, supported, refresh]);

  const mutation = useMutation({
    mutationFn: async (operation: PluginMutationVariables) => operation.run(),
    onSuccess: async (message) => {
      setFeedback({ kind: "success", message });
      setDetailItem(null);
      await refresh();
    },
    onError: (error) => setFeedback({ kind: "error", message: errorMessage(error) }),
  });

  const installSource = useCallback(
    (source: string, sourceKey?: string) => {
      if (!client || !sourceInstallSupported || mutation.isPending || !source.trim()) return;
      setFeedback(null);
      mutation.mutate({
        action: "install",
        sourceKey,
        run: async () => {
          const installed = await client.installPluginSource({ source: source.trim() });
          return t("settings.plugins.feedback.installed", { name: pluginDisplayName(installed) });
        },
      });
    },
    [client, mutation, sourceInstallSupported, t],
  );
  const installFromForm = useCallback(() => {
    if (!installState.canSubmit || mutation.isPending) return;
    const input = installForm.getSubmission();
    if (!client || !sourceInstallSupported) return;
    setFeedback(null);
    mutation.mutate({
      action: "install",
      run: async () => {
        const installed = await client.installPluginSource(input);
        installForm.reset();
        return t("settings.plugins.feedback.installed", { name: pluginDisplayName(installed) });
      },
    });
  }, [client, installForm, installState.canSubmit, mutation, sourceInstallSupported, t]);
  const action = useCallback(
    (name: PluginRowAction, plugin: PluginListItem) => {
      if (!client) return;
      const pluginName = pluginDisplayName(plugin);
      const run = async () => {
        if (name === "remove") {
          const confirmed = await confirmDialog({
            title: t("settings.plugins.removeConfirmTitle", { name: pluginName }),
            message: t("settings.plugins.removeConfirmMessage"),
            confirmLabel: t("settings.plugins.actions.remove"),
            destructive: true,
          });
          if (!confirmed) return t("settings.plugins.feedback.kept", { name: pluginName });
          await client.removePlugin(plugin.id);
        } else {
          await client[`${name}Plugin`](plugin.id);
        }
        return t(`settings.plugins.feedback.${name}`, { name: pluginName });
      };
      setFeedback(null);
      mutation.mutate({ action: name, pluginId: plugin.id, run });
    },
    [client, mutation, t],
  );
  const closeDetail = useCallback(() => setDetailItem(null), []);
  const selectMarketItem = useCallback((item: MarketCardItem) => setDetailItem(item), []);
  const removeDetail = useCallback(
    (item: MarketCardItem) => {
      const target = item.installedPluginId
        ? plugins.data?.find((plugin) => plugin.id === item.installedPluginId)
        : undefined;
      setDetailItem(null);
      if (target) action("remove", target);
    },
    [action, plugins.data],
  );
  const toggleGlobal = useCallback(
    (enabled: boolean) => {
      setFeedback(null);
      mutation.mutate({
        action: enabled ? "global-enable" : "global-disable",
        run: async () => {
          await patchConfig({ pluginsEnabled: enabled });
          return enabled
            ? t("settings.plugins.feedback.globalEnabled")
            : t("settings.plugins.feedback.globalDisabled");
        },
      });
    },
    [mutation, patchConfig, t],
  );
  const changeView = useCallback(
    (next: PluginsView) => {
      setActiveView(next);
      setQuery("");
      setSearchResetKey((key) => key + 1);
      AsyncStorage.setItem(VIEW_STORAGE_KEY, next).catch(() => undefined);
      onViewChange?.(next);
    },
    [onViewChange],
  );
  const refreshFromHeader = useCallback(() => {
    void refresh();
  }, [refresh]);
  const retryMarket = useCallback(() => {
    void market.refetch();
  }, [market]);
  const installMarketSource = useCallback(
    (source: string) => installSource(source, source),
    [installSource],
  );
  const changeMirror = useCallback((next: boolean) => {
    setMirror(next);
    AsyncStorage.setItem(MIRROR_STORAGE_KEY, next ? "1" : "0").catch(() => undefined);
  }, []);
  const closeLogs = useCallback(() => setLogsPlugin(null), []);
  const clientErrorFor = useCallback(
    (pluginId: string) => pluginRegistry.getEvaluationError(serverId, pluginId),
    [serverId],
  );

  const pageState = resolvePluginPageState({
    connected,
    supported,
    loading: plugins.isLoading,
    error: plugins.isError,
    pluginCount: plugins.data?.length ?? 0,
  });
  const installedCount = pluginInstalledCount(plugins.data);
  const normalizedQuery = query.trim().toLowerCase();
  const visiblePlugins = useMemo(
    () => plugins.data?.filter((plugin) => pluginMatchesQuery(plugin, normalizedQuery)),
    [normalizedQuery, plugins.data],
  );
  const installPendingSource =
    mutation.isPending && mutation.variables?.action === "install"
      ? mutation.variables.sourceKey
      : undefined;
  const footerPending = mutation.isPending && mutation.variables?.action === "install";

  if (pageState === "offline") {
    return (
      <Alert
        size="md"
        variant="warning"
        title={t("settings.plugins.states.offlineTitle")}
        description={t("settings.plugins.states.offlineDescription")}
      />
    );
  }
  if (pageState === "unsupported") {
    return <Alert size="md" variant="warning" title={t("settings.plugins.states.updateTitle")} />;
  }

  return (
    <PluginsPageBody
      view={view}
      installedCount={installedCount}
      query={query}
      mirror={mirror}
      searchResetKey={searchResetKey}
      feedback={feedback}
      fillViewport={fillViewport}
      onViewChange={changeView}
      onQueryChange={setQuery}
      onMirrorChange={changeMirror}
      onRefresh={refreshFromHeader}
      installedPageState={pageState}
      installedPlugins={visiblePlugins}
      installedError={plugins.error}
      installedQuery={query}
      onRetryInstalled={retry}
      mutation={mutation}
      onAction={action}
      onOpenLogs={setLogsPlugin}
      supportsLogs={logsSupported}
      providerStatus={providerStatus}
      clientErrorFor={clientErrorFor}
      configEnabled={config?.pluginsEnabled === true}
      onToggleGlobal={toggleGlobal}
      marketSupported={marketSupported}
      market={market}
      plugins={plugins.data}
      searchHits={search.data}
      searchLoading={search.isLoading || search.isFetching}
      searchError={search.error}
      installPendingSource={installPendingSource}
      installBusy={mutation.isPending}
      language={i18n.language}
      onInstall={installMarketSource}
      onSelectMarket={selectMarketItem}
      onRetryMarket={retryMarket}
      sourceInstallSupported={sourceInstallSupported}
      installForm={installForm}
      installState={installState}
      footerPending={footerPending}
      onInstallForm={installFromForm}
      builtinSupported={builtinSupported}
      builtin={builtin}
      client={client}
      logsPlugin={logsPlugin}
      serverId={serverId}
      onCloseLogs={closeLogs}
      detailItem={detailItem}
      onCloseDetail={closeDetail}
      onRemoveDetail={removeDetail}
      readme={readme.data}
      readmeLoading={readme.isLoading || readme.isFetching}
      readmeError={readme.error}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    marginBottom: theme.spacing[4],
  },
  headerTools: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flexShrink: 1,
  },
  mirrorRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  mirrorLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  searchField: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 200,
    flexShrink: 1,
  },
  searchInput: { minWidth: 160 },
  intro: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    marginBottom: theme.spacing[6],
  },
  introTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  introBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  introMoreRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  trustRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  trustText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardHalf: { flexBasis: "48%", flexGrow: 1, minWidth: 240 },
  cardFull: { width: "100%" },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardWho: { flex: 1, minWidth: 0 },
  cardName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  cardAuthorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: 2,
  },
  cardAuthor: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  cardSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
  },
  cardMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  metaChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  metaChipIcon: { color: theme.colors.foregroundExtraMuted },
  metaChipText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  logo: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoLarge: {
    width: 44,
    height: 44,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoLetter: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  logoLetterLarge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  logoIcon: { color: theme.colors.foregroundExtraMuted },
  pluginList: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    marginBottom: theme.spacing[4],
  },
  pluginRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  builtinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  pluginInfo: { flex: 1, minWidth: 160 },
  pluginTitleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  pluginName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  version: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  pluginDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  pluginSource: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  callsPage: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  pluginControls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  menuButton: { padding: theme.spacing[1], borderRadius: theme.borderRadius.sm },
  menuIcon: { color: theme.colors.foregroundMuted },
  dangerIcon: { color: theme.colors.statusDanger },
  empty: { padding: theme.spacing[4], alignItems: "center" },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[4],
  },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    marginTop: theme.spacing[2],
  },
  footerLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footerInput: { flex: 1, minWidth: 200 },
  logsState: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  logList: { gap: theme.spacing[2] },
  logEntry: {
    padding: theme.spacing[3],
    gap: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  logStdout: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  logStderr: {
    color: theme.colors.statusDanger,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  logMessage: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.base,
  },
  fill: { flex: 1 },
  fillScroll: { flex: 1 },
  fillContent: { paddingBottom: theme.spacing[4] },
  detailBody: { gap: theme.spacing[4] },
  detailHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  detailName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  detailSection: { gap: theme.spacing[2] },
  detailSectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailDescription: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: 22,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  detailLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  detailValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    textAlign: "right",
  },
}));
