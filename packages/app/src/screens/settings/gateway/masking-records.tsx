/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop, react-perf/jsx-no-jsx-as-prop -- settings records: a handful of closures and style arrays, not a hot streaming list. */
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";
import type { GatewayMaskingRecordWire, GatewayMaskingSummaryWire } from "@neolix/protocol/gateway";
import {
  MASK_SECRET_KINDS,
  formatCount,
  kindColorIndex,
  maskShape,
  rankRecordKinds,
  recordDayKey,
  recordDayName,
  timeLabel,
  type MaskFacet,
} from "./masking-shared";

export type MaskRecordMode = "req" | "val";

interface MaskingRecordsProps {
  summary: GatewayMaskingSummaryWire | null;
  records: readonly GatewayMaskingRecordWire[];
  more: boolean;
  busy: boolean;
  error: string;
  read: boolean;
  mode: MaskRecordMode;
  facet: MaskFacet;
  kind: string;
  agent: string;
  provider: string;
  expanded: string;
  onMode: (mode: MaskRecordMode) => void;
  onFacet: (facet: MaskFacet) => void;
  onKind: (kind: string) => void;
  onAgent: (agent: string) => void;
  onProvider: (provider: string) => void;
  onLoadMore: () => void;
  onClear: () => void;
  onExpand: (key: string) => void;
}

function kindLabel(t: TFunction, kind: string): string {
  return t(`settings.gatewayPages.masking.kind.${kind}`, { defaultValue: kind });
}

function finderLabel(t: TFunction, by: string): string {
  if (by === "yours") {
    return t("settings.gatewayPages.masking.finderYours");
  }
  if (by === "model") {
    return t("settings.gatewayPages.masking.finderModel");
  }
  return t("settings.gatewayPages.masking.finderRule");
}

function actionLabel(t: TFunction, action: string | undefined): string | null {
  if (action === "warn") {
    return t("settings.gatewayPages.masking.sentAsWritten");
  }
  if (action === "block") {
    return t("settings.gatewayPages.masking.heldBack");
  }
  return null;
}

export function MaskingRecordsCard(props: MaskingRecordsProps) {
  const { t } = useTranslation();
  const { summary } = props;
  return (
    <SettingsSection
      title={t("settings.gatewayPages.masking.recordsTitle")}
      info={t("settings.gatewayPages.masking.recordsHint")}
      testID="gateway-masking-records"
    >
      <View style={settingsStyles.card}>
        <RecordsHeader
          summary={summary}
          mode={props.mode}
          facet={props.facet}
          kind={props.kind}
          agent={props.agent}
          provider={props.provider}
          onMode={props.onMode}
          onFacet={props.onFacet}
          onKind={props.onKind}
          onAgent={props.onAgent}
          onProvider={props.onProvider}
        />
        <RecordsBody
          summary={summary}
          records={props.records}
          mode={props.mode}
          facet={props.facet}
          kind={props.kind}
          agent={props.agent}
          provider={props.provider}
          busy={props.busy}
          read={props.read}
          error={props.error}
          expanded={props.expanded}
          onMode={props.onMode}
          onKind={props.onKind}
          onExpand={props.onExpand}
        />
        <RecordsFooter
          mode={props.mode}
          more={props.more}
          busy={props.busy}
          clearable={props.records.length > 0 || (summary?.requests ?? 0) > 0}
          onLoadMore={props.onLoadMore}
          onClear={props.onClear}
        />
      </View>
    </SettingsSection>
  );
}

