import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { GatewayConfigWire } from "@neolix/protocol/gateway";
import { FormTextInput } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";

/**
 * The request archive's switch and caps, at the top of Usage › Requests as
 * myna keeps it: every call's headers and bodies, secrets taken out, kept on
 * this computer. `archive.local` turns it on; `maxMB` is how much of one body
 * is kept and `keepMB` the folder's cap, the oldest calls going first.
 */
export function GatewayRequestArchive({
  config,
  apply,
  edit,
}: {
  config: GatewayConfigWire;
  apply: (mutate: (next: GatewayConfigWire) => void) => Promise<void>;
  edit: (mutate: (next: GatewayConfigWire) => void) => void;
}) {
  const { t } = useTranslation();
  const archive = config.archive;
  const enabled = archive?.local === true;
  const maxMB = archive?.maxMB ?? DEFAULT_MAX_MB;
  const keepMB = archive?.keepMB ?? DEFAULT_KEEP_MB;

  const toggle = useCallback(
    (next: boolean) => {
      void apply((draft) => {
        draft.archive = { ...draft.archive, local: next };
      });
    },
    [apply],
  );
  const changeMax = useCallback(
    (text: string) => {
      const value = megabytes(text);
      if (value === null) {
        return;
      }
      edit((draft) => {
        draft.archive = { ...draft.archive, maxMB: value };
      });
    },
    [edit],
  );
  const changeKeep = useCallback(
    (text: string) => {
      const value = megabytes(text);
      if (value === null) {
        return;
      }
      edit((draft) => {
        draft.archive = { ...draft.archive, keepMB: value };
      });
    },
    [edit],
  );

  return (
    <View style={[settingsStyles.card, styles.card]} testID="gateway-request-archive">
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <Text style={styles.title}>{t("settings.gatewayPages.usage.archive.title")}</Text>
          <Text style={styles.sub}>{t("settings.gatewayPages.usage.archive.hint")}</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={toggle}
          accessibilityLabel={t("settings.gatewayPages.usage.archive.title")}
          testID="gateway-archive-toggle"
        />
      </View>
      {enabled ? (
        <View style={styles.caps}>
          <View style={styles.capField}>
            <Text style={styles.capLabel}>{t("settings.gatewayPages.usage.archive.maxBody")}</Text>
            <FormTextInput
              initialValue={String(maxMB)}
              onChangeText={changeMax}
              keyboardType="number-pad"
              size="sm"
              testID="gateway-archive-max-mb"
            />
          </View>
          <View style={styles.capField}>
            <Text style={styles.capLabel}>{t("settings.gatewayPages.usage.archive.keep")}</Text>
            <FormTextInput
              initialValue={String(keepMB)}
              onChangeText={changeKeep}
              keyboardType="number-pad"
              size="sm"
              testID="gateway-archive-keep-mb"
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const DEFAULT_MAX_MB = 32;
const DEFAULT_KEEP_MB = 1024;

/** A whole number of megabytes, or null while the field is not one. */
function megabytes(text: string): number | null {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1 || value > 1_048_576) {
    return null;
  }
  return value;
}

const styles = StyleSheet.create((theme) => ({
  card: {
    marginBottom: theme.spacing[4],
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowMain: {
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  sub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  caps: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  capField: {
    gap: theme.spacing[1],
    minWidth: 140,
  },
  capLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
