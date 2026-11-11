import { describe, expect, it } from "vitest";
import {
  GATEWAY_MODE_FALLBACK_VIEW,
  GATEWAY_MODE_HIDDEN_HOST_SECTIONS,
  GATEWAY_MODE_HIDDEN_PAGES,
  gatewayModeReasonFromServer,
} from "./gateway-mode";

describe("gateway mode's hidden parts", () => {
  it("hides the agents and library sections, as myna does", () => {
    expect([...GATEWAY_MODE_HIDDEN_HOST_SECTIONS].sort()).toEqual(["agents", "library"]);
    expect(GATEWAY_MODE_FALLBACK_VIEW).toBe("sources");
  });

  it("hides no app page: myna's GATEWAY_HIDES names only Agents and Library", () => {
    // app.js:45 `const GATEWAY_HIDES = ["agents", "library"]`. The agent-file
    // and desktop settings are rows inside pages, hidden by their own
    // components, not whole pages.
    expect([...GATEWAY_MODE_HIDDEN_PAGES]).toEqual([]);
  });
});

describe("gateway mode's reason from the daemon", () => {
  it("names the --gateway flag separately from a pinned setting", () => {
    expect(gatewayModeReasonFromServer("flag")).toBe("flag");
    expect(gatewayModeReasonFromServer("on")).toBe("pinned-on");
    expect(gatewayModeReasonFromServer("off")).toBe("pinned-off");
  });

  it("reads detection, not connection: no agents here versus agents found", () => {
    expect(gatewayModeReasonFromServer("no-agents")).toBe("no-agents");
    expect(gatewayModeReasonFromServer("")).toBe("agents");
  });
});
