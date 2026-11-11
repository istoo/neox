import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import type { SessionOutboundMessage } from "@neolix/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

type GatewayImportPreviewPayload = Extract<
  SessionOutboundMessage,
  { type: "gateway.provider.preview_import.response" }
>["payload"];

const ThemedCheck = withUnistyles(Check);
const ThemedSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accent });

export type ImportSource = GatewayImportPreviewPayload["sources"][number];
export type ImportItem = ImportSource["providers"][number];

function itemKey(sourceId: string, item: ImportItem): string {
  return `${sourceId}/${item.ref}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Translate = ReturnType<typeof useTranslation>["t"];

function importStatusLabel(taken: boolean, hasKey: boolean, t: Translate): string {
  if (taken) {
    return t("settings.gatewayPages.providers.importAlreadyAdded");
  }
  return hasKey
    ? t("settings.gatewayPages.providers.importHasKey")
    : t("settings.gatewayPages.providers.importNoKey");
}

interface ImportRowProps {
  sourceId: string;
  item: ImportItem;
  selected: boolean;
  taken: boolean;
  onToggle: (key: string) => void;
}

function ImportRow({ sourceId, item, selected, taken, onToggle }: ImportRowProps) {
  const { t } = useTranslation();
  const handlePress = useCallback(
    () => onToggle(itemKey(sourceId, item)),
    [item, onToggle, sourceId],
  );
  const accessibilityState = useMemo(
    () => ({ checked: selected, disabled: taken }),
    [selected, taken],
  );
  const statusLabel = useMemo(
    () => importStatusLabel(taken, item.apiKey !== undefined, t),
    [item.apiKey, t, taken],
  );
  return (
    <PressHighlight
      style={[styles.row, taken ? styles.rowTaken : null]}
      onPress={handlePress}
      disabled={taken}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      accessibilityLabel={item.name}
      testID={`gateway-import-${sourceId}-${item.ref}`}
    >
      <View style={[styles.checkBox, selected ? styles.checkBoxOn : null]}>
        {selected ? <ThemedCheck size={12} uniProps={accentColorMapping} /> : null}
      </View>
      <View style={styles.rowContent}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {`${hostOf(item.baseUrl)} · ${item.protocol}`}
        </Text>
      </View>
      <Text style={taken ? styles.statusTaken : styles.statusNew}>{statusLabel}</Text>
    </PressHighlight>
  );
}

export interface ProvidersImportSheetProps {
  sources: ImportSource[] | null;
  loading: boolean;
  error: string | null;
  /** Provider ids and base URLs already in the gateway, so repeats are marked. */
  existing: { ids: string[]; baseUrls: string[] };
  onClose: () => void;
  onImport: (items: { sourceId: string; provider: ImportItem }[]) => void;
}

export function ProvidersImportSheet({
  sources,
  loading,
  error,
  existing,
  onClose,
  onImport,
}: ProvidersImportSheetProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const header = useMemo(
    () => ({ title: t("settings.gatewayPages.providers.importProviders") }),
    [t],
  );
  const handleToggle = useCallback((key: string) => {
    setSelected((previous) =>
      previous.includes(key) ? previous.filter((entry) => entry !== key) : [...previous, key],
    );
  }, []);

  const takenOf = useCallback(
    (item: ImportItem) =>
      existing.baseUrls.includes(item.baseUrl.trim().replace(/\/+$/, "")) ||
      existing.ids.includes(item.name.toLowerCase().replace(/[^a-z0-9-]/g, "-")),
    [existing.baseUrls, existing.ids],
  );

  const chosen = useMemo(() => {
    if (sources === null) {
      return [];
    }
    const picked: { sourceId: string; provider: ImportItem }[] = [];
    for (const source of sources) {
      for (const item of source.providers) {
        if (selected.includes(itemKey(source.id, item))) {
          picked.push({ sourceId: source.id, provider: item });
        }
      }
    }
    return picked;
  }, [selected, sources]);

  const handleImport = useCallback(() => {
    if (chosen.length > 0) {
      onImport(chosen);
    }
  }, [chosen, onImport]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" size="sm" onPress={onClose}>
          {t("settings.gatewayPages.providers.cancel")}
        </Button>
        <Button variant="default" size="sm" onPress={handleImport} disabled={chosen.length === 0}>
          {t("settings.gatewayPages.providers.importAction", { count: chosen.length })}
        </Button>
      </View>
    ),
    [chosen.length, handleImport, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={560}
      testID="gateway-provider-import-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.hint}>{t("settings.gatewayPages.providers.importHint")}</Text>
        {loading ? <ThemedSpinner size="small" /> : null}
        {error === null ? null : <Text style={styles.error}>{error}</Text>}
        {sources?.map((source) => (
          <View key={source.id} style={styles.section}>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>{source.name}</Text>
              <Text style={styles.sectionPath} numberOfLines={1}>
                {source.path}
              </Text>
            </View>
            {source.found ? null : (
              <Text style={styles.hint}>{t("settings.gatewayPages.providers.importNotFound")}</Text>
            )}
            {source.error === undefined ? null : <Text style={styles.error}>{source.error}</Text>}
            {source.providers.length > 0 ? (
              <View style={settingsStyles.card}>
                {source.providers.map((item, index) => (
                  <View key={item.ref} style={index > 0 ? styles.rowBorder : undefined}>
                    <ImportRow
                      sourceId={source.id}
                      item={item}
                      selected={selected.includes(itemKey(source.id, item))}
                      taken={takenOf(item)}
                      onToggle={handleToggle}
                    />
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionHead: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  sectionPath: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  rowTaken: {
    opacity: theme.opacity[50],
  },
  checkBox: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: {
    borderColor: theme.colors.accent,
  },
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  sub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusNew: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusTaken: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
