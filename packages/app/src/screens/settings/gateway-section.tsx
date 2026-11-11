/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop -- settings form rows: a handful of closures and prop objects, none of them in a hot list, so memoising each one buys nothing. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  GatewayConfigWire,
  GatewayKeyLimitWire,
  GatewayKeyWire,
  GatewayOidcRuleWire,
  GatewaySearchKeyQuotaWire,
  GatewayStatusWire,
} from "@neolix/protocol/gateway";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useBuiltinFeatureEnabled, useBuiltinFeatures } from "@/plugins/builtin-features";
import { hostFeatureAvailability, useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { modelDisabled } from "@/screens/settings/app/disabled-models";
import { gatewayConfigUnavailable } from "@/screens/settings/gateway/gateway-config-state";
import { useGatewayKeyRowKeys } from "@/screens/settings/gateway/key-rows";
import { GatewayMaskingPage } from "@/screens/settings/gateway/masking-page";
import { GatewayOverviewPage } from "@/screens/settings/gateway/overview-page";
import { GatewayProvidersPage } from "@/screens/settings/gateway/providers-page";
import { GatewayRoutingPage } from "@/screens/settings/gateway/routing-page";
import { GatewayUsagePage } from "@/screens/settings/gateway/usage-page";
import type { GatewayPageProps } from "@/screens/settings/gateway/types";
import { recentCallsWindow } from "@/screens/settings/gateway/recent-calls-window";
import { useSettingsSubviewStore } from "@/stores/settings-subview-store";
import { McpAddressRow } from "@/screens/settings/app/mcp-address-row";
import { LibraryWayLink } from "@/screens/settings/app/library-way-link";

type GatewayTab = "overview" | "providers" | "routing" | "keys" | "advanced";
export type GatewayPane = GatewayTab | "usage" | "masking";

export function GatewaySettingsSection({
  serverId,
  pane,
  focusRecord,
  openProvider,
}: {
  serverId: string;
  pane: GatewayPane;
  /** A masking record a notification opens the page on. */
  focusRecord?: string;
  /** Navigates to a provider's editor, for a plan card's missing key. */
  openProvider?: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const serverInfo = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  // Null until server_info arrives: showing "upgrade the host" then would be
  // wrong for a host that does support the gateway.
  const supported = hostFeatureAvailability(serverInfo, "llmGateway");
  const vendorsSupported = hostFeatureAvailability(serverInfo, "gatewaySearchVendors");
  const { config, status, searchVendors, isLoading, error, refresh, save } =
    useGatewayConfig(serverId);
  const budgetEnabled = useBuiltinFeatureEnabled(serverId, "budget");
  // The Usage page's plan card asks the Providers page to open one provider:
  // read it for the render that mounts the page, then clear it.
  const focusProvider = useSettingsSubviewStore((state) => state.gatewayProvider);
  const setGatewayProvider = useSettingsSubviewStore((state) => state.setGatewayProvider);
  useEffect(() => {
    if (pane === "providers" && focusProvider !== null) {
      setGatewayProvider(null);
    }
  }, [pane, focusProvider, setGatewayProvider]);
  const [draft, setDraft] = useState<GatewayConfigWire | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const active = draft ?? config;
  const edit = useCallback(
    (mutate: (next: GatewayConfigWire) => void) => {
      setDraft((previous) => {
        const base = previous ?? config;
        if (base === null) {
          return previous;
        }
        const next = cloneConfig(base);
        mutate(next);
        return next;
      });
    },
    [config],
  );

  const apply = useCallback(
    async (mutate: (next: GatewayConfigWire) => void) => {
      const base = draft ?? config;
      if (base === null) {
        return;
      }
      const next = cloneConfig(base);
      mutate(next);
      await save(next);
      setDraft(null);
    },
    [config, draft, save],
  );

  const handleSave = useCallback(async () => {
    if (active === null) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      await save(active);
      setDraft(null);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsSaving(false);
    }
  }, [active, save]);

  if (supported === null) {
    return (
      <View style={settingsStyles.section}>
        <LoadingSpinner size="large" color={styles.loadingColor.color} />
      </View>
    );
  }

  if (!supported) {
    return (
      <SettingsSection title={t("settings.gateway.title")}>
        <Card>
          <Row
            title={t("settings.gateway.upgradeHost")}
            sub={t("settings.gateway.upgradeHostHint")}
          />
        </Card>
      </SettingsSection>
    );
  }

  if (gatewayConfigUnavailable({ isLoading, hasConfig: active !== null, error })) {
    return (
      <SettingsSection title={t("settings.gateway.title")}>
        <Card>
          <Row
            title={t("settings.gateway.loadFailed")}
            sub={error instanceof Error ? error.message : String(error)}
            trailing={
              <Button variant="secondary" size="sm" onPress={refresh}>
                {t("common.actions.retry")}
              </Button>
            }
          />
        </Card>
      </SettingsSection>
    );
  }

  if (isLoading || active === null) {
    return (
      <View style={settingsStyles.section}>
        <LoadingSpinner size="large" color={styles.loadingColor.color} />
      </View>
    );
  }

  // The settings page header already names the page ("Models / Providers"),
  // so a pane renders bare, like myna's pages.
  return (
    <View style={settingsStyles.section} testID="gateway-settings">
      <GatewayPaneContent
        pane={pane}
        config={active}
        status={status}
        searchVendors={vendorsSupported === true ? searchVendors : null}
        error={error}
        edit={edit}
        apply={apply}
        setDraft={setDraft}
        serverId={serverId}
        budgetEnabled={budgetEnabled}
        {...(focusRecord === undefined ? {} : { focusRecord })}
        {...(focusProvider === null ? {} : { focusProvider })}
        {...(openProvider === undefined ? {} : { openProvider })}
      />

      {draft !== null ? (
        <Card style={styles.saveCard}>
          {saveError !== null ? (
            <Text style={[settingsStyles.rowError, styles.cardMessage]}>{saveError}</Text>
          ) : null}
          <Row
            title={t("settings.gateway.save")}
            sub={t("settings.gateway.saveHint")}
            trailing={
              <View style={styles.rowActions}>
                <Button variant="ghost" size="sm" onPress={() => setDraft(null)}>
                  {t("settings.gateway.discard")}
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onPress={handleSave}
                  disabled={isSaving}
                  testID="gateway-save"
                >
                  {isSaving ? t("settings.gateway.saving") : t("settings.gateway.save")}
                </Button>
              </View>
            }
          />
        </Card>
      ) : null}
    </View>
  );
}

/** The usage page, on the subpage the settings sidebar mirrors. */
function UsagePane(page: GatewayPageProps) {
  const view = useSettingsSubviewStore((state) => state.usage);
  const setView = useSettingsSubviewStore((state) => state.setUsage);
  return <GatewayUsagePage {...page} view={view} onViewChange={setView} />;
}

function GatewayPaneContent({
  pane,
  setDraft,
  budgetEnabled,
  ...page
}: GatewayPageProps & {
  pane: GatewayPane;
  setDraft: (value: GatewayConfigWire | null) => void;
  budgetEnabled: boolean;
}): ReactNode {
  const gatewayCallsPage = useBuiltinFeatures(page.serverId).gatewayCallsPage;
  switch (pane) {
    case "overview":
      return (
        <>
          <GatewayOverviewPage {...page} />
          {page.status !== null ? (
            <RecentCallsCard status={page.status} callsPage={gatewayCallsPage} />
          ) : null}
          {page.status !== null ? <AccountPoolCard status={page.status} /> : null}
          <SearchCard
            config={page.config}
            edit={page.edit}
            pluginVendors={page.searchVendors}
            serverId={page.serverId}
          />
          <KeysTab
            keys={page.config.keys ?? []}
            edit={page.edit}
            budgetEnabled={budgetEnabled}
            serverId={page.serverId}
          />
          <AdvancedTab config={page.config} setDraft={setDraft} />
        </>
      );
    case "providers":
      return <GatewayProvidersPage {...page} />;
    case "routing":
      return <GatewayRoutingPage {...page} />;
    case "keys":
      return (
        <KeysTab
          keys={page.config.keys ?? []}
          edit={page.edit}
          budgetEnabled={budgetEnabled}
          serverId={page.serverId}
        />
      );
    case "advanced":
      return <AdvancedTab config={page.config} setDraft={setDraft} />;
    case "usage":
      return <UsagePane {...page} />;
    case "masking":
      return <GatewayMaskingPage {...page} />;
    default:
      return null;
  }
}

type SearchApiWire = NonNullable<NonNullable<GatewayConfigWire["search"]>["apis"]>[number];

/** The search APIs myna knows, by their vendor ids. */
const SEARCH_VENDORS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "tavily", name: "Tavily" },
  { id: "brave", name: "Brave Search" },
  { id: "exa", name: "Exa" },
  { id: "firecrawl", name: "Firecrawl" },
  { id: "you", name: "You.com" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "volcengine", name: "Doubao Search" },
  { id: "wsa", name: "Yuanbao Search" },
  { id: "searxng", name: "SearXNG" },
];

