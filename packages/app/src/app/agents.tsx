import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AgentsScreen } from "@/screens/agents-screen";

export default function AgentsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AgentsScreen />
    </HostRouteBootstrapBoundary>
  );
}
