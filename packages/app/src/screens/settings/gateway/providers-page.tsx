import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Boxes, ChevronRight, MoreVertical, Plus } from "lucide-react-native";
import type {
  GatewayConfigWire,
  GatewayPriceWire,
  GatewayProviderWire,
} from "@neolix/protocol/gateway";
import type { SessionOutboundMessage } from "@neolix/protocol/messages";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { Switch } from "@/components/ui/switch";
import { SettingsAction } from "@/components/settings";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { StatusBadge } from "@/components/ui/status-badge";
import { PluginIconView } from "@/plugins/icons";
import { useProviderRowActions, type PluginRowAction } from "@/plugins/row-actions";
import { getStatusDotColor } from "@/utils/status-dot-color";
import type { Theme } from "@/styles/theme";
import { settingsStyles } from "@/styles/settings";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSettingsNavigate } from "@/screens/settings/app/shared";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { ProvidersAddSheet } from "./providers-add-sheet";
import { ProvidersImportSheet, type ImportItem, type ImportSource } from "./providers-import-sheet";
import { ProviderEditor } from "./providers-editor";
import type { GatewayProviderPreset } from "./providers-presets";
import {
  isProviderOn,
  moveProvider,
  nextProviderId,
  providerAccountName,
  providerCanMove,
  providerHost,
  providerKeySummary,
  providerMatchesQuery,
  providerModelCount,
  uniqueProviderId,
  withPreservedProviderFields,
  type ProviderKeySummary,
} from "./providers-helpers";
import type { GatewayPageProps } from "./types";

const ThemedProviderIcon = withUnistyles(Boxes);
const ThemedChevron = withUnistyles(ChevronRight);
const ThemedMore = withUnistyles(MoreVertical);
const ThemedPluginIcon = withUnistyles(PluginIconView);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

type UpstreamStatus = Extract<
  SessionOutboundMessage,
  { type: "gateway.provider.upstream_status.response" }
>["payload"]["statuses"][number];
type UpstreamLevel = NonNullable<UpstreamStatus["level"]>;

/** The levels worth saying; a vendor reporting all well gets no badge. */
const UPSTREAM_LABELS: Record<Exclude<UpstreamLevel, "ok">, string> = {
  maintenance: "upstreamMaintenance",
  degraded: "upstreamDegraded",
  partial: "upstreamPartial",
  major: "upstreamMajor",
};

/** A key's health tone, through the one status-dot mapping. */
const DOT_TONE_PROPS = {
  success: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "attention" }) }),
  warning: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "needs_input" }) }),
  muted: (theme: Theme) => ({
    color: getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }),
  }),
} satisfies Record<ProviderKeySummary["tone"], (theme: Theme) => { color: string | null }>;

function ProviderDotView({ color }: { color: string | null }) {
  return <View style={[styles.dot, color === null ? null : { backgroundColor: color }]} />;
}

const ThemedProviderDot = withUnistyles(ProviderDotView);

/** What the editor is open on: nothing, a new provider, one by id, or a copy of one. */
type EditorTarget =
  | { kind: "new"; preset?: GatewayProviderPreset }
  | { kind: "existing"; id: string }
  | { kind: "duplicate"; provider: GatewayProviderWire }
  | null;

interface ProviderRowProps {
  provider: GatewayProviderWire;
  /** The host whose plugins contribute this row's menu items. */
  serverId: string;
  /** When off, the accounts' own names are hidden; keys are masked either way. */
  maskAccounts: boolean;
  /** What the vendor's status page says, when it says anything but "all well". */
  upstream?: Exclude<UpstreamLevel, "ok">;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onMove: (id: string, delta: -1 | 1) => void;
}

