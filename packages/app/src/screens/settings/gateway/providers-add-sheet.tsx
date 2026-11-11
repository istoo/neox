import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight, Download, SquarePen } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SearchField } from "@/components/ui/search-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { SubscriptionsSection } from "./subscriptions-section";
import {
  GATEWAY_PROVIDER_PRESETS,
  type GatewayProviderPreset,
  type GatewayProviderPresetKind,
} from "./providers-presets";

const ThemedChevron = withUnistyles(ChevronRight);
const ThemedCustom = withUnistyles(SquarePen);
const ThemedImport = withUnistyles(Download);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const SECTIONS: { kind: GatewayProviderPresetKind; titleKey: string; hintKey: string }[] = [
  { kind: "vendor", titleKey: "presetsVendors", hintKey: "presetsVendorsHint" },
  { kind: "relay", titleKey: "presetsRelays", hintKey: "presetsRelaysHint" },
  { kind: "local", titleKey: "presetsLocal", hintKey: "presetsLocalHint" },
];

function hostOf(url: string | undefined): string {
  if (url === undefined) {
    return "";
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function presetMatches(preset: GatewayProviderPreset, words: string[]): boolean {
  if (words.length === 0) {
    return true;
  }
  const haystack = [
    preset.id,
    preset.name,
    preset.fullName ?? "",
    preset.note ?? "",
    ...Object.values(preset.endpoints),
  ]
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

interface PresetRowProps {
  preset: GatewayProviderPreset;
  onPick: (preset: GatewayProviderPreset) => void;
}

function PresetRow({ preset, onPick }: PresetRowProps) {
  const handlePress = useCallback(() => onPick(preset), [onPick, preset]);
  const firstEndpoint = Object.values(preset.endpoints)[0];
  return (
    <PressHighlight
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={preset.name}
      testID={`gateway-preset-${preset.id}`}
    >
      <View style={styles.rowContent}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {preset.name}
          </Text>
          {preset.note === undefined ? null : (
            <Text style={styles.note} numberOfLines={1}>
              {preset.note}
            </Text>
          )}
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {hostOf(firstEndpoint)}
        </Text>
      </View>
      <ThemedChevron size={14} uniProps={mutedColorMapping} />
    </PressHighlight>
  );
}

export interface ProvidersAddSheetProps {
  serverId: string | null;
  canImport: boolean;
  onClose: () => void;
  onPickPreset: (preset: GatewayProviderPreset) => void;
  onPickCustom: () => void;
  onImport: () => void;
}

export function ProvidersAddSheet({
  serverId,
  canImport,
  onClose,
  onPickPreset,
  onPickCustom,
  onImport,
}: ProvidersAddSheetProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const visible = useMemo(
    () => GATEWAY_PROVIDER_PRESETS.filter((preset) => presetMatches(preset, words)),
    [words],
  );
  const header = useMemo(() => ({ title: t("settings.gatewayPages.providers.addProvider") }), [t]);
  const handleQuery = useCallback((value: string) => setQuery(value), []);
  const noMatch = visible.length === 0;

  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={onClose}
      desktopMaxWidth={560}
      testID="gateway-provider-add-sheet"
    >
      <View style={styles.body}>
        <SearchField
          value={query}
          onChangeText={handleQuery}
          placeholder={t("settings.gatewayPages.providers.searchPresets")}
          accessibilityLabel={t("settings.gatewayPages.providers.searchPresets")}
          clearAccessibilityLabel={t("providerCatalog.clearSearch")}
          testID="gateway-preset-search"
        />

        <SubscriptionsSection serverId={serverId} onClose={onClose} />

        {noMatch ? (
          <Text style={styles.empty}>
            {t("settings.gatewayPages.providers.noPreset", { query })}
          </Text>
        ) : null}

        {SECTIONS.map((section) => {
          const presets = visible.filter((preset) => preset.kind === section.kind);
          if (presets.length === 0) {
            return null;
          }
          return (
            <View key={section.kind} style={styles.section}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>
                  {t(`settings.gatewayPages.providers.${section.titleKey}`)}
                </Text>
                <Text style={styles.sectionHint}>
                  {t(`settings.gatewayPages.providers.${section.hintKey}`)}
                </Text>
              </View>
              <View style={settingsStyles.card}>
                {presets.map((preset, index) => (
                  <View key={preset.id} style={index > 0 ? styles.rowBorder : undefined}>
                    <PresetRow preset={preset} onPick={onPickPreset} />
                  </View>
                ))}
              </View>
            </View>
          );
        })}

        <View style={settingsStyles.card}>
          <PressHighlight
            style={styles.actionRow}
            onPress={onPickCustom}
            accessibilityRole="button"
            accessibilityLabel={t("settings.gatewayPages.providers.customProvider")}
            testID="gateway-preset-custom"
          >
            <ThemedCustom size={16} uniProps={foregroundColorMapping} />
            <View style={styles.actionText}>
              <Text style={styles.name}>{t("settings.gatewayPages.providers.customProvider")}</Text>
              <Text style={styles.sub}>
                {t("settings.gatewayPages.providers.customProviderHint")}
              </Text>
            </View>
          </PressHighlight>
          {canImport ? (
            <View style={styles.rowBorder}>
              <PressHighlight
                style={styles.actionRow}
                onPress={onImport}
                accessibilityRole="button"
                accessibilityLabel={t("settings.gatewayPages.providers.importProviders")}
                testID="gateway-preset-import"
              >
                <ThemedImport size={16} uniProps={foregroundColorMapping} />
                <View style={styles.actionText}>
                  <Text style={styles.name}>
                    {t("settings.gatewayPages.providers.importProviders")}
                  </Text>
                  <Text style={styles.sub}>
                    {t("settings.gatewayPages.providers.importProvidersHint")}
                  </Text>
                </View>
              </PressHighlight>
            </View>
          ) : null}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
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
  sectionHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
  rowContent: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  sub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  actionText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
