import "../../index.css";

import type {
  NativeApi,
  PullRequestPipelineResult,
  PullRequestPipelineSummary,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { PullRequestPipelineSection } from "./PullRequestPipelineSection";

const { getPipeline, openExternal } = vi.hoisted(() => ({
  getPipeline: vi.fn<NativeApi["pullRequests"]["pipeline"]>(),
  openExternal: vi.fn<NativeApi["shell"]["openExternal"]>(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    pullRequests: { pipeline: getPipeline },
    shell: { openExternal },
  }),
}));

const SUMMARY: PullRequestPipelineSummary = {
  id: 777,
  status: "running",
  url: "https://gitlab.example/pipelines/777",
};

function pipelineResult(
  overrides: Partial<PullRequestPipelineResult> = {},
): PullRequestPipelineResult {
  return {
    error: null,
    pipeline: {
      id: 777,
      status: "running",
      url: SUMMARY.url,
      ref: "main",
      sha: "abc123",
      stages: [
        {
          name: "verify",
          status: "running",
          jobs: [
            {
              id: 101,
              name: "build",
              stage: "verify",
              status: "success",
              url: "https://gitlab.example/jobs/101",
              allowFailure: false,
              durationSeconds: 64,
            },
            {
              id: 102,
              name: "lint",
              stage: "verify",
              status: "manual",
              url: "https://gitlab.example/jobs/102",
              allowFailure: true,
              durationSeconds: null,
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function renderSection(summary: PullRequestPipelineSummary | null = SUMMARY) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PullRequestPipelineSection cwd="/repo" changeRequestNumber={42} summary={summary} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getPipeline.mockReset();
  openExternal.mockReset();
});

describe("PullRequestPipelineSection", () => {
  it("groups jobs by stage, shows status and elapsed time, and opens the job logs", async () => {
    getPipeline.mockResolvedValue(pipelineResult());
    await renderSection();

    await expect.element(page.getByText("verify")).toBeVisible();
    await expect.element(page.getByText("Pipeline #777")).toBeVisible();
    await expect.element(page.getByText("build")).toBeVisible();
    await expect.element(page.getByText("1m 4s")).toBeVisible();
    await expect.element(page.getByText("lint")).toBeVisible();
    await expect.element(page.getByText("Allowed to fail")).toBeVisible();

    expect(getPipeline).toHaveBeenCalledWith({
      cwd: "/repo",
      pipelineId: 777,
      changeRequestNumber: 42,
    });

    await page.getByText("build").click();
    expect(openExternal).toHaveBeenCalledWith("https://gitlab.example/jobs/101");
  });

  it("keeps the pipeline visible when its jobs fail to load", async () => {
    getPipeline.mockResolvedValue(pipelineResult({ pipeline: null, error: "forge unavailable" }));
    await renderSection();

    await expect.element(page.getByText("Pipeline #777")).toBeVisible();
    await expect.element(page.getByText("Could not load pipeline jobs.")).toBeVisible();
  });

  it("renders nothing when the pull request has no pipeline", async () => {
    getPipeline.mockResolvedValue({ pipeline: null, error: null });
    await renderSection(null);

    await expect.element(page.getByText("Pipeline", { exact: true })).not.toBeInTheDocument();
    expect(getPipeline).not.toHaveBeenCalled();
  });
});
