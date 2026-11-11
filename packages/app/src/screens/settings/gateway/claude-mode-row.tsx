import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Field } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useGatewayMode } from "@/screens/settings/app/gateway-mode";
import { formatAgo } from "@/usage/format";
import { claudeModeChoicesDisabled, withClaudeMode } from "./claude-mode-choice";

type ClaudeModeWhy = "" | "off" | "os" | "missing";

interface ClaudeModeView {
  tui: boolean;
  why: ClaudeModeWhy;
  last: { tui: boolean; why: string; at: number } | null;
}

const MODE_OPTIONS = [
  { value: "tui", labelKey: "claudeModeTui" },
  { value: "p", labelKey: "claudeModeP" },
] as const;

/**
 * The Claude Code provider editor's "Claude Code runs as" row (myna's
 * claudemode.js): whether a subscription's runs are Claude Code's
 * interactive mode or `claude -p`, how the last request went, and on hover
 * or focus what each mode is. It switches here, through the gateway
 * config's `claudePrintMode`, as myna's row does — except where this page
 * serves as the gateway itself, where only the gateway's Settings change it
 * (myna claudemode.js:75).
 */
export function ClaudeModeRow({ serverId, visible }: { serverId: string; visible: boolean }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const canRead = useHostFeature(serverId, "gatewayClaudeMode");
  const gateway = useGatewayMode(serverId);
  const { config, save } = useGatewayConfig(serverId);
  const disabled = claudeModeChoicesDisabled(gateway.enabled);
  const [mode, setMode] = useState<ClaudeModeView | null>(null);

  useEffect(() => {
    if (!visible || !canRead || !client) {
      return;
    }
    let cancelled = false;
    void client
      .getGatewayClaudeMode()
      .then((payload) => {
        if (!cancelled) {
          setMode(payload.mode);
        }
        return undefined;
      })
      .catch(() => {
        // An older daemon without the read: the row shows nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, client, visible]);

  const changeMode = useCallback(
    (choice: string) => {
      if (disabled || config === null || mode === null) {
        return;
      }
      const picked = choice === "p" ? "p" : "tui";
      if ((picked === "tui") === mode.tui) {
        return;
      }
      void save(withClaudeMode(config, picked))
        .then(() => (client === null ? undefined : client.getGatewayClaudeMode()))
        .then((payload) => {
          if (payload !== undefined) {
            setMode(payload.mode);
          }
          return undefined;
        })
        .catch(() => {
          // The write failed; the row keeps what it showed.
        });
    },
    [client, config, disabled, mode, save],
  );

  if (!visible || !canRead || mode === null) {
    return null;
  }

  // The setting is the interactive mode unless the machine says why not:
  // on where it can't, Claude requests fail, as myna shows it.
  const interactive = mode.why !== "off";
  const whyText =
    mode.why === "missing"
      ? t("settings.gatewayPages.providers.claudeWhyMissing")
      : t("settings.gatewayPages.providers.claudeWhyOs");
  const options = MODE_OPTIONS.map((option) => ({
    value: option.value,
    label: t(`settings.gatewayPages.providers.${option.labelKey}`),
  }));
  const last = mode.last;

  return (
    <Field label={t("settings.gatewayPages.providers.claudeRunsAs")}>
      <View style={styles.row}>
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild triggerRefProp="ref">
            <PressHighlight
              accessibilityRole="button"
              accessibilityHint={
                disabled ? t("settings.gatewayPages.providers.claudeModeHint") : undefined
              }
            >
              <View pointerEvents={disabled ? "none" : "auto"}>
                <SegmentedControl
                  options={options}
                  value={mode.tui ? "tui" : "p"}
                  onValueChange={changeMode}
                  size="sm"
                />
              </View>
            </PressHighlight>
          </TooltipTrigger>
          <TooltipContent side="bottom" maxWidth={360}>
            <View style={styles.tip}>
              <Text style={styles.tipTitle}>
                {t("settings.gatewayPages.providers.claudeModeTui")}
                {mode.tui ? ` · ${t("settings.gatewayPages.providers.claudeModeInUse")}` : ""}
              </Text>
              <Text style={styles.tipText}>
                {t("settings.gatewayPages.providers.claudeModeTuiWhat")}
              </Text>
              <Text style={styles.tipGood}>
                {t("settings.gatewayPages.providers.claudeModeTuiGood")}
              </Text>
              <Text style={styles.tipTitle}>
                {t("settings.gatewayPages.providers.claudeModeP")}
                {mode.tui ? "" : ` · ${t("settings.gatewayPages.providers.claudeModeInUse")}`}
              </Text>
              <Text style={styles.tipText}>
                {t("settings.gatewayPages.providers.claudeModePWhat")}
              </Text>
              <Text style={styles.tipGood}>
                {t("settings.gatewayPages.providers.claudeModePGood")}
              </Text>
              <Text style={styles.tipBad}>
                {t("settings.gatewayPages.providers.claudeModePBad")}
              </Text>
              <Text style={styles.tipFoot}>
                {t("settings.gatewayPages.providers.claudeModeFoot")}
              </Text>
            </View>
          </TooltipContent>
        </Tooltip>
        {saidText({
          interactive,
          tui: mode.tui,
          whyText,
          last,
          t,
        })}
      </View>
    </Field>
  );
}

/** How the runs are going now, as myna's claudeModeDraw says it. */
function saidText(input: {
  interactive: boolean;
  tui: boolean;
  whyText: string;
  last: ClaudeModeView["last"];
  t: TFunction;
}): ReactElement | null {
  const { interactive, tui, whyText, last, t } = input;
  if (interactive && !tui) {
    return (
      <Text style={[styles.said, styles.saidBad]}>
        {t("settings.gatewayPages.providers.claudeFail", { why: whyText })}
      </Text>
    );
  }
  if (!interactive) {
    return <Text style={styles.said}>{t("settings.gatewayPages.providers.claudeAllPrint")}</Text>;
  }
  if (last === null || !last.tui) {
    return null;
  }
  const ago = formatAgo(new Date(last.at).toISOString());
  return (
    <Text style={styles.said}>
      {t("settings.gatewayPages.providers.claudeLastTui", { ago: ago ?? "" })}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  said: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  saidBad: {
    color: theme.colors.statusDanger,
  },
  tip: {
    gap: theme.spacing[1],
  },
  tipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  tipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  tipGood: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
  tipBad: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  tipFoot: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
