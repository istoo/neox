import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Box, Boxes, Copy, Route } from "lucide-react-native";
import type { GatewayConfigWire, GatewayStatusWire } from "@neolix/protocol/gateway";
import { SettingsCard, SettingsCollapsibleRow, SettingsRow } from "@/components/settings";
import { useSettingsRowLayout } from "@/components/settings/row-density";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ControlSizeProvider } from "@/components/ui/control-size";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { formatModelDisplayName, type ModelDisplayName } from "@/provider-selection/model-catalog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import type { GatewayPageProps } from "./types";
import {
  filterGatewayModels,
  formatContextWindow,
  gatewayKeyLabel,
  gatewayKeySecret,
  listGatewayModels,
  parseGatewayListen,
  type GatewayListen,
  type GatewayModelEntry,
} from "./overview-data";
import {
  buildGatewaySnippet,
  gatewayBaseEnvName,
  gatewayBaseUrl,
  type GatewayApi,
  type SnippetLanguage,
} from "./overview-snippets";

const GATEWAY_API_COUNT = 4;

type ListenState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; listen: string | null };

const ThemedBoxes = withUnistyles(Boxes);
const ThemedBox = withUnistyles(Box);
const ThemedRoute = withUnistyles(Route);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function GatewayOverviewPage({ serverId, config, status, error, apply }: GatewayPageProps) {
  const { t } = useTranslation();
  const models = useMemo(() => listGatewayModels(config), [config]);
  const client = useHostRuntimeClient(serverId);
  const supportsDaemonStatus = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.daemonStatusRpc === true,
  );
  const listenQuery = useFetchQuery<string | null>({
    queryKey: ["gateway", "daemon-listen", serverId],
    dataShape: "value",
    enabled: supportsDaemonStatus && client !== null,
    staleTimeMs: 30_000,
    queryFn: (): Promise<string | null> => {
      if (client === null) {
        return Promise.resolve(null);
      }
      return client.getDaemonStatus().then((daemon) => daemon.listen);
    },
  });

  const listenState = resolveListenState(supportsDaemonStatus, listenQuery);
  const parsedListen = listenState.kind === "ready" ? parseGatewayListen(listenState.listen) : null;
  const origin = parsedListen?.thisComputerUrl ?? parsedListen?.networkUrl ?? null;
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0] ?? null;

  return (
    <View style={styles.page} testID="gateway-overview-page">
      {error !== null ? (
        <Alert
          variant="error"
          title={t("settings.gatewayPages.overview.errorTitle")}
          description={error.message}
        />
      ) : null}
      <GatewayStatusCard config={config} status={status} apply={apply} modelCount={models.length} />
      <GatewayShareCard listenState={listenState} parsedListen={parsedListen} />
      {origin !== null ? (
        <GatewayConnectCard
          config={config}
          models={models}
          origin={origin}
          selectedModel={selectedModel}
        />
      ) : null}
      <GatewayModelsCard
        models={models}
        selectedModelId={selectedModel?.id ?? null}
        onSelectModel={setSelectedModelId}
      />
    </View>
  );
}

function resolveListenState(
  supported: boolean,
  query: { isLoading: boolean; isError: boolean; data: string | null | undefined },
): ListenState {
  if (!supported || query.isError) {
    return { kind: "unavailable" };
  }
  if (query.isLoading) {
    return { kind: "loading" };
  }
  return { kind: "ready", listen: query.data ?? null };
}

