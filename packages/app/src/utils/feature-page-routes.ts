export type FeaturePageRoute = "agents" | "library" | "models" | "schedules";

const FEATURE_ROUTE_PREFIXES: readonly (readonly [string, FeaturePageRoute])[] = [
  ["/schedules", "schedules"],
  ["/library", "library"],
  ["/models", "models"],
  // The old address; the route redirects to /models.
  ["/myna", "models"],
  ["/agents", "agents"],
];

/**
 * Which feature page a pathname owns, or null. Exact segment matching keeps
 * `/schedules` from being mistaken for another page and keeps its app chrome.
 * The old `/myna` address belongs to Models & quota; it never renders on its
 * own.
 */
export function resolveFeaturePageRoute(pathname: string): FeaturePageRoute | null {
  const path = pathname.split("?")[0] || "";
  for (const [prefix, route] of FEATURE_ROUTE_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return route;
    }
  }
  return null;
}
