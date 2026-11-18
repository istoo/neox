import { describe, expect, it, vi } from "vitest";

import { requestDetachSubagent, resolveDetachSubagentLabel } from "./subagentDetach.logic";

describe("resolveDetachSubagentLabel", () => {
  it("uses a real title and drops the default one", () => {
    expect(resolveDetachSubagentLabel("Review branch")).toBe("Review branch");
    expect(resolveDetachSubagentLabel("  Review branch  ")).toBe("Review branch");
    expect(resolveDetachSubagentLabel("New Agent")).toBeNull();
    expect(resolveDetachSubagentLabel("   ")).toBeNull();
    expect(resolveDetachSubagentLabel(null)).toBeNull();
  });
});

describe("requestDetachSubagent", () => {
  it("does nothing when the user cancels", async () => {
    const detach = vi.fn(async () => {});
    const onDetached = vi.fn();
    await expect(
      requestDetachSubagent({
        confirm: async () => false,
        detach,
        onDetached,
        reportError: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(detach).not.toHaveBeenCalled();
    expect(onDetached).not.toHaveBeenCalled();
  });

  it("detaches and then opens the standalone agent", async () => {
    const detach = vi.fn(async () => {});
    const onDetached = vi.fn();
    await expect(
      requestDetachSubagent({
        confirm: async () => true,
        detach,
        onDetached,
        reportError: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(detach).toHaveBeenCalledOnce();
    expect(onDetached).toHaveBeenCalledOnce();
  });

  it("reports a rejected detach without opening a thread", async () => {
    const reportError = vi.fn();
    const onDetached = vi.fn();
    await expect(
      requestDetachSubagent({
        confirm: async () => true,
        detach: async () => {
          throw new Error("agent is archived");
        },
        onDetached,
        reportError,
      }),
    ).resolves.toBe(false);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error));
    expect(onDetached).not.toHaveBeenCalled();
  });
});