function SearchCard({
  config,
  edit,
  pluginVendors,
  serverId,
}: {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
  pluginVendors: ReadonlyArray<{ vendor: string; name: string }> | null;
  serverId: string;
}) {
  const { t } = useTranslation();
  // A plugin's search APIs sit beside the built-in vendors, under the
  // vendor id the config keeps.
  const vendors = useMemo(() => {
    const extra = (pluginVendors ?? [])
      .filter((vendor) => !SEARCH_VENDORS.some((entry) => entry.id === vendor.vendor))
      .map((vendor) => ({ id: vendor.vendor, name: vendor.name }));
    return [...SEARCH_VENDORS, ...extra];
  }, [pluginVendors]);
  const search = config.search;
  const configured = search?.apis ?? [];
  // A configuration from before the list existed shows its one Tavily
  // endpoint as the first row; any edit writes the list from then on.
  const legacy: SearchApiWire[] =
    configured.length === 0 && (search?.url !== undefined || search?.apiKey !== undefined)
      ? [
          {
            vendor: "tavily",
            ...(search?.apiKey === undefined ? {} : { key: search.apiKey }),
            ...(search?.url === undefined ? {} : { url: search.url }),
          },
        ]
      : [];
  const apis = configured.length > 0 ? configured : legacy;
  const writeApis = (next: SearchApiWire[]) => {
    edit((draft) => {
      draft.search = { ...draft.search, enabled: draft.search?.enabled ?? true, apis: next };
    });
  };
  const update = (index: number, patch: Partial<SearchApiWire>) => {
    writeApis(apis.map((api, at) => (at === index ? { ...api, ...patch } : api)));
  };
  return (
    <Card title={t("settings.gateway.search")} sub={t("settings.gateway.searchHint")}>
      <SwitchRow
        title={t("settings.gateway.searchEnabled")}
        hint={t("settings.gateway.searchHint")}
        value={search?.enabled === true}
        onChange={(value) =>
          edit((next) => {
            next.search = { ...next.search, enabled: value };
          })
        }
      />
      {search?.enabled === true ? (
        <>
          <SearcherRow config={config} edit={edit} />
          <SearcherThenRow config={config} edit={edit} />
          {apis.length === 0 ? (
            <View style={styles.fieldRow}>
              <Text style={settingsStyles.rowHint}>{t("settings.gateway.searchNoApis")}</Text>
            </View>
          ) : (
            apis.map((api, index) => (
              <SearchApiRow
                // eslint-disable-next-line react/no-array-index-key -- an editable list has no id but its place.
                key={`${api.vendor}-${index}`}
                api={api}
                index={index}
                vendors={vendors}
                serverId={serverId}
                onChange={(patch) => update(index, patch)}
                onRemove={() => writeApis(apis.filter((_, at) => at !== index))}
              />
            ))
          )}
          <View style={styles.fieldRow}>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => writeApis([...apis, { vendor: "tavily", key: "" }])}
            >
              {t("settings.gateway.searchAddApi")}
            </Button>
          </View>
          <SearchFirstRow config={config} edit={edit} apis={apis} />
          <SearchAllRow config={config} edit={edit} apis={apis} />
          <NumberRow
            label={t("settings.gateway.searchMonthlyCalls")}
            value={search.monthlyCalls ?? undefined}
            onChange={(value) =>
              edit((next) => {
                next.search = { ...next.search, enabled: true, monthlyCalls: value };
              })
            }
          />
        </>
      ) : null}
      <McpAddressRow
        path="/mcp/myna/web-search"
        label={t("settings.gateway.searchMcpServer")}
        hint={t("settings.gateway.searchMcpHint")}
      />
      <LibraryWayLink server="web-search" />
    </Card>
  );
}