function GatewayStatusCard({
  config,
  status,
  apply,
  modelCount,
}: {
  config: GatewayConfigWire;
  status: GatewayStatusWire | null;
  apply: GatewayPageProps["apply"];
  modelCount: number;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const enabled = status?.enabled ?? config.enabled !== false;
  const providerCount = config.providers?.length ?? 0;
  const summary = enabled
    ? t("settings.gatewayPages.overview.statusSummary", {
        models: modelCount,
        providers: providerCount,
        apis: GATEWAY_API_COUNT,
      })
    : t("settings.gatewayPages.overview.stoppedHint");
  const handleToggle = useCallback(
    (value: boolean) => {
      void apply((next) => {
        next.enabled = value;
      }).catch((cause: unknown) => {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [apply, toast],
  );

  return (
    <SettingsCard testID="gateway-status-card">
      <View style={styles.statusRow}>
        <ThemedBoxes size={20} uniProps={mutedIconMapping} />
        <View style={styles.statusMain}>
          <View style={styles.statusTitleRow}>
            <Text style={styles.statusTitle}>{t("settings.gatewayPages.overview.title")}</Text>
            <StatusBadge
              label={t(
                enabled
                  ? "settings.gatewayPages.overview.running"
                  : "settings.gatewayPages.overview.stopped",
              )}
              variant={enabled ? "success" : "muted"}
              size="xs"
            />
          </View>
          <Text style={styles.statusSummary}>{summary}</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={handleToggle}
          accessibilityLabel={t("settings.gatewayPages.overview.enableGateway")}
        />
      </View>
    </SettingsCard>
  );
}

function GatewayShareCard({
  listenState,
  parsedListen,
}: {
  listenState: ListenState;
  parsedListen: GatewayListen | null;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"local" | "network">("local");
  const options = useMemo(
    () => [
      { value: "local" as const, label: t("settings.gatewayPages.overview.thisComputer") },
      { value: "network" as const, label: t("settings.gatewayPages.overview.localNetwork") },
    ],
    [t],
  );
  const thisComputerUrl = parsedListen?.thisComputerUrl ?? parsedListen?.networkUrl ?? null;
  const networkUrl = parsedListen?.networkUrl ?? null;
  const address = mode === "local" ? thisComputerUrl : networkUrl;
  const addressLabel = addressRowLabel(mode, thisComputerUrl, t);
  const hint = mode === "network" ? describeShare(listenState, parsedListen, t) : null;

  return (
    <SettingsCard testID="gateway-share-card">
      <View style={styles.shareRow}>
        <Text style={styles.shareTitle}>
          {t("settings.gatewayPages.overview.shareOnLocalNetwork")}
        </Text>
        <SegmentedControl options={options} value={mode} onValueChange={setMode} />
      </View>
      {address !== null ? <AddressRow label={addressLabel} value={address} /> : null}
      <View style={styles.hintRow}>
        {hint !== null ? <Text style={styles.hint}>{hint}</Text> : null}
        <Text style={styles.hint}>{t("settings.gatewayPages.overview.shareHint")}</Text>
      </View>
    </SettingsCard>
  );
}

function addressRowLabel(
  mode: "local" | "network",
  thisComputerUrl: string | null,
  t: TFunction,
): string {
  if (mode === "network") {
    return t("settings.gatewayPages.overview.localNetwork");
  }
  if (thisComputerUrl === null) {
    return t("settings.gatewayPages.overview.address");
  }
  return t("settings.gatewayPages.overview.thisComputer");
}

function describeShare(
  listenState: ListenState,
  parsed: GatewayListen | null,
  t: TFunction,
): string {
  if (listenState.kind === "loading") {
    return "…";
  }
  if (parsed === null) {
    return t("settings.gatewayPages.overview.lanUnknown");
  }
  const listen = parsed.listen ?? "";
  switch (parsed.kind) {
    case "loopback":
      return t("settings.gatewayPages.overview.lanLoopback", { listen, port: parsed.port });
    case "wildcard":
      return t("settings.gatewayPages.overview.lanWildcard", { listen, port: parsed.port });
    case "network":
      return t("settings.gatewayPages.overview.lanSpecific", { listen });
    case "socket":
      return t("settings.gatewayPages.overview.lanSocket");
    case "unknown":
      return t("settings.gatewayPages.overview.lanUnknown");
  }
}

function AddressRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  const layout = useSettingsRowLayout();
  return (
    <View style={layout.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={layout.title}>{label}</Text>
      </View>
      <ValueWithCopy
        value={value}
        copyValue={value}
        copyLabel={t("settings.gatewayPages.overview.copyAddress")}
        copiedLabel={t("settings.gatewayPages.overview.address")}
      />
    </View>
  );
}

function ValueWithCopy({
  value,
  copyValue,
  copyLabel,
  copiedLabel,
}: {
  value: string;
  copyValue: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const layout = useSettingsRowLayout();
  const toast = useToast();
  const handleCopy = useCallback(() => {
    void copyToClipboard(copyValue).then(() => toast.copied(copiedLabel));
  }, [copyValue, toast, copiedLabel]);

  return (
    <View style={styles.valueLine}>
      <Text style={styles.codeValue} numberOfLines={1}>
        {value}
      </Text>
      <ControlSizeProvider size={layout.controlSize}>
        <Button
          variant="ghost"
          leftIcon={Copy}
          accessibilityLabel={copyLabel}
          onPress={handleCopy}
        />
      </ControlSizeProvider>
    </View>
  );
}

function GatewayConnectCard({
  config,
  models,
  origin,
  selectedModel,
}: {
  config: GatewayConfigWire;
  models: readonly GatewayModelEntry[];
  origin: string;
  selectedModel: GatewayModelEntry | null;
}) {
  const { t } = useTranslation();
  const [api, setApi] = useState<GatewayApi>("openai");
  const [language, setLanguage] = useState<SnippetLanguage>("shell");
  const apiOptions = useMemo(
    () => [
      { value: "openai" as const, label: t("settings.gatewayPages.overview.apiOpenAI") },
      { value: "responses" as const, label: t("settings.gatewayPages.overview.apiResponses") },
      { value: "anthropic" as const, label: t("settings.gatewayPages.overview.apiAnthropic") },
      { value: "gemini" as const, label: t("settings.gatewayPages.overview.apiGemini") },
    ],
    [t],
  );
  const languageOptions = useMemo(
    () => [
      { value: "shell" as const, label: t("settings.gatewayPages.overview.shell") },
      { value: "curl" as const, label: t("settings.gatewayPages.overview.curl") },
      { value: "python" as const, label: t("settings.gatewayPages.overview.python") },
      { value: "node" as const, label: t("settings.gatewayPages.overview.node") },
    ],
    [t],
  );

  const keyEntry = config.keys?.[0];
  const keySecret = keyEntry === undefined ? "neolix" : gatewayKeySecret(keyEntry);
  const keyDisplay = keyEntry === undefined ? "neolix" : gatewayKeyLabel(keyEntry);
  const modelId = selectedModel?.id ?? "provider/model";
  const baseUrl = gatewayBaseUrl(origin, api);
  const envName = gatewayBaseEnvName(api);
  const note = connectNote(api, t);
  const snippet = buildGatewaySnippet({
    api,
    language,
    origin,
    model: modelId,
    apiKey: keySecret,
  });

  return (
    <SettingsCard testID="gateway-connect-card">
      <SettingsCollapsibleRow
        label={t("settings.gatewayPages.overview.connect")}
        summary={baseUrl}
        defaultExpanded={false}
      >
        <SettingsRow label={t("settings.gatewayPages.overview.api")} hint={note}>
          <SegmentedControl options={apiOptions} value={api} onValueChange={setApi} />
        </SettingsRow>
        <SettingsRow
          label={t("settings.gatewayPages.overview.baseUrl")}
          hint={t("settings.gatewayPages.overview.baseUrlHint", { env: envName })}
        >
          <ValueWithCopy
            value={baseUrl}
            copyValue={baseUrl}
            copyLabel={t("settings.gatewayPages.overview.copyBaseUrl")}
            copiedLabel={t("settings.gatewayPages.overview.baseUrl")}
          />
        </SettingsRow>
        <SettingsRow
          label={t(
            keyEntry === undefined
              ? "settings.gatewayPages.overview.apiKey"
              : "settings.gatewayPages.overview.gatewayKey",
          )}
          hint={t(
            keyEntry === undefined
              ? "settings.gatewayPages.overview.keyHintLoopback"
              : "settings.gatewayPages.overview.keyHintKeys",
          )}
        >
          <ValueWithCopy
            value={keyDisplay}
            copyValue={keySecret}
            copyLabel={t("settings.gatewayPages.overview.copyKey")}
            copiedLabel={t("settings.gatewayPages.overview.gatewayKey")}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.gatewayPages.overview.model")}
          hint={t(
            models.length === 0
              ? "settings.gatewayPages.overview.noModelsHint"
              : "settings.gatewayPages.overview.modelHint",
          )}
        >
          <ValueWithCopy
            value={modelId}
            copyValue={modelId}
            copyLabel={t("settings.gatewayPages.overview.copyModelId")}
            copiedLabel={t("settings.gatewayPages.overview.modelIdsCopied")}
          />
        </SettingsRow>
        <ExampleBlock
          language={language}
          languageOptions={languageOptions}
          onLanguageChange={setLanguage}
          snippet={snippet}
        />
      </SettingsCollapsibleRow>
    </SettingsCard>
  );
}

function connectNote(api: GatewayApi, t: TFunction): string {
  switch (api) {
    case "openai":
      return t("settings.gatewayPages.overview.noteOpenAI");
    case "responses":
      return t("settings.gatewayPages.overview.noteResponses");
    case "anthropic":
      return t("settings.gatewayPages.overview.noteAnthropic");
    case "gemini":
      return t("settings.gatewayPages.overview.noteGemini");
  }
}

function ExampleBlock({
  language,
  languageOptions,
  onLanguageChange,
  snippet,
}: {
  language: SnippetLanguage;
  languageOptions: { value: SnippetLanguage; label: string }[];
  onLanguageChange: (value: SnippetLanguage) => void;
  snippet: string;
}) {
  const { t } = useTranslation();
  const layout = useSettingsRowLayout();
  const toast = useToast();
  const handleCopy = useCallback(() => {
    void copyToClipboard(snippet).then(() =>
      toast.copied(t("settings.gatewayPages.overview.example")),
    );
  }, [snippet, toast, t]);

  return (
    <View style={styles.exampleBlock}>
      <View style={styles.exampleHeader}>
        <Text style={layout.title}>{t("settings.gatewayPages.overview.example")}</Text>
        <View style={styles.exampleControls}>
          <ControlSizeProvider size={layout.controlSize}>
            <SegmentedControl
              options={languageOptions}
              value={language}
              onValueChange={onLanguageChange}
            />
            <Button
              variant="ghost"
              leftIcon={Copy}
              accessibilityLabel={t("settings.gatewayPages.overview.copySnippet")}
              onPress={handleCopy}
            />
          </ControlSizeProvider>
        </View>
      </View>
      <View style={styles.codeBlock}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text selectable style={styles.codeText}>
            {snippet}
          </Text>
        </ScrollView>
      </View>
    </View>
  );
}

function GatewayModelsCard({
  models,
  selectedModelId,
  onSelectModel,
}: {
  models: readonly GatewayModelEntry[];
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterGatewayModels(models, query), [models, query]);
  const showSearch = models.length >= 5;

  return (
    <SettingsCard testID="gateway-models-card">
      <SettingsCollapsibleRow
        label={t("settings.gatewayPages.overview.models")}
        summary={models.length > 0 ? String(models.length) : undefined}
        defaultExpanded
      >
        {models.length > 0 ? (
          <ModelsToolbar
            query={query}
            onQueryChange={setQuery}
            showSearch={showSearch}
            models={filtered}
          />
        ) : null}
        {models.length === 0 ? (
          <EmptyModels
            title={t("settings.gatewayPages.overview.noModels")}
            hint={t("settings.gatewayPages.overview.noModelsHint")}
          />
        ) : null}
        {models.length > 0 && filtered.length === 0 ? (
          <View style={styles.emptyRow}>
            <Text style={styles.emptyText}>
              {t("settings.gatewayPages.overview.noModelMatch", { query: query.trim() })}
            </Text>
          </View>
        ) : null}
        {filtered.map((model) => (
          <ModelRow
            key={model.id}
            model={model}
            selected={model.id === selectedModelId}
            onSelect={onSelectModel}
          />
        ))}
      </SettingsCollapsibleRow>
    </SettingsCard>
  );
}

function ModelsToolbar({
  query,
  onQueryChange,
  showSearch,
  models,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  showSearch: boolean;
  models: readonly GatewayModelEntry[];
}) {
  const { t } = useTranslation();
  const layout = useSettingsRowLayout();
  const toast = useToast();
  const handleCopy = useCallback(() => {
    const ids = models.map((model) => model.id).join("\n");
    void copyToClipboard(ids).then(() =>
      toast.copied(t("settings.gatewayPages.overview.modelIdsCopied")),
    );
  }, [models, toast, t]);

  return (
    <View style={[layout.row, styles.toolbarRow]}>
      {showSearch ? (
        <SearchField
          testID="gateway-model-search"
          value={query}
          onChangeText={onQueryChange}
          placeholder={t("settings.gatewayPages.overview.findModel")}
          clearAccessibilityLabel={t("settings.gatewayPages.overview.clearSearch")}
        />
      ) : (
        <View style={styles.toolbarSpacer} />
      )}
      {models.length > 0 ? (
        <ControlSizeProvider size={layout.controlSize}>
          <Button variant="ghost" onPress={handleCopy} testID="gateway-copy-model-ids">
            {t("settings.gatewayPages.overview.copyAllIds")}
          </Button>
        </ControlSizeProvider>
      ) : null}
    </View>
  );
}

function EmptyModels({ title, hint }: { title: string; hint: string }) {
  return (
    <View style={styles.emptyRow}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{hint}</Text>
    </View>
  );
}

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: GatewayModelEntry;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const layout = useSettingsRowLayout();
  const handlePress = useCallback(() => onSelect(model.id), [onSelect, model.id]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      layout.row,
      styles.modelRow,
      selected ? styles.modelRowSelected : null,
      pressed ? styles.modelRowPressed : null,
    ],
    [layout, selected],
  );
  const display = formatModelDisplayName(
    { id: model.id, label: model.label },
    t("common.modelName.oneMillionContext"),
  );
  const subtitle = modelSubtitle(model, t, display);

  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      onPress={handlePress}
      style={rowStyle}
      highlightStyle={styles.modelRowPressed}
    >
      {model.group ? (
        <ThemedRoute size={16} uniProps={mutedIconMapping} />
      ) : (
        <ThemedBox size={16} uniProps={mutedIconMapping} />
      )}
      <View style={styles.modelMain}>
        <Text style={styles.modelId} numberOfLines={1}>
          {display.label}
        </Text>
        <Text style={styles.modelSubtitle} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {model.contextWindow !== null ? (
        <View
          accessible
          accessibilityLabel={t("settings.gatewayPages.overview.contextWindow", {
            tokens: formatContextWindow(model.contextWindow),
          })}
        >
          <StatusBadge label={formatContextWindow(model.contextWindow)} variant="muted" size="xs" />
        </View>
      ) : null}
      <ControlSizeProvider size={layout.controlSize}>
        <ModelCopyButton modelId={model.id} />
      </ControlSizeProvider>
    </PressHighlight>
  );
}

function ModelCopyButton({ modelId }: { modelId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const handleCopy = useCallback(() => {
    void copyToClipboard(modelId).then(() =>
      toast.copied(t("settings.gatewayPages.overview.modelIdsCopied")),
    );
  }, [modelId, toast, t]);
  return (
    <Button
      variant="ghost"
      leftIcon={Copy}
      accessibilityLabel={t("settings.gatewayPages.overview.copyModelId")}
      onPress={handleCopy}
    />
  );
}

function modelSubtitle(model: GatewayModelEntry, t: TFunction, display: ModelDisplayName): string {
  if (model.group) {
    const parts: string[] = [];
    const groupId = display.rawId.slice("group/".length);
    if (model.label !== groupId) {
      parts.push(model.label);
    }
    parts.push(t("settings.gatewayPages.overview.routingGroup"));
    if (model.members.length > 0) {
      parts.push(model.members.join(", "));
    }
    return parts.join(" · ");
  }
  // The raw id and its routing prefix stay here, in the row's details.
  return [display.source, model.providerLabel, display.rawId]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  page: {
    gap: theme.spacing[3],
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  statusMain: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
  statusTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  statusSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  shareTitle: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  hintRow: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  valueLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
  },
  codeValue: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  toolbarRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  toolbarSpacer: {
    flex: 1,
  },
  modelRow: {
    justifyContent: "flex-start",
    gap: theme.spacing[2],
  },
  modelRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  modelRowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  modelMain: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  modelId: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  modelSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  emptyRow: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  exampleBlock: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  exampleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  exampleControls: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  codeBlock: {
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    maxHeight: 320,
  },
  codeText: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: theme.fontSize.code * 1.5,
  },
}));
