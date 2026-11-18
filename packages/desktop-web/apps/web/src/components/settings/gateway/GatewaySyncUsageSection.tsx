// FILE: GatewaySyncUsageSection.tsx
// Purpose: The Usage page's cross-device card — every synced computer's days, its recent
//          calls and the merged quota history, gated on the host's `sync` capability.
// Layer: Settings panel pane
import { useQuery } from "@tanstack/react-query";

import { HostUpdateNotice } from "~/components/hosts/HostUpdateNotice";
import { useHostFeatures } from "~/hooks/useHostFeatures";
import { useTranslation } from "~/i18n";
import { HOST_FEATURES } from "~/lib/hostFeatures.logic";
import { getSyncUsage } from "~/lib/neolixHostApi";

import { Button } from "../../ui/button";
import { SettingsSection } from "../SettingsPanelPrimitives";
import { formatTokens, formatUsd, formatWhen } from "./gatewayHelpers";
import { GatewayEmpty } from "./GatewayPrimitives";
import { buildSyncUsageView, sparklinePath, type SyncUsageView } from "./gatewaySyncUsage.logic";

const SYNC_USAGE_QUERY_KEY = ["neolix-host", "sync-usage"] as const;
const SPARKLINE_WIDTH = 100;
const SPARKLINE_HEIGHT = 24;

export function GatewaySyncUsageSection({ refreshMs }: { refreshMs: number }) {
  const { t } = useTranslation();
  const hostFeatures = useHostFeatures();
  const status = hostFeatures.featureStatus(HOST_FEATURES.sync);
  return (
    <SettingsSection title="gateway:sync_usage_title">
      {status === "unknown" ? (
        <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>
      ) : status === "unavailable" ? (
        <div className="px-3 py-2">
          <HostUpdateNotice compact />
        </div>
      ) : (
        <GatewaySyncUsageBody refreshMs={refreshMs} />
      )}
    </SettingsSection>
  );
}

function GatewaySyncUsageBody({ refreshMs }: { refreshMs: number }) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: SYNC_USAGE_QUERY_KEY,
    queryFn: getSyncUsage,
    staleTime: 60_000,
    refetchInterval: refreshMs > 0 ? refreshMs : false,
    retry: false,
  });

  if (query.isPending) {
    return <div className="px-3 py-2 text-ui-sm text-muted-foreground">{t("gateway:loading")}</div>;
  }
  if (query.error) {
    const message = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        <GatewayEmpty tone="error">{message}</GatewayEmpty>
        <div>
          <Button size="xs" variant="ghost" onClick={() => void query.refetch()}>
            {t("common:tryAgain")}
          </Button>
        </div>
      </div>
    );
  }

  const view = buildSyncUsageView(query.data);
  return <GatewaySyncUsageView view={view} />;
}

export function GatewaySyncUsageView({ view }: { view: SyncUsageView }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="grid grid-cols-3 gap-px bg-[color:var(--color-border)]">
        {(
          [
            ["tokens", formatTokens(view.totals.tokens)],
            ["calls", String(view.totals.calls)],
            ["cost", formatUsd(view.totals.cost)],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2">
            <div className="text-ui-xs text-muted-foreground">{t(`gateway:usage_kpi_${key}`)}</div>
            <div className="text-ui font-medium">{value}</div>
          </div>
        ))}
      </div>

      {view.hasSharedUsage ? (
        <>
          <SyncUsageSeries view={view} />
          <SyncUsageDevices view={view} />
          <SyncUsageRecentCalls view={view} />
          <SyncUsageQuotas view={view} />
        </>
      ) : (
        <div className="px-3 py-2">
          <GatewayEmpty>{t("gateway:sync_usage_empty")}</GatewayEmpty>
        </div>
      )}

      <div className="px-3 py-2 text-ui-xs text-muted-foreground">
        {t("gateway:sync_usage_note")}
      </div>
    </>
  );
}

