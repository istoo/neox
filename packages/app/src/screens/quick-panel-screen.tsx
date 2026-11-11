import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { getDesktopHost } from "@/desktop/host";
import { useAgentConnect } from "@/hooks/use-agent-connect";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useTimeAgo } from "@/hooks/use-time-ago";
import { useBuiltinFeatureEnabled } from "@/plugins/builtin-features";
import {
  buildSelectableProviderSelectorProviders,
  type ProviderSelectorProvider,
} from "@/provider-selection/provider-selection";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSettingsHostServerId } from "@/screens/settings/app/shared";
import { AgentGuideCard } from "@/screens/settings/agent/agent-guide-card";
import { GatewayQuotaSection } from "@/screens/settings/gateway/usage-quotas";
import { UsageReportSection } from "@/screens/settings/gateway/usage-overview";
import { GatewayRoutingPage } from "@/screens/settings/gateway/routing-page";
import { useGatewayUsage, type GatewayUsageFilters } from "@/screens/settings/gateway/usage-data";
import type { GatewayPageProps } from "@/screens/settings/gateway/types";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { useUsageDisplay } from "@/usage/display";
import type { UsageReportEntry } from "@/usage/types";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import type { GatewayConfigWire, GatewayUsagePeriodWire } from "@neolix/protocol/gateway";
import type { AgentProvider } from "@neolix/protocol/agent-types";

/**
 * myna's quick panel (gui/app.go togglePanel, index.html:107-111): the same
 * four tabs — Agents, Allowances, Usage, Routing — in a small window by the
 * tray icon. Neolix's versions reuse the gateway pages' own components in a
 * compact size; Routing only exists while the `routing` built-in is on.
 */

type PanelTab = "agents" | "allowances" | "usage" | "routing";

const PANEL_TABS: PanelTab[] = ["agents", "allowances", "usage", "routing"];
const PANEL_REFRESH_MS = 30_000;
const SHOW_ACCOUNTS = false;
const EMPTY_REPORTS: readonly UsageReportEntry[] = [];
const EMPTY_USAGE_FILTERS: GatewayUsageFilters = {};
const MODEL_CHIP_TOOLBAR = { glyphSize: 14, showCaret: false };

const USAGE_PERIODS = [
  { value: "today", labelKey: "settings.gatewayPages.usage.period.today" },
  { value: "7d", labelKey: "settings.gatewayPages.usage.period.week" },
  { value: "30d", labelKey: "settings.gatewayPages.usage.period.month" },
  { value: "all", labelKey: "settings.gatewayPages.usage.period.all" },
] as const;

const TAB_LABEL_KEYS = {
  agents: "quickPanel.tabs.agents",
  allowances: "quickPanel.tabs.allowances",
  usage: "quickPanel.tabs.usage",
  routing: "quickPanel.tabs.routing",
} as const satisfies Record<PanelTab, string>;

/** myna's per-agent model picker (app.js agentRow fields), Neolix's chip. */
function AgentModelChip({ agent }: { agent: AggregatedAgent }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(agent.serverId);
  const selection = useSessionStore(
    useShallow((state) => {
      const current = state.sessions[agent.serverId]?.agents.get(agent.id);
      if (!current) {
        return null;
      }
      return {
        runtimeModelId: current.runtimeInfo?.model ?? null,
        configuredModelId: current.model,
        runtimeThinkingOptionId: current.runtimeInfo?.thinkingOptionId ?? null,
        explicitThinkingOptionId: current.thinkingOptionId,
      };
    }),
  );
  const { entries, isLoading } = useProvidersSnapshot(agent.serverId, { cwd: agent.cwd });
  const entry = useMemo(
    () => entries?.find((candidate) => candidate.provider === agent.provider) ?? null,
    [agent.provider, entries],
  );
  const providers = useMemo<ProviderSelectorProvider[]>(
    () => (entry ? buildSelectableProviderSelectorProviders([entry]) : []),
    [entry],
  );
  const models = useMemo(() => filterSelectableModels(entry?.models ?? null), [entry]);
  const activeModelId = useMemo(() => {
    if (!selection) {
      return "";
    }
    return (
      resolveAgentModelSelection({
        models,
        runtimeModelId: selection.runtimeModelId,
        configuredModelId: selection.configuredModelId,
        runtimeThinkingOptionId: selection.runtimeThinkingOptionId,
        explicitThinkingOptionId: selection.explicitThinkingOptionId,
      }).activeModelId ?? ""
    );
  }, [models, selection]);

  const handleSelect = useCallback(
    (_provider: AgentProvider, modelId: string) => {
      if (!client) {
        return;
      }
      void client.setAgentModel(agent.id, modelId).catch((error: unknown) => {
        toast.error(toErrorMessage(error));
      });
    },
    [agent.id, client, toast],
  );

  return (
    <View style={styles.modelChip}>
      <CombinedModelSelector
        providers={providers}
        selectedProvider={agent.provider}
        selectedModel={activeModelId}
        onSelect={handleSelect}
        isLoading={isLoading || entry?.status === "loading"}
        disabled={!client}
        serverId={agent.serverId}
        desktopPlacement="bottom-start"
        desktopMinWidth={320}
        toolbar={MODEL_CHIP_TOOLBAR}
      />
      {entry === null && !isLoading ? (
        <Text style={styles.modelHint} numberOfLines={1}>
          {t("providerSelection.selectModel")}
        </Text>
      ) : null}
    </View>
  );
}

