import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";

const fixture = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock("~/lib/neolixGatewayApi", () => ({
  neolixGatewayApi: {
    heldList: fixture.list,
    heldRead: fixture.read,
    heldReveal: fixture.reveal,
  },
}));

import { GatewayHeldReports, GatewayHeldRouteReport } from "./GatewayHeldReports";

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.list.mockResolvedValue({ names: ["held-1.txt", "held-2.txt"] });
  fixture.read.mockResolvedValue({ text: "HELD REPORT TEXT" });
  fixture.reveal.mockResolvedValue({ ok: true });
});

describe("gateway held reports", () => {
  it("lists the kept reports and opens one as text", async () => {
    await render(wrap(<GatewayHeldReports />));
    await expect.element(page.getByText("Held reports")).toBeVisible();
    await page.getByRole("button", { name: "held-1.txt" }).click();
    await expect.element(page.getByText("HELD REPORT TEXT")).toBeVisible();

    await page.getByRole("button", { name: "Open folder" }).click();
    expect(fixture.reveal).toHaveBeenCalledWith(undefined);
  });

  it("shows the held report of one past call with its copy action", async () => {
    await render(wrap(<GatewayHeldRouteReport name="held-1.txt" />));
    await expect.element(page.getByText("HELD REPORT TEXT")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy report" })).toBeEnabled();
    expect(fixture.read).toHaveBeenCalledWith("held-1.txt");
  });
});
