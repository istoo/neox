/* eslint-disable react-perf/jsx-no-new-function-as-prop -- settings page: a handful of callbacks, none in a hot list. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import type {
  GatewayMaskingPreviewWire,
  GatewayMaskingRecordWire,
  GatewayMaskingSummaryWire,
} from "@neolix/protocol/gateway";
import { useFetchQuery } from "@/data/query";
import { useGatewayMode } from "@/screens/settings/app/gateway-mode";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { isWeb } from "@/constants/platform";
import { confirmDialog } from "@/utils/confirm-dialog";
import { MaskingSummaryCard } from "./masking-summary";
import { MaskingRecordsCard, type MaskRecordMode } from "./masking-records";
import { MaskingRulesCard } from "./masking-rules";
import { MaskingLocalModelCard, MaskingPreviewCard } from "./masking-preview";
import { MASK_SECRET_KINDS, mergeMaskingFirstPage, type MaskFacet } from "./masking-shared";
import type { GatewayPageProps } from "./types";

const DAYS_STORAGE_KEY = "neolix.gatewayMaskingDays";
const PAGE_SIZE = 40;
const REFRESH_MS = 15_000;

/** Puts a record a notification opened on in time order, newest first. */
function insertRecord(
  current: GatewayMaskingRecordWire[],
  record: GatewayMaskingRecordWire,
): GatewayMaskingRecordWire[] {
  if (current.some((entry) => entry.key === record.key)) {
    return current;
  }
  const at = current.findIndex((entry) => Number(entry.key) < Number(record.key));
  const next = [...current];
  next.splice(at === -1 ? next.length : at, 0, record);
  return next;
}

function storedDays(): 7 | 30 {
  if (!isWeb) {
    return 7;
  }
  try {
    return window.localStorage.getItem(DAYS_STORAGE_KEY) === "30" ? 30 : 7;
  } catch {
    return 7;
  }
}

/**
 * myna's Insights › Masking: what masking kept from vendors, request by
 * request and value by value, with the rules that decide it. Neolix has no
 * local model, so that facet is absent rather than always zero.
 */
