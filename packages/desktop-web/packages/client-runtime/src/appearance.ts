// FILE: appearance.ts
// Purpose: Per-device host presentation (colour and sidebar badge), ported from
//          the native app. Stored in app settings, never on the daemon.
// Layer: Client runtime settings logic
// Exports: host colour palette, badge options, and the defaults.

export const HOST_COLORS = [
  "none",
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type HostColor = (typeof HOST_COLORS)[number];
export type HostBadgeDisplay = "name" | "icon" | "hidden";

export const HOST_BADGE_DISPLAYS: readonly HostBadgeDisplay[] = ["name", "icon", "hidden"];

const HEX: Record<Exclude<HostColor, "none">, string> = {
  violet: "#7a6aa8",
  sky: "#3d7ea6",
  emerald: "#388068",
  orange: "#a4673a",
  pink: "#b05c80",
  indigo: "#6a70b8",
  teal: "#368080",
  red: "#b06260",
  amber: "#8f7838",
  blue: "#5179b0",
};

export function hostColorValue(color: HostColor): string | null {
  return color === "none" ? null : HEX[color];
}

export function isHostColor(value: string): value is HostColor {
  return (HOST_COLORS as readonly string[]).includes(value);
}

export interface HostAppearance {
  readonly color: HostColor;
  readonly badgeDisplay?: HostBadgeDisplay | undefined;
}

export const DEFAULT_HOST_APPEARANCE: HostAppearance = { color: "none" };

export function readHostAppearance(
  records:
    | Readonly<
        Record<
          string,
          { readonly color: string; readonly badgeDisplay?: HostBadgeDisplay | undefined }
        >
      >
    | undefined,
  hostId: string,
): HostAppearance {
  const stored = records?.[hostId];
  if (!stored || !isHostColor(stored.color)) return DEFAULT_HOST_APPEARANCE;
  return {
    color: stored.color,
    ...(stored.badgeDisplay ? { badgeDisplay: stored.badgeDisplay } : {}),
  };
}

/**
 * The badge the sidebar should draw for a host: the user's choice, or the
 * native app's default (local hidden, remote named).
 *
 * SidebarHostBadge renders this for connected-host thread rows and workspace
 * titles; the host row's colour dot uses the same stored appearance.
 */
export function resolveHostBadgeDisplay(input: {
  appearance: HostAppearance;
  isLocalHost: boolean;
}): HostBadgeDisplay {
  if (input.appearance.badgeDisplay) return input.appearance.badgeDisplay;
  return input.isLocalHost ? "hidden" : "name";
}
