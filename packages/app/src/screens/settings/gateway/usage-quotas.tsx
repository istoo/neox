import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Svg, { Line, Polyline } from "react-native-svg";
import type {
  GatewayQuotaAccountWire,
  GatewayQuotaPointWire,
  GatewayQuotaWindowWire,
} from "@neolix/protocol/gateway";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectField } from "@/components/ui/select-field";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import type { Theme } from "@/styles/theme";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { maskAccount } from "@/usage/mask-account";
import type { UsageDisplayAs } from "@/usage/preferences";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { formatCompact, formatUsd, useGatewayQuota, type GatewayQuotaTrend } from "./usage-data";

type CreditsMode = "on" | "first" | "last" | "off";
const CREDITS_MODES: readonly CreditsMode[] = ["on", "first", "last", "off"];
const TWO_DAYS_MS = 48 * 60 * 60_000;
const CURVE_WIDTH = 300;
const CURVE_HEIGHT = 60;
/** A vendor's reset time can move a little between readings; inside this it is the same cycle. */
const RESET_DRIFT_MS = 5 * 60_000;

/**
 * The gateway accounts' own allowances, as myna draws them: one card per
 * account, a meter per window with its reset and pace, and the account's
 * curve over the range the head picks. Neolix's own agent subscriptions stay
 * a separate group below.
 */