function RecordsHeader({
  summary,
  mode,
  facet,
  kind,
  agent,
  provider,
  onMode,
  onFacet,
  onKind,
  onAgent,
  onProvider,
}: {
  summary: GatewayMaskingSummaryWire | null;
  mode: MaskRecordMode;
  facet: MaskFacet;
  kind: string;
  agent: string;
  provider: string;
  onMode: (mode: MaskRecordMode) => void;
  onFacet: (facet: MaskFacet) => void;
  onKind: (kind: string) => void;
  onAgent: (agent: string) => void;
  onProvider: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const ranking = summary?.kinds ?? [];
  const secretCount =
    summary?.kinds
      .filter((entry) => (MASK_SECRET_KINDS as readonly string[]).includes(entry.name))
      .reduce((total, entry) => total + entry.n, 0) ?? 0;
  return (
    <View>
      <View style={styles.bar}>
        <SegmentedControl
          options={[
            { value: "req", label: t("settings.gatewayPages.masking.byRequest") },
            { value: "val", label: t("settings.gatewayPages.masking.byValue") },
          ]}
          value={mode}
          onValueChange={(value) => onMode(value === "val" ? "val" : "req")}
        />
        <View style={styles.live}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>{t("settings.gatewayPages.masking.live")}</Text>
        </View>
      </View>
      <View style={styles.facets}>
        <Facet
          label={t("settings.gatewayPages.masking.facetAll")}
          count={summary?.n ?? 0}
          selected={facet === "" && kind === ""}
          onPress={() => onFacet("")}
        />
        <Facet
          label={t("settings.gatewayPages.masking.facetSecrets")}
          count={secretCount}
          selected={facet === "secret"}
          onPress={() => onFacet("secret")}
        />
        <Facet
          label={t("settings.gatewayPages.masking.facetRules")}
          count={summary?.by.rule ?? 0}
          selected={facet === "rule"}
          onPress={() => onFacet("rule")}
        />
        <BlockedFacet
          count={summary?.blocked ?? 0}
          selected={facet === "blocked"}
          onPress={() => onFacet("blocked")}
        />
        <KindFacet kind={kind} ranking={ranking} onClear={() => onKind("")} />
      </View>
      <Narrowed agent={agent} provider={provider} onAgent={onAgent} onProvider={onProvider} />
    </View>
  );
}

function BlockedFacet({
  count,
  selected,
  onPress,
}: {
  count: number;
  selected: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  if (count === 0 && !selected) {
    return null;
  }
  return (
    <Facet
      label={t("settings.gatewayPages.masking.heldBack")}
      count={count}
      selected={selected}
      danger
      onPress={onPress}
    />
  );
}

function KindFacet({
  kind,
  ranking,
  onClear,
}: {
  kind: string;
  ranking: readonly { name: string }[];
  onClear: () => void;
}) {
  const { t } = useTranslation();
  if (kind === "") {
    return null;
  }
  return (
    <PressHighlight onPress={onClear} style={[styles.facet, styles.facetOn]}>
      <KindDot kind={kind} ranking={ranking} />
      <Text style={styles.facetText}>{kindLabel(t, kind)}</Text>
      <Text style={styles.facetX}>×</Text>
    </PressHighlight>
  );
}

function Narrowed({
  agent,
  provider,
  onAgent,
  onProvider,
}: {
  agent: string;
  provider: string;
  onAgent: (agent: string) => void;
  onProvider: (provider: string) => void;
}) {
  if (agent === "" && provider === "") {
    return null;
  }
  return (
    <View style={styles.narrowed}>
      {agent === "" ? null : (
        <PressHighlight onPress={() => onAgent("")} style={styles.narrow}>
          <Text style={styles.narrowText} numberOfLines={1}>
            {agent}
          </Text>
          <Text style={styles.facetX}>×</Text>
        </PressHighlight>
      )}
      {provider === "" ? null : (
        <PressHighlight onPress={() => onProvider("")} style={styles.narrow}>
          <Text style={styles.narrowText} numberOfLines={1}>
            {provider}
          </Text>
          <Text style={styles.facetX}>×</Text>
        </PressHighlight>
      )}
    </View>
  );
}

function RecordsBody({
  summary,
  records,
  mode,
  facet,
  kind,
  agent,
  provider,
  busy,
  read,
  error,
  expanded,
  onMode,
  onKind,
  onExpand,
}: {
  summary: GatewayMaskingSummaryWire | null;
  records: readonly GatewayMaskingRecordWire[];
  mode: MaskRecordMode;
  facet: MaskFacet;
  kind: string;
  agent: string;
  provider: string;
  busy: boolean;
  read: boolean;
  error: string;
  expanded: string;
  onMode: (mode: MaskRecordMode) => void;
  onKind: (kind: string) => void;
  onExpand: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (error !== "") {
    return <Text style={styles.error}>{error}</Text>;
  }
  if (mode === "val") {
    return (
      <ValueList
        summary={summary}
        facet={facet}
        kind={kind}
        ranking={summary?.kinds ?? []}
        onPick={(next) => {
          onMode("req");
          onKind(next);
        }}
      />
    );
  }
  const filtered = facet !== "" || kind !== "" || agent !== "" || provider !== "";
  return (
    <RequestList
      records={records}
      ranking={summary?.kinds ?? []}
      expanded={expanded}
      busy={busy}
      read={read}
      emptyLabel={t(
        filtered
          ? "settings.gatewayPages.masking.noMatch"
          : "settings.gatewayPages.masking.nothingYet",
      )}
      onExpand={onExpand}
    />
  );
}

function RecordsFooter({
  mode,
  more,
  busy,
  clearable,
  onLoadMore,
  onClear,
}: {
  mode: MaskRecordMode;
  more: boolean;
  busy: boolean;
  clearable: boolean;
  onLoadMore: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.foot}>
      <Text style={styles.footText}>{t("settings.gatewayPages.masking.keptFor")}</Text>
      {mode === "req" && more ? (
        <Button variant="ghost" size="sm" onPress={onLoadMore} disabled={busy}>
          {t(
            busy
              ? "settings.gatewayPages.masking.loading"
              : "settings.gatewayPages.masking.loadMore",
          )}
        </Button>
      ) : null}
      {mode === "req" && clearable ? (
        <Button variant="ghost" size="sm" onPress={onClear}>
          {t("settings.gatewayPages.masking.clearRecords")}
        </Button>
      ) : null}
    </View>
  );
}

function Facet({
  label,
  count,
  selected,
  danger,
  onPress,
}: {
  label: string;
  count: number;
  selected: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  return (
    <PressHighlight
      onPress={onPress}
      style={[styles.facet, selected ? styles.facetOn : null]}
      accessibilityState={{ selected }}
    >
      <Text style={[styles.facetText, danger === true ? styles.facetDanger : null]}>{label}</Text>
      <Text style={styles.facetCount}>{formatCount(count)}</Text>
    </PressHighlight>
  );
}

function KindDot({ kind, ranking }: { kind: string; ranking: readonly { name: string }[] }) {
  const dots = [
    styles.dot0,
    styles.dot1,
    styles.dot2,
    styles.dot3,
    styles.dot4,
    styles.dot5,
    styles.dot6,
  ];
  return <View style={[styles.dot, dots[kindColorIndex(kind, ranking)]]} />;
}

function RequestList({
  records,
  ranking,
  expanded,
  busy,
  read,
  emptyLabel,
  onExpand,
}: {
  records: readonly GatewayMaskingRecordWire[];
  ranking: readonly { name: string }[];
  expanded: string;
  busy: boolean;
  read: boolean;
  emptyLabel: string;
  onExpand: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (records.length === 0) {
    return (
      <Text style={styles.empty}>
        {busy || !read ? t("settings.gatewayPages.masking.loading") : emptyLabel}
      </Text>
    );
  }
  let day = "";
  const groups: Array<{ day: string; records: GatewayMaskingRecordWire[] }> = [];
  for (const record of records) {
    const key = recordDayKey(record.t);
    if (key !== day) {
      day = key;
      groups.push({ day: key, records: [] });
    }
    groups.at(-1)?.records.push(record);
  }
  return (
    <View>
      {groups.map((group) => (
        <View key={group.day}>
          <Text style={styles.day}>
            {recordDayName(
              group.records[0]?.t ?? group.day,
              t("settings.gatewayPages.masking.today"),
              t("settings.gatewayPages.masking.yesterday"),
            )}
          </Text>
          {group.records.map((record) => (
            <RequestRow
              key={record.key}
              record={record}
              ranking={ranking}
              expanded={expanded === record.key}
              onPress={() => onExpand(record.key)}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function RequestRow({
  record,
  ranking,
  expanded,
  onPress,
}: {
  record: GatewayMaskingRecordWire;
  ranking: readonly { name: string }[];
  expanded: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const kinds = rankRecordKinds(record.values);
  return (
    <View>
      <PressHighlight onPress={onPress} style={[styles.row, styles.rowBorder]}>
        <Text style={styles.time}>{timeLabel(record.t)}</Text>
        <View style={styles.route}>
          <Text style={styles.who} numberOfLines={1}>
            {record.agent ?? t("settings.gatewayPages.masking.unknownAgent")}
          </Text>
          <Text style={styles.arrow}>→</Text>
          <Text style={styles.who} numberOfLines={1}>
            {record.provider ?? t("settings.gatewayPages.masking.aVendor")}
          </Text>
        </View>
        <Text style={styles.model} numberOfLines={1}>
          {record.model ?? ""}
        </Text>
        <View style={styles.kinds}>
          {record.blocked === true ? (
            <Text style={styles.held}>{t("settings.gatewayPages.masking.heldBack")}</Text>
          ) : null}
          {kinds.slice(0, 3).map((entry) => (
            <View key={entry.kind} style={styles.kindChip}>
              <KindDot kind={entry.kind} ranking={ranking} />
              <Text style={styles.kindText}>{kindLabel(t, entry.kind)}</Text>
              <Text style={styles.kindCount}>×{formatCount(entry.n)}</Text>
            </View>
          ))}
          {kinds.length > 3 ? <Text style={styles.kindMore}>+{kinds.length - 3}</Text> : null}
        </View>
        <Text style={styles.rowN}>{formatCount(record.n)}</Text>
      </PressHighlight>
      {expanded ? <RecordDetail record={record} ranking={ranking} /> : null}
    </View>
  );
}

function RecordDetail({
  record,
  ranking,
}: {
  record: GatewayMaskingRecordWire;
  ranking: readonly { name: string }[];
}) {
  const { t } = useTranslation();
  const places = record.values.reduce((total, value) => total + value.n, 0);
  return (
    <View style={styles.detail}>
      {record.blocked === true ? (
        <Text style={styles.detailBlocked}>
          {t("settings.gatewayPages.masking.blockedDetail", {
            provider: record.provider ?? t("settings.gatewayPages.masking.aVendor"),
          })}
        </Text>
      ) : null}
      <View style={styles.steps}>
        <Step
          label={t("settings.gatewayPages.masking.stepFound", { n: record.values.length })}
          sub={t("settings.gatewayPages.masking.stepFoundSub")}
        />
        <Step
          label={t("settings.gatewayPages.masking.stepReplaced", { n: places })}
          sub={t("settings.gatewayPages.masking.stepReplacedSub")}
        />
        <Step
          label={t(
            record.blocked === true
              ? "settings.gatewayPages.masking.stepHeld"
              : "settings.gatewayPages.masking.stepSent",
          )}
          sub={
            record.blocked === true
              ? t("settings.gatewayPages.masking.stepHeldSub")
              : (record.provider ?? t("settings.gatewayPages.masking.aVendor"))
          }
        />
      </View>
      <View style={styles.valueList}>
        {record.values.map((value) => {
          const action = actionLabel(t, value.a);
          const back = record.back?.[value.p] ?? 0;
          return (
            <View key={value.p} style={styles.valueRow}>
              <KindDot kind={value.k} ranking={ranking} />
              <Text style={styles.valueKind}>{kindLabel(t, value.k)}</Text>
              <Text style={styles.valueShape}>{maskShape(value.h, value.l)}</Text>
              <Text style={styles.valueBy}>{finderLabel(t, value.b)}</Text>
              {action !== null ? <Text style={styles.valueAction}>{action}</Text> : null}
              {back > 0 ? (
                <Text style={styles.valueBack}>
                  {t("settings.gatewayPages.masking.inAnswer", { n: formatCount(back) })}
                </Text>
              ) : null}
              <Text style={styles.valueN}>×{formatCount(value.n)}</Text>
            </View>
          );
        })}
      </View>
      <Text style={styles.detailNote}>{t("settings.gatewayPages.masking.valueNeverStored")}</Text>
    </View>
  );
}

function Step({ label, sub }: { label: string; sub: string }) {
  return (
    <View style={styles.step}>
      <Text style={styles.stepLabel}>{label}</Text>
      <Text style={styles.stepSub} numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

function ValueList({
  summary,
  facet,
  kind,
  ranking,
  onPick,
}: {
  summary: GatewayMaskingSummaryWire | null;
  facet: MaskFacet;
  kind: string;
  ranking: readonly { name: string }[];
  onPick: (kind: string) => void;
}) {
  const { t } = useTranslation();
  if (summary === null) {
    return <Text style={styles.empty}>{t("settings.gatewayPages.masking.loading")}</Text>;
  }
  const values = summary.values.filter((value) => {
    if (kind !== "" && value.k !== kind) {
      return false;
    }
    if (facet === "secret") {
      return (MASK_SECRET_KINDS as readonly string[]).includes(value.k);
    }
    if (facet === "rule") {
      return value.b === "rule";
    }
    if (facet === "blocked") {
      return false;
    }
    return true;
  });
  if (values.length === 0) {
    return (
      <Text style={styles.empty}>
        {t(
          summary.values.length > 0
            ? "settings.gatewayPages.masking.noMatch"
            : "settings.gatewayPages.masking.nothingYet",
        )}
      </Text>
    );
  }
  const max = Math.max(1, values[0]?.n ?? 1);
  return (
    <View>
      <View style={styles.valueHead}>
        <Text style={styles.valueHeadText}>{t("settings.gatewayPages.masking.maskedMost")}</Text>
      </View>
      {values.map((value, index) => (
        <PressHighlight
          key={value.p}
          onPress={() => onPick(value.k)}
          style={[styles.valueListRow, styles.rowBorder]}
        >
          <Text style={styles.rank}>{String(index + 1).padStart(2, "0")}</Text>
          <Text style={styles.valueShape}>{maskShape(value.h, value.l)}</Text>
          <View style={styles.valueKindCell}>
            <KindDot kind={value.k} ranking={ranking} />
            <Text style={styles.kindText}>{kindLabel(t, value.k)}</Text>
          </View>
          <Text style={styles.valueBy}>{finderLabel(t, value.b)}</Text>
          <View style={styles.valueBar}>
            <View
              style={[styles.valueBarFill, { width: `${Math.max(3, (100 * value.n) / max)}%` }]}
            />
          </View>
          <Text style={styles.rowN}>{formatCount(value.n)}</Text>
        </PressHighlight>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  live: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.statusSuccess,
  },
  liveText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  facets: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  facet: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
  },
  facetOn: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface3,
  },
  facetText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  facetDanger: { color: theme.colors.statusDanger },
  facetCount: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  facetX: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dot0: { backgroundColor: theme.colors.accent },
  dot1: { backgroundColor: theme.colors.terminal.blue },
  dot2: { backgroundColor: theme.colors.statusWarning },
  dot3: { backgroundColor: theme.colors.terminal.magenta },
  dot4: { backgroundColor: theme.colors.statusSuccess },
  dot5: { backgroundColor: theme.colors.terminal.cyan },
  dot6: { backgroundColor: theme.colors.statusDanger },
  narrowed: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  narrow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  narrowText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, maxWidth: 180 },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[6],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  day: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    minHeight: 44,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: theme.colors.border },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  route: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 1 },
  who: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, maxWidth: 110 },
  arrow: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  model: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flex: 1,
    minWidth: 60,
  },
  kinds: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 1 },
  held: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  kindChip: { flexDirection: "row", alignItems: "center", gap: 3 },
  kindText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  kindCount: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  kindMore: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  rowN: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    minWidth: 32,
    textAlign: "right",
  },
  detail: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
  detailBlocked: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingTop: theme.spacing[2],
  },
  steps: { flexDirection: "row", gap: theme.spacing[2], paddingTop: theme.spacing[2] },
  step: { flex: 1, gap: 2 },
  stepLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  stepSub: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  valueList: { gap: 2 },
  valueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: 3,
  },
  valueKind: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, minWidth: 80 },
  valueShape: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  valueBy: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flex: 1 },
  valueAction: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  valueBack: { color: theme.colors.statusSuccess, fontSize: theme.fontSize.sm },
  valueN: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  detailNote: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  valueHead: { paddingHorizontal: theme.spacing[4], paddingVertical: theme.spacing[2] },
  valueHeadText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  valueListRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    minHeight: 40,
  },
  rank: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
    width: 18,
  },
  valueKindCell: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 100 },
  valueBar: {
    width: 80,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  valueBarFill: {
    height: 4,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.accent,
    opacity: theme.opacity[50],
  },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footText: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm, flex: 1 },
}));
