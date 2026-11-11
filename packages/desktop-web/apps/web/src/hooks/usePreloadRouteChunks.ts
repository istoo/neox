import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms code-split route chunks once the browser is idle.
 *
 *  Settings and thread routes are reached through programmatic `navigate()`
 *  calls (sidebar gear, keyboard shortcut, the "New thread" button), so the
 *  router's intent-based preloading never fires for them — without this, the
 *  first open pays the chunk download/parse cost. For a brand-new thread that
 *  cost lands right on the draft-landing paint, so warming the thread chunk is
 *  the largest single lever for new-chat startup time.
 *
 *  Only the route chunks are loaded (`loadRouteChunk`), never a route match:
 *  `preloadRoute` builds a match for a placeholder thread, and when the startup
 *  navigation (restoring the last thread) commits while that preload is in
 *  flight the router drops the match and its loader throws
 *  "reading '_nonReactive'" into the console.
 */
export function usePreloadRouteChunks() {
  const router = useRouter();

  useEffect(() => {
    const warm = (routeId: "/_chat/$threadId" | "/_chat/settings") => {
      const route = router.routesById[routeId];
      Promise.resolve(router.loadRouteChunk(route)).catch(() => {
        // Preloading is best-effort; navigation falls back to loading on demand.
      });
    };
    // New-task navigation is a primary startup action. Warm that route as soon
    // as the root commits so an immediate click never waits for the browser's
    // idle callback (which can be delayed for several seconds during hydration).
    warm("/_chat/$threadId");

    const preloadSettings = () => warm("/_chat/settings");

    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preloadSettings, { timeout: 5000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preloadSettings, 1500);
    return () => clearTimeout(timeoutId);
  }, [router]);
}
