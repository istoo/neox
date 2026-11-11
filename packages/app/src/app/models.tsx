import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ModelsScreen } from "@/screens/models-screen";

export default function ModelsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <ModelsScreen />
    </HostRouteBootstrapBoundary>
  );
}
