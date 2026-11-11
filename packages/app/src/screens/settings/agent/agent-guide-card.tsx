/* eslint-disable react-perf/jsx-no-new-function-as-prop -- a handful of guide steps; none of them is in a hot list. */
import { useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, X } from "lucide-react-native";
import type { AgentConnectEntry, AgentConnectModel } from "@neolix/protocol/agent-connect";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { useGatewayConfig } from "@/hooks/use-gateway-config";
import { useToast } from "@/contexts/toast-api-context";
import { buildModelsRoute } from "@/utils/host-routes";
import { useSettingsNavigate } from "@/screens/settings/app/shared";
import { useGatewayMode } from "@/screens/settings/app/gateway-mode";
import { guideStateOf } from "./agent-guide";
import {
  buildRoutingTemplates,
  groupFromTemplate,
  type RoutingTemplate,
  type RoutingTemplateKind,
} from "@/screens/settings/gateway/routing-templates";

const TEMPLATE_ORDER: readonly RoutingTemplateKind[] = ["steady", "thrifty", "smart"];
const TEMPLATE_NAME_KEYS: Record<RoutingTemplateKind, string> = {
  steady: "settings.gatewayPages.routing.templateSteadyName",
  thrifty: "settings.gatewayPages.routing.templateThriftyName",
  smart: "settings.gatewayPages.routing.templateSmartName",
};
/** Agents named on the card; the rest are in the list under it (myna's GUIDE_CHIPS). */
const GUIDE_CHIPS = 6;

interface AgentGuideCardProps {
  serverId: string;
  entries: readonly AgentConnectEntry[];
  models: readonly AgentConnectModel[];
  onConnect: (provider: string) => void;
}

/**
 * myna's Get started card (gui/assets/app.js guideShown/guideCard): three
 * steps, each ticked from what is so — a model source, an agent connected,
 * and optionally a routing group of the user's own. Put away with the X,
 * as myna's guideHidden; it is not drawn in gateway mode, nor once both
 * steps are done.
 */
