import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useHostFeatures } from "./useHostFeatures";

const harness = vi.hoisted(() => ({
  getHostFeatures: vi.fn(),
  notify: null as null | (() => void),
  unsubscribe: vi.fn(),
}));

vi.mock("~/lib/neolixHostApi", () => ({ getHostFeatures: harness.getHostFeatures }));
vi.mock("~/wsTransportEvents", () => ({
  addWsTransportStateListener: () => () => {},
}));
vi.mock("~/wsNativeApi", () => ({
  onNeolixHostFeaturesUpdated: (listener: () => void) => {
    harness.notify = listener;
    return harness.unsubscribe;
  },
}));

function Probe() {
  const { featureStatus } = useHostFeatures();
  return <div data-sync={featureStatus("sync")} />;
}

const screens: Awaited<ReturnType<typeof render>>[] = [];
const clients: QueryClient[] = [];

afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
  for (const client of clients.splice(0)) client.clear();
  harness.getHostFeatures.mockReset();
  harness.notify = null;
});

it("refetches the flags when the host re-announces server_info", async () => {
  harness.getHostFeatures
    .mockResolvedValueOnce({ serverVersion: "0.16.0", features: { sync: true } })
    .mockResolvedValueOnce({ serverVersion: "0.16.0", features: { sync: false } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const screen = await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  screens.push(screen);

  await vi.waitFor(() => {
    expect(document.querySelector("[data-sync]")?.getAttribute("data-sync")).toBe("available");
  });
  expect(harness.getHostFeatures).toHaveBeenCalledTimes(1);

  // The bridge pushes a new server_info after its host daemon restarts; the transport stays
  // open, so only this signal can make the flags current again.
  act(() => harness.notify?.());

  await vi.waitFor(() => {
    expect(document.querySelector("[data-sync]")?.getAttribute("data-sync")).toBe("unavailable");
  });
  expect(harness.getHostFeatures).toHaveBeenCalledTimes(2);
});
