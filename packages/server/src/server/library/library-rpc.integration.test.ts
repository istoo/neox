import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestNeolixDaemon, type TestNeolixDaemon } from "../test-utils/neolix-daemon.js";

/**
 * The library's RPCs over a real daemon, in an isolated NEOLIX_HOME and HOME,
 * so the commands that change this computer's folders run for real.
 */
describe("library RPCs through a daemon", () => {
  let daemon: TestNeolixDaemon;
  let client: DaemonClient;
  let root: string;
  let home: string;
  let oldHome: string | undefined;
  let oldUserProfile: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "neolix-library-rpc-"));
    home = path.join(root, "home");
    await mkdir(home, { recursive: true });
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    daemon = await createTestNeolixDaemon({ mcpEnabled: false });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.1.70",
    });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
  });

  afterAll(async () => {
    await client?.close();
    await daemon?.close();
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    if (oldUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = oldUserProfile;
    }
    await rm(root, { recursive: true, force: true });
  });

  test("syncs, keeps a server local or direct, and moves skills", async () => {
    await client.saveLibraryMcpServer({
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
    });
    const synced = await client.syncLibrary();
    expect(synced.result.problems).toEqual([]);
    expect(synced.library.mcp[0]?.name).toBe("docs");

    const local = await client.setLibraryMcpLocal("docs", true);
    expect(local.library.mcp[0]?.local).toBe(true);

    const direct = await client.setLibraryMcpRouter("docs", true);
    expect(direct.library.mcp[0]?.router).toBe("direct");

    const source = path.join(root, "skill-src");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: One\n---\n");
    await client.importLibrarySkill(source);
    await client.setLibrarySkillAgents("skill-src", ["claude"]);
    await client.setLibrarySkillHere("skill-src", false);
    let snapshot = await client.getLibrary();
    expect(snapshot.library.skills.find((skill) => skill.name === "skill-src")?.offHere).toBe(true);
    await client.setLibrarySkillHere("skill-src", true);

    const shared = path.join(home, ".agents", "skills", "shared-one");
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(shared, "SKILL.md"), "---\ndescription: Shared\n---\n");
    await client.handOverLibrarySkills(["shared-one"]);
    snapshot = await client.getLibrary();
    expect(snapshot.library.skills.some((skill) => skill.name === "shared-one")).toBe(true);

    await client.handBackLibrarySkill("shared-one");
    const libraryDir = path.join(daemon.neolixHome, "library", "skills", "shared-one");
    expect(await lstat(libraryDir).then((info) => info.isSymbolicLink())).toBe(true);

    const second = path.join(root, "skill-two");
    await mkdir(second, { recursive: true });
    await writeFile(path.join(second, "SKILL.md"), "---\ndescription: Two\n---\n");
    await client.importLibrarySkill(second);
    const own = path.join(home, ".claude", "skills", "skill-two");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "SKILL.md"), "mine\n");
    await client.settleLibrarySkill("skill-two", "claude", false);
    expect(await lstat(own).then((info) => info.isSymbolicLink())).toBe(true);

    for (const name of ["skill-src", "shared-one", "skill-two"]) {
      await client.removeLibrarySkill(name);
    }
    snapshot = await client.getLibrary();
    expect(snapshot.library.skills).toEqual([]);

    await expect(client.runLibraryRtk("install", { distro: "Ubuntu" })).rejects.toThrow(
      /WSL distro named Ubuntu/,
    );
  }, 90_000);
});
