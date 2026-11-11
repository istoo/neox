/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop -- settings summary: a handful of closures and option arrays, none in a hot list. */
import { Shield } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import type { GatewayMaskingSummaryWire } from "@neolix/protocol/gateway";
import type { Theme } from "@/styles/theme";
import { dayLabel, formatCount, maskingSummaryPending } from "./masking-shared";

const ThemedShield = withUnistyles(Shield);
const accentIcon = (theme: Theme) => ({ color: theme.colors.accent });

interface MaskingSummaryProps {
  summary: GatewayMaskingSummaryWire | null;
  /** The first read is still out: its numbers are unknown, not zero. */
  loading: boolean;
  error: Error | null;
  days: 7 | 30;
  maskingOn: boolean;
  onDays: (days: 7 | 30) => void;
  onToggle: () => void;
  selectedAgent: string;
  selectedProvider: string;
  onPickAgent: (agent: string) => void;
  onPickProvider: (provider: string) => void;
}

/**
 * What masking kept from vendors over the last 7 or 30 days: the number, the
 * values found, the days, and where they came from and went to.
 */
export function MaskingSummaryCard({
  summary,
  loading,
  error,
  days,
  maskingOn,
  onDays,
  onToggle,
  selectedAgent,
  selectedProvider,
  onPickAgent,
  onPickProvider,
}: MaskingSummaryProps) {
  const { t } = useTranslation();
  return (
    <SettingsSection
      title={t("settings.gatewayPages.masking.keptTitle")}
      info={t(
        maskingOn
          ? "settings.gatewayPages.masking.keptHintOn"
          : "settings.gatewayPages.masking.keptHintOff",
      )}
      trailing={
        <SegmentedControl
          options={[
            { value: "7", label: t("settings.gatewayPages.masking.days7") },
            { value: "30", label: t("settings.gatewayPages.masking.days30") },
          ]}
          value={String(days)}
          onValueChange={(value) => onDays(value === "30" ? 30 : 7)}
        />
      }
      testID="gateway-masking-summary"
    >
      <View style={settingsStyles.card}>
        {maskingSummaryPending(loading, summary) ? (
          <View style={styles.loading}>
            <LoadingSpinner color={styles.spinnerColor.color} />
          </View>
        ) : (
          <>
            <SummaryBand summary={summary} maskingOn={maskingOn} onToggle={onToggle} />
            <DayStrip summary={summary} />
            <SummaryFlow
              summary={summary}
              selectedAgent={selectedAgent}
              selectedProvider={selectedProvider}
              onPickAgent={onPickAgent}
              onPickProvider={onPickProvider}
            />
          </>
        )}
        {error !== null ? <Text style={styles.error}>{error.message}</Text> : null}
      </View>
    </SettingsSection>
  );
}