export function AgentGuideCard({ serverId, entries, models, onConnect }: AgentGuideCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useSettingsNavigate();
  const gatewayMode = useGatewayMode();
  const { settings, updateSettings } = useAppSettings();
  const { config, save } = useGatewayConfig(serverId);

  const ownGroups = useMemo(
    () => (config?.groups ?? []).filter((group) => group.auto !== true),
    [config],
  );
  const guide = guideStateOf({
    gatewayMode: gatewayMode.enabled,
    hidden: settings.guideHidden === true,
    models: models.length,
    anyConnected: entries.some((entry) => entry.connected),
    ownGroups: ownGroups.length,
  });
  const source = models.length;
  const agent = guide.agent;
  const routing = guide.routing;
  // An external agent is added by its own link or shell function, not this
  // card's switch (myna's connectKind "link" is not offered here).
  const connectable = entries.filter(
    (entry) => !entry.connected && entry.kind !== "external" && entry.reason === null,
  );
  const ready = connectable.slice(0, GUIDE_CHIPS);
  const allReady = connectable.length;

  const template = useMemo<RoutingTemplate | null>(() => {
    if (config === null) {
      return null;
    }
    const templates = buildRoutingTemplates(config);
    for (const kind of TEMPLATE_ORDER) {
      const found = templates.find((entry) => entry.kind === kind);
      if (found !== undefined) {
        return found;
      }
    }
    return templates[0] ?? null;
  }, [config]);

  const hide = useCallback(() => {
    updateSettings({ guideHidden: true });
  }, [updateSettings]);

  const open = useCallback(
    (view: "sources" | "routing") => {
      navigate(buildModelsRoute({ serverId, view }));
    },
    [navigate, serverId],
  );

  const addTemplate = useCallback(() => {
    if (config === null || template === null) {
      return;
    }
    const label = t(TEMPLATE_NAME_KEYS[template.kind]);
    void save({
      ...config,
      groups: [...(config.groups ?? []), groupFromTemplate(config, template, label)],
    }).catch((cause: unknown) => {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    });
  }, [config, save, t, template, toast]);

  if (!guide.show) {
    return null;
  }

  return (
    <View style={styles.card} accessibilityLabel={t("settings.usePages.agent.guide.title")}>
      <View style={styles.head}>
        <Text style={styles.title}>{t("settings.usePages.agent.guide.title")}</Text>
        <Text style={styles.count}>
          {t("settings.usePages.agent.guide.done", {
            n: Number(source > 0) + Number(agent),
            m: 2,
          })}
        </Text>
        <View style={styles.grow} />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          onPress={hide}
          accessibilityLabel={t("settings.usePages.agent.guide.hide")}
        />
      </View>

      <GuideStep
        n={1}
        done={source > 0}
        title={t("settings.usePages.agent.guide.source")}
        say={
          source > 0
            ? t("settings.usePages.agent.guide.sourceDone", { n: source })
            : t("settings.usePages.agent.guide.sourceHint")
        }
      >
        {source === 0 ? (
          <Button variant="default" size="sm" onPress={() => open("sources")}>
            {t("settings.usePages.agent.guide.addProvider")}
          </Button>
        ) : null}
      </GuideStep>

      <GuideStep
        n={2}
        done={agent}
        title={t("settings.usePages.agent.guide.agent")}
        say={agentStepSay(t, agent, ready.length)}
      >
        {!agent && ready.length > 0 ? (
          <View style={styles.chips}>
            {ready.map((entry) => (
              <Button
                key={entry.provider}
                variant="secondary"
                size="sm"
                onPress={() => onConnect(entry.provider)}
              >
                {entry.name ?? entry.provider}
              </Button>
            ))}
            {allReady > GUIDE_CHIPS ? (
              <Text style={styles.more}>
                {t("settings.usePages.agent.guide.more", { n: allReady - GUIDE_CHIPS })}
              </Text>
            ) : null}
          </View>
        ) : null}
      </GuideStep>

      <GuideStep
        n={3}
        done={routing}
        title={t("settings.usePages.agent.guide.routing")}
        say={
          routing
            ? ownGroups.map((group) => group.label ?? group.id).join(", ")
            : t("settings.usePages.agent.guide.routingHint")
        }
      >
        {!routing && source > 0 ? (
          <View style={styles.chips}>
            {template !== null ? (
              <Button variant="default" size="sm" onPress={addTemplate}>
                {t("settings.usePages.agent.guide.addTemplate", {
                  name: t(TEMPLATE_NAME_KEYS[template.kind]),
                })}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onPress={() => open("routing")}>
              {t("settings.usePages.agent.guide.openRouting")}
            </Button>
          </View>
        ) : null}
      </GuideStep>
    </View>
  );
}

function agentStepSay(t: TFunction, connected: boolean, ready: number): string {
  if (connected) {
    return "";
  }
  return ready > 0
    ? t("settings.usePages.agent.guide.agentHint")
    : t("settings.usePages.agent.guide.agentNone");
}

function GuideStep({
  n,
  done,
  title,
  say,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  say: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.step}>
      <View style={[styles.tick, done ? styles.tickDone : null]}>
        {done ? <Check size={12} /> : <Text style={styles.tickNumber}>{n}</Text>}
      </View>
      <View style={styles.stepBody}>
        <Text style={styles.stepTitle}>{title}</Text>
        {say.length > 0 ? <Text style={styles.stepSay}>{say}</Text> : null}
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    marginBottom: theme.spacing[4],
  },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "600" },
  count: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  grow: { flex: 1 },
  step: { flexDirection: "row", gap: theme.spacing[3] },
  tick: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tickDone: {
    borderColor: theme.colors.success,
    backgroundColor: theme.colors.success,
  },
  tickNumber: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  stepBody: { flex: 1, gap: theme.spacing[1] },
  stepTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, fontWeight: "600" },
  stepSay: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  more: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
