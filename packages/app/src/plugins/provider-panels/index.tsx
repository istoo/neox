import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import type { PluginTheme } from "@neolix/plugin";
import { usePluginHostNavigation } from "../host-navigation";
import { PluginInstallationProvider } from "../installation-provider";
import { resolvePluginPlatform } from "../platform";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";

interface ProviderPanelsProps {
  serverId: string;
  provider: { id: string; name: string };
  theme: PluginTheme;
}

function ProviderPanelsBody({ serverId, provider, theme }: ProviderPanelsProps) {
  const plugins = useInstalledPlugins();
  const hosts = useHosts();
  const compact = useIsCompactFormFactor();
  const navigation = usePluginHostNavigation(serverId);
  const host = useMemo(
    () => ({
      id: serverId,
      label: hosts.find((candidate) => candidate.serverId === serverId)?.label ?? serverId,
    }),
    [hosts, serverId],
  );
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const entries = plugins
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      plugin.providerPanels.map((panel) => ({
        plugin,
        panel,
        title: plugin.i18n.resolve(panel.title, plugin.locale),
      })),
    );
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map(({ plugin, panel, title }) => (
        <SurfaceErrorBoundary
          key={`${plugin.id}/${panel.id}`}
          installation={plugin}
          Surface={panel.Component}
          resetKey={`${serverId}/${provider.id}`}
        >
          <PluginInstallationProvider plugin={plugin}>
            <View style={styles.section}>
              <Text style={styles.title}>{title}</Text>
              <panel.Component
                theme={theme}
                host={host}
                layout={layout}
                navigation={navigation}
                provider={provider}
              />
            </View>
          </PluginInstallationProvider>
        </SurfaceErrorBoundary>
      ))}
    </>
  );
}

const pluginThemeMapping = (theme: Parameters<typeof toPluginTheme>[0]) => ({
  theme: toPluginTheme(theme),
});

const ThemedProviderPanelsBody = withUnistyles(ProviderPanelsBody);

/** The panels plugins draw inside a gateway provider's editor. */
export function ProviderPluginPanels({
  serverId,
  provider,
}: {
  serverId: string;
  provider: { id: string; name: string };
}) {
  return (
    <ThemedProviderPanelsBody
      serverId={serverId}
      provider={provider}
      uniProps={pluginThemeMapping}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
}));
