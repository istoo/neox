import { describe, expect, it } from "vitest";

import { HOST_FEATURES, hostFeatureStatus, hostFeatureUnavailable } from "./hostFeatures.logic";

describe("hostFeatures", () => {
  it("is unknown until the flags arrive", () => {
    expect(hostFeatureStatus(null, HOST_FEATURES.sync)).toBe("unknown");
    expect(hostFeatureUnavailable(undefined, HOST_FEATURES.sync)).toBe(false);
  });

  it("is unavailable when the host does not advertise the flag", () => {
    expect(hostFeatureStatus({}, HOST_FEATURES.agentDetach)).toBe("unavailable");
    expect(hostFeatureStatus({ agentDetach: false }, HOST_FEATURES.agentDetach)).toBe(
      "unavailable",
    );
    expect(hostFeatureUnavailable({}, HOST_FEATURES.agentDetach)).toBe(true);
  });

  it("is available only on an explicit true", () => {
    expect(
      hostFeatureStatus(
        { checkoutForgeSetAutoMerge: true },
        HOST_FEATURES.checkoutForgeSetAutoMerge,
      ),
    ).toBe("available");
    expect(
      hostFeatureUnavailable(
        { checkoutForgeSetAutoMerge: true },
        HOST_FEATURES.checkoutForgeSetAutoMerge,
      ),
    ).toBe(false);
  });
});
