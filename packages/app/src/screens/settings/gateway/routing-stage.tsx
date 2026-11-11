/* eslint-disable react-perf/jsx-no-new-array-as-prop, react-perf/jsx-no-new-object-as-prop -- routing stage: small style arrays in a card drawn a few times a second, not a hot list. */
import { StyleSheet } from "react-native-unistyles";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  GatewayAccountStatusWire,
  GatewayRouteTraceWire,
  GatewayRouteWire,
  GatewayStatusWire,
} from "@neolix/protocol/gateway";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import { RoutingDot } from "./routing-dot";
import { isRouteLive, seatStatus, type RoutingTone } from "./routing-model";
import { agentDisplayName } from "./routing-agent-names";

interface GatewayRoutingStageProps {
  trace: GatewayRouteTraceWire | null;
  status: GatewayStatusWire | null;
  hideAccounts: boolean;
}

interface StageSeat {
  key: string;
  provider: string;
  account: string | null;
  model: string | null;
  text: string;
  tone: RoutingTone;
  active: boolean;
}

export function GatewayRoutingStage({ trace, status, hideAccounts }: GatewayRoutingStageProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const route = trace?.routes[0] ?? null;
  const seats = route === null ? statusSeats(status, t) : routeSeats(route, hideAccounts, t);
  const stageStyle = compact ? styles.stageCompact : styles.stage;
  return (
    <View style={settingsStyles.card} testID="gateway-routing-stage">
      <View style={stageStyle}>
        <AgentNode
          agent={
            route === null
              ? t("settings.gatewayPages.routing.stageNoAgent")
              : agentDisplayName(route.agent)
          }
          model={route?.model ?? t("settings.gatewayPages.routing.stageNoModel")}
          t={t}
        />
        <Arrow compact={compact} />
        <GatewayNode live={route !== null && isRouteLive(route)} t={t} />
        <Arrow compact={compact} />
        <SeatList seats={seats} hideAccounts={hideAccounts} t={t} />
      </View>
      <StageStats trace={trace} t={t} />
    </View>
  );
}

function AgentNode({ agent, model, t }: { agent: string; model: string; t: TFunction }) {
  return (
    <View style={styles.node}>
      <Text style={styles.nodeKind}>{t("settings.gatewayPages.routing.stageAgent")}</Text>
      <Text style={styles.nodeName} numberOfLines={1}>
        {agent}
      </Text>
      <Text style={styles.nodeSub} numberOfLines={1}>
        {model}
      </Text>
    </View>
  );
}

function GatewayNode({ live, t }: { live: boolean; t: TFunction }) {
  return (
    <View style={[styles.node, styles.gatewayNode]}>
      <RoutingDot tone={live ? "active" : "neutral"} style={styles.liveDot} />
      <Text style={styles.nodeKind}>{t("settings.gatewayPages.routing.stageGateway")}</Text>
      <Text style={styles.nodeName}>Neox</Text>
      <Text style={styles.nodeSub}>{t("settings.gatewayPages.routing.stageGatewaySub")}</Text>
    </View>
  );
}

function Arrow({ compact }: { compact: boolean }) {
  if (compact) {
    return (
      <Text style={styles.arrowDown} accessibilityElementsHidden>
        ↓
      </Text>
    );
  }
  return (
    <Text style={styles.arrow} accessibilityElementsHidden>
      →
    </Text>
  );
}

function SeatList({
  seats,
  hideAccounts,
  t,
}: {
  seats: StageSeat[];
  hideAccounts: boolean;
  t: TFunction;
}) {
  if (seats.length === 0) {
    return (
      <View style={styles.seats}>
        <Text style={styles.empty}>{t("settings.gatewayPages.routing.stageNoSeats")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.seats}>
      {seats.map((seat) => (
        <SeatRow key={seat.key} seat={seat} hideAccounts={hideAccounts} />
      ))}
    </View>
  );
}

function SeatRow({ seat, hideAccounts }: { seat: StageSeat; hideAccounts: boolean }) {
  const name =
    hideAccounts && seat.account !== null
      ? `${seat.provider} · ${maskText(seat.account)}`
      : seat.provider;
  return (
    <View style={styles.seat}>
      <RoutingDot tone={seat.tone} />
      <View style={styles.seatText}>
        <Text style={styles.seatName} numberOfLines={1}>
          {name}
        </Text>
        {seat.model === null ? null : (
          <Text style={styles.seatModel} numberOfLines={1}>
            {seat.model}
          </Text>
        )}
      </View>
      <Text style={[styles.seatStatus, seat.active ? styles.seatStatusActive : null]}>
        {seat.text}
      </Text>
    </View>
  );
}

function StageStats({ trace, t }: { trace: GatewayRouteTraceWire | null; t: TFunction }) {
  return (
    <View style={styles.stats}>
      <Stat
        value={trace?.stats.requests ?? 0}
        label={t("settings.gatewayPages.routing.requests")}
      />
      <Stat
        value={trace?.stats.rerouted ?? 0}
        label={t("settings.gatewayPages.routing.rerouted")}
      />
      <Stat
        value={trace?.stats.errors ?? 0}
        label={t("settings.gatewayPages.routing.agentErrors")}
      />
    </View>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value.toLocaleString()}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function routeSeats(route: GatewayRouteWire, hideAccounts: boolean, t: TFunction): StageSeat[] {
  return route.seats.map((seat) => {
    const status = seatStatus(seat, route, Date.now(), t);
    return {
      key: seat.id,
      provider: seat.providerLabel,
      account: hideAccounts ? seat.account : null,
      model: seat.model,
      text: status.text,
      tone: status.tone,
      active: status.active,
    };
  });
}

function statusSeats(status: GatewayStatusWire | null, t: TFunction): StageSeat[] {
  if (status === null) {
    return [];
  }
  return status.accounts.map((account) => statusSeat(account, t));
}

function statusSeat(account: GatewayAccountStatusWire, t: TFunction): StageSeat {
  const resting = account.restingUntil !== null && account.restingUntil > Date.now();
  let text = "";
  if (resting) {
    const seconds = Math.max(1, Math.round(((account.restingUntil ?? 0) - Date.now()) / 1000));
    text = t("settings.gatewayPages.routing.seatResting", { when: `${seconds}s` });
  } else if (account.usedPercent !== null) {
    text = t("settings.gatewayPages.routing.seatUsage", { percent: account.usedPercent });
  }
  return {
    key: `${account.provider}/${account.account}`,
    provider: account.provider,
    account: account.account,
    model: null,
    text,
    tone: resting ? "muted" : "neutral",
    active: account.inflight > 0,
  };
}

function maskText(value: string): string {
  return "•".repeat(Math.min(8, Math.max(3, value.length)));
}

const styles = StyleSheet.create((theme) => ({
  stage: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    minHeight: 168,
  },
  stageCompact: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  node: {
    width: 148,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    gap: 2,
  },
  gatewayNode: {
    alignItems: "center",
  },
  nodeKind: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  nodeName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  nodeSub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  arrow: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.lg,
  },
  arrowDown: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.lg,
    alignSelf: "center",
  },
  seats: {
    flex: 1,
    gap: theme.spacing[1],
    minWidth: 0,
  },
  seat: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  liveDot: {
    marginBottom: theme.spacing[1],
  },
  seatText: {
    flex: 1,
    minWidth: 0,
  },
  seatName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  seatModel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  seatStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    textAlign: "right",
  },
  seatStatusActive: {
    color: theme.colors.foreground,
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[3],
  },
  stats: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "flex-end",
    gap: theme.spacing[6],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  stat: {
    alignItems: "flex-end",
  },
  statValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
