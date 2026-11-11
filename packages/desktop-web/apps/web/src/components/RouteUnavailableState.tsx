// FILE: RouteUnavailableState.tsx
// Purpose: Full-surface empty state for a route whose backend this build does not provide,
//          so a direct or legacy link explains itself instead of bouncing to a fresh chat.
// Layer: Route UI component

import { RouteInsetSurface } from "./RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "./RouteSurface";

export function RouteUnavailableState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader />
        <main
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-6 pb-16 text-center"
          role="status"
        >
          <p className="text-ui-lg font-medium text-foreground">{title}</p>
          <p className="text-ui text-muted-foreground">{description}</p>
        </main>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
