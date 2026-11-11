// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { HtmlFrame, type HtmlFrameHandle } from "./index.web";

const noBridge = () => null;

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("HtmlFrame rendered no iframe");
  return frame as HTMLIFrameElement;
}

describe("HtmlFrame bridge", () => {
  it("answers the page's message with its id and forwards posted events", async () => {
    const ref = createRef<HtmlFrameHandle>();
    const bridge = vi.fn(async () => ({ ok: 1 }));
    const { container } = render(
      <HtmlFrame ref={ref} html="<html><body>page</body></html>" bridge={bridge} />,
    );
    const frame = frameOf(container);
    if (!frame.contentWindow) throw new Error("The iframe has no window");
    const reply = vi.spyOn(frame.contentWindow, "postMessage");

    const message = new MessageEvent("message", {
      data: { myna: 1, id: 7, method: "hello" },
    });
    Object.defineProperty(message, "source", { value: frame.contentWindow });
    window.dispatchEvent(message);

    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ myna: 1, id: 7, result: { ok: 1 } }, "*"),
    );
    expect(bridge).toHaveBeenCalledWith({ myna: 1, id: 7, method: "hello" });

    ref.current?.post({ event: "action", data: { id: "check" } });
    expect(reply).toHaveBeenCalledWith({ myna: 1, event: "action", data: { id: "check" } }, "*");
  });

  it("replies with the bridge's error and ignores other windows' messages", async () => {
    const bridge = vi.fn(() => {
      throw new Error("no method");
    });
    const { container } = render(
      <HtmlFrame html="<html><body>page</body></html>" bridge={bridge} />,
    );
    const frame = frameOf(container);
    if (!frame.contentWindow) throw new Error("The iframe has no window");
    const reply = vi.spyOn(frame.contentWindow, "postMessage");

    const stranger = new MessageEvent("message", { data: { myna: 1, id: 1, method: "read" } });
    window.dispatchEvent(stranger);
    expect(bridge).not.toHaveBeenCalled();

    const message = new MessageEvent("message", { data: { myna: 1, id: 2, method: "read" } });
    Object.defineProperty(message, "source", { value: frame.contentWindow });
    window.dispatchEvent(message);

    await waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ myna: 1, id: 2, error: "no method" }, "*"),
    );
  });

  it("sizes an embedded frame to the height the page reports", async () => {
    const { container } = render(
      <HtmlFrame html="<html><body>panel</body></html>" autoHeight bridge={noBridge} />,
    );
    const frame = frameOf(container);
    if (!frame.contentWindow) throw new Error("The iframe has no window");
    const message = new MessageEvent("message", {
      data: { myna: 1, method: "size", params: { height: 240 } },
    });
    Object.defineProperty(message, "source", { value: frame.contentWindow });
    window.dispatchEvent(message);
    await waitFor(() => expect(frame.style.height).toBe("240px"));
  });
});
