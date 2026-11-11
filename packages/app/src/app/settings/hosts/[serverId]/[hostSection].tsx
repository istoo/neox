import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useSettingsSectionReplacement } from "@/plugins/page-replacement-navigation";
import { useBuiltinFeatures } from "@/plugins/builtin-features";
import { buildPluginSettingsRoute } from "@/plugins/settings/routes";
import SettingsScreen from "@/screens/settings-screen";
import {
  buildModelsRoute,
  buildSettingsHostSectionRoute,
  modelsViewForHostSection,
  normalizeHostSectionSlug,
} from "@/utils/host-routes";

export default function SettingsHostSectionRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    hostSection?: string;
    record?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId.trim() : "";
  const rawSection = typeof params.hostSection === "string" ? params.hostSection : "";
  const section = normalizeHostSectionSlug(rawSection) ?? "connections";
  const rawRecord = typeof params.record === "string" ? params.record.trim() : "";
  const focusRecord = rawRecord === "" ? undefined : rawRecord;
  const replacement = useSettingsSectionReplacement(serverId, section);
  const { hidden } = useBuiltinFeatures(serverId);
  const view = useMemo(
    () => ({
      kind: "host" as const,
      serverId,
      section,
      ...(focusRecord === undefined ? {} : { focusRecord }),
    }),
    [serverId, section, focusRecord],
  );

  // A plugin replacing this section keeps the page it provides.
  if (replacement) {
    return (
      <Redirect
        href={buildPluginSettingsRoute(
          serverId,
          replacement.installation.id,
          replacement.screen.id,
        )}
      />
    );
  }

  // The gateway and masking sections now live on the Models & quota page.
  const modelsView = modelsViewForHostSection(section);
  if (serverId && modelsView !== null) {
    return (
      <Redirect
        href={buildModelsRoute({
          serverId,
          view: modelsView,
          ...(modelsView === "masking" && focusRecord !== undefined ? { record: focusRecord } : {}),
        })}
      />
    );
  }

  // A feature switched off leaves no page behind; myna sends the reader to Agents.
  if (serverId && hidden.hostSections.has(section)) {
    return <Redirect href={buildSettingsHostSectionRoute(serverId, "agents")} />;
  }

  return (
    <HostRouteBootstrapBoundary>
      <SettingsScreen view={view} />
    </HostRouteBootstrapBoundary>
  );
}
