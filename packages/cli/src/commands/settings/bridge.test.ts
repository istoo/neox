import { describe, expect, it, vi } from "vitest";
import type { CommandOptions } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { patchAppSetting, readAppSettings } from "./bridge.js";

vi.mock("../../utils/client.js", () => ({ connectToDaemon: vi.fn() }));

const options = { daemonTarget: { kind: "instance", home: "/tmp/neolix" } } as CommandOptions;

function client(overrides: Record<string, unknown> = {}) {
  return {
    getSyncAppSettings: vi.fn(),
    patchSyncAppSetting: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function connecting(fake: ReturnType<typeof client>): void {
  vi.mocked(connectToDaemon).mockResolvedValue(fake as never);
}

describe("the app settings bridge", () => {
  it("reads the copy the daemon keeps", async () => {
    const fake = client({
      getSyncAppSettings: vi.fn().mockResolvedValue({ settings: { theme: "dark" } }),
    });
    connecting(fake);
    await expect(readAppSettings(options)).resolves.toEqual({ theme: "dark" });
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("says the daemon is not reachable instead of doing nothing", async () => {
    vi.mocked(connectToDaemon).mockRejectedValue(new Error("boom"));
    await expect(readAppSettings(options)).rejects.toThrow(
      "app settings are kept by the app and read through the daemon, which is not reachable: boom. Nothing was changed.",
    );
    await expect(patchAppSetting(options, "theme", "dark")).rejects.toThrow("Nothing was changed");
  });

  it("writes one key and closes the connection", async () => {
    const fake = client({ patchSyncAppSetting: vi.fn().mockResolvedValue({}) });
    connecting(fake);
    await patchAppSetting(options, "theme", "midnight");
    expect(fake.patchSyncAppSetting).toHaveBeenCalledWith("theme", "midnight");
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("reports the daemon's refusal as a failed write", async () => {
    const fake = client({
      patchSyncAppSetting: vi.fn().mockResolvedValue({ error: "already closed" }),
    });
    connecting(fake);
    await expect(patchAppSetting(options, "theme", "dark")).rejects.toThrow(
      "theme: already closed: nothing was changed",
    );
    expect(fake.close).toHaveBeenCalledOnce();
  });
});
