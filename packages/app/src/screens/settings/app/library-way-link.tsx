import { useCallback } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useBuiltinFeatures } from "@/plugins/builtin-features";
import { useSettingsSubviewStore } from "@/stores/settings-subview-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { useGatewayMode } from "./gateway-mode";
import { useSettingsHostServerId, useSettingsNavigate } from "./shared";

type NeolixLibraryServer = "vision" | "image" | "web-search";

const SERVERS: Record<
  NeolixLibraryServer,
  { name: string; label: "libraryWayVision" | "libraryWayImage" | "libraryWayWebSearch" }
> = {
  // The daemon's Library ids (server library/market-servers.ts NEOLIX_*_ID).
  vision: { name: "neox-vision", label: "libraryWayVision" },
  image: { name: "neox-image", label: "libraryWayImage" },
  "web-search": { name: "neox-web-search", label: "libraryWayWebSearch" },
};

/**
 * myna's libWay (gui/assets/app.js:21440): a Models row's way to give agents
 * Neolix's own server through the Library, or to turn the Library on. None in
 * gateway mode, where there is no Library.
 */
export function LibraryWayLink({
  server,
  hidden = false,
}: {
  server: NeolixLibraryServer;
  /** The row's own choice is Off: myna hides the link then. */
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useSettingsNavigate();
  const serverId = useSettingsHostServerId();
  const gatewayMode = useGatewayMode();
  const features = useBuiltinFeatures(serverId);
  const spec = SERVERS[server];

  const onPress = useCallback(() => {
    if (!features.isEnabled("library")) {
      features.setEnabled("library", true);
      return;
    }
    if (!serverId) {
      return;
    }
    // The Library opens the server's market sheet; the user ticks the
    // agents there and confirms, as myna's library "server" call does.
    useSettingsSubviewStore.getState().setLibraryServer(spec.name);
    useSettingsSubviewStore.getState().setLibrary("mcp");
    navigate(buildSettingsHostSectionRoute(serverId, "library"));
  }, [features, navigate, serverId, spec.name]);

  const enabled = features.isEnabled("library");
  const label = enabled
    ? t(`settings.pages.actions.${spec.label}`)
    : t("settings.pages.actions.turnOnLibrary");

  if (gatewayMode.enabled || hidden) {
    return null;
  }
  return (
    <PressHighlight
      accessibilityRole="button"
      onPress={onPress}
      testID={`settings-library-way-${server}`}
    >
      <Text style={styles.link}>{label}</Text>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  link: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[1],
  },
}));
