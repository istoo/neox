import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNeolixHome } from "@neolix/server/daemon-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectToDaemon } from "../../utils/client.js";
import { createLibraryCommand } from "./index.js";

vi.mock("../../utils/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/client.js")>();
  return { ...actual, connectToDaemon: vi.fn() };
});

const library = {
  dir: "/library",
  backupsDir: "/backups",
  homeDir: "/home",
  agents: [],
  instructions: { shared: "" },
  mcp: [],
  skills: [],
  hooks: [],
  subagents: [],
  counts: { mcp: 0, skills: 0, hooks: 0, subagents: 0, rtk: 0 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("library daemon selection", () => {
  it("connects to the home --home names, not NEOLIX_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "neolix-library-cli-"));
    const other = mkdtempSync(join(tmpdir(), "neolix-library-other-"));
    process.env.NEOLIX_HOME = other;
    const client = {
      getLibrary: vi.fn(async () => ({ library })),
      close: vi.fn(async () => undefined),
    };
    vi.mocked(connectToDaemon).mockResolvedValueOnce(client as never);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await createLibraryCommand().parseAsync(["--home", home], { from: "user" });
    } finally {
      write.mockRestore();
      delete process.env.NEOLIX_HOME;
    }
    expect(connectToDaemon).toHaveBeenLastCalledWith({
      target: { kind: "instance", home: resolveNeolixHome({ NEOLIX_HOME: home }) },
    });
    expect(client.getLibrary).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it("refuses --json instead of printing prose", async () => {
    await expect(createLibraryCommand().parseAsync(["--json"], { from: "user" })).rejects.toThrow(
      /no JSON output/,
    );
  });
});
