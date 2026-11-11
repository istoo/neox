import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { GatewayPriceWire } from "@neolix/protocol/gateway";
import { FormTextInput } from "@/components/ui/form-field";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { ModelPriceDraft } from "./providers-helpers";
import { PeakBadge } from "./providers-peak-badge";

type PriceCatalog = Record<string, GatewayPriceWire | null>;

/**
 * The catalog's list prices for a provider's models, which the price fields
 * show as placeholders and compare against on save.
 */
export function useModelPriceCatalog(
  serverId: string,
  providerId: string,
  models: readonly { id: string }[],
  enabled: boolean,
): PriceCatalog {
  const client = useHostRuntimeClient(serverId);
  const [catalog, setCatalog] = useState<PriceCatalog>({});
  const ids = models.map((model) => model.id);
  const key = ids.join("\n");
  useEffect(() => {
    if (!enabled || client === null || providerId.trim().length === 0) {
      return;
    }
    let live = true;
    const wanted = key.length === 0 ? [] : key.split("\n");
    void client
      .getGatewayModelPrices(providerId.trim(), wanted)
      .then((result) => {
        if (live) {
          setCatalog(result.prices);
        }
        return undefined;
      })
      .catch(() => {
        // Without the catalog the fields still take prices; they just can not
        // tell that one matches it.
      });
    return () => {
      live = false;
    };
  }, [client, enabled, key, providerId]);
  return catalog;
}

type PriceKey = keyof ModelPriceDraft;

interface PriceFieldProps {
  field: PriceKey;
  label: string;
  value: string;
  placeholder: string;
  onChange: (field: PriceKey, text: string) => void;
}

function PriceField({ field, label, value, placeholder, onChange }: PriceFieldProps) {
  const handleChange = useCallback((text: string) => onChange(field, text), [field, onChange]);
  return (
    <View style={styles.cell}>
      <Text style={styles.cellLabel}>{label}</Text>
      <FormTextInput
        size="sm"
        initialValue={value}
        onChangeText={handleChange}
        placeholder={placeholder}
        keyboardType="decimal-pad"
        accessibilityLabel={label}
      />
    </View>
  );
}

export interface ModelPriceFieldsProps {
  draft: ModelPriceDraft;
  /** What the catalog lists the model at, shown as placeholders. */
  catalog: GatewayPriceWire | null;
  onChange: (draft: ModelPriceDraft) => void;
}

/** One model's hand-set price; empty fields take the catalog's. */
export function ModelPriceFields({ draft, catalog, onChange }: ModelPriceFieldsProps) {
  const { t } = useTranslation();
  const tier = catalog?.tiers?.[0];
  const handleChange = useCallback(
    (field: PriceKey, text: string) => onChange({ ...draft, [field]: text }),
    [draft, onChange],
  );
  const fields: { key: PriceKey; label: string; placeholder: string }[] = [
    {
      key: "input",
      label: t("settings.gatewayPages.providers.priceInput"),
      placeholder: catalogText(catalog?.inputPerMTok),
    },
    {
      key: "output",
      label: t("settings.gatewayPages.providers.priceOutput"),
      placeholder: catalogText(catalog?.outputPerMTok),
    },
    {
      key: "cacheRead",
      label: t("settings.gatewayPages.providers.priceCacheRead"),
      placeholder: catalogText(catalog?.cacheReadPerMTok),
    },
    {
      key: "cacheWrite",
      label: t("settings.gatewayPages.providers.priceCacheWrite"),
      placeholder: catalogText(catalog?.cacheWritePerMTok),
    },
    {
      key: "cacheWrite1h",
      label: t("settings.gatewayPages.providers.priceCacheWrite1h"),
      placeholder: catalogText(catalog?.cacheWrite1hPerMTok),
    },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.priceRow}>
        <Text style={styles.label}>{t("settings.gatewayPages.providers.price")}</Text>
        <PeakBadge
          peak={catalog?.peak}
          label={t("settings.gatewayPages.providers.peakOffPeak")}
          hint={t("settings.gatewayPages.providers.peakHint")}
        />
      </View>
      <View style={styles.grid}>
        {fields.map((field) => (
          <PriceField
            key={field.key}
            field={field.key}
            label={field.label}
            value={draft[field.key]}
            placeholder={field.placeholder}
            onChange={handleChange}
          />
        ))}
      </View>
      <Text style={styles.sublabel}>{t("settings.gatewayPages.providers.priceLongContext")}</Text>
      <View style={styles.grid}>
        <PriceField
          field="tierAbove"
          label={t("settings.gatewayPages.providers.priceTierAbove")}
          value={draft.tierAbove}
          placeholder={tier === undefined ? "" : String(tier.aboveTokens)}
          onChange={handleChange}
        />
        <PriceField
          field="tierInput"
          label={t("settings.gatewayPages.providers.priceTierInput")}
          value={draft.tierInput}
          placeholder={catalogText(tier?.inputPerMTok)}
          onChange={handleChange}
        />
        <PriceField
          field="tierOutput"
          label={t("settings.gatewayPages.providers.priceTierOutput")}
          value={draft.tierOutput}
          placeholder={catalogText(tier?.outputPerMTok)}
          onChange={handleChange}
        />
      </View>
      <Text style={styles.hint}>{t("settings.gatewayPages.providers.priceHint")}</Text>
    </View>
  );
}

function catalogText(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  priceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  sublabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  cell: {
    flexGrow: 1,
    flexBasis: 120,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  cellLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
