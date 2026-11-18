// The provider's reply-header and request-header passthrough lists: only names
// the daemon can pass are written to the config, and a bad name says why.

import "../../../index.css";

import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { GatewayConfig, GatewayProvider } from "~/lib/gatewayTypes";

import { ProviderHeaderPassThrough } from "./GatewayProviderAdvanced";

function Harness({ onConfig }: { onConfig: (config: GatewayConfig) => void }) {
  const [config, setConfig] = useState<GatewayConfig>({
    version: 1,
    providers: [
      {
        id: "vendor",
        protocol: "openai",
        baseUrl: "https://api.example.com/v1",
        models: [],
      },
    ],
  });
  const edit = (mutate: (draft: GatewayConfig) => void) => {
    setConfig((current) => {
      const draft = structuredClone(current);
      mutate(draft);
      onConfig(draft);
      return draft;
    });
  };
  const provider = config.providers?.[0] as GatewayProvider | undefined;
  if (!provider) return null;
  return <ProviderHeaderPassThrough provider={provider} edit={edit} />;
}

it("writes reply header names canonically once they are passable", async () => {
  const drafts: GatewayConfig[] = [];
  const screen = await render(<Harness onConfig={(config) => drafts.push(config)} />);
  try {
    await expect.element(screen.getByText("No reply header listed.")).toBeVisible();
    await screen.getByRole("button", { name: "Add reply header" }).click();
    const input = screen.getByRole("textbox", { name: "Reply headers 1" });

    await input.fill("Cache-Control");
    await expect.element(screen.getByText("Cache-Control is never passed on.")).toBeVisible();
    expect(input.element().getAttribute("aria-invalid")).toBe("true");
    expect(drafts.at(-1)?.providers?.[0]?.replyHeaders).toBeUndefined();

    await input.fill(" x-trace ");
    expect(drafts.at(-1)?.providers?.[0]?.replyHeaders).toEqual(["X-Trace"]);
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});

it("refuses a name that is not a header name", async () => {
  const drafts: GatewayConfig[] = [];
  const screen = await render(<Harness onConfig={(config) => drafts.push(config)} />);
  try {
    await screen.getByRole("button", { name: "Add request header" }).click();
    const input = screen.getByRole("textbox", { name: "Request headers 1" });

    await input.fill("Bad Header");
    await expect.element(screen.getByText('"Bad Header" isn\'t a header name.')).toBeVisible();
    expect(drafts.at(-1)?.providers?.[0]?.passHeaders).toBeUndefined();

    await input.fill("Anthropic-Beta");
    expect(drafts.at(-1)?.providers?.[0]?.passHeaders).toEqual(["Anthropic-Beta"]);
  } finally {
    await screen.unmount();
    vi.clearAllMocks();
  }
});
