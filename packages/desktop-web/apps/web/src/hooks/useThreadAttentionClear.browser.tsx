import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useThreadAttentionClear } from "./useThreadAttentionClear";

const state = vi.hoisted(() => ({
  clearAgent: vi.fn(async (_input: unknown) => {}),
}));

vi.mock("../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nativeApi")>()),
  readNativeApi: () => ({
    neolix: { attention: { clearAgent: state.clearAgent } },
  }),
}));

it("clears on focus entry, composer focus, prompt send, and leaving the agent", async () => {
  vi.clearAllMocks();
  const hook = await renderHook(
    (props: { isFocused: boolean } | undefined) =>
      useThreadAttentionClear({ threadId: "agent-1", isFocused: props?.isFocused ?? true }),
    { initialProps: { isFocused: true } },
  );
  try {
    await expect.poll(() => state.clearAgent.mock.calls.length).toBe(1);
    expect(state.clearAgent).toHaveBeenCalledWith({ threadId: "agent-1" });

    hook.result.current.clearOnInputFocus();
    await expect.poll(() => state.clearAgent.mock.calls.length).toBe(2);
    hook.result.current.clearOnPromptSend();
    await expect.poll(() => state.clearAgent.mock.calls.length).toBe(3);

    const beforeBlur = state.clearAgent.mock.calls.length;
    await hook.rerender({ isFocused: false });
    await expect.poll(() => state.clearAgent.mock.calls.length).toBe(beforeBlur + 1);
  } finally {
    await hook.unmount();
  }
});