export function GatewayQuotaSection({
  serverId,
  refreshMs,
  displayAs,
  maskAccounts,
  onOpenProvider,
}: {
  serverId: string;
  refreshMs: number;
  displayAs: UsageDisplayAs;
  maskAccounts: boolean;
  /** Opens a provider's editor, from a plan card's missing key. */
  onOpenProvider?: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const supported = useHostFeature(serverId, "gatewayQuotas");
  // A plan card has no gateway account behind it; only a host that says so
  // may send one (COMPAT(gatewayQuotaPlanCards)).
  const planCards = useHostFeature(serverId, "gatewayQuotaPlanCards");
  const [trend, setTrend] = useState<GatewayQuotaTrend>("cycle");
  const { quota, isLoading, error, refresh } = useGatewayQuota({
    serverId,
    trend,
    refreshMs,
  });
  const { config, save } = useGatewayConfig(serverId);
  // A Codex account's credits setting lives on its gateway account, as
  // myna keeps CodexCreditsMode; an API-key account has none to show.
  const creditsSettings = useMemo(() => {
    const settings = new Map<string, { mode: CreditsMode; codex: boolean }>();
    for (const provider of config?.providers ?? []) {
      for (const account of provider.accounts ?? []) {
        settings.set(account.id === undefined ? "" : `${provider.id}/${account.id}`, {
          mode: account.creditsMode ?? "on",
          codex: account.codexAccountId !== undefined,
        });
      }
    }
    return settings;
  }, [config]);
  const setCredits = useCallback(
    (providerId: string, accountId: string, mode: CreditsMode) => {
      if (config === null) {
        return;
      }
      const providers = config.providers ?? [];
      const providerAt = providers.findIndex((provider) => provider.id === providerId);
      const provider = providers[providerAt];
      if (provider === undefined) {
        return;
      }
      const accounts = provider.accounts ?? [];
      const accountAt = accounts.findIndex((account) => account.id === accountId);
      const account = accounts[accountAt];
      if (account === undefined) {
        return;
      }
      const { creditsMode: _creditsMode, ...rest } = account;
      const updated = mode === "on" ? rest : { ...rest, creditsMode: mode };
      void save({
        ...config,
        providers: [
          ...providers.slice(0, providerAt),
          {
            ...provider,
            accounts: [...accounts.slice(0, accountAt), updated, ...accounts.slice(accountAt + 1)],
          },
          ...providers.slice(providerAt + 1),
        ],
      }).catch((cause: unknown) => {
        toast.error(toErrorMessage(cause));
      });
    },
    [config, save, toast],
  );
  const trendOptions = useMemo(
    () => [
      { id: "off", value: "off" as const, label: t("settings.gatewayPages.usage.quota.trendOff") },
      { id: "2d", value: "2d" as const, label: t("settings.gatewayPages.usage.quota.trend2d") },
      {
        id: "cycle",
        value: "cycle" as const,
        label: t("settings.gatewayPages.usage.quota.trendCycle"),
      },
    ],
    [t],
  );
  const trendDisplay = useMemo(() => ({ label: trendName(trend, t) }), [trend, t]);
  const changeTrend = useCallback((next: GatewayQuotaTrend) => setTrend(next), []);
  const now = Date.now();

  // A host without the quota RPC keeps the usage page; this group is the one it cannot answer.
  if (!supported) {
    return null;
  }

  let body: ReactNode;
  if (error !== null) {
    body = <Alert variant="error" description={error.message} />;
  } else if (isLoading) {
    body = (
      <View style={styles.loading}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  } else if (quota === null) {
    body = (
      <View style={[settingsStyles.card, styles.messageCard]}>
        <Text style={styles.message}>{t("settings.gatewayPages.usage.errors.disconnected")}</Text>
      </View>
    );
  } else if (quota.accounts.length === 0) {
    body = (
      <View style={[settingsStyles.card, styles.messageCard]}>
        <Text style={styles.message}>{t("settings.gatewayPages.usage.quota.empty")}</Text>
      </View>
    );
  } else {
    // A plan card has no gateway account behind it: it is drawn in its own
    // group, as myna keeps a provider's coding plan apart from its keys.
    const accounts = quota.accounts.filter((account) => !(planCards && account.kind === "plan"));
    const plans = quota.accounts.filter((account) => planCards && account.kind === "plan");
    const card = (account: GatewayQuotaAccountWire, asPlan: boolean) => {
      const credits = creditsSettings.get(`${account.provider}/${account.account}`);
      const creditsMode = asPlan || credits?.codex !== true ? null : credits.mode;
      return (
        <QuotaAccountCard
          key={account.id}
          serverId={serverId}
          account={account}
          trend={trend}
          displayAs={displayAs}
          maskAccounts={maskAccounts}
          now={now}
          onWarmed={refresh}
          creditsMode={creditsMode}
          onCreditsChange={setCredits}
          asPlan={asPlan}
          {...(onOpenProvider === undefined ? {} : { onOpenProvider })}
        />
      );
    };
    body = (
      <View style={styles.cards}>
        {accounts.map((account) => card(account, false))}
        {plans.length === 0 ? null : (
          <>
            <Text style={styles.planTitle}>{t("settings.gatewayPages.usage.quota.planTitle")}</Text>
            {plans.map((account) => card(account, true))}
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{t("settings.gatewayPages.usage.quota.title")}</Text>
        <View style={styles.trendSelect}>
          <SelectField
            label={t("settings.gatewayPages.usage.quota.trendLabel")}
            value={trend}
            selectedDisplay={trendDisplay}
            options={trendOptions}
            onChange={changeTrend}
            placeholder={t("settings.gatewayPages.usage.quota.trendLabel")}
            emptyText={t("settings.gatewayPages.usage.quota.trendLabel")}
            title={t("settings.gatewayPages.usage.quota.trendLabel")}
            size="sm"
            field={false}
            testID="gateway-quota-trend"
          />
        </View>
      </View>

      {body}
      <Text style={styles.note}>{t("settings.gatewayPages.usage.quota.note")}</Text>
    </View>
  );
}

type WarmState = "pending" | { status: number | null; error?: string };

function QuotaAccountCard({
  serverId,
  account,
  trend,
  displayAs,
  maskAccounts,
  now,
  onWarmed,
  creditsMode,
  onCreditsChange,
  asPlan,
  onOpenProvider,
}: {
  serverId: string;
  account: GatewayQuotaAccountWire;
  /** A provider plan's card: no account to mask, warm or hold credits. */
  asPlan: boolean;
  /** Opens this plan's provider editor, when the card names a provider. */
  onOpenProvider?: (providerId: string) => void;
  trend: GatewayQuotaTrend;
  displayAs: UsageDisplayAs;
  maskAccounts: boolean;
  now: number;
  onWarmed: () => void;
  /** A Codex account's mode; null for an account that holds no credits. */
  creditsMode: CreditsMode | null;
  onCreditsChange: (provider: string, account: string, mode: CreditsMode) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const client = useHostRuntimeClient(serverId);
  const [warm, setWarm] = useState<WarmState | null>(null);
  const warmUp = useCallback(async () => {
    if (client === null) {
      return;
    }
    setWarm("pending");
    try {
      const result = await client.warmGatewayAccount({
        provider: account.provider,
        account: account.account,
      });
      if (result.error !== undefined) {
        setWarm({ status: result.status, error: result.error });
        return;
      }
      if (result.status === null || result.status < 200 || result.status >= 300) {
        setWarm({ status: result.status });
        return;
      }
      setWarm({ status: result.status });
      onWarmed();
    } catch (cause) {
      setWarm({ status: null, error: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [account.account, account.provider, client, onWarmed]);

  const changeCredits = useCallback(
    (mode: CreditsMode) => onCreditsChange(account.provider, account.account, mode),
    [account.account, account.provider, onCreditsChange],
  );
  const openSettings = useCallback(
    () => onOpenProvider?.(account.providerId ?? account.provider),
    [account.provider, account.providerId, onOpenProvider],
  );
  const creditsOptions = useMemo(
    () =>
      CREDITS_MODES.map((mode) => ({
        id: mode,
        value: mode,
        label: t(`settings.gatewayPages.usage.quota.credits.${mode}`),
      })),
    [t],
  );
  const creditsDisplay = useMemo(
    () =>
      creditsMode === null
        ? null
        : { label: t(`settings.gatewayPages.usage.quota.credits.${creditsMode}`) },
    [creditsMode, t],
  );

  const name = maskAccounts && !asPlan ? maskAccount(account.accountLabel) : account.accountLabel;
  return (
    <View style={[settingsStyles.card, styles.card]}>
      <View style={styles.cardHead}>
        <Text style={styles.provider} numberOfLines={1}>
          {account.providerLabel}
        </Text>
        {account.enabled ? null : (
          <Text style={styles.tag}>{t("settings.gatewayPages.usage.quota.disabled")}</Text>
        )}
        <View style={styles.cardSpacer} />
        <Text style={styles.account} numberOfLines={1}>
          {name}
        </Text>
        {account.canWarm ? (
          <Button
            variant="ghost"
            size="sm"
            loading={warm === "pending"}
            disabled={client === null}
            onPress={warmUp}
            testID={`gateway-quota-warm-${account.id}`}
          >
            {warm === "pending"
              ? t("settings.gatewayPages.usage.quota.warming")
              : t("settings.gatewayPages.usage.quota.warm")}
          </Button>
        ) : null}
      </View>

      {warmResult(warm, t) === null ? null : (
        <Text style={warmFailed(warm) ? styles.error : styles.warmNote}>{warmResult(warm, t)}</Text>
      )}

      {account.restingUntil === null ? null : (
        <Text style={styles.tag}>
          {t("settings.gatewayPages.usage.quota.resting", {
            when: formatClock(account.restingUntil, now, locale),
          })}
        </Text>
      )}

      <View style={styles.windows}>
        {account.windows.map((window) => (
          <QuotaWindowRow
            key={window.id}
            window={window}
            displayAs={displayAs}
            locale={locale}
            now={now}
          />
        ))}
      </View>

      {account.error === undefined ? null : (
        <>
          <Text style={styles.error}>
            {asPlan ? planErrorText(account.error, t) : account.error}
          </Text>
          {asPlan && onOpenProvider !== undefined ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={openSettings}
              testID={`gateway-quota-open-settings-${account.id}`}
            >
              {t("settings.gatewayPages.usage.quota.openSettings")}
            </Button>
          ) : null}
        </>
      )}

      {creditsMode === null ? null : (
        <View style={styles.creditsRow}>
          <Text style={styles.creditsLabel}>
            {t("settings.gatewayPages.usage.quota.creditsLabel")}
          </Text>
          <SelectField
            label={t("settings.gatewayPages.usage.quota.creditsLabel")}
            value={creditsMode}
            selectedDisplay={creditsDisplay}
            options={creditsOptions}
            onChange={changeCredits}
            placeholder={t("settings.gatewayPages.usage.quota.creditsLabel")}
            emptyText={t("settings.gatewayPages.usage.quota.creditsLabel")}
            title={t("settings.gatewayPages.usage.quota.creditsLabel")}
            size="sm"
            field={false}
            testID={`gateway-quota-credits-${account.id}`}
          />
        </View>
      )}

      {trend === "off" ? null : (
        <QuotaCurve account={account} trend={trend} now={now} locale={locale} />
      )}

      <View style={styles.cardFoot}>
        <Text style={styles.footText} numberOfLines={1}>
          {account.lastReadAt === null
            ? t("settings.gatewayPages.usage.quota.neverRead")
            : t("settings.gatewayPages.usage.quota.updated", {
                when: formatClock(account.lastReadAt, now, locale),
              })}
          {account.monthlyUsdCap === null
            ? ""
            : ` · ${t("settings.gatewayPages.usage.quota.cap", {
                cap: formatUsd(account.monthlyUsdCap, locale),
              })}`}
          {account.warmup ? ` · ${t("settings.gatewayPages.usage.quota.warmOn")}` : ""}
        </Text>
      </View>
    </View>
  );
}

/**
 * A plan card's failure in the reader's language, as myna words it: the
 * server's reason is the raw one, told apart by the key fields it names.
 */
function planErrorText(
  error: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (/SecretId and SecretKey/i.test(error)) {
    return t("settings.gatewayPages.usage.quota.planNeedsSecretId");
  }
  if (/AccessKey ID and Secret/i.test(error)) {
    return t("settings.gatewayPages.usage.quota.planNeedsAccessKey");
  }
  return error;
}

function warmFailed(warm: WarmState | null): boolean {
  if (warm === null || warm === "pending") {
    return false;
  }
  if (warm.error !== undefined) {
    return true;
  }
  return warm.status === null || warm.status < 200 || warm.status >= 300;
}

function warmResult(
  warm: WarmState | null,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (warm === null || warm === "pending") {
    return null;
  }
  if (!warmFailed(warm)) {
    return t("settings.gatewayPages.usage.quota.warmed");
  }
  if (warm.error !== undefined) {
    return warm.error;
  }
  if (warm.status === null) {
    return t("settings.gatewayPages.usage.quota.warmFailedUnknown");
  }
  return t("settings.gatewayPages.usage.quota.warmFailed", { status: String(warm.status) });
}

function QuotaWindowRow({
  window,
  displayAs,
  locale,
  now,
}: {
  window: GatewayQuotaWindowWire;
  displayAs: UsageDisplayAs;
  locale: string | undefined;
  now: number;
}) {
  const { t } = useTranslation();
  const used = window.usedPercent === null ? null : clamp(window.usedPercent);
  const fill = meterFill(used, displayAs);
  const pace = window.pacePct === null ? null : Math.round(window.pacePct);
  const whole = quotaWhole(window, locale, t);
  const share = shareText(used, displayAs, t);

  return (
    <View style={styles.window}>
      <View style={styles.windowLabels}>
        <Text style={styles.windowName}>{windowName(window, t)}</Text>
        <Text style={styles.windowShare} numberOfLines={1}>
          {whole === null ? share : `${whole} · ${share}`}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${fill}%` }, paceStyle(pace)]} />
      </View>
      <View style={styles.windowFoot}>
        {window.resetsAt === null ? (
          <Text style={styles.reset}>{rollingText(window, t, locale)}</Text>
        ) : (
          <Text style={styles.reset} numberOfLines={1}>
            {t("settings.gatewayPages.usage.quota.resets", {
              when: formatClock(window.resetsAt, now, locale),
            })}
            {window.resetsAt <= now
              ? ""
              : ` · ${t("settings.gatewayPages.usage.quota.resetsIn", {
                  when: formatUntil(window.resetsAt, now, locale),
                })}`}
          </Text>
        )}
        {pace === null ? null : (
          <Text style={pace > 0 ? styles.paceOver : styles.paceUnder}>
            {t("settings.gatewayPages.usage.quota.pace", { n: paceNumber(pace) })}
          </Text>
        )}
      </View>
      <WindowHolds window={window} locale={locale} t={t} />
    </View>
  );
}

/** What the whole window holds, or why it can't be told. */
function WindowHolds({
  window,
  locale,
  t,
}: {
  window: GatewayQuotaWindowWire;
  locale: string | undefined;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (window.holds !== undefined) {
    const cost = window.holds.priced
      ? ` · ${t("settings.gatewayPages.usage.quota.wholeCost", {
          cost: formatUsd(window.holds.costUsd, locale),
        })}`
      : "";
    return (
      <Text style={styles.holds} numberOfLines={1}>
        {t("settings.gatewayPages.usage.quota.whole", {
          tokens: formatCompact(window.holds.tokens, locale),
        })}
        {cost}
      </Text>
    );
  }
  if (window.holdsWhy === undefined) {
    return null;
  }
  return <Text style={styles.holdsWhy}>{holdsWhyText(window.holdsWhy, t)}</Text>;
}

function holdsWhyText(why: GatewayQuotaWindowWire["holdsWhy"], t: (key: string) => string): string {
  switch (why) {
    case "low":
      return t("settings.gatewayPages.usage.quota.holds.low");
    case "clock":
      return t("settings.gatewayPages.usage.quota.holds.clock");
    case "none":
      return t("settings.gatewayPages.usage.quota.holds.none");
    case "log":
      return t("settings.gatewayPages.usage.quota.holds.log");
    default:
      return "";
  }
}

function trendName(trend: GatewayQuotaTrend, t: (key: string) => string): string {
  switch (trend) {
    case "off":
      return t("settings.gatewayPages.usage.quota.trendOff");
    case "2d":
      return t("settings.gatewayPages.usage.quota.trend2d");
    case "cycle":
      return t("settings.gatewayPages.usage.quota.trendCycle");
  }
}

function meterFill(used: number | null, displayAs: UsageDisplayAs): number {
  if (used === null) {
    return 0;
  }
  return displayAs === "remaining" ? 100 - used : used;
}

function shareText(
  used: number | null,
  displayAs: UsageDisplayAs,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (used === null) {
    return t("settings.gatewayPages.usage.quota.noReading");
  }
  if (displayAs === "remaining") {
    return t("settings.gatewayPages.usage.quota.left", { n: Math.round(100 - used) });
  }
  return t("settings.gatewayPages.usage.quota.used", { n: Math.round(used) });
}

/** The window's whole, in the vendor's own amounts: what is left of what it holds. */
function quotaWhole(
  window: GatewayQuotaWindowWire,
  locale: string | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (window.remaining === null || window.limit === null) {
    return null;
  }
  if (window.kind === "allowance") {
    return `${formatAmount(window.remaining, locale)} / ${formatAmount(window.limit, locale)}`;
  }
  return t("settings.gatewayPages.usage.quota.wholeTokens", {
    left: formatCompact(window.remaining, locale),
    limit: formatCompact(window.limit, locale),
  });
}

function formatAmount(value: number, locale: string | undefined): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}

function windowName(window: GatewayQuotaWindowWire, t: (key: string) => string): string {
  // A plan's control plane names its own windows ("5 hours", "Weekly").
  if (window.name !== undefined && window.name.length > 0) {
    return window.name;
  }
  switch (window.kind) {
    case "allowance":
      return t("settings.gatewayPages.usage.quota.window.allowance");
    case "tokens5h":
      return t("settings.gatewayPages.usage.quota.window.tokens5h");
    case "tokens7d":
      return t("settings.gatewayPages.usage.quota.window.tokens7d");
  }
}

function rollingText(
  window: GatewayQuotaWindowWire,
  t: (key: string, options?: Record<string, unknown>) => string,
  locale: string | undefined,
): string {
  if (window.windowMs === undefined) {
    return t("settings.gatewayPages.usage.quota.rolling");
  }
  const hours = Math.round(window.windowMs / (60 * 60_000));
  return t("settings.gatewayPages.usage.quota.rollingFor", {
    span: new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "hour",
      unitDisplay: "short",
    }).format(hours),
  });
}

function paceNumber(pace: number): string {
  if (pace === 0) {
    return "±0%";
  }
  return `${pace > 0 ? "+" : "−"}${Math.abs(pace)}%`;
}

interface CurveLine {
  id: string;
  label: string;
  points: GatewayQuotaPointWire[];
  series: number;
  /** Where the window began, for the axis and the even burn. */
  start: number;
  /** When the allowance window starts again; null for a rolling one. */
  resetsAt: number | null;
  usedPercent: number | null;
}

/**
 * The lines a card draws: the allowance window over the readings the poller
 * kept, and each token cap over the calls the ledger replayed. An account
 * with two readings is the least a curve can say.
 */
function curveLines(
  account: GatewayQuotaAccountWire,
  trend: GatewayQuotaTrend,
  now: number,
  t: (key: string) => string,
): CurveLine[] {
  const lines: CurveLine[] = [];
  account.windows.forEach((window, index) => {
    const source = window.kind === "allowance" ? account.history : (window.history ?? []);
    const points = trimCurve(source, window.windowMs, trend, now);
    if (points.length < 2) {
      return;
    }
    lines.push({
      id: window.id,
      label: windowName(window, t),
      points,
      series: index,
      start: lineStart(points, window.windowMs, trend, now),
      resetsAt: window.resetsAt,
      usedPercent: points.at(-1)?.usedPercent ?? null,
    });
  });
  return lines;
}

function trimCurve(
  points: readonly GatewayQuotaPointWire[],
  windowMs: number | undefined,
  trend: GatewayQuotaTrend,
  now: number,
): GatewayQuotaPointWire[] {
  if (trend === "2d") {
    return points.filter((point) => point.at >= now - TWO_DAYS_MS);
  }
  if (windowMs !== undefined) {
    return points.filter((point) => point.at >= now - windowMs);
  }
  const last = points.at(-1);
  if (last === undefined || last.resetsAt === null) {
    return [...points];
  }
  const out: GatewayQuotaPointWire[] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.resetsAt === null || Math.abs(point.resetsAt - last.resetsAt) > RESET_DRIFT_MS) {
      break;
    }
    out.push(point);
  }
  return out.toReversed();
}

function lineStart(
  points: readonly GatewayQuotaPointWire[],
  windowMs: number | undefined,
  trend: GatewayQuotaTrend,
  now: number,
): number {
  if (trend === "2d") {
    return now - TWO_DAYS_MS;
  }
  if (windowMs !== undefined) {
    return now - windowMs;
  }
  return points[0]?.at ?? now;
}

function QuotaCurve({
  account,
  trend,
  now,
  locale,
}: {
  account: GatewayQuotaAccountWire;
  trend: GatewayQuotaTrend;
  now: number;
  locale: string | undefined;
}) {
  const { t } = useTranslation();
  const lines = curveLines(account, trend, now, t);
  if (lines.length === 0) {
    return (
      <View style={styles.curve}>
        <Text style={styles.curveHead}>{t("settings.gatewayPages.usage.quota.leftOverTime")}</Text>
        <Text style={styles.curveEmpty}>{t("settings.gatewayPages.usage.quota.noCurve")}</Text>
      </View>
    );
  }
  const x0 = Math.min(...lines.map((line) => line.start));
  const resets = lines.map((line) => line.resetsAt ?? 0);
  const x1 = Math.max(now, ...resets);
  const end = x1 > x0 ? x1 : x0 + 3_600_000;
  return (
    <View style={styles.curve}>
      <View style={styles.curveLabels}>
        <Text style={styles.curveHead}>{t("settings.gatewayPages.usage.quota.leftOverTime")}</Text>
      </View>
      <ThemedCurve
        lines={lines.map((line) => ({
          series: line.series,
          points: curveGeometry(line.points, x0, end),
        }))}
        even={evenBurn(lines, x0, end)}
        uniProps={CURVE_COLORS}
      />
      <View style={styles.curveAxis}>
        <Text style={styles.axisText}>{formatClock(x0, now, locale)}</Text>
        <Text style={styles.axisText}>{formatClock(end, now, locale)}</Text>
      </View>
      <View style={styles.legend}>
        {lines.map((line) => (
          <View key={line.id} style={styles.legendItem}>
            <View style={[styles.swatch, swatchStyle(line.series)]} />
            <Text style={styles.legendName} numberOfLines={1}>
              {line.label}
            </Text>
            <Text style={styles.legendValue}>{leftText(line.usedPercent)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function leftText(usedPercent: number | null): string {
  if (usedPercent === null) {
    return "—";
  }
  return `${Math.round(100 - clamp(usedPercent))}%`;
}

function curveGeometry(points: readonly GatewayQuotaPointWire[], x0: number, x1: number): string {
  const parts: string[] = [];
  for (const point of points) {
    if (point.usedPercent === null) {
      continue;
    }
    const x = ((point.at - x0) / (x1 - x0)) * CURVE_WIDTH;
    const y = (clamp(point.usedPercent) / 100) * CURVE_HEIGHT;
    parts.push(`${clampRange(x, 0, CURVE_WIDTH).toFixed(1)},${y.toFixed(1)}`);
  }
  return parts.join(" ");
}

/**
 * An even burn runs from everything left at the window's start (the top) to
 * nothing at its reset (the foot). A rolling window has no reset, so none.
 */
function evenBurn(
  lines: readonly CurveLine[],
  x0: number,
  x1: number,
): { from: number; to: number } | null {
  for (const line of lines) {
    if (line.resetsAt === null || line.resetsAt <= x0) {
      continue;
    }
    return {
      from: clampRange(((line.start - x0) / (x1 - x0)) * CURVE_WIDTH, 0, CURVE_WIDTH),
      to: clampRange(
        ((Math.min(line.resetsAt, x1) - x0) / (x1 - x0)) * CURVE_WIDTH,
        0,
        CURVE_WIDTH,
      ),
    };
  }
  return null;
}

function CurveSvg({
  lines,
  even,
  series1,
  series2,
  series3,
  evenColor,
  gridColor,
}: {
  lines: { series: number; points: string }[];
  even: { from: number; to: number } | null;
  series1: string;
  series2: string;
  series3: string;
  evenColor: string;
  gridColor: string;
}) {
  const colors = [series1, series2, series3];
  return (
    <Svg
      width="100%"
      height={CURVE_HEIGHT}
      viewBox={`0 0 ${CURVE_WIDTH} ${CURVE_HEIGHT}`}
      preserveAspectRatio="none"
    >
      {[0, 0.5, 1].map((fraction) => (
        <Line
          key={fraction}
          x1={0}
          x2={CURVE_WIDTH}
          y1={CURVE_HEIGHT * fraction}
          y2={CURVE_HEIGHT * fraction}
          stroke={gridColor}
          strokeWidth={1}
        />
      ))}
      {even === null ? null : (
        <Line
          x1={even.from}
          y1={0}
          x2={even.to}
          y2={CURVE_HEIGHT}
          stroke={evenColor}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      )}
      {lines.map((line) => (
        <Polyline
          key={line.series}
          points={line.points}
          fill="none"
          stroke={colors[line.series % colors.length]}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );
}

const ThemedCurve = withUnistyles(CurveSvg);

const CURVE_COLORS = (theme: Theme) => ({
  series1: theme.colors.accent,
  series2: theme.colors.palette.green[400],
  series3: theme.colors.palette.purple[500],
  evenColor: theme.colors.foregroundExtraMuted,
  gridColor: theme.colors.border,
});

function swatchStyle(series: number) {
  if (series % 3 === 1) {
    return styles.swatch2;
  }
  if (series % 3 === 2) {
    return styles.swatch3;
  }
  return styles.swatch1;
}

function clamp(value: number): number {
  return clampRange(value, 0, 100);
}

function clampRange(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function paceStyle(pace: number | null) {
  if (pace === null || pace <= 0) {
    return null;
  }
  return styles.fillOver;
}

/** A reset or reading on the reader's clock: the time today, the day too before that. */
function formatClock(at: number, now: number, locale: string | undefined): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date(now).toDateString();
  return date.toLocaleString(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatUntil(at: number, now: number, locale: string | undefined): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (minutes < 60) {
    return relative.format(minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return relative.format(hours, "hour");
  }
  return relative.format(Math.round(hours / 24), "day");
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[3],
  },
  sectionHead: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    justifyContent: "space-between",
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  trendSelect: {
    minWidth: 128,
  },
  cards: {
    gap: theme.spacing[3],
  },
  planTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  cardHead: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  cardSpacer: {
    flex: 1,
  },
  provider: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  account: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    maxWidth: 220,
  },
  tag: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  windows: {
    gap: theme.spacing[3],
  },
  window: {
    gap: theme.spacing[1],
  },
  windowLabels: {
    alignItems: "baseline",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  windowName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  windowShare: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  track: {
    backgroundColor: theme.colors.surface3,
    borderRadius: 3,
    height: 6,
    overflow: "hidden",
  },
  fill: {
    backgroundColor: theme.colors.accent,
    borderRadius: 3,
    height: "100%",
  },
  fillOver: {
    backgroundColor: theme.colors.statusWarning,
  },
  windowFoot: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  reset: {
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  paceOver: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  paceUnder: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  holds: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  holdsWhy: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  curve: {
    borderTopColor: theme.colors.border,
    borderTopWidth: 1,
    gap: theme.spacing[1],
    paddingTop: theme.spacing[3],
  },
  curveLabels: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  curveHead: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  curveEmpty: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  curveAxis: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  axisText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginTop: theme.spacing[1],
  },
  legendItem: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[1.5],
  },
  swatch: {
    borderRadius: 2,
    height: 6,
    width: 6,
  },
  swatch1: {
    backgroundColor: theme.colors.accent,
  },
  swatch2: {
    backgroundColor: theme.colors.palette.green[400],
  },
  swatch3: {
    backgroundColor: theme.colors.palette.purple[500],
  },
  legendName: {
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
  },
  legendValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  cardFoot: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  creditsRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  creditsLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  footText: {
    color: theme.colors.foregroundExtraMuted,
    flex: 1,
    fontSize: theme.fontSize.sm,
  },
  warmNote: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  messageCard: {
    padding: theme.spacing[4],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  loading: {
    alignItems: "center",
    padding: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  note: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
}));