function ProviderRow({
  provider,
  serverId,
  maskAccounts,
  upstream,
  canMoveUp,
  canMoveDown,
  onOpen,
  onToggle,
  onMove,
}: ProviderRowProps) {
  const { t } = useTranslation();
  const pluginActions = useProviderRowActions({
    serverId,
    id: provider.id,
    name: provider.label ?? provider.id,
  });
  const handlePress = useCallback(() => onOpen(provider.id), [onOpen, provider.id]);
  const handleToggle = useCallback(
    (enabled: boolean) => onToggle(provider.id, enabled),
    [onToggle, provider.id],
  );
  const handleMoveUp = useCallback(() => onMove(provider.id, -1), [onMove, provider.id]);
  const handleMoveDown = useCallback(() => onMove(provider.id, 1), [onMove, provider.id]);
  const key = providerKeySummary(provider);
  const keyText = key.kind === "key" ? key.text : t(`settings.gatewayPages.providers.${key.kind}`);
  const accountName = providerAccountName(provider);
  const moveUpIcon = useMemo(() => <ThemedArrowUp size={14} uniProps={mutedColorMapping} />, []);
  const moveDownIcon = useMemo(
    () => <ThemedArrowDown size={14} uniProps={mutedColorMapping} />,
    [],
  );
  const modelCount = providerModelCount(provider);
  const modelLabel =
    modelCount === 0
      ? t("settings.gatewayPages.providers.noModels")
      : t("settings.gatewayPages.providers.modelCount", { count: modelCount });
  const name = provider.label ?? provider.id;
  const subParts = [providerHost(provider.baseUrl), modelLabel];
  if (!maskAccounts && accountName !== null) {
    subParts.unshift(accountName);
  }

  return (
    <PressHighlight
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={t("settings.gatewayPages.providers.openProvider", { name })}
      testID={`gateway-provider-${provider.id}`}
    >
      <View style={styles.iconBox}>
        {provider.icon === undefined || provider.icon.length === 0 ? (
          <ThemedProviderIcon size={16} uniProps={foregroundColorMapping} />
        ) : (
          <Text style={styles.iconGlyph}>{provider.icon}</Text>
        )}
      </View>
      <View style={styles.rowContent}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {name}
          </Text>
          {isProviderOn(provider) ? null : (
            <StatusBadge
              label={t("settings.gatewayPages.providers.badgeOff")}
              variant="muted"
              size="xs"
            />
          )}
          {upstream === undefined ? null : (
            <StatusBadge
              label={t(`settings.gatewayPages.providers.${UPSTREAM_LABELS[upstream]}`)}
              variant={upstream === "degraded" || upstream === "maintenance" ? "warning" : "error"}
              size="xs"
            />
          )}
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {subParts.join(" · ")}
        </Text>
      </View>
      <View style={styles.keyCell}>
        <ThemedProviderDot uniProps={DOT_TONE_PROPS[key.tone]} />
        <Text style={styles.keyText} numberOfLines={1}>
          {keyText}
        </Text>
      </View>
      {isProviderOn(provider) ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            accessibilityRole="button"
            accessibilityLabel={t("settings.gatewayPages.providers.reorder")}
            hitSlop={8}
            style={styles.menuTrigger}
          >
            <ThemedMore size={14} uniProps={mutedColorMapping} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" width={200}>
            <DropdownMenuItem leading={moveUpIcon} disabled={!canMoveUp} onSelect={handleMoveUp}>
              {t("settings.gatewayPages.providers.moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={moveDownIcon}
              disabled={!canMoveDown}
              onSelect={handleMoveDown}
            >
              {t("settings.gatewayPages.providers.moveDown")}
            </DropdownMenuItem>
            {pluginActions.map((action) => (
              <ProviderPluginAction key={action.key} action={action} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <Switch
        value={isProviderOn(provider)}
        onValueChange={handleToggle}
        accessibilityLabel={t("settings.gatewayPages.providers.enabled")}
        testID={`gateway-provider-switch-${provider.id}`}
      />
      <ThemedChevron size={14} uniProps={mutedColorMapping} />
    </PressHighlight>
  );
}

function ProviderPluginAction({ action }: { action: PluginRowAction }) {
  const leading = useMemo(
    () =>
      action.icon === undefined ? undefined : (
        <ThemedPluginIcon icon={action.icon} size={14} uniProps={mutedColorMapping} />
      ),
    [action.icon],
  );
  return (
    <DropdownMenuItem leading={leading} onSelect={action.run}>
      {action.title}
    </DropdownMenuItem>
  );
}

function resolveEditingProvider(
  editor: EditorTarget,
  providers: readonly GatewayProviderWire[],
): GatewayProviderWire | null {
  if (editor === null || editor.kind === "new") {
    return null;
  }
  if (editor.kind === "existing") {
    return providers.find((provider) => provider.id === editor.id) ?? null;
  }
  return { ...editor.provider, id: nextProviderId(providers), label: undefined };
}

function copyName(provider: GatewayProviderWire): string {
  return provider.label ?? provider.id;
}

/** What the editor is open on, as the props it takes. */
function editorDetails(editor: EditorTarget): {
  originalId: string | null;
  copyOfName: string | null;
  preset: GatewayProviderPreset | null;
} {
  if (editor === null) {
    return { originalId: null, copyOfName: null, preset: null };
  }
  switch (editor.kind) {
    case "existing":
      return { originalId: editor.id, copyOfName: null, preset: null };
    case "duplicate":
      return { originalId: null, copyOfName: copyName(editor.provider), preset: null };
    default:
      return { originalId: null, copyOfName: null, preset: editor.preset ?? null };
  }
}

function editorKeyOf(editor: EditorTarget, copyOfName: string | null): string {
  if (editor === null) {
    return "closed";
  }
  if (editor.kind === "existing") {
    return `open-existing-${editor.id}`;
  }
  if (editor.kind === "new") {
    return `open-new-${editor.preset?.id ?? "blank"}`;
  }
  return `open-duplicate-${copyOfName ?? "blank"}`;
}

/**
 * The gateway's pricing table after a provider saves: every model's price the
 * editor gave (null deletes it), and the keys of models it no longer has.
 */
function applyProviderSave(
  next: GatewayConfigWire,
  provider: GatewayProviderWire,
  originalId: string | null,
  prices: Record<string, GatewayPriceWire | null>,
  sameAs: Record<string, string>,
): void {
  const list = next.providers ?? [];
  if (originalId === null) {
    next.providers = [...list, provider];
  } else {
    const index = list.findIndex((entry) => entry.id === originalId);
    if (index >= 0) {
      const previous = list[index];
      const saved = withPreservedProviderFields(provider, previous);
      next.providers = list.map((entry, position) => (position === index ? saved : entry));
    }
  }
  next.pricing = withModelPrices(next.pricing ?? {}, provider, originalId, prices);
  const modelSameAs = withModelSameAs(next.modelSameAs ?? {}, provider, originalId, sameAs);
  next.modelSameAs = Object.keys(modelSameAs).length > 0 ? modelSameAs : undefined;
}

function withModelPrices(
  table: Record<string, GatewayPriceWire>,
  provider: GatewayProviderWire,
  originalId: string | null,
  prices: Record<string, GatewayPriceWire | null>,
): Record<string, GatewayPriceWire> {
  const next = { ...table };
  const prefixes = new Set([provider.id]);
  if (originalId !== null) {
    prefixes.add(originalId);
  }
  const modelIds = new Set(provider.models.map((model) => model.id));
  for (const key of Object.keys(next)) {
    const slash = key.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    const model = key.slice(slash + 1);
    if (prefixes.has(key.slice(0, slash)) && model !== "*" && !modelIds.has(model)) {
      delete next[key];
    }
  }
  for (const [modelId, price] of Object.entries(prices)) {
    for (const prefix of prefixes) {
      delete next[`${prefix}/${modelId}`];
    }
    if (price !== null) {
      next[`${provider.id}/${modelId}`] = price;
    }
  }
  return next;
}

/** The same-as table with this provider's models rewritten, under its current id. */
function withModelSameAs(
  table: Record<string, string>,
  provider: GatewayProviderWire,
  originalId: string | null,
  sameAs: Record<string, string>,
): Record<string, string> {
  const next = { ...table };
  const prefixes = new Set([provider.id]);
  if (originalId !== null) {
    prefixes.add(originalId);
  }
  const modelIds = new Set(provider.models.map((model) => model.id));
  for (const key of Object.keys(next)) {
    const slash = key.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    if (prefixes.has(key.slice(0, slash)) && !modelIds.has(key.slice(slash + 1))) {
      delete next[key];
    }
  }
  for (const modelId of modelIds) {
    for (const prefix of prefixes) {
      delete next[`${prefix}/${modelId}`];
    }
    const same = (sameAs[modelId] ?? "").trim();
    if (same.length > 0) {
      next[`${provider.id}/${modelId}`] = same;
    }
  }
  return next;
}

export function GatewayProvidersPage({ serverId, config, apply, focusProvider }: GatewayPageProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [masked, setMasked] = useState(true);
  const [offOpen, setOffOpen] = useState(false);
  // The Usage page's "Open settings" names the provider to open on arrival.
  const [editor, setEditor] = useState<EditorTarget>(
    focusProvider === undefined ? null : { kind: "existing", id: focusProvider },
  );
  const [adding, setAdding] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const client = useHostRuntimeClient(serverId);
  const navigate = useSettingsNavigate();
  // myna's agentPrefLinks, providers side: the agent settings themselves
  // live on the Agents page.
  const openAgentsPage = useCallback(
    () => navigate(buildSettingsHostSectionRoute(serverId, "agents")),
    [navigate, serverId],
  );
  const canImport = useHostFeature(serverId, "gatewayProviderImport");
  const [importing, setImporting] = useState(false);
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const canUpstream = useHostFeature(serverId, "gatewayProviderUpstream");
  const [upstreamStatuses, setUpstreamStatuses] = useState<UpstreamStatus[]>([]);

  const providers = useMemo(() => config.providers ?? [], [config.providers]);
  const pricing = useMemo(() => config.pricing ?? {}, [config.pricing]);
  const modelSameAs = useMemo(() => config.modelSameAs ?? {}, [config.modelSameAs]);

  useEffect(() => {
    if (!canUpstream || client === null) {
      return;
    }
    let live = true;
    void client
      .getGatewayUpstreamStatus()
      .then((result) => {
        if (live) {
          setUpstreamStatuses(result.statuses);
        }
        return undefined;
      })
      .catch(() => {
        // A page that could not be read says nothing; the rows stay as they are.
      });
    return () => {
      live = false;
    };
  }, [canUpstream, client]);

  const upstreamByHost = useMemo(() => {
    const map = new Map<string, Exclude<UpstreamLevel, "ok">>();
    for (const status of upstreamStatuses) {
      if (status.level === null || status.level === "ok") {
        continue;
      }
      for (const host of status.hosts) {
        map.set(host.toLowerCase(), status.level);
      }
    }
    return map;
  }, [upstreamStatuses]);
  const searching = query.trim().length > 0;
  const visible = useMemo(
    () => providers.filter((provider) => providerMatchesQuery(provider, query)),
    [providers, query],
  );
  const onProviders = visible.filter(isProviderOn);
  const offProviders = visible.filter((provider) => !isProviderOn(provider));

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      setToggleError(null);
      void apply((next) => {
        const target = next.providers?.find((provider) => provider.id === id);
        if (target !== undefined) {
          target.enabled = enabled;
        }
      }).catch((cause: unknown) => {
        setToggleError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [apply],
  );

  const handleMove = useCallback(
    (id: string, delta: -1 | 1) => {
      if (searching) {
        return;
      }
      setToggleError(null);
      void apply((next) => {
        const moved = moveProvider(next.providers ?? [], id, delta);
        if (moved !== null) {
          next.providers = moved;
        }
      }).catch((cause: unknown) => {
        setToggleError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [apply, searching],
  );

  const handleOpen = useCallback((id: string) => {
    setEditor({ kind: "existing", id });
  }, []);
  const handleOpenNew = useCallback(() => setAdding(true), []);
  const handleCloseAdd = useCallback(() => setAdding(false), []);
  const handleOpenImport = useCallback(() => {
    setAdding(false);
    setImporting(true);
    setSources(null);
    setImportError(null);
    setImportLoading(true);
    if (client === null) {
      setImportLoading(false);
      setImportError(t("settings.gatewayPages.providers.importUnavailable"));
      return;
    }
    void client
      .previewGatewayProviderImport()
      .then((result) => {
        setSources(result.sources);
        return undefined;
      })
      .catch((cause: unknown) => {
        setImportError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setImportLoading(false));
  }, [client, t]);
  const handleCloseImport = useCallback(() => setImporting(false), []);
  const handleImport = useCallback(
    (items: { sourceId: string; provider: ImportItem }[]) => {
      void apply((next) => {
        const list = [...(next.providers ?? [])];
        for (const { provider } of items) {
          list.push({
            id: uniqueProviderId(provider.name, list),
            label: provider.name,
            protocol: provider.protocol,
            baseUrl: provider.baseUrl,
            ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
            models: provider.models.map((id) => ({ id })),
            ...(provider.headers === undefined ? {} : { headers: provider.headers }),
            ...(provider.enabled === false ? { enabled: false } : {}),
          });
        }
        next.providers = list;
      })
        .then(() => setImporting(false))
        .catch((cause: unknown) => {
          setImportError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [apply],
  );
  const handlePickPreset = useCallback((preset: GatewayProviderPreset) => {
    setAdding(false);
    setEditor({ kind: "new", preset });
  }, []);
  const handlePickCustom = useCallback(() => {
    setAdding(false);
    setEditor({ kind: "new" });
  }, []);
  const handleDuplicate = useCallback(
    (id: string) => {
      const source = providers.find((provider) => provider.id === id);
      if (source !== undefined) {
        setEditor({ kind: "duplicate", provider: source });
      }
    },
    [providers],
  );
  const handleClose = useCallback(() => setEditor(null), []);
  const importExisting = useMemo(
    () => ({
      ids: providers.map((provider) => provider.id),
      baseUrls: providers.map((provider) => provider.baseUrl.trim().replace(/\/+$/, "")),
    }),
    [providers],
  );
  const handleToggleOffGroup = useCallback(() => setOffOpen((open) => !open), []);
  const handleMaskedChange = useCallback((value: boolean) => setMasked(value), []);
  const handleQueryChange = useCallback((value: string) => setQuery(value), []);

  const handleSave = useCallback(
    async (
      provider: GatewayProviderWire,
      originalId: string | null,
      prices: Record<string, GatewayPriceWire | null>,
      sameAs: Record<string, string>,
      autoSwitch: { codex?: boolean; claude?: boolean },
    ) => {
      await apply((next) => {
        applyProviderSave(next, provider, originalId, prices, sameAs);
        // The automatic sign-in switches are the gateway's, not the
        // provider's, so they are written beside it on the same save.
        if (autoSwitch.codex !== undefined) {
          next.codexAutoSwitchSignIn = autoSwitch.codex;
        }
        if (autoSwitch.claude !== undefined) {
          next.claudeAutoSwitchSignIn = autoSwitch.claude;
        }
      });
      setEditor(null);
    },
    [apply],
  );

  const handleRemove = useCallback(
    async (id: string) => {
      await apply((next) => {
        next.providers = (next.providers ?? []).filter((provider) => provider.id !== id);
      });
      setEditor(null);
    },
    [apply],
  );

  const editingProvider = resolveEditingProvider(editor, providers);
  const { originalId, copyOfName: copiedName, preset: editorPreset } = editorDetails(editor);
  const copyOfName = copiedName;
  const editorKey = editorKeyOf(editor, copyOfName);

  return (
    <View style={styles.page} testID="gateway-providers-page">
      <View style={styles.searchRow} testID="gateway-provider-search-row">
        <SearchField
          value={query}
          onChangeText={handleQueryChange}
          placeholder={t("settings.gatewayPages.providers.searchPlaceholder")}
          accessibilityLabel={t("settings.gatewayPages.providers.searchPlaceholder")}
          clearAccessibilityLabel={t("providerCatalog.clearSearch")}
          testID="gateway-provider-search"
        />
      </View>
      <View style={styles.maskRow} testID="gateway-provider-mask-row">
        <Text style={styles.maskLabel}>{t("settings.gatewayPages.providers.maskAccounts")}</Text>
        <Switch
          value={masked}
          onValueChange={handleMaskedChange}
          accessibilityLabel={t("settings.gatewayPages.providers.maskAccounts")}
          testID="gateway-provider-mask"
        />
      </View>

      {providers.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.empty}>{t("settings.gatewayPages.providers.empty")}</Text>
          <Button
            variant="default"
            leftIcon={Plus}
            onPress={handleOpenNew}
            testID="gateway-provider-add-empty"
          >
            {t("settings.gatewayPages.providers.addProvider")}
          </Button>
        </View>
      ) : null}

      {onProviders.length > 0 ? (
        <View style={settingsStyles.card}>
          {onProviders.map((provider, index) => {
            const canMove = providerCanMove(index, onProviders.length, searching);
            return (
              <View key={provider.id} style={index > 0 ? settingsStyles.rowBorder : undefined}>
                <ProviderRow
                  provider={provider}
                  serverId={serverId}
                  maskAccounts={masked}
                  upstream={upstreamByHost.get(providerHost(provider.baseUrl).toLowerCase())}
                  canMoveUp={canMove.up}
                  canMoveDown={canMove.down}
                  onOpen={handleOpen}
                  onToggle={handleToggle}
                  onMove={handleMove}
                />
              </View>
            );
          })}
        </View>
      ) : null}

      {offProviders.length > 0 ? (
        <>
          <PressHighlight
            style={styles.foldRow}
            onPress={handleToggleOffGroup}
            accessibilityRole="button"
            accessibilityLabel={`${t("settings.gatewayPages.providers.offGroup")} ${offProviders.length}`}
            testID="gateway-provider-off-fold"
          >
            <Text style={styles.foldLabel}>
              {`${t("settings.gatewayPages.providers.offGroup")} ${offProviders.length}`}
            </Text>
            <View style={offOpen ? styles.foldChevronOpen : undefined}>
              <ThemedChevron size={12} uniProps={mutedColorMapping} />
            </View>
          </PressHighlight>
          {offOpen || searching ? (
            <View style={settingsStyles.card}>
              {offProviders.map((provider, index) => (
                <View key={provider.id} style={index > 0 ? settingsStyles.rowBorder : undefined}>
                  <ProviderRow
                    provider={provider}
                    serverId={serverId}
                    maskAccounts={masked}
                    canMoveUp={false}
                    canMoveDown={false}
                    onOpen={handleOpen}
                    onToggle={handleToggle}
                    onMove={handleMove}
                  />
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}

      {toggleError === null ? null : <Text style={styles.error}>{toggleError}</Text>}

      {providers.length > 0 && searching && visible.length === 0 ? (
        <Text style={styles.empty}>{t("settings.gatewayPages.providers.noMatch", { query })}</Text>
      ) : null}

      <SettingsSection title={t("settings.gatewayPages.providers.codexPrefs")}>
        <SettingsAction
          label={t("settings.gatewayPages.providers.codexAgentsLink")}
          actionLabel={t("settings.gatewayPages.providers.codexAgentsLinkOpen")}
          onPress={openAgentsPage}
          testID="agent-prefs-codex-agents-link-providers"
        />
      </SettingsSection>

      {providers.length > 0 ? (
        <View style={styles.addRow}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={Plus}
            onPress={handleOpenNew}
            testID="gateway-provider-add"
          >
            {t("settings.gatewayPages.providers.addProvider")}
          </Button>
        </View>
      ) : null}

      {adding ? (
        <ProvidersAddSheet
          serverId={serverId}
          canImport={canImport}
          onClose={handleCloseAdd}
          onPickPreset={handlePickPreset}
          onPickCustom={handlePickCustom}
          onImport={handleOpenImport}
        />
      ) : null}

      {importing ? (
        <ProvidersImportSheet
          sources={sources}
          loading={importLoading}
          error={importError}
          existing={importExisting}
          onClose={handleCloseImport}
          onImport={handleImport}
        />
      ) : null}

      {editor === null ? null : (
        <ProviderEditor
          key={editorKey}
          serverId={serverId}
          providers={providers}
          pricing={pricing}
          modelSameAs={modelSameAs}
          provider={editingProvider}
          originalId={originalId}
          copyOfName={copyOfName}
          preset={editorPreset}
          codexAutoSwitchSignIn={config.codexAutoSwitchSignIn === true}
          claudeAutoSwitchSignIn={config.claudeAutoSwitchSignIn === true}
          onClose={handleClose}
          onDuplicate={handleDuplicate}
          onSave={handleSave}
          onRemove={handleRemove}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: {
    gap: theme.spacing[3],
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  menuTrigger: {
    padding: theme.spacing[0.5],
    borderRadius: theme.borderRadius.base,
  },
  maskRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  maskLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  iconBox: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  iconGlyph: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  sub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  keyCell: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    maxWidth: 160,
    flexShrink: 1,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  keyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  foldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    marginTop: theme.spacing[1],
  },
  foldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  foldChevronOpen: {
    transform: [{ rotate: "90deg" }],
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  emptyState: {
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  addRow: {
    alignItems: "flex-start",
  },
}));
