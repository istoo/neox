import { Redirect } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { useReplacedPageTarget } from "@/plugins/page-replacement-navigation";
import { useActiveHostBuiltinFeatures } from "@/plugins/builtin-features";
import { SessionsScreen } from "@/screens/sessions-screen";

export default function SessionsRoute() {
  const { isEnabled } = useActiveHostBuiltinFeatures();
  const replacement = useReplacedPageTarget("sessions");
  // A feature switched off takes its page with it; myna sends the reader to Agents.
  if (!isEnabled("sessions")) return <Redirect href="/" />;
  if (replacement) {
    return (
      <Redirect
        href={buildPluginSurfaceRoute(replacement.serverId, replacement.pluginId, {
          kind: "surface",
          id: replacement.screenId,
        })}
      />
    );
  }
  return (
    <HostRouteBootstrapBoundary>
      <SessionsScreen />
    </HostRouteBootstrapBoundary>
  );
}