function SummaryBand({
  summary,
  maskingOn,
  onToggle,
}: {
  summary: GatewayMaskingSummaryWire | null;
  maskingOn: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const values = summary?.n ?? 0;
  const blocked = summary?.blocked ?? 0;
  const restored = summary?.restored ?? 0;
  return (
    <View style={styles.band}>
      <View style={styles.numbers}>
        <Text style={styles.big}>{formatCount(values)}</Text>
        <Text style={settingsStyles.rowHint}>
          {t(
            values === 1
              ? "settings.gatewayPages.masking.valueMasked"
              : "settings.gatewayPages.masking.valuesMasked",
          )}
        </Text>
        <View style={styles.stats}>
          <Stat
            label={t("settings.gatewayPages.masking.differentValues")}
            value={summary?.distinct ?? 0}
          />
          <Stat
            label={t("settings.gatewayPages.masking.requests")}
            value={summary?.requests ?? 0}
          />
          {restored > 0 ? (
            <Stat label={t("settings.gatewayPages.masking.restored")} value={restored} />
          ) : null}
          {blocked > 0 ? (
            <Stat label={t("settings.gatewayPages.masking.heldBack")} value={blocked} danger />
          ) : null}
        </View>
      </View>
      <Button variant={maskingOn ? "ghost" : "default"} onPress={onToggle}>
        {t(
          maskingOn
            ? "settings.gatewayPages.masking.turnOff"
            : "settings.gatewayPages.masking.turnOn",
        )}
      </Button>
    </View>
  );
}

function SummaryFlow({
  summary,
  selectedAgent,
  selectedProvider,
  onPickAgent,
  onPickProvider,
}: {
  summary: GatewayMaskingSummaryWire | null;
  selectedAgent: string;
  selectedProvider: string;
  onPickAgent: (agent: string) => void;
  onPickProvider: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const hasFlow = summary !== null && summary.agents.length > 0 && summary.providers.length > 0;
  if (!hasFlow || summary === null) {
    return <Text style={styles.empty}>{t("settings.gatewayPages.masking.flowEmpty")}</Text>;
  }
  return (
    <View style={styles.flow}>
      <FlowColumn
        title={t("settings.gatewayPages.masking.agents")}
        rows={summary.agents}
        selected={selectedAgent}
        onPick={onPickAgent}
      />
      <View style={styles.hub}>
        <ThemedShield size={20} strokeWidth={1.6} uniProps={accentIcon} />
        <Text style={styles.hubText}>{t("settings.gatewayPages.masking.maskedHere")}</Text>
      </View>
      <FlowColumn
        title={t("settings.gatewayPages.masking.providers")}
        rows={summary.providers}
        selected={selectedProvider}
        onPick={onPickProvider}
      />
    </View>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, danger === true ? styles.statDanger : null]}>
        {formatCount(value)}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function DayStrip({ summary }: { summary: GatewayMaskingSummaryWire | null }) {
  const { t } = useTranslation();
  const days = summary?.days ?? [];
  const max = Math.max(1, ...days.map((day) => day.n));
  if (days.length === 0) {
    return null;
  }
  const first = days[0];
  const last = days.at(-1);
  return (
    <View style={styles.strip}>
      <View style={styles.bars}>
        {days.map((day, index) => (
          <View
            key={day.day}
            style={[styles.barTrack, index === days.length - 1 ? styles.barTrackNow : null]}
          >
            <View
              style={[
                styles.barFill,
                index === days.length - 1 ? styles.barFillNow : null,
                { height: `${day.n === 0 ? 0 : Math.max(8, (100 * day.n) / max)}%` },
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>
          {first === undefined ? "" : dayLabel(first.day, t("settings.gatewayPages.masking.today"))}
        </Text>
        <Text style={styles.axisText}>
          {last === undefined ? "" : dayLabel(last.day, t("settings.gatewayPages.masking.today"))}
        </Text>
      </View>
    </View>
  );
}

function FlowColumn({
  title,
  rows,
  selected,
  onPick,
}: {
  title: string;
  rows: readonly { name: string; n: number }[];
  selected: string;
  onPick: (name: string) => void;
}) {
  return (
    <View style={styles.flowColumn}>
      <Text style={styles.flowTitle}>{title}</Text>
      {rows.slice(0, 3).map((row) => (
        <PressHighlight
          key={row.name}
          onPress={() => onPick(selected === row.name ? "" : row.name)}
          style={[styles.flowRow, selected === row.name ? styles.flowRowOn : null]}
        >
          <Text style={styles.flowName} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.flowCount}>{formatCount(row.n)}</Text>
        </PressHighlight>
      ))}
      {rows.length > 3 ? <Text style={styles.flowMore}>+{rows.length - 3}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  band: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  numbers: { flex: 1, gap: theme.spacing[1] },
  big: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.normal,
  },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
    marginTop: theme.spacing[2],
  },
  stat: { gap: 2 },
  statValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  statDanger: { color: theme.colors.statusDanger },
  statLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  loading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[6],
  },
  spinnerColor: { color: theme.colors.foregroundMuted },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  strip: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  bars: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
    height: 28,
  },
  barTrack: {
    flex: 1,
    height: "100%",
    justifyContent: "flex-end",
    backgroundColor: theme.colors.surface3,
    borderRadius: 2,
    overflow: "hidden",
  },
  barTrackNow: { backgroundColor: theme.colors.surface4 },
  barFill: {
    width: "100%",
    borderRadius: 2,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: theme.opacity[50],
  },
  barFillNow: { backgroundColor: theme.colors.accent, opacity: 1 },
  axis: { flexDirection: "row", justifyContent: "space-between" },
  axisText: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  flow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  flowColumn: { flex: 1, gap: theme.spacing[1] },
  flowTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 2,
  },
  flowRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: 4,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
  },
  flowRowOn: { backgroundColor: theme.colors.interactionHighlight },
  flowName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  flowCount: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  flowMore: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  hub: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    width: 86,
  },
  hubText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
}));
