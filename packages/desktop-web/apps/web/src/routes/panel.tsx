// FILE: panel.tsx
// Purpose: Compact tray panel for the forked web UI. Mirrors the old RN
//          quick-panel-screen: agents, allowances, usage, and routing in a
//          380px window opened from the tray or `neolix panel`.
// Layer: Route

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { isAutomationRunThread } from "@synara/shared/automationMode";
import { isSidechatThread } from "@synara/shared/sidechatThread";
import { useMemo, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { resolveThreadStatusPill } from "~/components/Sidebar.logic";
import { GatewayAllowancesPane } from "~/components/settings/gateway/GatewayAllowancesPane";
import { GatewayRoutingPane } from "~/components/settings/gateway/GatewayRoutingPane";
import { GatewayUsagePane } from "~/components/settings/gateway/GatewayUsagePane";
import { ExternalLinkIcon } from "~/lib/icons";
import { GATEWAY_QUERY_KEY, saveGatewayConfig } from "~/lib/gatewayConfigSave";
import type { GatewayConfig } from "~/lib/gatewayTypes";
import { neolixGatewayApi } from "~/lib/neolixGatewayApi";
import { formatRelativeTime } from "~/lib/relativeTime";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";
import type { SidebarThreadSummary } from "~/types";
import { useTranslation } from "~/i18n";

type PanelTab = "agents" | "allowances" | "usage" | "routing";

function statusDotClass(summary: SidebarThreadSummary): string {
  const pill = resolveThreadStatusPill({
    thread: summary,
    hasPendingApprovals: summary.hasPendingApprovals,
    hasPendingUserInput: summary.hasPendingUserInput,
  });
  if (pill) return pill.dotClass;
  return summary.session?.status === "closed" || summary.session === null
    ? "bg-muted-foreground/40"
    : "bg-muted-foreground/60";
}

function AgentRow({
  summary,
  projectName,
  onOpen,
}: {
  summary: SidebarThreadSummary;
  projectName: string;
  onOpen: (threadId: string) => void;
}) {
  const updatedAt = summary.updatedAt ?? summary.createdAt;
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onOpen(summary.id)}
      className="flex w-full min-w-0 items-start gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-foreground/[0.06] focus-visible:outline-2 focus-visible:outline-ring"
      title={summary.title}
    >
      <span
        aria-hidden
        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${statusDotClass(summary)}`}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
            {summary.title || t("common:untitled")}
          </span>
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            {formatRelativeTime(updatedAt)}
          </span>
        </span>
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-ui-xs text-muted-foreground">
            {projectName}
          </span>
          <span className="max-w-[45%] shrink-0 truncate text-ui-xs text-muted-foreground/80">
            {summary.modelSelection.model}
          </span>
        </span>
      </span>
    </button>
  );
}

function openPanelThread(threadId: string): void {
  void window.neolixDesktop?.panel?.openThread?.(threadId);
}

function AgentsTab() {
  const { t } = useTranslation();
  const [summariesSelector] = useState(() => createSidebarThreadSummariesSelector());
  const summaries = useStore(summariesSelector);
  const projects = useStore((state) => state.projects);
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const threads = useMemo(
    () =>
      summaries
        .filter(
          (summary) =>
            !summary.archivedAt &&
            !summary.parentThreadId &&
            !isSidechatThread(summary) &&
            !isAutomationRunThread(summary),
        )
        .sort((left, right) => {
          const leftRunning = left.session?.status === "running" ? 0 : 1;
          const rightRunning = right.session?.status === "running" ? 0 : 1;
          if (leftRunning !== rightRunning) return leftRunning - rightRunning;
          const leftAt = Date.parse(left.updatedAt ?? left.createdAt);
          const rightAt = Date.parse(right.updatedAt ?? right.createdAt);
          return rightAt - leftAt;
        }),
    [summaries],
  );

  const openThread = openPanelThread;

  if (threads.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-ui-sm text-muted-foreground">
        {t("common:noResults")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto py-1.5">
      {threads.map((summary) => (
        <AgentRow
          key={summary.id}
          summary={summary}
          projectName={projectNameById.get(summary.projectId) ?? ""}
          onOpen={openThread}
        />
      ))}
    </div>
  );
}

function GatewayTab({ tab }: { tab: "allowances" | "usage" | "routing" }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{ base: GatewayConfig; value: GatewayConfig } | null>(null);
  const query = useQuery({
    queryKey: GATEWAY_QUERY_KEY,
    queryFn: neolixGatewayApi.getConfig,
    staleTime: 5_000,
  });
  const config = draft?.value ?? query.data?.config;

  const edit = (mutate: (next: GatewayConfig) => void) => {
    const base = draft?.base ?? query.data?.config;
    if (!base) return;
    const next = structuredClone(draft?.value ?? base);
    mutate(next);
    setDraft({ base, value: next });
  };
  const apply = async (mutate: (next: GatewayConfig) => void) => {
    const base = draft?.base ?? query.data?.config;
    if (!base) return;
    const next = structuredClone(draft?.value ?? base);
    mutate(next);
    // This window has its own cache; the save re-reads the daemon so it cannot revert what
    // the main window saved meanwhile.
    const saved = await saveGatewayConfig(base, next);
    queryClient.setQueryData(GATEWAY_QUERY_KEY, saved);
    setDraft(null);
  };

  if (query.isLoading && !config) {
    return <p className="px-4 py-8 text-ui-sm text-muted-foreground">{t("gateway:loading")}</p>;
  }
  if (!config) {
    return (
      <p className="px-4 py-8 text-ui-sm text-muted-foreground">
        {query.error ? t("gateway:load_failed") : t("gateway:no_config")}
      </p>
    );
  }
  return (
    <div className="min-w-0 overflow-y-auto px-2 py-2">
      {tab === "allowances" ? <GatewayAllowancesPane config={config} apply={apply} /> : null}
      {tab === "usage" ? <GatewayUsagePane config={config} apply={apply} /> : null}
      {tab === "routing" ? <GatewayRoutingPane config={config} edit={edit} apply={apply} /> : null}
    </div>
  );
}

function QuickPanelRoute() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PanelTab>("agents");
  const tabs: readonly { id: PanelTab; label: string }[] = [
    { id: "agents", label: t("workspace:agents") },
    { id: "allowances", label: t("gateway:tab_allowances") },
    { id: "usage", label: t("gateway:tab_usage") },
    { id: "routing", label: t("gateway:tab_routing") },
  ];

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <span className="text-ui-sm font-semibold">{APP_DISPLAY_NAME}</span>
        <button
          type="button"
          aria-label={t("common:open", { title: APP_DISPLAY_NAME })}
          title={t("common:open", { title: APP_DISPLAY_NAME })}
          onClick={() => void window.neolixDesktop?.panel?.openMain?.()}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ExternalLinkIcon className="size-4" />
        </button>
      </header>
      <nav
        aria-label={APP_DISPLAY_NAME}
        className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1"
      >
        {tabs.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => setTab(candidate.id)}
            aria-current={tab === candidate.id ? "page" : undefined}
            className={`min-w-0 flex-1 truncate rounded-md px-1.5 py-1 text-ui-sm transition-colors ${
              tab === candidate.id
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {candidate.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === "agents" ? <AgentsTab /> : <GatewayTab tab={tab} />}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/panel")({
  component: QuickPanelRoute,
});
