/* eslint-disable react/no-array-index-key, react-perf/jsx-no-new-function-as-prop, complexity -- settings cards: segments have no id but their place, a handful of callbacks, and one state per row. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  GatewayConfigWire,
  GatewayMaskingLocalModelStatusWire,
  GatewayMaskingPreviewWire,
} from "@neolix/protocol/gateway";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { formatCount, kindColorIndex, maskShape } from "./masking-shared";

const PLACEHOLDER = /\{\{[^{}\s]{1,64}\}\}/g;

interface MaskingPreviewProps {
  text: string;
  preview: GatewayMaskingPreviewWire | null;
  error: string;
  onChangeText: (text: string) => void;
}

/** Text typed here is masked as a request would be, and kept nowhere. */
export function MaskingPreviewCard({ text, preview, error, onChangeText }: MaskingPreviewProps) {
  const { t } = useTranslation();
  const ranking = (preview?.hits ?? []).map((hit) => ({ name: hit.kind }));
  return (
    <SettingsSection
      title={t("settings.gatewayPages.masking.previewTitle")}
      info={t("settings.gatewayPages.masking.previewHint")}
      testID="gateway-masking-preview"
    >
      <View style={settingsStyles.card}>
        <View style={styles.input}>
          <Field label={t("settings.gatewayPages.masking.previewLabel")}>
            <FormTextInput
              initialValue=""
              resetKey="gateway-masking-preview"
              placeholder={t("settings.gatewayPages.masking.previewPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              onChangeText={onChangeText}
            />
          </Field>
        </View>
        {error !== "" ? <Text style={styles.error}>{error}</Text> : null}
        {text.trim().length > 0 ? <PreviewOutput preview={preview} ranking={ranking} /> : null}
      </View>
    </SettingsSection>
  );
}

function PreviewOutput({
  preview,
  ranking,
}: {
  preview: GatewayMaskingPreviewWire | null;
  ranking: readonly { name: string }[];
}) {
  const { t } = useTranslation();
  if (preview === null) {
    return null;
  }
  const counts = new Map<string, number>();
  const first = new Map<string, (typeof preview.hits)[number]>();
  for (const hit of preview.hits) {
    counts.set(hit.placeholder, (counts.get(hit.placeholder) ?? 0) + 1);
    if (!first.has(hit.placeholder)) {
      first.set(hit.placeholder, hit);
    }
  }
  const unique = [...first.values()];
  return (
    <View style={styles.output}>
      <Text style={styles.outputLabel}>{t("settings.gatewayPages.masking.vendorWouldGet")}</Text>
      {preview.blocked ? (
        <Text style={styles.blocked}>{t("settings.gatewayPages.masking.wouldBeHeldBack")}</Text>
      ) : null}
      <Text style={styles.text}>{renderMaskedText(preview.text)}</Text>
      {unique.length === 0 ? (
        <Text style={styles.note}>{t("settings.gatewayPages.masking.nothingWouldMask")}</Text>
      ) : (
        <View style={styles.hitList}>
          {unique.map((hit) => (
            <View key={hit.placeholder} style={styles.hit}>
              <KindDot kind={hit.kind} ranking={ranking} />
              <Text style={styles.hitKind}>
                {t(`settings.gatewayPages.masking.kind.${hit.kind}`, { defaultValue: hit.kind })}
              </Text>
              <Text style={styles.hitShape}>{maskShape(hit.head, hit.len)}</Text>
              <Text style={styles.hitBy}>{finderLabel(t, hit.by)}</Text>
              <Text style={[styles.hitAction, actionStyle(hit.action)]}>
                {actionLabel(t, hit.action)}
              </Text>
              <Text style={styles.hitN}>×{formatCount(counts.get(hit.placeholder) ?? 1)}</Text>
            </View>
          ))}
        </View>
      )}
      {preview.off ? (
        <Text style={styles.note}>{t("settings.gatewayPages.masking.previewOff")}</Text>
      ) : null}
    </View>
  );
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

function actionLabel(t: TFunction, action: string | undefined) {
  if (action === "block") {
    return t("settings.gatewayPages.masking.heldBack");
  }
  if (action === "warn") {
    return t("settings.gatewayPages.masking.sentAsWritten");
  }
  return t("settings.gatewayPages.masking.masked");
}

function actionStyle(action: string | undefined) {
  if (action === "block") {
    return styles.hitBlock;
  }
  if (action === "warn") {
    return styles.hitWarn;
  }
  return null;
}

function renderMaskedText(text: string) {
  const parts = text.split(PLACEHOLDER);
  const marks = text.match(PLACEHOLDER) ?? [];
  return parts.map((part, index) => (
    <Text key={`${index}-${part.slice(0, 8)}`}>
      {part}
      {marks[index] !== undefined ? <Text style={styles.placeholder}>{marks[index]}</Text> : null}
    </Text>
  ));
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

/** AstrLink Guard: the switch, its files and its download, and the threshold. */
export function MaskingLocalModelCard({
  serverId,
  config,
  apply,
}: {
  serverId: string;
  config: GatewayConfigWire;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "gatewayMaskingLocalModel");
  const [status, setStatus] = useState<GatewayMaskingLocalModelStatusWire | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const on = config.masking?.model === "astrlink-guard";
  const score = config.masking?.modelScore ?? 0.8;

  const refresh = useCallback(async () => {
    if (client === null) {
      return;
    }
    try {
      const result = await client.getGatewayMaskingLocalModelStatus();
      setStatus(result.status);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  useEffect(() => {
    if (!supported || client === null || !connected) {
      return undefined;
    }
    void refresh();
    return undefined;
  }, [client, connected, refresh, supported]);

  useEffect(() => {
    if (status?.downloading !== true || client === null) {
      return undefined;
    }
    const timer = setInterval(() => {
      void refresh();
    }, 1_000);
    return () => clearInterval(timer);
  }, [client, refresh, status?.downloading]);

  const onToggle = useCallback(
    (value: boolean) => {
      setError("");
      void apply((next) => {
        next.masking = {
          ...next.masking,
          enabled: next.masking?.enabled ?? true,
          allow: next.masking?.allow ?? [],
          model: value ? "astrlink-guard" : "",
        };
      })
        .then(() => {
          // myna starts the download when the model is turned on; until it is
          // here, requests the model would read are held back.
          if (
            value &&
            client !== null &&
            status?.installed === false &&
            status.downloading !== true
          ) {
            void client
              .downloadGatewayMaskingLocalModel()
              .then((result) => {
                setStatus(result.status);
                return undefined;
              })
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : String(cause));
              });
          }
          return undefined;
        })
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        });
    },
    [apply, client, status],
  );

  const onScore = useCallback(
    (value: string) => {
      void apply((next) => {
        next.masking = {
          ...next.masking,
          enabled: next.masking?.enabled ?? true,
          allow: next.masking?.allow ?? [],
          modelScore: Number(value),
        };
      }).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [apply],
  );

  const download = useCallback(async () => {
    if (client === null) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await client.downloadGatewayMaskingLocalModel();
      setStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const cancel = useCallback(async () => {
    if (client === null) {
      return;
    }
    try {
      const result = await client.cancelGatewayMaskingLocalModelDownload();
      setStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client]);

  const remove = useCallback(async () => {
    if (client === null) {
      return;
    }
    const ok = await confirmDialog({
      title: t("settings.gatewayPages.masking.localModelRemoveTitle"),
      message: t("settings.gatewayPages.masking.localModelRemoveMessage"),
      confirmLabel: t("settings.gatewayPages.masking.remove"),
      cancelLabel: t("settings.gatewayPages.masking.cancel"),
      destructive: true,
    });
    if (!ok) {
      return;
    }
    try {
      const result = await client.removeGatewayMaskingLocalModel();
      setStatus(result.status);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [client, t]);

  if (!supported) {
    return (
      <SettingsSection
        title={t("settings.gatewayPages.masking.localModelTitle")}
        testID="gateway-masking-local-model"
      >
        <View style={settingsStyles.card}>
          <View style={styles.localRow}>
            <Text style={styles.localHint}>
              {t("settings.gatewayPages.masking.localModelUnsupported")}
            </Text>
          </View>
        </View>
      </SettingsSection>
    );
  }

  const size = status === null ? "" : formatSize(status.size);
  const percent =
    status !== null && (status.total ?? 0) > 0
      ? Math.min(100, Math.round(((status.done ?? 0) / (status.total ?? 1)) * 100))
      : 0;
  let modelStatus = t("settings.gatewayPages.masking.loading");
  if (status !== null) {
    modelStatus = status.installed
      ? t("settings.gatewayPages.masking.localModelInstalled", { size })
      : t("settings.gatewayPages.masking.localModelNotInstalled", { size });
  }
  let action: ReactNode;
  if (status?.downloading === true) {
    action = (
      <Button variant="outline" onPress={() => void cancel()}>
        {t("settings.gatewayPages.masking.cancel")}
      </Button>
    );
  } else if (status?.installed === true) {
    action = (
      <Button variant="ghost" onPress={() => void remove()}>
        {t("settings.gatewayPages.masking.remove")}
      </Button>
    );
  } else {
    action = (
      <Button
        variant="secondary"
        loading={busy}
        disabled={status === null || status.supported === false}
        onPress={() => void download()}
      >
        {t("settings.gatewayPages.masking.localModelDownload")}
      </Button>
    );
  }

  return (
    <SettingsSection
      title={t("settings.gatewayPages.masking.localModelTitle")}
      info={t("settings.gatewayPages.masking.localModelHint")}
      testID="gateway-masking-local-model"
    >
      <View style={settingsStyles.card}>
        <View style={styles.localRow}>
          <View style={styles.localMain}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.gatewayPages.masking.localModelRow")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t(
                on
                  ? "settings.gatewayPages.masking.localModelOnHint"
                  : "settings.gatewayPages.masking.localModelOffHint",
              )}
            </Text>
          </View>
          <Switch value={on} onValueChange={onToggle} disabled={status?.supported === false} />
        </View>
        <View style={[styles.localRow, settingsStyles.rowBorder]}>
          <View style={styles.localMain}>
            <Text style={settingsStyles.rowTitle}>AstrLink Guard</Text>
            <Text style={settingsStyles.rowHint}>{modelStatus}</Text>
            {status?.downloading === true ? (
              <Text style={styles.localProgress}>
                {t("settings.gatewayPages.masking.localModelDownloading", {
                  percent: formatCount(percent),
                })}
              </Text>
            ) : null}
            {status?.running === true ? (
              <Text style={styles.localNote}>
                {t("settings.gatewayPages.masking.localModelRunning", {
                  device: status.device ?? "CPU",
                })}
              </Text>
            ) : null}
            {status?.failed !== undefined ? (
              <Text style={styles.localError}>
                {t("settings.gatewayPages.masking.localModelFailed", {
                  message: status.failed,
                })}
              </Text>
            ) : null}
            {status?.error !== undefined ? (
              <Text style={styles.localError}>{status.error}</Text>
            ) : null}
          </View>
          {action}
        </View>
        {status?.installed !== true && status?.downloading !== true ? (
          <Text style={styles.localSizeHint}>
            {t("settings.gatewayPages.masking.localModelSizeHint", { size: size || "39 MB" })}
          </Text>
        ) : null}
        {on ? (
          <View style={[styles.localRow, settingsStyles.rowBorder]}>
            <View style={styles.localMain}>
              <Text style={settingsStyles.rowTitle}>
                {t("settings.gatewayPages.masking.thresholdTitle")}
              </Text>
              <Text style={settingsStyles.rowHint}>
                {t("settings.gatewayPages.masking.thresholdHint")}
              </Text>
            </View>
            <SegmentedControl
              options={SCORE_OPTIONS}
              value={String(score)}
              onValueChange={onScore}
            />
          </View>
        ) : null}
        {error !== "" ? <Text style={styles.localError}>{error}</Text> : null}
      </View>
    </SettingsSection>
  );
}

const SCORE_OPTIONS = ["0.5", "0.6", "0.7", "0.8", "0.9", "0.95"].map((value) => ({
  value,
  label: value,
}));

/** Bytes as the size a settings row shows (39.6 MB). */
function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${Math.round(bytes / 1_000)} KB`;
  }
  return `${bytes} B`;
}

const styles = StyleSheet.create((theme) => ({
  input: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[3] },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  output: {
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    marginTop: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  outputLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  blocked: { color: theme.colors.statusDanger, fontSize: theme.fontSize.sm },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  placeholder: {
    color: theme.colors.accent,
    fontFamily: theme.fontFamily.mono,
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius.sm,
  },
  note: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hitList: { gap: 2 },
  hit: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], paddingVertical: 2 },
  hitKind: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, minWidth: 70 },
  hitShape: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  hitBy: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flex: 1 },
  hitAction: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hitWarn: { color: theme.colors.statusWarning },
  hitBlock: { color: theme.colors.statusDanger },
  hitN: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  localRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  localMain: { flex: 1, gap: 2 },
  localHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  localProgress: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  localNote: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  localError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  localSizeHint: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dot0: { backgroundColor: theme.colors.accent },
  dot1: { backgroundColor: theme.colors.terminal.blue },
  dot2: { backgroundColor: theme.colors.statusWarning },
  dot3: { backgroundColor: theme.colors.terminal.magenta },
  dot4: { backgroundColor: theme.colors.statusSuccess },
  dot5: { backgroundColor: theme.colors.terminal.cyan },
  dot6: { backgroundColor: theme.colors.statusDanger },
}));
