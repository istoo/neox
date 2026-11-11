/* eslint-disable react-perf/jsx-no-new-function-as-prop, react-perf/jsx-no-new-object-as-prop -- one closure per Apply/Undo press, none of them in a hot list. */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { GatewayTuneAdviceWire } from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { useGatewayTune } from "@/hooks/use-gateway-diagnostics";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { formatCompact, formatPercent } from "./usage-data";

type TuneKnob = "compact" | "cache_ttl";

/**
 * The Context tab's advice, myna's tune: the compaction window and cache
 * lifetime that would have cost this user's own calls the fewest tokens.
 * Apply writes the agent's own setting (Claude Code's settings.json, Codex's
 * config.toml) only when pressed; Undo puts back what was there before.
 */
export function GatewayUsageTune({ serverId }: { serverId: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const client = useHostRuntimeClient(serverId);
  const tune = useGatewayTune(serverId, 7);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const change = useCallback(
    async (advice: GatewayTuneAdviceWire, knob: TuneKnob, value: string | null, undo: boolean) => {
      if (client === null) {
        return;
      }
      const key = `${advice.agent}.${knob}`;
      setBusy(key);
      setFailure(null);
      try {
        const payload = undo
          ? await client.undoGatewayTune({
              agent: advice.agent === "codex" ? "codex" : "claude",
              knob,
              ...(knob === "compact" && advice.compact !== undefined
                ? { model: advice.compact.model }
                : {}),
            })
          : await client.applyGatewayTune({
              agent: advice.agent === "codex" ? "codex" : "claude",
              knob,
              ...(knob === "compact" && advice.compact !== undefined
                ? { model: advice.compact.model }
                : {}),
              value: value ?? "",
            });
        if (payload.error !== null) {
          setFailure(payload.error);
          return;
        }
        await tune.refresh();
      } catch (cause) {
        setFailure(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [client, tune],
  );

  if (tune.error !== null || tune.advice.length === 0) {
    return null;
  }
  return (
    <View style={[settingsStyles.card, styles.card]} testID="gateway-usage-tune">
      <View style={styles.head}>
        <Text style={styles.title}>{t("settings.gatewayPages.usage.probes.tune.title")}</Text>
        <Text style={styles.hint}>
          {t("settings.gatewayPages.usage.probes.tune.hint", { days: tune.days })}
        </Text>
      </View>
      {tune.advice.map((advice) => (
        <AdviceRow
          key={advice.agent}
          advice={advice}
          locale={locale}
          busy={busy}
          onChange={change}
        />
      ))}
      {failure === null ? null : <Text style={styles.error}>{failure}</Text>}
      <Text style={styles.note}>{t("settings.gatewayPages.usage.probes.tune.applyNote")}</Text>
    </View>
  );
}

function AdviceRow({
  advice,
  locale,
  busy,
  onChange,
}: {
  advice: GatewayTuneAdviceWire;
  locale: string | undefined;
  busy: string | null;
  onChange: (
    advice: GatewayTuneAdviceWire,
    knob: TuneKnob,
    value: string | null,
    undo: boolean,
  ) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.entry}>
      <Text style={styles.agent}>
        {t("settings.gatewayPages.usage.probes.tune.agent", {
          agent: advice.agent,
          calls: new Intl.NumberFormat(locale).format(advice.calls),
        })}
      </Text>
      {advice.compact === undefined ? null : (
        <TuneLine
          text={t("settings.gatewayPages.usage.probes.tune.compact", {
            model: advice.compact.model,
            current: formatCompact(advice.compact.current, locale),
            best: formatCompact(advice.compact.best, locale),
            saves: savings(advice.compact.cost, advice.compact.low),
          })}
          ours={advice.compact.setting?.ours === true}
          busy={busy === `${advice.agent}.compact`}
          locked={advice.compact.setting?.locked}
          onApply={() => onChange(advice, "compact", String(advice.compact?.best ?? ""), false)}
          onUndo={() => onChange(advice, "compact", null, true)}
        />
      )}
      {advice.ttl === undefined ? null : (
        <TuneLine
          text={t("settings.gatewayPages.usage.probes.tune.ttl", {
            current: advice.ttl.current,
            best: advice.ttl.best,
            saves: savings(advice.ttl.cost, advice.ttl.low),
          })}
          ours={advice.ttl.setting?.ours === true}
          busy={busy === `${advice.agent}.cache_ttl`}
          locked={advice.ttl.setting?.locked}
          onApply={() => onChange(advice, "cache_ttl", advice.ttl?.best ?? null, false)}
          onUndo={() => onChange(advice, "cache_ttl", null, true)}
        />
      )}
    </View>
  );
}

function TuneLine({
  text,
  ours,
  busy,
  locked,
  onApply,
  onUndo,
}: {
  text: string;
  ours: boolean;
  busy: boolean;
  locked: string | undefined;
  onApply: () => void;
  onUndo: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.lineRow}>
      <Text style={styles.line}>{text}</Text>
      {locked !== undefined ? (
        <Text style={styles.note}>
          {t("settings.gatewayPages.usage.probes.tune.locked", { name: locked })}
        </Text>
      ) : (
        <Button variant="outline" size="sm" loading={busy} onPress={ours ? onUndo : onApply}>
          {ours
            ? t("settings.gatewayPages.usage.probes.tune.undo")
            : t("settings.gatewayPages.usage.probes.tune.apply")}
        </Button>
      )}
    </View>
  );
}

/** The share a setting would save, or the fact that it would not. */
function savings(cost: number, low: number): string {
  if (cost <= 0 || low >= cost) {
    return "0%";
  }
  return formatPercent((cost - low) / cost, undefined);
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginTop: theme.spacing[4],
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  head: {
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entry: {
    gap: theme.spacing[1],
  },
  agent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  line: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));
