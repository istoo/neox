import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { LibraryScreen } from "@/screens/library-screen";

export default function LibraryRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <LibraryScreen />
    </HostRouteBootstrapBoundary>
  );
}