/** One agent: the row opens it in the main window, the chip changes its model. */
function AgentRow({ agent }: { agent: AggregatedAgent }) {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo(agent.lastActivityAt ?? agent.createdAt);
  const workspace = agent.projectPlacement?.workspaceName ?? agent.projectPlacement?.projectName;

  const handlePress = useCallback(() => {
    void getDesktopHost()?.panel?.openAgent?.({ serverId: agent.serverId, agentId: agent.id });
  }, [agent.id, agent.serverId]);

  let dotStyle = styles.dotIdle;
  if (agent.status === "running") {
    dotStyle = styles.dotRunning;
  } else if (agent.status === "initializing") {
    dotStyle = styles.dotInitializing;
  }

  return (
    <View style={styles.row}>
      <PressHighlight
        onPress={handlePress}
        style={styles.rowOpen}
        accessibilityRole="button"
        accessibilityLabel={agent.title ?? t("agentList.fallbackTitle")}
      >
        <View style={styles.titleLine}>
          <Text style={[styles.statusDot, dotStyle]}>●</Text>
          <Text style={styles.title} numberOfLines={1}>
            {agent.title || t("agentList.fallbackTitle")}
          </Text>
          <Text style={styles.age}>{timeAgo}</Text>
        </View>
        {workspace ? (
          <Text style={styles.workspace} numberOfLines={1}>
            {workspace}
          </Text>
        ) : null}
      </PressHighlight>
      <AgentModelChip agent={agent} />
    </View>
  );
}

function AgentsTab({ agents, serverId }: { agents: AggregatedAgent[]; serverId: string | null }) {
  const { t } = useTranslation();
  const connect = useAgentConnect(serverId);
  const connectFromGuide = useCallback(
    (provider: string) => {
      void connect.setConnected(provider, true, null);
    },
    [connect],
  );
  // myna draws its Get started card in the panel as in the window
  // (app.js agentsLead); the same card and the same verdict, above the list.
  const guide = serverId !== null ? connect.snapshot : null;
  if (agents.length === 0 && guide === null) {
    return <Text style={styles.empty}>{t("quickPanel.empty")}</Text>;
  }
  return (
    <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
      {serverId !== null && guide !== null ? (
        <AgentGuideCard
          serverId={serverId}
          entries={guide.entries}
          models={guide.models}
          onConnect={connectFromGuide}
        />
      ) : null}
      {agents.map((agent) => (
        <AgentRow key={`${agent.serverId}:${agent.id}`} agent={agent} />
      ))}
    </ScrollView>
  );
}

/** myna's Allowances tab: the gateway's quota cards (app.js renderPanelQuota). */
function AllowancesTab({ serverId }: { serverId: string }) {
  const { display } = useUsageDisplay(EMPTY_REPORTS);
  return (
    <ScrollView contentContainerStyle={styles.tabContent} showsVerticalScrollIndicator={false}>
      <GatewayQuotaSection
        serverId={serverId}
        refreshMs={PANEL_REFRESH_MS}
        displayAs={display.displayAs}
        maskAccounts={SHOW_ACCOUNTS}
      />
    </ScrollView>
  );
}

