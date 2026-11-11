import { ThreadId } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { emitWsTransportState } from "../wsTransportEvents";
import { useThreadComputerStateSeed } from "./useThreadComputerStateSeed";

const calls = vi.hoisted(() => ({
  getThreadState: vi.fn().mockResolvedValue(undefined),
  upsert: vi.fn(),
}));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ computer: { getThreadState: calls.getThreadState } }),
}));
vi.mock("../computerStateStore", () => ({
  useComputerStateStore: (
    selector: (store: { upsertThreadState: typeof calls.upsert }) => unknown,
  ) => selector({ upsertThreadState: calls.upsert }),
}));

// Neox hides the Computer surfaces; these cases cover the seeding logic itself.
vi.mock("~/neolixFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/neolixFeatures")>()),
  NEOLIX_COMPUTER_UI_ENABLED: true,
}));

it("restores thread state and server event interests after reconnect", async () => {
  const threadId = ThreadId.makeUnsafe("reconnect-thread");
  function Probe() {
    useThreadComputerStateSeed(threadId);
    return null;
  }
  calls.getThreadState.mockClear();
  const screen = await render(<Probe />);
  await expect.poll(() => calls.getThreadState.mock.calls.length).toBe(1);
  emitWsTransportState("connecting");
  expect(calls.getThreadState).toHaveBeenCalledTimes(1);
  emitWsTransportState("open");
  await expect.poll(() => calls.getThreadState.mock.calls.length).toBe(2);
  expect(calls.getThreadState).toHaveBeenLastCalledWith({ threadId });
  await screen.unmount();
  emitWsTransportState("open");
  expect(calls.getThreadState).toHaveBeenCalledTimes(2);
});
