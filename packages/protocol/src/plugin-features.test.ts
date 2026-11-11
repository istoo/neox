import { describe, expect, it } from "vitest";
import {
  BUILTIN_FEATURE_IDS,
  BuiltinFeaturesSchema,
  hiddenBuiltinSurfaces,
} from "./plugin-features.js";

describe("hiddenBuiltinSurfaces", () => {
  it("hides nothing when no switch is off", () => {
    expect(hiddenBuiltinSurfaces(undefined)).toEqual({
      hostSections: new Set(),
      settingsPages: new Set(),
      sidebarItems: new Set(),
    });
    expect(hiddenBuiltinSurfaces({ sessions: true })).toEqual({
      hostSections: new Set(),
      settingsPages: new Set(),
      sidebarItems: new Set(),
    });
  });

  it("maps switched-off features to every Neolix surface they own", () => {
    const hidden = hiddenBuiltinSurfaces({
      sessions: false,
      usage: false,
      otel: false,
      redact: false,
    });

    expect([...hidden.hostSections]).toEqual(["sessions", "usage", "masking"]);
    expect([...hidden.settingsPages]).toEqual(["quota", "privacy", "observability"]);
    expect([...hidden.sidebarItems]).toEqual(["history", "usage"]);
  });

  it("keeps a switch for a feature with no Neolix surface", () => {
    const hidden = hiddenBuiltinSurfaces({ tools: false });

    expect(hidden.hostSections.size).toBe(0);
    expect(hidden.settingsPages.size).toBe(0);
    expect(hidden.sidebarItems.size).toBe(0);
  });
});

describe("BuiltinFeaturesSchema", () => {
  it("accepts myna's feature ids and rejects unknown ones", () => {
    expect(BUILTIN_FEATURE_IDS).toContain("sessions");
    expect(BuiltinFeaturesSchema.parse({ sessions: false })).toEqual({ sessions: false });
    expect(BuiltinFeaturesSchema.safeParse({ not_a_feature: false }).success).toBe(false);
  });
});