/** myna's Usage tab: what the window's requests add up to (renderPanelUse). */
function UsageTab({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<GatewayUsagePeriodWire>("today");
  const { report, isLoading, error } = useGatewayUsage({
    serverId,
    period,
    filters: EMPTY_USAGE_FILTERS,
    refreshMs: PANEL_REFRESH_MS,
  });
  const periodOptions = useMemo(
    () => USAGE_PERIODS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
    [t],
  );
  return (
    <ScrollView contentContainerStyle={styles.tabContent} showsVerticalScrollIndicator={false}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <SegmentedControl
          options={periodOptions}
          value={period}
          onValueChange={setPeriod}
          size="sm"
        />
      </ScrollView>
      <UsageReportSection report={report} isLoading={isLoading} error={error} />
    </ScrollView>
  );
}

/** myna's Routing tab: the gateway routing page, saved as it changes. */
function RoutingTab({ serverId }: { serverId: string }) {
  const { config, status, searchVendors, isLoading, error, save } = useGatewayConfig(serverId);
  const [draft, setDraft] = useState<GatewayConfigWire | null>(null);
  const active = draft ?? config;

  const edit = useCallback(
    (mutate: (next: GatewayConfigWire) => void) => {
      const base = draft ?? config;
      if (base === null) {
        return;
      }
      const next = structuredClone(base);
      mutate(next);
      setDraft(next);
    },
    [config, draft],
  );
  const apply = useCallback(
    async (mutate: (next: GatewayConfigWire) => void) => {
      const base = draft ?? config;
      if (base === null) {
        return;
      }
      const next = structuredClone(base);
      mutate(next);
      await save(next);
      setDraft(null);
    },
    [config, draft, save],
  );
  const page = useMemo<GatewayPageProps | null>(
    () =>
      active === null
        ? null
        : { serverId, config: active, status, searchVendors, error, edit, apply },
    [active, apply, edit, error, searchVendors, serverId, status],
  );

  if (page === null) {
    return (
      <View style={styles.centered}>
        {isLoading ? <LoadingSpinner color={styles.spinner.color} /> : null}
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.tabContent} showsVerticalScrollIndicator={false}>
      <GatewayRoutingPage {...page} />
    </ScrollView>
  );
}

function PanelTabButton({
  tab,
  label,
  count,
  active,
  onSelect,
}: {
  tab: PanelTab;
  label: string;
  count?: number;
  active: boolean;
  onSelect: (tab: PanelTab) => void;
}) {
  const handlePress = useCallback(() => onSelect(tab), [onSelect, tab]);
  const buttonStyle = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const labelStyle = useMemo(() => [styles.tabLabel, active && styles.tabLabelActive], [active]);
  return (
    <PressHighlight
      onPress={handlePress}
      style={buttonStyle}
      accessibilityRole="tab"
      accessibilityLabel={label}
    >
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
      {count !== undefined && count > 0 ? (
        <Text style={styles.tabCount} numberOfLines={1}>
          {count}
        </Text>
      ) : null}
    </PressHighlight>
  );
}

export function QuickPanelScreen() {
  const { t } = useTranslation();
  const { agents } = useAggregatedAgents({ demand: true });
  const settingsServerId = useSettingsHostServerId();
  const localServerId = useLocalDaemonServerId();
  const sorted = useMemo(() => {
    const running = (agent: AggregatedAgent) => (agent.status === "running" ? 0 : 1);
    return [...agents].sort((a, b) => running(a) - running(b));
  }, [agents]);
  const serverId = settingsServerId ?? localServerId ?? sorted[0]?.serverId ?? null;
  const routingEnabled = useBuiltinFeatureEnabled(serverId, "routing");
  const [tab, setTab] = useState<PanelTab>("agents");
  const activeTab = tab === "routing" && !routingEnabled ? "agents" : tab;

  const tabs = useMemo(
    () => PANEL_TABS.filter((candidate) => candidate !== "routing" || routingEnabled),
    [routingEnabled],
  );
  const selectTab = useCallback((next: PanelTab) => setTab(next), []);
  const openMain = useCallback(() => {
    void getDesktopHost()?.panel?.openMain?.();
  }, []);
  const openMainStyle = useMemo(() => [styles.openMain], []);

  let content;
  if (activeTab === "agents") {
    content = <AgentsTab agents={sorted} serverId={serverId} />;
  } else if (serverId === null) {
    content = <Text style={styles.empty}>{t("quickPanel.noHost")}</Text>;
  } else if (activeTab === "allowances") {
    content = <AllowancesTab serverId={serverId} />;
  } else if (activeTab === "usage") {
    content = <UsageTab serverId={serverId} />;
  } else {
    content = <RoutingTab serverId={serverId} />;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.brand}>Neox</Text>
        <PressHighlight
          onPress={openMain}
          hitSlop={8}
          style={openMainStyle}
          accessibilityRole="button"
          accessibilityLabel={t("quickPanel.openMain")}
        >
          <ExternalLink size={16} color="#8b8fa3" />
        </PressHighlight>
      </View>
      <View style={styles.tabs} accessibilityRole="tablist">
        {tabs.map((candidate) => (
          <PanelTabButton
            key={candidate}
            tab={candidate}
            label={t(TAB_LABEL_KEYS[candidate])}
            count={candidate === "agents" ? agents.length : undefined}
            active={candidate === activeTab}
            onSelect={selectTab}
          />
        ))}
      </View>
      <View style={styles.body}>{content}</View>
      {activeTab === "agents" ? <Text style={styles.hint}>{t("quickPanel.hint")}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  brand: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  openMain: {
    padding: theme.spacing[1],
  },
  tabs: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  body: {
    flex: 1,
  },
  list: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  rowOpen: {
    flex: 1,
    gap: 2,
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusDot: {
    fontSize: 8,
  },
  dotRunning: {
    color: theme.colors.palette.green[500],
  },
  dotInitializing: {
    color: theme.colors.palette.amber[500],
  },
  dotIdle: {
    color: theme.colors.foregroundMuted,
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  workspace: {
    marginLeft: 14,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  age: {
    marginLeft: "auto",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  modelChip: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: 170,
  },
  modelHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tabContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  empty: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  hint: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