function SearchApiRow({
  api,
  index,
  vendors,
  serverId,
  onChange,
  onRemove,
}: {
  api: SearchApiWire;
  index: number;
  vendors: ReadonlyArray<{ id: string; name: string }>;
  serverId: string;
  onChange: (patch: Partial<SearchApiWire>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const vendor = vendors.find((entry) => entry.id === api.vendor)?.name ?? api.vendor;
  return (
    <View style={styles.searchApi}>
      <View style={styles.searchApiHead}>
        <Text style={settingsStyles.rowTitle}>{vendor}</Text>
        {api.off === true ? (
          <Text style={styles.rowMuted}>{t("settings.gateway.searchOff")}</Text>
        ) : null}
        <View style={styles.searchApiGrow} />
        <Button variant="ghost" size="sm" onPress={onRemove}>
          {t("settings.gateway.searchRemove")}
        </Button>
      </View>
      <View style={styles.searchVendors}>
        {vendors.map((entry) => (
          <Button
            key={entry.id}
            variant={entry.id === api.vendor ? "secondary" : "ghost"}
            size="sm"
            onPress={() => onChange({ vendor: entry.id })}
          >
            {entry.name}
          </Button>
        ))}
      </View>
      <TextRow
        label={t("settings.gateway.searchApiKey")}
        hint={t("settings.gateway.searchApiKeyHint")}
        value={api.key ?? ""}
        secure
        resetKey={`key-${index}-${api.vendor}`}
        onChangeText={(value) => onChange({ key: value.length === 0 ? undefined : value })}
      />
      <TextRow
        label={t("settings.gateway.searchUrl")}
        hint={t("settings.gateway.searchUrlHint")}
        value={api.url ?? ""}
        keyboardType="url"
        resetKey={`url-${index}-${api.vendor}`}
        onChangeText={(value) => onChange({ url: value.length === 0 ? undefined : value })}
      />
      <SwitchRow
        title={t("settings.gateway.searchPickOrder")}
        hint={t("settings.gateway.searchPickHint")}
        value={api.pick === "order"}
        onChange={(value) => onChange({ pick: value ? "order" : "" })}
      />
      <SwitchRow
        title={t("settings.gateway.searchOff")}
        hint={t("settings.gateway.searchOffHint")}
        value={api.off === true}
        onChange={(value) => onChange({ off: value ? true : undefined })}
      />
      <SearchKeysRows api={api} serverId={serverId} name={vendor} />
    </View>
  );
}

interface SearcherChoice {
  ref: string;
  label: string;
  kind: "provider" | "model";
}

/** The daemon's answer: its host whitelist decides, and an explicit switch wins. */
function providerSearches(provider: NonNullable<GatewayConfigWire["providers"]>[number]): boolean {
  return provider.searchesUpstream === true;
}

/** The providers whose own wire can search, and their models, as a searcher may name them. */
function searcherChoices(config: GatewayConfigWire, ownLabel: string): SearcherChoice[] {
  const out: SearcherChoice[] = [];
  for (const provider of config.providers ?? []) {
    if (!providerSearches(provider)) {
      continue;
    }
    const models = provider.models.filter((model) => !modelDisabled(config, provider.id, model.id));
    if (models.length === 0) {
      continue;
    }
    const name = provider.label ?? provider.id;
    out.push({ ref: provider.id, label: `${name} · ${ownLabel}`, kind: "provider" });
    for (const model of models) {
      out.push({
        ref: `${provider.id}/${model.id}`,
        label: `${model.label ?? model.id} · ${name}`,
        kind: "model",
      });
    }
  }
  return out;
}

function searcherLabel(
  config: GatewayConfigWire,
  ref: string,
  ownLabel: string,
  choiceLabel: (ref: string) => string,
): string {
  const choice = searcherChoices(config, ownLabel).find((entry) => entry.ref === ref);
  return choice?.label ?? choiceLabel(ref);
}

/** A search API's keys: one, or several separated by commas, spaces or lines. */
function searcherShown(
  config: GatewayConfigWire,
  saved: string,
  autoLabel: string,
  ownLabel: string,
  t: TFunction,
): string {
  if (saved === "off") {
    return t("settings.gateway.searcherOff");
  }
  if (saved === "") {
    return `${t("settings.gateway.searcherAuto")} · ${autoLabel}`;
  }
  return searcherLabel(config, saved, ownLabel, (ref) => ref);
}

function searchKeysOf(key: string | undefined): string[] {
  const out: string[] = [];
  for (const entry of (key ?? "").split(/[,;\s]+/)) {
    if (entry.length > 0 && !out.includes(entry)) {
      out.push(entry);
    }
  }
  return out;
}

function maskedKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : "…";
}

function canProviderSearch(config: GatewayConfigWire): boolean {
  return (config.providers ?? []).some((provider) => providerSearches(provider));
}

function hasAskedApis(apis: readonly SearchApiWire[]): boolean {
  return apis.some((api) => api.off !== true);
}

/**
 * myna's Searches for other models: the provider that searches for a model
 * that can't, the gateway's automatic pick, or off for the search APIs only.
 */
function SearcherRow({
  config,
  edit,
}: {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
}) {
  const { t } = useTranslation();
  const ownLabel = t("settings.gateway.searcherOwn");
  const choices = useMemo(() => searcherChoices(config, ownLabel), [config, ownLabel]);
  const saved = (config.search?.searcher ?? "").trim();
  const auto = choices.find((choice) => choice.kind === "provider");
  const display = searcherShown(
    config,
    saved,
    auto?.label ?? t("settings.gateway.searcherNone"),
    ownLabel,
    t,
  );
  const pick = (value: string) => {
    edit((next) => {
      next.search = { ...next.search, searcher: value };
    });
  };
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldGrow}>
        <Field label={t("settings.gateway.searcher")} hint={t("settings.gateway.searcherHint")}>
          <DropdownMenu>
            <DropdownTrigger accessibilityRole="button">{display}</DropdownTrigger>
            <DropdownMenuContent side="bottom" align="end" minWidth={280} maxWidth={420}>
              <DropdownMenuItem selected={saved === ""} onSelect={() => pick("")}>
                {`${t("settings.gateway.searcherAuto")} · ${auto?.label ?? t("settings.gateway.searcherNone")}`}
              </DropdownMenuItem>
              <DropdownMenuItem selected={saved === "off"} onSelect={() => pick("off")}>
                {t("settings.gateway.searcherOff")}
              </DropdownMenuItem>
              {choices.map((choice) => (
                <DropdownMenuItem
                  key={choice.ref}
                  selected={saved === choice.ref}
                  onSelect={() => pick(choice.ref)}
                >
                  {choice.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
      </View>
    </View>
  );
}

/**
 * myna's If it fails: the searchers asked in its place, in this order, when
 * the one above fails or finds nothing. Shown only while one is named.
 */
function SearcherThenRow({
  config,
  edit,
}: {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
}) {
  const { t } = useTranslation();
  const ownLabel = t("settings.gateway.searcherOwn");
  const choices = useMemo(() => searcherChoices(config, ownLabel), [config, ownLabel]);
  const saved = (config.search?.searcher ?? "").trim();
  const then = config.search?.searcherThen ?? [];
  if (saved === "" || saved === "off") {
    return null;
  }
  const free = choices.filter((choice) => choice.ref !== saved && !then.includes(choice.ref));
  const put = (list: string[]) => {
    edit((next) => {
      next.search = { ...next.search, searcherThen: list };
    });
  };
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldGrow}>
        <Field
          label={t("settings.gateway.searcherThen")}
          hint={t("settings.gateway.searcherThenHint")}
        >
          <View style={styles.searcherThen}>
            {then.map((ref, at) => {
              const others = choices.filter(
                (choice) =>
                  choice.ref !== saved && (choice.ref === ref || !then.includes(choice.ref)),
              );
              return (
                <DropdownMenu key={ref}>
                  <DropdownTrigger accessibilityRole="button">
                    {`${at + 1}. ${searcherLabel(config, ref, ownLabel, (value) => value)}`}
                  </DropdownTrigger>
                  <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={400}>
                    <DropdownMenuItem
                      onSelect={() => put(then.filter((_entry, index) => index !== at))}
                    >
                      {t("settings.gateway.searcherThenRemove")}
                    </DropdownMenuItem>
                    {others.map((choice) => (
                      <DropdownMenuItem
                        key={choice.ref}
                        selected={choice.ref === ref}
                        onSelect={() =>
                          put(then.map((entry, index) => (index === at ? choice.ref : entry)))
                        }
                      >
                        {choice.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            })}
            {free.length > 0 ? (
              <DropdownMenu>
                <DropdownTrigger accessibilityRole="button">
                  {t("settings.gateway.searcherThenAdd")}
                </DropdownTrigger>
                <DropdownMenuContent side="bottom" align="end" minWidth={240} maxWidth={400}>
                  {free.map((choice) => (
                    <DropdownMenuItem key={choice.ref} onSelect={() => put([...then, choice.ref])}>
                      {choice.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </View>
        </Field>
      </View>
    </View>
  );
}

/** myna's Search first with: the provider's search or the search APIs, when both can. */
function SearchFirstRow({
  config,
  edit,
  apis,
}: {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
  apis: readonly SearchApiWire[];
}) {
  const { t } = useTranslation();
  const searcherOff = (config.search?.searcher ?? "").trim() === "off";
  if (searcherOff || !canProviderSearch(config) || !hasAskedApis(apis)) {
    return null;
  }
  const first = config.search?.searchFirst === "api" ? "api" : "model";
  const options = [
    { value: "model", label: t("settings.gateway.searchFirstModel") },
    { value: "api", label: t("settings.gateway.searchFirstApi") },
  ];
  const change = (value: string) => {
    edit((next) => {
      next.search = { ...next.search, searchFirst: value === "api" ? "api" : "" };
    });
  };
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldGrow}>
        <Field
          label={t("settings.gateway.searchFirst")}
          hint={t("settings.gateway.searchFirstHint")}
        >
          <SegmentedControl options={options} value={first} onValueChange={change} />
        </Field>
      </View>
    </View>
  );
}

/** myna's Models that search by themselves: their provider's own search, or the gateway's. */
function SearchAllRow({
  config,
  edit,
  apis,
}: {
  config: GatewayConfigWire;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
  apis: readonly SearchApiWire[];
}) {
  const { t } = useTranslation();
  const searcherOff = (config.search?.searcher ?? "").trim() === "off";
  const can = (!searcherOff && canProviderSearch(config)) || hasAskedApis(apis);
  const value = config.search?.searchAll === true ? "myna" : "own";
  const options = [
    { value: "own", label: t("settings.gateway.searchAllOwn"), disabled: !can },
    { value: "myna", label: t("settings.gateway.searchAllMyna"), disabled: !can },
  ];
  const change = (next: string) => {
    edit((draft) => {
      draft.search = { ...draft.search, searchAll: next === "myna" };
    });
  };
  return (
    <View style={styles.fieldRow}>
      <View style={styles.fieldGrow}>
        <Field
          label={t("settings.gateway.searchAll")}
          hint={can ? t("settings.gateway.searchAllHint") : t("settings.gateway.searchAllNone")}
        >
          <SegmentedControl options={options} value={value} onValueChange={change} />
        </Field>
      </View>
    </View>
  );
}

interface SearchQuotaState {
  status: "idle" | "loading" | "ready" | "error";
  keys?: ReadonlyArray<GatewaySearchKeyQuotaWire>;
  error?: string;
}

/**
 * myna's Keys of <name>: an API's keys, how a search picks among them (the
 * switch above), and what each has used of its limit where the vendor says
 * it (Tavily's /usage). An unknown read says why, never 0 used.
 */
function SearchKeysRows({
  api,
  serverId,
  name,
}: {
  api: SearchApiWire;
  serverId: string;
  name: string;
}) {
  const { t } = useTranslation();
  const keys = searchKeysOf(api.key);
  const quota = api.vendor === "tavily";
  const shown = keys.length > 1 || (quota && keys.length > 0);
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "gatewaySearchQuota");
  const [state, setState] = useState<SearchQuotaState>({ status: "idle" });
  const load = useCallback(
    (fresh: boolean) => {
      if (!quota || !client || !supported) {
        return;
      }
      setState({ status: "loading" });
      client
        .getGatewaySearchQuota(api.vendor, { fresh })
        .then((payload) => setState({ status: "ready", keys: payload.keys }))
        .catch((cause: unknown) =>
          setState({
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
    },
    [api.vendor, client, quota, supported],
  );
  useEffect(() => {
    load(false);
  }, [load]);
  if (!shown) {
    return null;
  }
  return (
    <View style={styles.searchKeys}>
      <View style={styles.searchApiHead}>
        <Text style={styles.rowMuted}>{t("settings.gateway.searchKeys", { name })}</Text>
        <View style={styles.searchApiGrow} />
        {quota ? (
          <Button variant="ghost" size="sm" onPress={() => load(true)}>
            {t("settings.gateway.searchKeyCheck")}
          </Button>
        ) : null}
      </View>
      <Text style={styles.rowMuted}>
        {keys.length > 1
          ? t("settings.gateway.searchKeysHintMulti")
          : t("settings.gateway.searchKeysHintSingle")}
      </Text>
      {keys.map((key, at) => {
        const entry = state.keys?.[at];
        return (
          <View key={key} style={styles.searchKeyLine}>
            <Text style={styles.rowMuted}>{entry?.key ?? maskedKey(key)}</Text>
            <Text style={styles.searchKeyUse}>{searchKeySaid(t, state, entry, at)}</Text>
          </View>
        );
      })}
    </View>
  );
}

function searchKeySaid(
  t: TFunction,
  state: SearchQuotaState,
  entry: GatewaySearchKeyQuotaWire | undefined,
  at: number,
): string {
  if (!state.keys && state.status === "error") {
    return t("settings.gateway.searchKeyUnknown", { why: state.error ?? "" });
  }
  if (!state.keys || state.status === "loading") {
    return at === 0 ? t("settings.gateway.searchKeyReading") : "";
  }
  if (!entry) {
    return "";
  }
  if (!entry.known) {
    return t("settings.gateway.searchKeyUnknown", { why: entry.err ?? "" });
  }
  const used = t(
    entry.unlimited ? "settings.gateway.searchKeyUsedNoLimit" : "settings.gateway.searchKeyUsed",
    { used: entry.used, limit: entry.limit },
  );
  if (entry.usedUp) {
    return `${used} · ${t("settings.gateway.searchKeyUsedUp")}`;
  }
  if (entry.of === "plan" && entry.plan !== undefined) {
    return `${used} · ${t("settings.gateway.searchKeyPlan", { plan: entry.plan })}`;
  }
  if ((entry.paygoLeft ?? 0) > 0) {
    return `${used} · ${t("settings.gateway.searchKeyPaygo", { n: entry.paygoLeft })}`;
  }
  return used;
}

/** Myna's Redact page: which secret kinds are masked, plus the user's own patterns. */
function AccountPoolCard({ status }: { status: GatewayStatusWire }) {
  const { t } = useTranslation();
  const now = Date.now();
  return (
    <Card title={t("settings.gateway.accountPool")} sub={t("settings.gateway.accountPoolHint")}>
      {status.accounts.length === 0 ? (
        <Text style={settingsStyles.rowHint}>{t("settings.gateway.noAccounts")}</Text>
      ) : (
        status.accounts.map((account, index) => {
          const until = account.restingUntil ?? 0;
          const resting = until > now;
          const spend = account.spendUsd ?? 0;
          return (
            <View
              key={`${account.provider}/${account.account}`}
              style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
            >
              <View style={[settingsStyles.rowContent, styles.rowStack]}>
                <View style={styles.titleLine}>
                  <Dot tone={accountTone(resting, account.enabled)} />
                  <Text style={settingsStyles.rowTitle}>
                    {account.provider}
                    <Text style={styles.rowMuted}>/{account.account}</Text>
                  </Text>
                  <Pill label={`P${account.priority} · W${account.weight}`} />
                </View>
                <Text style={settingsStyles.rowHint}>
                  {resting
                    ? `${t("settings.gateway.resting")} ${Math.max(0, Math.ceil((until - now) / 1000))}s`
                    : t("settings.gateway.awake")}
                  {` · ${account.inflight} ${t("settings.gateway.inflight")}`}
                  {spend > 0 ? ` · $${spend.toFixed(2)}` : ""}
                </Text>
              </View>
              <View style={styles.bars}>
                <QuotaBar
                  label={t("settings.gateway.quota5hShort")}
                  used={account.tokens5h}
                  cap={account.tokens5hCap ?? null}
                />
                <QuotaBar
                  label={t("settings.gateway.quota7dShort")}
                  used={account.tokens7d}
                  cap={account.tokens7dCap ?? null}
                />
                {account.usedPercent !== null && account.usedPercent !== undefined ? (
                  <QuotaBar
                    label={t("settings.gateway.vendorQuota")}
                    used={Math.round(account.usedPercent)}
                    cap={100}
                  />
                ) : null}
              </View>
            </View>
          );
        })
      )}
    </Card>
  );
}

function RecentCallsCard({ status, callsPage }: { status: GatewayStatusWire; callsPage: number }) {
  const { t } = useTranslation();
  const recent = status.recent ?? [];
  // myna's gateway page: callsPage at first, the same again on each "Show more", and a fresh
  // setting starts the list over.
  const [shown, setShown] = useState(callsPage);
  useEffect(() => setShown(callsPage), [callsPage]);
  const { visible: visibleCount, more } = recentCallsWindow(recent.length, shown, callsPage);
  const visible = recent.slice(0, visibleCount);
  const showMore = useCallback(() => setShown((current) => current + more), [more]);
  return (
    <Card title={t("settings.gateway.recentCalls")} sub={t("settings.gateway.recentCallsHint")}>
      {recent.length === 0 ? (
        <Text style={settingsStyles.rowHint}>{t("settings.gateway.noRecent")}</Text>
      ) : (
        visible.map((call, index) => (
          <View
            key={`${call.time}-${call.provider}-${call.model}`}
            style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
          >
            <View style={[settingsStyles.rowContent, styles.rowStack]}>
              <View style={styles.titleLine}>
                <Dot tone={call.ok ? "ok" : "error"} />
                <Text style={settingsStyles.rowTitle}>{call.model}</Text>
                <Pill label={call.provider} />
              </View>
              <Text style={settingsStyles.rowHint}>
                {formatTime(call.time)} · {call.inputTokens + call.outputTokens} tok
                {call.costUsd > 0 ? ` · $${call.costUsd.toFixed(4)}` : ""}
                {call.status > 0 ? ` · ${call.status}` : ""}
              </Text>
            </View>
          </View>
        ))
      )}
      {more > 0 ? (
        <Button variant="ghost" size="sm" onPress={showMore}>
          {t("settings.gateway.showMore", { n: more })}
        </Button>
      ) : null}
    </Card>
  );
}

function KeysTab({
  keys,
  edit,
  budgetEnabled,
  serverId,
}: {
  keys: GatewayKeyWire[];
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
  budgetEnabled: boolean;
  serverId: string;
}) {
  const { t } = useTranslation();
  const rowKeys = useGatewayKeyRowKeys(keys);
  return (
    <>
      {keys.map((entry, keyIndex) => (
        <KeyCard
          key={rowKeys[keyIndex]}
          entry={entry}
          budgetEnabled={budgetEnabled}
          onChange={(mutate) =>
            edit((next) => {
              const list = next.keys ?? [];
              const current = list[keyIndex];
              if (current === undefined) {
                return;
              }
              const normalized: Exclude<GatewayKeyWire, string> =
                typeof current === "string"
                  ? { key: current, models: [] }
                  : { ...current, models: current.models ?? [] };
              mutate(normalized);
              list[keyIndex] = normalized;
              next.keys = [...list];
            })
          }
          onRemove={() =>
            edit((next) => {
              next.keys = (next.keys ?? []).filter((_, index) => index !== keyIndex);
            })
          }
        />
      ))}
      <AddButton
        label={t("settings.gateway.addKey")}
        onPress={() =>
          edit((next) => {
            next.keys = [...(next.keys ?? []), { key: "", models: [] }];
          })
        }
      />
      <OidcRulesCard serverId={serverId} keys={keys} />
    </>
  );
}

function KeyCard({
  entry,
  budgetEnabled,
  onChange,
  onRemove,
}: {
  entry: GatewayKeyWire;
  budgetEnabled: boolean;
  onChange: (mutate: (entry: Exclude<GatewayKeyWire, string>) => void) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const normalized: Exclude<GatewayKeyWire, string> =
    typeof entry === "string" ? { key: entry, models: [] } : entry;
  const models = normalized.models ?? [];
  return (
    <Card
      title={normalized.label ?? maskKey(normalized.key)}
      sub={models.length === 0 ? t("settings.gateway.allModels") : models.join(", ")}
      trailing={
        <Button variant="ghost" size="sm" onPress={onRemove}>
          {t("settings.gateway.remove")}
        </Button>
      }
    >
      <TextRow
        label={t("settings.gateway.keyValue")}
        value={normalized.key}
        secure
        onChangeText={(value) => onChange((next) => (next.key = value))}
      />
      <TextRow
        label={t("settings.gateway.label")}
        value={normalized.label ?? ""}
        onChangeText={(value) =>
          onChange((next) => (next.label = value.length > 0 ? value : undefined))
        }
      />
      <TextRow
        label={t("settings.gateway.allowedModels")}
        hint={t("settings.gateway.allowedModelsHint")}
        value={models.join(", ")}
        onChangeText={(value) => onChange((next) => (next.models = splitList(value)))}
      />
      {budgetEnabled ? (
        <>
          <NumberRow
            label={t("settings.gateway.dailyTokens")}
            value={normalized.dailyTokens}
            onChange={(value) => onChange((next) => (next.dailyTokens = value))}
          />
          <NumberRow
            label={t("settings.gateway.monthlyUsd")}
            value={normalized.monthlyUsd}
            onChange={(value) => onChange((next) => (next.monthlyUsd = value))}
          />
        </>
      ) : null}
      <NumberRow
        label={t("settings.gateway.ratePerMinute")}
        value={normalized.ratePerMinute}
        onChange={(value) => onChange((next) => (next.ratePerMinute = value))}
      />
      <NumberRow
        label={t("settings.gateway.searchCallsPerMonth")}
        value={normalized.searchCallsPerMonth}
        onChange={(value) => onChange((next) => (next.searchCallsPerMonth = value))}
      />
      <KeyLimitsEditor
        limits={normalized.limits ?? []}
        onChange={(limits) => onChange((next) => (next.limits = limits))}
      />
      <TextRow
        label={t("settings.gateway.expiresAt")}
        value={normalized.expiresAt ?? ""}
        hint="2027-01-01T00:00:00Z"
        onChangeText={(value) =>
          onChange((next) => (next.expiresAt = value.length > 0 ? value : undefined))
        }
      />
      <SwitchRow
        title={t("settings.gateway.readOnlyKey")}
        hint={t("settings.gateway.readOnlyKeyHint")}
        value={normalized.readOnly === true}
        onChange={(value) => onChange((next) => (next.readOnly = value))}
      />
      <SwitchRow
        title={t("settings.gateway.issuesKeys")}
        hint={t("settings.gateway.issuesKeysHint")}
        value={normalized.issues === true}
        onChange={(value) => onChange((next) => (next.issues = value))}
      />
    </Card>
  );
}

type LimitPeriod = GatewayKeyLimitWire["period"];

const LIMIT_PERIODS: readonly LimitPeriod[] = ["day", "week", "month", "days", "hours"];

/**
 * A key's budget windows (myna access.Limit, Settings › Keys): each one
 * holds the key on its own, and a request passes only while all of them
 * have something left. Reset starts the window again from now, as myna's
 * reset does; the row's older day-token and month-dollar caps still apply
 * when no windows are listed.
 */
function KeyLimitsEditor({
  limits,
  onChange,
}: {
  limits: GatewayKeyLimitWire[];
  onChange: (limits: GatewayKeyLimitWire[]) => void;
}) {
  const { t } = useTranslation();
  const periodLabel = (period: LimitPeriod): string =>
    ({
      day: t("settings.gateway.limitDay"),
      week: t("settings.gateway.limitWeek"),
      month: t("settings.gateway.limitMonth"),
      days: t("settings.gateway.limitDays"),
      hours: t("settings.gateway.limitHours"),
    })[period];
  const update = (index: number, mutate: (limit: GatewayKeyLimitWire) => void): void => {
    onChange(
      limits.map((limit, at) => {
        if (at !== index) {
          return limit;
        }
        const next = { ...limit };
        mutate(next);
        return next;
      }),
    );
  };
  const cards = limits.map((limit, index) => ({ id: `limit-card-${index}`, limit }));
  return (
    <View style={styles.limitsBlock}>
      <Text style={styles.limitsTitle}>{t("settings.gateway.limits")}</Text>
      <Text style={styles.limitsHint}>{t("settings.gateway.limitsHint")}</Text>
      {cards.map(({ id, limit }, index) => (
        <View key={id} style={styles.limitCard}>
          <SegmentedControl
            options={LIMIT_PERIODS.map((period) => ({
              value: period,
              label: periodLabel(period),
            }))}
            value={limit.period}
            onValueChange={(period) =>
              update(index, (next) => {
                next.period = period;
                if (period === "days" && next.days === undefined) next.days = 1;
                if (period === "hours" && next.hours === undefined) next.hours = 1;
              })
            }
          />
          {limit.period === "days" ? (
            <NumberRow
              label={t("settings.gateway.limitDaysLabel")}
              value={limit.days}
              onChange={(value) => update(index, (next) => (next.days = value))}
            />
          ) : null}
          {limit.period === "hours" ? (
            <NumberRow
              label={t("settings.gateway.limitHoursLabel")}
              value={limit.hours}
              onChange={(value) => update(index, (next) => (next.hours = value))}
            />
          ) : null}
          <NumberRow
            label={t("settings.gateway.limitTokens")}
            value={limit.tokens}
            onChange={(value) => update(index, (next) => (next.tokens = value))}
          />
          <NumberRow
            label={t("settings.gateway.limitCost")}
            value={limit.cost}
            onChange={(value) => update(index, (next) => (next.cost = value))}
          />
          <SwitchRow
            title={t("settings.gateway.limitCacheReads")}
            value={limit.cacheReads === true}
            onChange={(value) => update(index, (next) => (next.cacheReads = value))}
          />
          <View style={styles.limitActions}>
            <Button
              variant="ghost"
              size="sm"
              onPress={() =>
                update(index, (next) => {
                  next.since = new Date().toISOString();
                })
              }
            >
              {t("settings.gateway.limitReset")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onChange(limits.filter((_, at) => at !== index))}
            >
              {t("settings.gateway.remove")}
            </Button>
          </View>
        </View>
      ))}
      {limits.length < 5 ? (
        <AddButton
          label={t("settings.gateway.addLimit")}
          onPress={() =>
            onChange([...limits, { period: "day", tokens: 1_000_000, cacheReads: false }])
          }
        />
      ) : null}
    </View>
  );
}

function AdvancedTab({
  config,
  setDraft,
}: {
  config: GatewayConfigWire;
  setDraft: (config: GatewayConfigWire) => void;
}) {
  const { t } = useTranslation();
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <Card title={t("settings.gateway.advanced")} sub={t("settings.gateway.advancedHint")}>
      <Button variant="ghost" size="sm" onPress={() => setRawOpen((open) => !open)}>
        {rawOpen ? t("settings.gateway.hideJson") : t("settings.gateway.showJson")}
      </Button>
      {rawOpen ? <JsonEditor value={config} onApply={setDraft} /> : null}
    </Card>
  );
}

function JsonEditor({
  value,
  onApply,
}: {
  value: GatewayConfigWire;
  onApply: (config: GatewayConfigWire) => void;
}) {
  const { t } = useTranslation();
  const initial = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const apply = useCallback(() => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setError(t("settings.gateway.invalidJson"));
        return;
      }
      setError(null);
      onApply(parsed as GatewayConfigWire);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.gateway.invalidJson"));
    }
  }, [text, t, onApply]);
  return (
    <View style={styles.jsonEditor}>
      <TextRow label="JSON" value={text} multiline onChangeText={setText} resetKey="gateway-json" />
      {error !== null ? (
        <Text style={[settingsStyles.rowError, styles.cardMessage]}>{error}</Text>
      ) : null}
      <Button variant="secondary" size="sm" onPress={apply}>
        {t("settings.gateway.apply")}
      </Button>
    </View>
  );
}

function Card({
  title,
  sub,
  trailing,
  style,
  children,
}: {
  title?: string;
  sub?: string;
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const body = <View style={[settingsStyles.card, style]}>{children}</View>;
  if (title === undefined) {
    return body;
  }
  return (
    <SettingsSection title={title} info={sub} trailing={trailing}>
      {body}
    </SettingsSection>
  );
}

function Row({ title, sub, trailing }: { title: string; sub?: string; trailing?: ReactNode }) {
  return (
    <View style={settingsStyles.row}>
      <View style={[settingsStyles.rowContent, styles.rowStack]}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        {sub !== undefined ? <Text style={settingsStyles.rowHint}>{sub}</Text> : null}
      </View>
      {trailing}
    </View>
  );
}

function accountTone(resting: boolean, enabled: boolean): "ok" | "warn" | "off" {
  if (resting) {
    return "warn";
  }
  return enabled ? "ok" : "off";
}

type DotTone = "ok" | "warn" | "error" | "off";

/** Each tone's dot colour comes from the status-dot family, never a local palette. */
const DOT_TONE_PROPS = {
  ok: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "attention" }) }),
  warn: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "needs_input" }) }),
  error: (theme: Theme) => ({ color: getStatusDotColor({ theme, bucket: "failed" }) }),
  off: (theme: Theme) => ({
    color: getStatusDotColor({ theme, bucket: "done", showDoneAsInactive: true }),
  }),
} satisfies Record<DotTone, (theme: Theme) => { color: string | null }>;

function DotView({ color }: { tone: DotTone; color: string | null }) {
  return <View style={[styles.dot, color === null ? null : { backgroundColor: color }]} />;
}

const ThemedDot = withUnistyles(DotView);

function Dot({ tone }: { tone: DotTone }) {
  return <ThemedDot tone={tone} uniProps={DOT_TONE_PROPS[tone]} />;
}

function Pill({ label }: { label: string }) {
  return <StatusBadge label={label} variant="muted" size="xs" />;
}

function QuotaBar({ label, used, cap }: { label: string; used: number; cap: number | null }) {
  const ratio = cap === null || cap <= 0 ? 0 : Math.min(1, used / cap);
  return (
    <View style={styles.quota}>
      <Text style={styles.quotaLabel}>{label}</Text>
      <View style={styles.quotaTrack}>
        <View style={[styles.quotaFill, { width: `${Math.round(ratio * 100)}%` }]} />
      </View>
      <Text style={styles.quotaValue}>
        {cap === null ? formatCompact(used) : `${Math.round(ratio * 100)}%`}
      </Text>
    </View>
  );
}

function TextRow({
  label,
  hint,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  secure,
  divider,
  multiline,
  resetKey,
}: {
  label: string;
  hint?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  keyboardType?: "default" | "url" | "decimal-pad" | "number-pad";
  secure?: boolean;
  divider?: boolean;
  multiline?: boolean;
  resetKey?: string;
}) {
  return (
    <View style={[styles.fieldRow, divider === true ? settingsStyles.rowBorder : null]}>
      <View style={styles.fieldGrow}>
        <Field label={label} hint={hint}>
          <FormTextInput
            initialValue={value}
            resetKey={resetKey ?? label}
            onChangeText={onChangeText}
            placeholder={placeholder}
            keyboardType={keyboardType ?? "default"}
            secureTextEntry={secure}
            autoCapitalize="none"
            autoCorrect={false}
            multiline={multiline}
          />
        </Field>
      </View>
    </View>
  );
}

function NumberRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
}) {
  return (
    <TextRow
      label={label}
      value={value === undefined ? "" : String(value)}
      keyboardType="number-pad"
      resetKey={`${label}-${value ?? ""}`}
      onChangeText={(text) => {
        const parsed = Number(text);
        onChange(text.trim().length === 0 || !Number.isFinite(parsed) ? undefined : parsed);
      }}
    />
  );
}

