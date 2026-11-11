import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { daemonWebCommand } from "../daemon/web.js";
import { createWebCommand } from "./index.js";

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return { ...actual, connectToDaemon: vi.fn() };
});

const page = { mode: "off" as const, serving: false, link: null, network: [], error: null };

const served = {
  mode: "local" as const,
  serving: true,
  link: "http://127.0.0.1:3430",
  network: [],
  error: null,
};

function fakeDaemon(answer = page) {
  const client = {
    getWebPage: vi.fn(async () => answer),
    setWebPage: vi.fn(async () => ({ page: answer, error: undefined })),
    close: vi.fn(async () => undefined),
  };
  vi.mocked(connectToDaemon).mockResolvedValueOnce(client as never);
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web commands", () => {
  it("daemon web uses the daemon --home selects", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-web-cli-"));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = fakeDaemon();
    await daemonWebCommand().parseAsync(["--home", home], { from: "user" });
    expect(client.getWebPage).toHaveBeenCalled();
    expect(connectToDaemon).toHaveBeenLastCalledWith({
      target: { kind: "instance", home: resolveNeolixHome({ NEOLIX_HOME: home }) },
    });
    output.mockRestore();
    consoleLog.mockRestore();
  });

  it("web uses the daemon --home selects and does not open a browser", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-web-cli-"));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const client = fakeDaemon(served);
    await createWebCommand().parseAsync(["--home", home, "--no-open"], { from: "user" });
    expect(client.setWebPage).toHaveBeenCalled();
    expect(connectToDaemon).toHaveBeenLastCalledWith({
      target: { kind: "instance", home: resolveNeolixHome({ NEOLIX_HOME: home }) },
    });
    consoleLog.mockRestore();
  });
});
