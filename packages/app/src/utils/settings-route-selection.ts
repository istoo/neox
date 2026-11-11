import {
  isSettingsSectionSlug,
  normalizeHostSectionSlug,
  type HostSectionSlug,
  type SettingsSectionSlug,
} from "./host-routes";

/**
 * What the Settings sidebar should highlight for a pathname. The route owns
 * this, not the screen's `view` prop: sibling routes keep their own props, so
 * a retained screen must never decide the highlight for the route on top.
 */
export type SettingsRouteSelection =
  | { kind: "none" }
  | { kind: "section"; section: SettingsSectionSlug }
  | { kind: "host"; serverId: string; section: HostSectionSlug }
  | { kind: "project"; serverId: string }
  | { kind: "plugin"; serverId: string };

const HOST_ROUTE_PREFIX = "/settings/hosts/";

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveSettingsRouteSelection(pathname: string): SettingsRouteSelection {
  if (pathname !== "/settings" && !pathname.startsWith("/settings/")) {
    return { kind: "none" };
  }

  if (pathname.startsWith(HOST_ROUTE_PREFIX)) {
    const rest = pathname.slice(HOST_ROUTE_PREFIX.length).split("?")[0] ?? "";
    const [rawServerId, section, ...tail] = rest.split("/").filter(Boolean);
    if (!rawServerId) {
      return { kind: "none" };
    }
    const serverId = decode(rawServerId);
    if (section === "plugins") {
      return { kind: "plugin", serverId };
    }
    if (section === "projects") {
      return { kind: "project", serverId };
    }
    if (tail.length === 0) {
      const normalized = normalizeHostSectionSlug(section ?? "");
      if (normalized) {
        return { kind: "host", serverId, section: normalized };
      }
    }
    return { kind: "none" };
  }

  const section = pathname.slice("/settings/".length).split("?")[0]?.split("/")[0] ?? "";
  return isSettingsSectionSlug(section) ? { kind: "section", section } : { kind: "none" };
}
