import { Redirect, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { useHostRuntimeBootstrapState } from "@/app/_layout";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveHostBuiltinFeatures } from "@/plugins/builtin-features";
import { isElectronRuntime } from "@/desktop/host";
import { useHardwareKeyboardPresent } from "@/keyboard";
import {
  isSettingsPageAvailable,
  SETTINGS_PAGE_BY_ID,
  type SettingsPageId,
} from "@/screens/settings/app";
import SettingsScreen from "@/screens/settings-screen";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import {
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
  buildSettingsSectionRoute,
  resolveSettingsSectionParam,
} from "@/utils/host-routes";

// COMPAT(settingsDaemonRedirect): added 2026-07-08, remove after 2027-01-08.
function SettingsDaemonRedirect() {
  const hosts = useHosts();
  const localDaemon = useLocalDaemonServerIdState();
  const bootstrapState = useHostRuntimeBootstrapState();

  if (localDaemon.status === "loading") {
    return <StartupSplashScreen bootstrapState={bootstrapState} />;
  }

  if (
    localDaemon.status === "resolved" &&
    localDaemon.serverId !== null &&
    hosts.some((host) => host.serverId === localDaemon.serverId)
  ) {
    return <Redirect href={buildSettingsHostSectionRoute(localDaemon.serverId, "host")} />;
  }

  return <Redirect href={buildSettingsRoute()} />;
}

export default function SettingsSectionRoute() {
  const params = useLocalSearchParams<{ section?: string }>();
  const rawSection = typeof params.section === "string" ? params.section : "";
  const { hidden } = useActiveHostBuiltinFeatures();
  const isDesktopApp = isElectronRuntime();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  const resolved = resolveSettingsSectionParam(rawSection);
  const section = resolved.kind === "section" ? resolved.section : "general";
  const view = useMemo(() => ({ kind: "section" as const, section }), [section]);
  if (resolved.kind === "redirect") {
    return <Redirect href={resolved.href} />;
  }

  // A feature switched off takes its settings page with it; General always stays.
  if (hidden.settingsPages.has(section)) {
    return <Redirect href={buildSettingsSectionRoute("general")} />;
  }

  // A section the current platform cannot draw has no page: go back to the
  // settings root instead of leaving an empty pane.
  const page = SETTINGS_PAGE_BY_ID.get(section as SettingsPageId);
  if (page === undefined || !isSettingsPageAvailable(page, isDesktopApp, hardwareKeyboardPresent)) {
    return <Redirect href={buildSettingsRoute()} />;
  }

  // COMPAT(settingsDaemonRedirect): added 2026-07-08, remove after 2027-01-08.
  if (rawSection === "daemon") {
    return (
      <HostRouteBootstrapBoundary>
        <SettingsDaemonRedirect />
      </HostRouteBootstrapBoundary>
    );
  }

  return <SettingsScreen view={view} />;
}
