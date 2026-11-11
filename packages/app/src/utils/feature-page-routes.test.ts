import { describe, expect, it } from "vitest";
import { resolveFeaturePageRoute } from "./feature-page-routes";

describe("feature page route ownership", () => {
  it("sends a cold start at /schedules to Scheduled tasks", () => {
    expect(resolveFeaturePageRoute("/schedules")).toBe("schedules");
  });

  it("keeps /schedules from landing on another feature page", () => {
    // Regression: a cold start at /schedules showed the old myna page.
    expect(resolveFeaturePageRoute("/schedules")).not.toBe("models");
  });

  it("sends the old /myna address to Models & quota", () => {
    expect(resolveFeaturePageRoute("/myna")).toBe("models");
    expect(resolveFeaturePageRoute("/models")).toBe("models");
  });

  it("owns the library and agents pages", () => {
    expect(resolveFeaturePageRoute("/library")).toBe("library");
    expect(resolveFeaturePageRoute("/agents")).toBe("agents");
  });

  it("matches whole path segments only", () => {
    expect(resolveFeaturePageRoute("/schedulesomething")).toBeNull();
    expect(resolveFeaturePageRoute("/h/local/workspace/1")).toBeNull();
    expect(resolveFeaturePageRoute("/settings")).toBeNull();
  });
});
