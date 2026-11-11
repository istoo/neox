import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { removeLocalStorageItem } from "../hooks/useLocalStorage";
import { useTerminalStateStore } from "../terminalStateStore";
import { adoptServerTerminalSurfaces } from "./serverTerminalSurface";

const TERMINAL = ThreadId.makeUnsafe("terminal-thread");
const CHAT = ThreadId.makeUnsafe("chat-thread");
const entryPoint = (threadId: ThreadId) =>
  useTerminalStateStore.getState().terminalStateByThreadId[threadId]?.entryPoint;

describe("adoptServerTerminalSurfaces", () => {
  beforeEach(() => {
    removeLocalStorageItem("neolix:adopted-terminal-surfaces");
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
  });

  it("opens a terminal-first thread as a terminal page on a client without its layout", () => {
    adoptServerTerminalSurfaces([{ id: TERMINAL, primarySurface: "terminal" }, { id: CHAT }], {
      complete: true,
    });
    expect(entryPoint(TERMINAL)).toBe("terminal");
    expect(entryPoint(CHAT)).toBeUndefined();
  });

  it("keeps the user's later choice instead of adopting the mark again", () => {
    adoptServerTerminalSurfaces([{ id: TERMINAL, primarySurface: "terminal" }], { complete: true });
    // Back to the default chat page: the store drops the default state.
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    adoptServerTerminalSurfaces([{ id: TERMINAL, primarySurface: "terminal" }], {
      complete: false,
    });
    adoptServerTerminalSurfaces([{ id: TERMINAL, primarySurface: "terminal" }], { complete: true });
    expect(entryPoint(TERMINAL)).toBeUndefined();
  });

  it("forgets threads a full snapshot no longer lists", () => {
    adoptServerTerminalSurfaces([{ id: TERMINAL, primarySurface: "terminal" }], { complete: true });
    adoptServerTerminalSurfaces([], { complete: true });
    useTerminalStateStore.setState({ terminalStateByThreadId: {} });
    adoptServerTerminalSurfaces([{ id: TERMINAL, primarySurface: "terminal" }], { complete: true });
    expect(entryPoint(TERMINAL)).toBe("terminal");
  });
});
