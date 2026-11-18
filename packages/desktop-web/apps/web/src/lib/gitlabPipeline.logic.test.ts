import { describe, expect, it } from "vitest";

import {
  flattenPipelineJobs,
  formatPipelineDuration,
  isPipelineActiveStatus,
  mapPipelineStatus,
} from "./gitlabPipeline.logic";

describe("isPipelineActiveStatus", () => {
  it("polls only while GitLab reports a transitional status", () => {
    for (const status of ["created", "preparing", "pending", "running", "canceling"]) {
      expect(isPipelineActiveStatus(status)).toBe(true);
    }
    for (const status of ["success", "failed", "canceled", "skipped", "manual", ""]) {
      expect(isPipelineActiveStatus(status)).toBe(false);
    }
    expect(isPipelineActiveStatus(null)).toBe(false);
  });
});

describe("mapPipelineStatus", () => {
  it("maps GitLab's vocabulary onto the shared check statuses", () => {
    expect(mapPipelineStatus("success")).toBe("success");
    expect(mapPipelineStatus("passed")).toBe("success");
    expect(mapPipelineStatus("failed")).toBe("failure");
    expect(mapPipelineStatus("canceled")).toBe("cancelled");
    expect(mapPipelineStatus("skipped")).toBe("skipped");
    expect(mapPipelineStatus("manual")).toBe("pending");
    expect(mapPipelineStatus("running")).toBe("pending");
    expect(mapPipelineStatus("something-new")).toBe("pending");
  });
});

describe("formatPipelineDuration", () => {
  it("formats elapsed seconds compactly and omits zero", () => {
    expect(formatPipelineDuration(7)).toBe("7s");
    expect(formatPipelineDuration(64)).toBe("1m 4s");
    expect(formatPipelineDuration(3_600)).toBe("1h");
    expect(formatPipelineDuration(3_661)).toBe("1h 1m 1s");
    expect(formatPipelineDuration(0)).toBeNull();
    expect(formatPipelineDuration(null)).toBeNull();
  });
});

function job(id: number, stage: string) {
  return {
    id,
    name: `job-${id}`,
    stage,
    status: "success" as const,
    url: null,
    allowFailure: false,
    durationSeconds: null,
  };
}

describe("flattenPipelineJobs", () => {
  it("flattens stages in order", () => {
    expect(
      flattenPipelineJobs([
        { name: "build", status: "success", jobs: [job(1, "build")] },
        { name: "test", status: "success", jobs: [job(2, "test"), job(3, "test")] },
      ]).map((entry) => entry.id),
    ).toEqual([1, 2, 3]);
  });
});