function SyncUsageSeries({ view }: { view: SyncUsageView }) {
  if (view.series.length === 0) return null;
  const peak = Math.max(1, ...view.series.map((point) => point.tokens));
  return (
    <div className="flex h-24 items-end gap-0.5 px-3 py-2">
      {view.series.slice(-60).map((point) => (
        <div
          key={point.key}
          title={`${point.label}: ${point.calls} · ${formatUsd(point.cost)}`}
          className="min-w-[3px] max-w-4 flex-1 rounded-sm bg-foreground/20 hover:bg-foreground/40"
          style={{ height: `${Math.max(2, (point.tokens / peak) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function SyncUsageDevices({ view }: { view: SyncUsageView }) {
  const { t } = useTranslation();
  if (view.devices.length === 0) return null;
  return (
    <div className="px-3 py-2">
      <SyncUsageTitle>{t("gateway:sync_usage_devices")}</SyncUsageTitle>
      {view.devices.map((device) => (
        <div
          key={device.id}
          className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border)] py-1 first:border-t-0"
        >
          <div className="min-w-0 truncate text-ui-sm">
            {device.isThis ? t("gateway:sync_usage_this_computer") : device.name || device.id}
          </div>
          <div className="shrink-0 truncate text-ui-xs text-muted-foreground">
            {t("gateway:sync_usage_device_detail", {
              tokens: formatTokens(device.tokens),
              calls: device.calls,
              cost: formatUsd(device.cost),
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SyncUsageRecentCalls({ view }: { view: SyncUsageView }) {
  const { t } = useTranslation();
  if (view.recentCalls.length === 0) return null;
  return (
    <div className="px-3 py-2">
      <SyncUsageTitle>{t("gateway:sync_usage_recent")}</SyncUsageTitle>
      {view.recentCalls.map((call) => (
        <div
          key={call.key}
          className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border)] py-1 first:border-t-0"
        >
          <div className="min-w-0 truncate text-ui-sm">
            {call.computer}
            {call.model ? ` · ${call.model}` : ""}
          </div>
          <div className="shrink-0 truncate text-ui-xs text-muted-foreground">
            {t("gateway:sync_usage_call_detail", {
              tokens: formatTokens(call.tokens),
              cost: call.cost === null ? "—" : formatUsd(call.cost),
              time: formatWhen(call.at),
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SyncUsageQuotas({ view }: { view: SyncUsageView }) {
  const { t } = useTranslation();
  if (view.quotas.length === 0) return null;
  return (
    <div className="px-3 py-2">
      <SyncUsageTitle>{t("gateway:sync_usage_quota_title")}</SyncUsageTitle>
      {view.quotas.map((quota) => {
        const path = sparklinePath(quota.points, SPARKLINE_WIDTH, SPARKLINE_HEIGHT);
        return (
          <div
            key={quota.key}
            className="border-t border-[color:var(--color-border)] py-1.5 first:border-t-0"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-ui-sm">{quota.provider}</div>
                <div className="truncate text-ui-xs text-muted-foreground">
                  {quota.account || "—"}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-ui-sm">
                  {quota.latestLeft === null
                    ? "—"
                    : t("gateway:sync_usage_quota_left", {
                        percent: Math.round(quota.latestLeft),
                      })}
                </div>
                <div className="text-ui-xs text-muted-foreground">
                  {t("gateway:sync_usage_quota_reading", {
                    time: formatWhen(quota.latestAt),
                  })}
                </div>
              </div>
            </div>
            {path ? (
              <svg
                role="img"
                aria-label={`${quota.provider} ${quota.name}`}
                viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
                preserveAspectRatio="none"
                className="mt-1 h-6 w-full text-foreground/40"
              >
                <path
                  d={path}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SyncUsageTitle({ children }: { children: string }) {
  return (
    <div className="mb-1 text-ui-xs uppercase tracking-wide text-muted-foreground">{children}</div>
  );
}
