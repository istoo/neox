// The local guard model's confidence threshold: myna's default and scores,
// written to masking.modelScore, and only while masking runs with a model
// that can run on this host.

import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type {
  GatewayConfig,
  GatewayLocalModelStatus,
  GatewayMaskingConfig,
  GatewayMaskingSummary,
} from "~/lib/gatewayTypes";
import { useState } from "react";

import { GatewayMaskingPane } from "./GatewayMaskingPane";

const fixture = vi.hoisted(() => ({
  summary: vi.fn(),
  records: vi.fn(),
  localModel: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("~/lib/neolixGatewayApi", () => ({
  neolixGatewayApi: {
    maskingSummary: fixture.summary,
    maskingRecords: fixture.records,
    maskingLocalModelStatus: fixture.localModel,
    maskingPreview: fixture.preview,
  },
}));

const summary: GatewayMaskingSummary = {
  n: 0,
  distinct: 0,
  requests: 0,
  blocked: 0,
  restored: 0,
  days: [],
  kinds: [],
  agents: [],
  providers: [],
  values: [],
  by: { rule: 0, yours: 0, model: 0 },
};

function Harness({
  initial,
  onDraft,
}: {
  initial: GatewayConfig;
  onDraft: (config: GatewayConfig) => void;
}) {
  const [config, setConfig] = useState(initial);
  return (
    <GatewayMaskingPane
      config={config}
      edit={(mutate) =>
        setConfig((current) => {
          const draft = structuredClone(current);
          mutate(draft);
          onDraft(draft);
          return draft;
        })
      }
      apply={async () => {}}
    />
  );
}

async function renderPane(
  config: GatewayConfig,
  model: Partial<GatewayLocalModelStatus>,
  onDraft: (config: GatewayConfig) => void,
) {
  fixture.localModel.mockResolvedValue({
    model: "astrlink-guard",
    supported: true,
    installed: true,
    size: 1,
    score: 0.8,
    ...model,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness initial={config} onDraft={onDraft} />
    </QueryClientProvider>,
  );
}

function maskingConfig(
  patch: Omit<GatewayMaskingConfig, "enabled"> & { enabled?: boolean | undefined },
): GatewayConfig {
  return { version: 1, masking: { ...patch, enabled: patch.enabled ?? true } };
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.summary.mockResolvedValue(summary);
  fixture.records.mockResolvedValue({ records: [], more: false });
  fixture.preview.mockResolvedValue({ text: "", hits: [], blocked: false, off: false });
});

describe("the local guard model's confidence threshold", () => {
  it("offers the default and myna's scores, and writes the pick", async () => {
    const drafts: GatewayConfig[] = [];
    await renderPane(maskingConfig({ model: "astrlink-guard" }), { score: 0.8 }, (config) =>
      drafts.push(config),
    );
    const picker = page.getByRole("combobox", { name: "Confidence threshold" });
    await expect.element(picker).toBeVisible();
    const select = picker.element() as HTMLSelectElement;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Default (0.8)",
      "0.5",
      "0.6",
      "0.7",
      "0.85",
      "0.9",
      "0.95",
    ]);
    expect(select.value).toBe("");

    await userEvent.selectOptions(select, "0.9");
    expect(drafts.at(-1)?.masking?.modelScore).toBe(0.9);
    expect(select.value).toBe("0.9");

    await userEvent.selectOptions(select, "");
    expect(drafts.at(-1)?.masking?.modelScore).toBeUndefined();
  });

  it("shows a stored score outside the usual list instead of moving it", async () => {
    await renderPane(
      maskingConfig({ model: "astrlink-guard", modelScore: 0.73 }),
      { score: 0.73 },
      () => {},
    );
    const picker = page.getByRole("combobox", { name: "Confidence threshold" });
    await expect.element(picker).toBeVisible();
    const select = picker.element() as HTMLSelectElement;
    expect(select.value).toBe("0.73");
    expect([...select.options].map((option) => option.value)).toContain("0.73");
  });

  it("is absent while masking is off", async () => {
    await renderPane(
      maskingConfig({ enabled: false, personal: false, model: "astrlink-guard" }),
      {},
      () => {},
    );
    await expect
      .element(page.getByRole("combobox", { name: "Confidence threshold" }))
      .not.toBeInTheDocument();
  });

  it("is absent while the model cannot run here", async () => {
    await renderPane(
      maskingConfig({ model: "astrlink-guard" }),
      { supported: false, installed: false },
      () => {},
    );
    await expect
      .element(page.getByRole("combobox", { name: "Confidence threshold" }))
      .not.toBeInTheDocument();
  });

  it("says when the model has to be named for the threshold to apply", async () => {
    await renderPane(maskingConfig({ model: undefined }), {}, () => {});
    await expect
      .element(page.getByText("Takes effect when the guard model is astrlink-guard."))
      .toBeVisible();
  });
});

describe("the masking preview", () => {
  it("highlights each hit in the returned text and lists where it came from", async () => {
    fixture.preview.mockResolvedValue({
      text: "token «secret:1» and id «secret:2» done",
      hits: [
        {
          placeholder: "«secret:1»",
          kind: "api_key",
          by: "rule",
          head: "sk-live-abcdef",
          len: 18,
          action: "mask",
        },
        {
          placeholder: "«secret:2»",
          kind: "email",
          by: "yours",
          len: 11,
          action: "block",
        },
      ],
      blocked: true,
      off: false,
    });
    await renderPane(maskingConfig({ model: "astrlink-guard" }), {}, () => {});

    const input = page.getByRole("textbox", { name: "Text to try" });
    await input.fill("token sk-live-abcdef and id me@example.com done");
    await page.getByRole("button", { name: "Preview", exact: true }).click();

    await expect
      .poll(() => fixture.preview.mock.calls.at(-1)?.[0])
      .toBe("token sk-live-abcdef and id me@example.com done");

    const marks = Array.from(document.querySelectorAll("mark"));
    expect(marks.map((mark) => mark.textContent)).toEqual(["«secret:1»", "«secret:2»"]);
    expect(marks[0]!.className).toContain("bg-foreground/15");
    expect(marks[1]!.className).toContain("bg-destructive/20");

    const body = document.body.textContent ?? "";
    expect(body).toContain("«secret:1» · sk-l…cdef");
    expect(body).toContain("api_key");
    expect(body).toContain("rule");
    expect(body).toContain("mask");
    expect(body).toContain("18");
    expect(body).toContain("email");
    expect(body).toContain("yours");
    expect(body).toContain("block");
    expect(body).toContain("Held back");
  });
});