function SwitchRow({
  title,
  hint,
  value,
  onChange,
  divider,
}: {
  title: string;
  hint?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  divider?: boolean;
}) {
  return (
    <View style={[settingsStyles.row, divider === true ? settingsStyles.rowBorder : null]}>
      <View style={[settingsStyles.rowContent, styles.rowStack]}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        {hint !== undefined ? <Text style={settingsStyles.rowHint}>{hint}</Text> : null}
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

interface OidcDraft {
  id?: string;
  key: string;
  issuer: string;
  audience: string;
  claims: string;
  ttlSeconds: number | undefined;
}

function eligibleOidcKeys(keys: readonly GatewayKeyWire[]): string[] {
  const out: string[] = [];
  for (const entry of keys) {
    if (typeof entry === "string") {
      continue;
    }
    if (entry.issues === true && entry.issuer === undefined) {
      out.push(entry.key);
    }
  }
  return out;
}

function claimsText(claims: Record<string, string> | undefined): string {
  return Object.entries(claims ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
}

function parseClaims(text: string): Record<string, string> | undefined {
  const claims: Record<string, string> = {};
  for (const part of text.split(",").map((entry) => entry.trim())) {
    if (part.length === 0) {
      continue;
    }
    const separator = part.indexOf("=");
    if (separator < 1) {
      continue;
    }
    claims[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return Object.keys(claims).length > 0 ? claims : undefined;
}

/**
 * myna's OIDC rules on the key page: a CI token matching a rule is traded
 * for a short-lived gateway key at POST /v1/myna/keys/oidc. The daemon owns
 * the rules, so this card reads and writes them over RPC, not the config form.
 */
function OidcRulesCard({ serverId, keys }: { serverId: string; keys: GatewayKeyWire[] }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [rules, setRules] = useState<GatewayOidcRuleWire[] | null>(null);
  const [draft, setDraft] = useState<OidcDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const eligible = useMemo(() => eligibleOidcKeys(keys), [keys]);

  const load = useCallback(() => {
    if (client === null) {
      return;
    }
    void (async () => {
      try {
        const answer = await client.listGatewayOidcRules();
        setRules(answer.rules);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [client]);

  useEffect(() => {
    load();
  }, [load]);

  const startAdd = useCallback(() => {
    setError(null);
    setDraft({
      key: eligible[0] ?? "",
      issuer: "",
      audience: "",
      claims: "",
      ttlSeconds: undefined,
    });
  }, [eligible]);

  const startEdit = useCallback((rule: GatewayOidcRuleWire) => {
    setError(null);
    setDraft({
      ...(rule.id === undefined ? {} : { id: rule.id }),
      key: rule.key,
      issuer: rule.issuer,
      audience: rule.audience ?? "",
      claims: claimsText(rule.claims),
      ttlSeconds: rule.ttlSeconds,
    });
  }, []);

  const save = useCallback(() => {
    if (client === null || draft === null) {
      return;
    }
    const claims = parseClaims(draft.claims);
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const answer = await client.saveGatewayOidcRule({
          ...(draft.id === undefined ? {} : { id: draft.id }),
          key: draft.key.trim(),
          ...(draft.issuer.trim().length === 0 ? {} : { issuer: draft.issuer.trim() }),
          ...(draft.audience.trim().length === 0 ? {} : { audience: draft.audience.trim() }),
          ...(claims === undefined ? {} : { claims }),
          ...(draft.ttlSeconds === undefined ? {} : { ttlSeconds: draft.ttlSeconds }),
        });
        setRules(answer.rules);
        if (answer.error === undefined) {
          setDraft(null);
        } else {
          setError(answer.error);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [client, draft]);

  const remove = useCallback(
    (id: string) => {
      if (client === null) {
        return;
      }
      Alert.alert(t("settings.gateway.oidcRemoveTitle"), t("settings.gateway.oidcRemoveBody"), [
        { text: t("settings.gateway.oidcCancel"), style: "cancel" },
        {
          text: t("settings.gateway.remove"),
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                const answer = await client.removeGatewayOidcRule(id);
                setRules(answer.rules);
                if (answer.error !== undefined) {
                  setError(answer.error);
                }
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              }
            })();
          },
        },
      ]);
    },
    [client, t],
  );

  let list: ReactNode = null;
  if (rules !== null) {
    list =
      rules.length === 0 ? (
        <Text style={[settingsStyles.rowHint, styles.cardMessage]}>
          {t("settings.gateway.oidcEmpty")}
        </Text>
      ) : (
        <>
          {rules.map((rule) => (
            <Row
              key={rule.id ?? `${rule.key}/${rule.issuer}`}
              title={`${rule.key} · ${rule.issuer}`}
              sub={claimsText(rule.claims)}
              trailing={
                <View style={styles.rowActions}>
                  <Button variant="ghost" size="sm" onPress={() => startEdit(rule)}>
                    {t("settings.gateway.oidcEdit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      if (rule.id !== undefined) {
                        remove(rule.id);
                      }
                    }}
                  >
                    {t("settings.gateway.remove")}
                  </Button>
                </View>
              }
            />
          ))}
        </>
      );
  }

  return (
    <Card
      title={t("settings.gateway.oidcSection")}
      sub={t("settings.gateway.oidcSectionHint")}
      trailing={
        <Button variant="ghost" size="sm" onPress={startAdd}>
          {t("settings.gateway.oidcAdd")}
        </Button>
      }
    >
      {list}
      {draft === null ? null : (
        <>
          <TextRow
            label={t("settings.gateway.oidcKey")}
            hint={
              eligible.length > 0
                ? `${t("settings.gateway.oidcKeyHint")} (${eligible.join(", ")})`
                : t("settings.gateway.oidcKeyHint")
            }
            value={draft.key}
            resetKey={`${draft.id ?? "new"}-key`}
            onChangeText={(value) => setDraft({ ...draft, key: value })}
          />
          <TextRow
            label={t("settings.gateway.oidcIssuer")}
            hint={t("settings.gateway.oidcIssuerHint")}
            value={draft.issuer}
            resetKey={`${draft.id ?? "new"}-issuer`}
            placeholder="https://token.actions.githubusercontent.com"
            onChangeText={(value) => setDraft({ ...draft, issuer: value })}
          />
          <TextRow
            label={t("settings.gateway.oidcAudience")}
            hint={t("settings.gateway.oidcAudienceHint")}
            value={draft.audience}
            resetKey={`${draft.id ?? "new"}-audience`}
            onChangeText={(value) => setDraft({ ...draft, audience: value })}
          />
          <TextRow
            label={t("settings.gateway.oidcClaims")}
            hint={t("settings.gateway.oidcClaimsHint")}
            value={draft.claims}
            resetKey={`${draft.id ?? "new"}-claims`}
            placeholder="repository=owner/name"
            onChangeText={(value) => setDraft({ ...draft, claims: value })}
          />
          <NumberRow
            label={t("settings.gateway.oidcTtl")}
            value={draft.ttlSeconds}
            onChange={(value) => setDraft({ ...draft, ttlSeconds: value })}
          />
          <Row
            title={t("settings.gateway.oidcSave")}
            trailing={
              <View style={styles.rowActions}>
                <Button variant="ghost" size="sm" onPress={() => setDraft(null)}>
                  {t("settings.gateway.oidcCancel")}
                </Button>
                <Button variant="default" size="sm" onPress={save} disabled={busy}>
                  {t("settings.gateway.oidcSave")}
                </Button>
              </View>
            }
          />
        </>
      )}
      <Text style={[settingsStyles.rowHint, styles.cardMessage]}>
        {t("settings.gateway.oidcEndpoint")}
      </Text>
      {error === null ? null : (
        <Text style={[settingsStyles.rowError, styles.cardMessage]}>{error}</Text>
      )}
    </Card>
  );
}

function AddButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <View style={styles.addButton}>
      <Button variant="ghost" size="sm" onPress={onPress}>
        {label}
      </Button>
    </View>
  );
}

function cloneConfig(config: GatewayConfigWire): GatewayConfigWire {
  return JSON.parse(JSON.stringify(config)) as GatewayConfigWire;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function maskKey(key: string): string {
  return key.length <= 6 ? key : `${key.slice(0, 4)}…${key.slice(-2)}`;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return String(value);
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const styles = StyleSheet.create((theme) => ({
  loadingColor: { color: theme.colors.foregroundMuted },
  rowStack: { gap: theme.spacing[0.5] },
  /** Padding for a sentence that sits inside a card rather than in one of its rows. */
  cardMessage: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  limitsBlock: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  limitsTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  limitsHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  limitCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  limitActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  titleLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  rowMuted: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.normal },
  rowActions: { flexDirection: "row", gap: theme.spacing[1] },
  dot: { width: 7, height: 7, borderRadius: theme.borderRadius.full },
  bars: { flexDirection: "row", gap: theme.spacing[3] },
  quota: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  quotaLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  quotaTrack: {
    width: 54,
    height: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  quotaFill: {
    height: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
  },
  quotaValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    minWidth: 30,
    textAlign: "right",
  },
  fieldRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  searchApi: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  searchApiHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  searchApiGrow: { flex: 1 },
  searchVendors: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1],
  },
  fieldGrow: { flex: 1 },
  searcherThen: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    alignItems: "center",
  },
  searchKeys: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  searchKeyLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  searchKeyUse: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  addButton: { paddingHorizontal: theme.spacing[2], paddingBottom: theme.spacing[2] },
  saveCard: { backgroundColor: theme.colors.surface2 },
  jsonEditor: { padding: theme.spacing[3], gap: theme.spacing[2] },
}));