export function GatewayMaskingPage({
  serverId,
  config,
  edit,
  apply,
  focusRecord,
}: GatewayPageProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const gatewayMode = useGatewayMode(serverId);
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "gatewayMaskingRecords");
  const [days, setDays] = useState<7 | 30>(storedDays);
  const [actionError, setActionError] = useState("");

  // The two switches this page can turn off; the user's own words mask on
  // their own and are not cleared by it.
  const maskingOn = config.masking?.enabled === true || config.masking?.personal === true;

  const summaryQuery = useFetchQuery({
    queryKey: ["gateway-masking-summary", serverId, days] as const,
    queryFn: async (): Promise<GatewayMaskingSummaryWire> => {
      if (client === null) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.getGatewayMaskingSummary(days);
      return result.summary;
    },
    enabled: supported && client !== null && connected,
    dataShape: "value",
    staleTimeMs: 10_000,
    refetchInterval: REFRESH_MS,
  });

  const refetchSummary = summaryQuery.refetch;
  const [mode, setMode] = useState<MaskRecordMode>("req");
  const [facet, setFacet] = useState<MaskFacet>("");
  const [kind, setKind] = useState("");
  const [agent, setAgent] = useState("");
  const [provider, setProvider] = useState("");
  const [records, setRecords] = useState<GatewayMaskingRecordWire[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [read, setRead] = useState(false);
  const [recordsError, setRecordsError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [focused, setFocused] = useState<GatewayMaskingRecordWire | null>(null);
  const sequence = useRef(0);

  const query = useMemo(() => {
    let kinds: string[] | undefined;
    if (kind !== "") {
      kinds = [kind];
    } else if (facet === "secret") {
      kinds = [...MASK_SECRET_KINDS];
    }
    return {
      ...(kinds === undefined ? {} : { kind: kinds }),
      ...(facet === "rule" ? { by: "rule" as const } : {}),
      ...(facet === "blocked" ? { blocked: true } : {}),
      ...(agent === "" ? {} : { agent }),
      ...(provider === "" ? {} : { provider }),
    };
  }, [agent, facet, kind, provider]);

  const loadRecords = useCallback(
    async (before: string | undefined, mergeFirst: boolean) => {
      if (client === null || !supported) {
        return;
      }
      const ticket = sequence.current + 1;
      sequence.current = ticket;
      setBusy(true);
      setRecordsError("");
      try {
        const page = await client.getGatewayMaskingRecords({
          limit: PAGE_SIZE,
          ...query,
          ...(before === undefined ? {} : { before }),
        });
        if (sequence.current !== ticket) {
          return;
        }
        setRecords((current) => {
          if (before !== undefined) {
            return [...current, ...page.records];
          }
          return mergeFirst ? mergeMaskingFirstPage(current, page.records) : page.records;
        });
        if (before !== undefined || !mergeFirst) {
          setMore(page.more);
        }
        setRead(true);
      } catch (cause) {
        if (sequence.current === ticket) {
          setRecordsError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (sequence.current === ticket) {
          setBusy(false);
          setRead(true);
        }
      }
    },
    [client, query, supported],
  );

  const fetchRecords = useCallback((before?: string) => loadRecords(before, false), [loadRecords]);
  const refreshRecords = useCallback(() => loadRecords(undefined, true), [loadRecords]);

  useEffect(() => {
    setExpanded("");
    void fetchRecords();
  }, [fetchRecords]);

  useEffect(() => {
    if (!connected) {
      return undefined;
    }
    const timer = setInterval(() => {
      void refreshRecords();
      void refetchSummary();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [connected, refreshRecords, refetchSummary]);

  const clearFocusParam = useCallback(() => {
    router.setParams({ record: "" });
    if (!isWeb || typeof window === "undefined") {
      return;
    }
    // Expo commits the incoming browser URL after setParams; strip the
    // consumed key afterwards so a reload does not replay it.
    window.setTimeout(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("record")) {
        return;
      }
      url.searchParams.delete("record");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }, 0);
  }, [router]);

  // myna's maskOneOpen (redact/page.js:637): a notification opens its record,
  // fetched on its own when the first page of records does not hold it.
  useEffect(() => {
    if (focusRecord === undefined || client === null || !supported) {
      return undefined;
    }
    let cancelled = false;
    setExpanded(focusRecord);
    client.getGatewayMaskingRecord(focusRecord).then(
      (payload) => {
        if (!cancelled && payload.record !== null) {
          setFocused(payload.record);
        }
        if (!cancelled) {
          clearFocusParam();
        }
        return undefined;
      },
      () => {
        if (!cancelled) {
          clearFocusParam();
        }
        return undefined;
      },
    );
    return () => {
      cancelled = true;
    };
  }, [focusRecord, client, supported, clearFocusParam]);

  const onDays = useCallback((next: 7 | 30) => {
    setDays(next);
    if (!isWeb) {
      return;
    }
    try {
      window.localStorage.setItem(DAYS_STORAGE_KEY, String(next));
    } catch {
      // A browser that refuses storage still masks; only the preference is lost.
    }
  }, []);

  const toggle = useCallback(() => {
    setActionError("");
    void apply((next) => {
      // Off turns both switches off: leaving Mask personal data on would keep
      // masking while the page says it is off.
      const on = next.masking?.enabled === true || next.masking?.personal === true;
      next.masking = {
        ...next.masking,
        enabled: !on,
        personal: on ? false : (next.masking?.personal ?? false),
        allow: next.masking?.allow ?? [],
      };
    }).catch((cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [apply]);

  const onFacet = useCallback((next: MaskFacet) => {
    setFacet(next);
    setKind("");
  }, []);

  const onKind = useCallback((next: string) => {
    setKind(next);
    setFacet("");
  }, []);

  const onAgent = useCallback((next: string) => {
    setAgent(next);
  }, []);

  const onProvider = useCallback((next: string) => {
    setProvider(next);
  }, []);

  const onExpand = useCallback((key: string) => {
    setExpanded((current) => (current === key ? "" : key));
  }, []);

  const onLoadMore = useCallback(() => {
    const last = records.at(-1);
    void fetchRecords(last?.key);
  }, [fetchRecords, records]);

  const onClear = useCallback(async () => {
    const ok = await confirmDialog({
      title: t("settings.gatewayPages.masking.clearTitle"),
      message: t("settings.gatewayPages.masking.clearMessage"),
      confirmLabel: t("settings.gatewayPages.masking.clearConfirm"),
      cancelLabel: t("settings.gatewayPages.masking.cancel"),
      destructive: true,
    });
    if (!ok || client === null) {
      return;
    }
    try {
      await client.clearGatewayMaskingRecords();
      setRecords([]);
      setMore(false);
      setExpanded("");
      setFocused(null);
      await refetchSummary();
    } catch (cause) {
      setRecordsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, refetchSummary, t]);

  const [previewText, setPreviewText] = useState("");
  const [preview, setPreview] = useState<GatewayMaskingPreviewWire | null>(null);
  const [previewError, setPreviewError] = useState("");
  useEffect(() => {
    if (client === null || !supported || previewText.trim().length === 0) {
      setPreview(null);
      setPreviewError("");
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      client.previewGatewayMasking(previewText).then(
        (result) => {
          if (!cancelled) {
            setPreview(result.preview);
            setPreviewError("");
          }
          return undefined;
        },
        (cause: unknown) => {
          if (!cancelled) {
            setPreview(null);
            setPreviewError(cause instanceof Error ? cause.message : String(cause));
          }
          return undefined;
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, previewText, supported]);

  const summaryError = summaryQuery.error ?? (actionError === "" ? null : new Error(actionError));
  // A record opened from a notification stays listed even when it falls
  // outside the first page the filters fetch.
  const shownRecords = useMemo(
    () => (focused === null ? records : insertRecord(records, focused)),
    [focused, records],
  );

  if (!supported) {
    return (
      <View style={settingsStyles.section}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.gatewayPages.masking.updateHost")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.gatewayPages.masking.updateHostHint")}
              </Text>
            </View>
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={settingsStyles.section}>
      <MaskingSummaryCard
        summary={summaryQuery.data ?? null}
        loading={summaryQuery.isLoading}
        error={summaryError}
        days={days}
        maskingOn={maskingOn}
        onDays={onDays}
        onToggle={toggle}
        selectedAgent={agent}
        selectedProvider={provider}
        onPickAgent={setAgent}
        onPickProvider={setProvider}
      />
      <MaskingRecordsCard
        summary={summaryQuery.data ?? null}
        records={shownRecords}
        more={more}
        busy={busy}
        error={recordsError}
        read={read}
        mode={mode}
        facet={facet}
        kind={kind}
        agent={agent}
        provider={provider}
        expanded={expanded}
        onMode={setMode}
        onFacet={onFacet}
        onKind={onKind}
        onAgent={onAgent}
        onProvider={onProvider}
        onLoadMore={onLoadMore}
        onClear={onClear}
        onExpand={onExpand}
      />
      <MaskingRulesCard config={config} edit={edit} apply={apply} hideAlert={gatewayMode.enabled} />
      <MaskingPreviewCard
        text={previewText}
        preview={preview}
        error={previewError}
        onChangeText={setPreviewText}
      />
      <MaskingLocalModelCard serverId={serverId} config={config} apply={apply} />
    </View>
  );
}
