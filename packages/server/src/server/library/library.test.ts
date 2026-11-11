import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLibraryService, type LibraryService } from "./index.js";
import { listLibrarySkills } from "./skills.js";
import { readLibrary, resolveLibraryPaths } from "./store.js";
import type { LibraryAgentTarget } from "./paths.js";
import { BLOCK_BEGIN, BLOCK_END } from "./instructions.js";
import { checkMcpServerHealth } from "./health.js";
import { searchSkillMarket } from "./market.js";
import { NEOLIX_WEB_SEARCH_ID, searchMarketServers } from "./market-servers.js";
import { hubToolNames } from "./hub.js";

describe("library", () => {
  let root: string;
  let neolixHome: string;
  let home: string;
  let service: LibraryService;

  const env = { PATH: "", HOME: "" } as NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "neolix-library-"));
    neolixHome = path.join(root, "neolix");
    home = path.join(root, "home");
    await mkdir(neolixHome, { recursive: true });
    await mkdir(home, { recursive: true });
    env.HOME = home;
    service = createLibraryService({ neolixHome, homeDir: home, env });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("writes the shared instructions between its markers and keeps the user's text", async () => {
    const file = path.join(home, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# Mine\n\nKeep this line.\n");

    await service.saveInstructions({ shared: "Read the docs first.", agents: ["claude"] });

    const written = await readFile(file, "utf8");
    expect(written).toContain("# Mine");
    expect(written).toContain("Keep this line.");
    expect(written).toContain(BLOCK_BEGIN);
    expect(written).toContain("Read the docs first.");
    expect(written).toContain(BLOCK_END);

    const snapshot = await service.getSnapshot();
    const row = snapshot.instructions.agents.find((agent) => agent.agent === "claude");
    expect(row?.on).toBe(true);
    expect(row?.own).toBe(3);

    await service.saveInstructions({ agents: [] });
    const after = await readFile(file, "utf8");
    expect(after).toContain("Keep this line.");
    expect(after).not.toContain(BLOCK_BEGIN);
  });

  test("leaves a block the user edited until the library's text changes", async () => {
    const file = path.join(home, ".claude", "CLAUDE.md");
    await service.saveInstructions({ shared: "Shared one", agents: ["claude"] });
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("Shared one", "Edited by me"));

    await service.saveInstructions({ agents: ["claude"] });
    expect(await readFile(file, "utf8")).toContain("Edited by me");

    await service.saveInstructions({ shared: "Shared two" });
    const next = await readFile(file, "utf8");
    expect(next).toContain("Shared two");
    expect(next).not.toContain("Edited by me");
  });

  test("flags a block as edited only when the file's copy changed", async () => {
    const file = path.join(home, ".claude", "CLAUDE.md");
    await service.saveInstructions({ shared: "Library text", agents: ["claude"] });
    const row = async () =>
      (await service.getSnapshot()).instructions.agents.find((agent) => agent.agent === "claude");

    expect((await row())?.edited).toBe(false);

    // The library moved on but the file was not synced: the block still has
    // the text the library wrote last, so it is not the user's edit.
    await writeFile(path.join(neolixHome, "library", "instructions.md"), "New library text\n");
    expect((await row())?.edited).toBe(false);

    const written = await readFile(file, "utf8");
    await writeFile(file, written.replace("Library text", "Edited by me"));
    expect((await row())?.edited).toBe(true);
  });

  test("writes an MCP server into Claude Code's file and takes only it back", async () => {
    const file = path.join(home, ".claude.json");
    await writeFile(file, JSON.stringify({ mcpServers: { theirs: { command: "x" } }, other: 1 }));

    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "docs-server"],
      env: { TOKEN: "abc" },
      agents: ["claude"],
    });

    const saved = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
      other: number;
    };
    expect(saved.other).toBe(1);
    expect(saved.mcpServers.theirs).toEqual({ command: "x" });
    expect(saved.mcpServers.docs).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "docs-server"],
      env: { TOKEN: "abc" },
    });

    await service.removeMcpServer("docs");
    const removed = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(removed.mcpServers.docs).toBeUndefined();
    expect(removed.mcpServers.theirs).toEqual({ command: "x" });
  });

  test("keeps a field the user added to a managed MCP entry", async () => {
    const file = path.join(home, ".claude.json");
    await writeFile(file, "{}\n");
    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
    });

    const first = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    first.mcpServers.docs.alwaysLoad = true;
    await writeFile(file, `${JSON.stringify(first, null, 2)}\n`);

    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
    });

    const next = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(next.mcpServers.docs.alwaysLoad).toBe(true);
  });

  test("writes Codex's TOML table and keeps the rest of the file", async () => {
    const file = path.join(home, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'model = "gpt-5"\n\n# keep me\n');

    await service.saveMcpServer(null, {
      name: "web",
      transport: "http",
      url: "https://example.com/mcp",
      agents: ["codex"],
    });

    const saved = await readFile(file, "utf8");
    expect(saved).toContain('model = "gpt-5"');
    expect(saved).toContain("# keep me");
    expect(saved).toContain("[mcp_servers.web]");
    expect(saved).toContain('url = "https://example.com/mcp"');

    await service.setMcpAgents("web", []);
    const removed = await readFile(file, "utf8");
    expect(removed).not.toContain("[mcp_servers.web]");
    expect(removed).toContain("# keep me");
  });

  test("keeps the indentation of a field the user added to a managed Goose entry", async () => {
    const file = path.join(home, ".config", "goose", "config.yaml");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "");

    const server = {
      name: "docs",
      transport: "stdio" as const,
      command: "npx",
      args: ["-y", "docs-server"],
      agents: ["goose"],
    };
    await service.saveMcpServer(null, server);
    const written = await readFile(file, "utf8");
    expect(written).toContain("  docs:\n");

    await writeFile(
      file,
      written.replace("    timeout: 300", "    timeout: 300\n    my_extra: keep-me"),
    );
    await service.saveMcpServer(null, server);

    const next = await readFile(file, "utf8");
    expect(next).toContain("    my_extra: keep-me");
    expect(next).not.toMatch(/^my_extra:/m);
  });

  test("links a skill folder into an agent's skills and unlinks it when unticked", async () => {
    const source = path.join(root, "source-skill");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Does a thing\n---\n\nBody\n");

    const imported = await service.importSkill(source);
    expect(imported.library.skills[0]).toMatchObject({
      name: "source-skill",
      description: "Does a thing",
    });

    await service.setSkillAgents("source-skill", ["claude"]);
    const link = path.join(home, ".claude", "skills", "source-skill");
    expect(await readlink(link)).toBe(path.join(neolixHome, "library", "skills", "source-skill"));

    await service.setSkillAgents("source-skill", []);
    await expect(readlink(link)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("writes a hook into Claude's settings and takes it back", async () => {
    const file = path.join(home, ".claude", "settings.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ theme: "dark" }));

    await service.saveHook(null, {
      name: "notify",
      event: "turn-end",
      command: "say done",
      agents: ["claude"],
    });

    const saved = JSON.parse(await readFile(file, "utf8")) as {
      theme: string;
      hooks: Record<string, unknown[]>;
    };
    expect(saved.theme).toBe("dark");
    expect(saved.hooks.Stop).toHaveLength(1);

    await service.removeHook("notify");
    const removed = JSON.parse(await readFile(file, "utf8")) as {
      theme: string;
      hooks?: unknown;
    };
    expect(removed.theme).toBe("dark");
    expect(removed.hooks).toBeUndefined();
  });

  test("writes a subagent file and removes it only while unchanged", async () => {
    await service.saveSubagent(null, {
      name: "reviewer",
      description: "Reviews a diff",
      prompt: "Review the change.",
      agents: ["claude"],
    });

    const file = path.join(home, ".claude", "agents", "reviewer.md");
    const written = await readFile(file, "utf8");
    expect(written).toContain('name: "reviewer"');
    expect(written).toContain("Review the change.");

    await writeFile(file, `${written}\nsomething mine\n`);
    await service.setSubagentAgents("reviewer", []);
    expect(await readFile(file, "utf8")).toContain("something mine");
  });

  test("keeps a copy of every file before it writes it", async () => {
    const file = path.join(home, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "before\n");

    const mutation = await service.saveInstructions({ shared: "after", agents: ["claude"] });
    expect(mutation.result.backup).toBeDefined();
    const copy = await readFile(
      path.join(mutation.result.backup ?? "", "claude", "CLAUDE.md"),
      "utf8",
    );
    expect(copy).toBe("before\n");
  });

  test("creates a set, switches the agents to it, and writes that text", async () => {
    const created = await service.saveInstructions({
      create: { id: "work", name: "Work" },
      texts: { work: "Work rules" },
    });
    expect(created.library.instructions.sets.map((set) => set.id)).toEqual(["default", "work"]);
    expect(created.library.instructions.sets.find((set) => set.id === "work")?.active).toBe(true);

    await service.saveInstructions({ agents: ["claude"] });
    const file = path.join(home, ".claude", "CLAUDE.md");
    expect(await readFile(file, "utf8")).toContain("Work rules");

    // The default set is empty and the file has nothing of the user's, so
    // switching back leaves no file behind.
    await service.saveInstructions({ activate: "default" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("hands the library's servers to an agent's launch config", async () => {
    expect(service.mcpServersForAgent("claude")).toEqual({});
    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "docs-server"],
      agents: ["claude"],
    });
    expect(service.mcpServersForAgent("claude")).toEqual({
      docs: { type: "stdio", command: "npx", args: ["-y", "docs-server"] },
    });
    expect(service.mcpServersForAgent("codex")).toEqual({});
  });

  test("keeps a config file's permissions when it writes it", async () => {
    const file = path.join(home, ".claude.json");
    await writeFile(file, "{}\n");
    await chmod(file, 0o600);

    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
    });

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(neolixHome, "library", "library.json"))).mode & 0o777).toBe(0o600);
  });

  test("reports no RTK when it is not on PATH", async () => {
    const status = await service.getRtk();
    expect(status.installed).toBe(false);
    expect(status.agents.map((agent) => agent.id)).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
      "pi",
      "omp",
    ]);
  });

  test("discovers what an agent already has and imports a copy", async () => {
    await mkdir(path.join(home, ".claude", "skills", "theirs"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "skills", "theirs", "SKILL.md"),
      "---\nname: theirs\ndescription: Their skill\n---\nBody\n",
    );
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          existing: { type: "stdio", command: "npx", args: ["-y", "existing"], env: { KEY: "v" } },
        },
      }),
    );

    const view = await service.discover();
    expect(view.servers.map((server) => server.name)).toEqual(["existing"]);
    expect(view.servers[0]?.agents).toEqual(["claude"]);
    expect(view.skills.map((skill) => skill.name)).toEqual(["theirs"]);
    expect(view.skills[0]?.description).toBe("Their skill");

    const { library, result } = await service.importDiscovered({
      servers: ["existing"],
      skills: ["theirs"],
    });
    expect(result.problems).toEqual([]);
    expect(library.mcp.find((server) => server.name === "existing")?.env).toEqual({ KEY: "v" });
    expect(library.skills.map((skill) => skill.name)).toEqual(["theirs"]);
    expect(
      await readFile(path.join(home, ".claude", "skills", "theirs", "SKILL.md"), "utf8"),
    ).toContain("Their skill");

    const after = await service.discover();
    expect(after.servers).toEqual([]);
    expect(after.skills).toEqual([]);
  });

  test("marks a server run from the agent's own app bundle as own", async () => {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.node_repl]",
        'command = "/Applications/Codex.app/Contents/Resources/cua_node/node_repl"',
        "",
        "[mcp_servers.gh]",
        'command = "gh-mcp"',
        "",
      ].join("\n"),
    );

    const view = await service.discover();
    const own = Object.fromEntries(
      view.servers.map((server) => [server.name, server.own === true]),
    );
    expect(own).toEqual({ node_repl: true, gh: false });
  });

  test("takes a found server and skill out of every agent, keeping a backup", async () => {
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          theirs: { type: "stdio", command: "npx", args: ["-y", "theirs"] },
          keep: { type: "stdio", command: "npx", args: ["-y", "keep"] },
        },
      }),
    );
    await mkdir(path.join(home, ".claude", "skills", "theirs"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "skills", "theirs", "SKILL.md"),
      "---\nname: theirs\ndescription: Their skill\n---\nBody\n",
    );

    const { library, result } = await service.removeDiscovered({
      servers: ["theirs"],
      skills: ["theirs"],
    });
    expect(result.problems).toEqual([]);
    expect(library.mcp.map((server) => server.name)).not.toContain("theirs");

    const config = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.theirs).toBeUndefined();
    expect(config.mcpServers.keep).toBeDefined();
    await expect(stat(path.join(home, ".claude", "skills", "theirs"))).rejects.toThrow();

    const backups = await service.listBackups();
    expect(backups.length).toBeGreaterThan(0);
    const after = await service.discover();
    expect(after.servers.map((server) => server.name)).toEqual(["keep"]);
    expect(after.skills).toEqual([]);
  });

  test("keeps a backup of a library skill before removing it", async () => {
    const source = path.join(root, "precious-skill");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Precious\n---\nBody\n");
    await service.importSkill(source);

    const removed = await service.removeSkill("precious-skill");
    expect(removed.library.skills.map((skill) => skill.name)).not.toContain("precious-skill");

    const backups = await service.listBackups();
    const files = backups.flatMap((backup) => backup.files.library ?? []);
    expect(files.map((file) => file.file)).toContain("skills/precious-skill/SKILL.md");
    expect(
      await stat(path.join(neolixHome, "library", "skills", "precious-skill")).catch(() => null),
    ).toBeNull();
  });

  test("keeps a library skill when its backup could not be copied", async () => {
    const source = path.join(root, "keep-me");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Keep me\n---\nBody\n");
    await service.importSkill(source);
    await symlink(
      path.join(root, "missing"),
      path.join(neolixHome, "library", "skills", "keep-me", "dangling"),
    );

    await expect(service.removeSkill("keep-me")).rejects.toThrow(/ENOENT/);

    expect(
      await readFile(path.join(neolixHome, "library", "skills", "keep-me", "SKILL.md"), "utf8"),
    ).toContain("Keep me");
    expect((await service.getSnapshot()).skills.map((skill) => skill.name)).toContain("keep-me");
  });

  test("keeps a found skill in place when its backup could not be copied", async () => {
    const folder = path.join(home, ".claude", "skills", "theirs");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SKILL.md"), "---\nname: theirs\ndescription: Theirs\n---\n");
    await symlink(path.join(root, "missing"), path.join(folder, "dangling"));

    await expect(service.removeDiscovered({ servers: [], skills: ["theirs"] })).rejects.toThrow(
      /ENOENT/,
    );

    expect(await readFile(path.join(folder, "SKILL.md"), "utf8")).toContain("Theirs");
  });

  test("refuses to take out a server the agent's app writes itself", async () => {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(
      path.join(home, ".codex", "config.toml"),
      [
        "[mcp_servers.node_repl]",
        'command = "/Applications/Codex.app/Contents/Resources/cua_node/node_repl"',
        "",
      ].join("\n"),
    );

    await expect(service.removeDiscovered({ servers: ["node_repl"], skills: [] })).rejects.toThrow(
      /put there by the agent's app itself/,
    );
    const config = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
    expect(config).toContain("node_repl");
  });

  test("reads the myna library and imports without touching its files", async () => {
    const mynaDir = path.join(home, ".config", "myna");
    await mkdir(path.join(mynaDir, "library", "skills", "shared-skill"), { recursive: true });
    await writeFile(
      path.join(mynaDir, "library", "skills", "shared-skill", "SKILL.md"),
      "---\ndescription: From myna\n---\nBody\n",
    );
    const dataFile = path.join(mynaDir, "library.json");
    const original = JSON.stringify({
      mcp: [
        {
          name: "myna-server",
          transport: "stdio",
          command: "uvx",
          args: ["thing"],
          env: { TOKEN: "secret" },
          agents: ["claude", "unknown-agent"],
        },
      ],
      skills: [{ name: "shared-skill", agents: ["codex", "unknown-agent"] }],
    });
    await writeFile(dataFile, original);

    const view = await service.getMynaLibrary();
    expect(view.available).toBe(true);
    expect(view.servers[0]?.agents).toEqual(["claude"]);
    expect(view.servers[0]?.env).toEqual({ TOKEN: "secret" });

    const imported = await service.importMynaLibrary({
      servers: ["myna-server"],
      skills: ["shared-skill"],
    });
    expect(imported.library.skills.map((skill) => skill.name)).toEqual(["shared-skill"]);
    expect(imported.library.mcp.find((server) => server.name === "myna-server")?.env).toEqual({
      TOKEN: "secret",
    });
    expect(await readFile(dataFile, "utf8")).toBe(original);
  });

  test("lists backups and puts one file back", async () => {
    const file = path.join(home, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "The original words.\n");

    await service.saveInstructions({ shared: "Shared text", agents: ["claude"] });
    const sessions = await service.listBackups();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.files.claude?.[0]?.file).toBe("CLAUDE.md");
    expect(sessions[0]?.files.claude?.[0]?.target).toBe(file);

    await writeFile(file, "Something else.\n");
    await service.restoreBackup("claude", sessions[0]?.stamp ?? "", "CLAUDE.md");
    expect(await readFile(file, "utf8")).toBe("The original words.\n");
  });

  test("moves an agent's own text into the shared text, then rewrites its block", async () => {
    const file = path.join(home, ".claude", "CLAUDE.md");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# Mine\n\nMy own words.\n");
    await service.saveInstructions({ shared: "Shared text", agents: ["claude"] });
    await writeFile(file, `${await readFile(file, "utf8")}\nMore of my own words.\n`);

    await service.saveInstructions({ importOwn: ["claude"] });
    const snapshot = await service.getSnapshot();
    expect(snapshot.instructions.shared).toContain("Shared text");
    expect(snapshot.instructions.shared).toContain("More of my own words.");
    const moved = await readFile(file, "utf8");
    expect(moved).toContain(BLOCK_BEGIN);
    expect(moved.trimEnd().endsWith(BLOCK_END)).toBe(true);

    await writeFile(file, moved.replace("Shared text", "Edited in the file"));
    await service.saveInstructions({ rewrite: ["claude"] });
    const rewritten = await readFile(file, "utf8");
    expect(rewritten).toContain("More of my own words.");
    expect(rewritten).not.toContain("Edited in the file");
  });

  test("installs a skill from a folder and updates it from the same source", async () => {
    const source = path.join(root, "source-skills", "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Demo\n---\nOne\n");

    const candidates = await service.findSkills({ kind: "folder", dir: path.dirname(source) });
    expect(candidates.map((candidate) => candidate.name)).toEqual(["demo"]);
    expect(candidates[0]?.description).toBe("Demo");

    const installed = await service.installSkills({ kind: "folder", dir: path.dirname(source) }, [
      "demo",
    ]);
    const skill = installed.library.skills[0];
    expect(skill?.source?.kind).toBe("folder");
    expect(skill?.commit).toBeUndefined();
    expect(skill?.modified).toBe(false);

    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Demo\n---\nTwo\n");
    const checks = await service.checkSkillUpdates();
    expect(checks).toEqual([{ name: "demo", available: true, gone: false }]);

    const updated = await service.updateSkills(["demo"]);
    expect(
      await readFile(path.join(neolixHome, "library", "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("Two");
    expect(updated.library.skills[0]?.modified).toBe(false);
  });

  test("keeps the old skill copy when an update cannot be copied", async () => {
    const sourceRoot = path.join(root, "copy-fail-source");
    const source = path.join(sourceRoot, "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Demo\n---\nOne\n");
    await service.installSkills({ kind: "folder", dir: sourceRoot }, ["demo"]);

    await symlink(path.join(source, "missing"), path.join(source, "dangling"));
    await expect(service.updateSkills(["demo"])).rejects.toThrow(/ENOENT/);

    expect(
      await readFile(path.join(neolixHome, "library", "skills", "demo", "SKILL.md"), "utf8"),
    ).toContain("One");
  });

  test("does not mark a skill gone when its source cannot be read", async () => {
    const sourceRoot = path.join(root, "gone-source");
    const source = path.join(sourceRoot, "demo");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Demo\n---\nOne\n");
    await service.installSkills({ kind: "folder", dir: sourceRoot }, ["demo"]);

    await rm(sourceRoot, { recursive: true, force: true });
    await expect(service.updateSkills(["demo"])).rejects.toThrow(/is not a folder/);

    const stored = await readLibrary(resolveLibraryPaths(neolixHome).dataFile);
    expect(stored?.skills.find((skill) => skill.name === "demo")?.gone).toBeFalsy();
  });

  test("copies skills into agents and links them into the shared folder", async () => {
    const source = path.join(root, "copy-source", "copied");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Copied\n---\nBody\n");
    await service.installSkills({ kind: "folder", dir: path.dirname(source) }, ["copied"]);

    await service.setSkillOptions({ copySkills: true, sharedSkills: true });
    await service.setSkillAgents("copied", ["claude"]);

    const destination = path.join(home, ".claude", "skills", "copied");
    const info = await stat(destination);
    expect(info.isDirectory()).toBe(true);
    expect((await stat(destination)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(destination, ".neolix-library.json"), "utf8")).toContain(
      "copied",
    );
    expect(await readlink(path.join(home, ".agents", "skills", "copied"))).toBe(
      path.join(neolixHome, "library", "skills", "copied"),
    );

    await service.setSkillOptions({ sharedSkills: false });
    await expect(stat(path.join(home, ".agents", "skills", "copied"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await service.setSkillAgents("copied", []);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("turns individual tools off with a Claude deny rule and takes it back", async () => {
    const file = path.join(home, ".claude.json");
    await writeFile(file, "{}\n");
    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
      disabledTools: ["search", "fetch"],
    });

    const withRules = JSON.parse(await readFile(file, "utf8")) as {
      permissions?: { deny?: string[] };
    };
    expect(withRules.permissions?.deny).toEqual(["mcp__docs__fetch", "mcp__docs__search"]);

    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
    });
    const without = JSON.parse(await readFile(file, "utf8")) as {
      permissions?: { deny?: string[] };
      mcpServers: Record<string, unknown>;
    };
    expect(without.permissions?.deny).toBeUndefined();
    expect(without.mcpServers.docs).toBeDefined();
  });

  test("reports a health check that never answers as a failure", async () => {
    const health = await checkMcpServerHealth(
      {
        name: "slow",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "setTimeout(() => undefined, 5000)"],
        agents: [],
      },
      { timeoutMs: 300, env: process.env },
    );
    expect(health.ok).toBe(false);
    expect(health.tools).toEqual([]);
    expect(health.error).toBeTruthy();
  });

  test("reads skills.sh search results", async () => {
    const requested: string[] = [];
    const hits = await searchSkillMarket("browser", {
      fetchImpl: (async (input: string | URL | Request) => {
        requested.push(String(input));
        return new Response(
          JSON.stringify({
            skills: [
              {
                id: "acme/skills/browser",
                name: "browser",
                source: "acme/skills",
                skillId: "browser",
                installs: 42,
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    expect(requested[0]).toBe("https://skills.sh/api/search?q=browser");
    expect(hits).toEqual([
      {
        id: "acme/skills/browser",
        name: "browser",
        source: "acme/skills",
        installs: 42,
        url: "https://skills.sh/acme/skills/browser",
      },
    ]);
    expect(
      await searchSkillMarket("   ", {
        fetchImpl: (async () => new Response("{}")) as typeof fetch,
      }),
    ).toEqual([]);
  });

  test("searches the shipped market snapshot and installs a server from it", async () => {
    const snapshot = path.join(root, "snapshot.json");
    await writeFile(
      snapshot,
      JSON.stringify([
        {
          name: "io.github.acme/demo-mcp",
          title: "Demo",
          description: "A demo server",
          repository: { url: "https://github.com/acme/demo-mcp" },
          packages: [
            {
              registryType: "npm",
              identifier: "@acme/demo-mcp",
              transport: { type: "stdio" },
              environmentVariables: [{ name: "DEMO_KEY", isRequired: true, isSecret: true }],
            },
          ],
        },
      ]),
    );
    const market = createLibraryService({
      neolixHome: path.join(root, "market-home"),
      homeDir: home,
      env,
      marketSnapshot: snapshot,
      marketFetch: (async () =>
        new Response(JSON.stringify({ servers: [] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const found = (await market.searchMarketServers("demo")).servers;
    expect(found.map((server) => server.name)).toContain("demo");
    const entry = found.find((server) => server.name === "demo");
    expect(entry?.inputs.map((input) => input.key)).toEqual(["DEMO_KEY"]);

    const installed = await market.installMarketServer(
      "io.github.acme/demo-mcp",
      {
        DEMO_KEY: "secret",
      },
      ["claude"],
    );
    const server = installed.library.mcp.find((item) => item.name === "demo");
    expect(server?.command).toBe("npx");
    expect(server?.args).toEqual(["-y", "@acme/demo-mcp"]);
    expect(server?.env).toEqual({ DEMO_KEY: "secret" });
    expect(server?.agents).toEqual(["claude"]);

    const again = (await market.searchMarketServers("demo")).servers;
    expect(again.find((item) => item.name === "demo")?.have).toBe("demo");
  });

  test("a market server that needs a value refuses to install without it", async () => {
    const market = createLibraryService({
      neolixHome: path.join(root, "market-home-2"),
      homeDir: home,
      env,
      marketFetch: (async () =>
        new Response(JSON.stringify({ servers: [] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    await expect(market.installMarketServer("github", {}, ["claude"])).rejects.toThrow(
      /needs Personal access token/,
    );
  });

  test("hub on writes one Neox entry with the agent's key, and off restores the servers", async () => {
    service.setHub({
      baseUrl: () => "http://127.0.0.1:6768",
      keyForAgent: async () => "hub-key",
    });
    const file = path.join(home, ".claude.json");
    await writeFile(file, "{}\n");
    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
    });

    await service.setMcpHub(true);
    const hubOnly = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(hubOnly.mcpServers)).toEqual(["neox-hub"]);
    expect(hubOnly.mcpServers["neox-hub"]).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:6768/mcp/neox/hub/claude",
      headers: { Authorization: "Bearer hub-key" },
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.mcpHub).toBe(true);

    await service.setMcpHub(false);
    const direct = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(direct.mcpServers)).toEqual(["docs"]);
  });

  test("names hub tools <server>__<tool>, cut to 64 characters", () => {
    const named = hubToolNames([
      { server: "docs", tool: "search", inputSchema: {} },
      { server: "docs", tool: "search", inputSchema: {} },
      { server: "a".repeat(70), tool: "b".repeat(20), inputSchema: {} },
    ]);
    expect(named[0]?.name).toBe("docs__search");
    expect(named[1]?.name).toBe("docs__search_2");
    expect(named[2]?.name.length).toBeLessThanOrEqual(64);
  });

  test("keeps the snapshot's servers when the live registry fails, and says why", async () => {
    const market = createLibraryService({
      neolixHome: path.join(root, "market-home-3"),
      homeDir: home,
      env,
      marketFetch: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });
    const found = await market.searchMarketServers("github");
    expect(found.servers.map((server) => server.name)).toContain("github");
    expect(found.registryError).toContain("the MCP Registry");
  });

  test("installs Neox's web search with the daemon's address and a hub key", async () => {
    const searchService = createLibraryService({
      neolixHome: path.join(root, "market-home-4"),
      homeDir: home,
      env,
      marketFetch: (async () =>
        new Response(JSON.stringify({ servers: [] }), {
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    searchService.setHub({
      baseUrl: () => "http://127.0.0.1:6768",
      keyForAgent: async (agent) => (agent === NEOLIX_WEB_SEARCH_ID ? "search-key" : null),
    });
    const found = await searchService.searchMarketServers("search");
    expect(found.servers.map((server) => server.name)).toContain(NEOLIX_WEB_SEARCH_ID);

    const installed = await searchService.installMarketServer(NEOLIX_WEB_SEARCH_ID, {}, [
      "claude",
      "codex",
    ]);
    const server = installed.library.mcp.find((item) => item.name === NEOLIX_WEB_SEARCH_ID);
    expect(server?.url).toBe("http://127.0.0.1:6768/mcp/myna/web-search");
    expect(server?.headers).toEqual({ Authorization: "Bearer search-key" });
    expect(server?.agents).toEqual(["claude", "codex"]);

    const again = await searchService.searchMarketServers("search");
    expect(again.servers.find((item) => item.name === NEOLIX_WEB_SEARCH_ID)?.have).toBe(
      NEOLIX_WEB_SEARCH_ID,
    );
  });

  test("offers Neox's own vision and image servers, with no agent picked", async () => {
    const outcome = await searchMarketServers("neox", { mcp: [] }, { live: false });
    for (const id of ["neox-vision", "neox-image"]) {
      const entry = outcome.servers.find((server) => server.id === id);
      expect(entry?.optIn).toBe(true);
      expect(entry?.have).toBeUndefined();
    }

    service.setHub({
      baseUrl: () => "http://127.0.0.1:6768",
      keyForAgent: async () => null,
    });
    const { library } = await service.installMarketServer("neox-vision", {}, []);
    const installed = library.mcp.find((server) => server.name === "neox-vision");
    expect(installed?.url).toBe("http://127.0.0.1:6768/mcp/myna/vision");
    expect(installed?.agents).toEqual([]);
  });

  test("keeps a server direct: its own entry beside the hub", async () => {
    service.setHub({
      baseUrl: () => "http://127.0.0.1:6768",
      keyForAgent: async () => null,
    });
    const file = path.join(home, ".claude.json");
    await writeFile(file, "{}\n");
    await service.saveMcpServer(null, {
      name: "docs",
      transport: "stdio",
      command: "npx",
      agents: ["claude"],
      router: "direct",
    });
    await service.setMcpHub(true);

    const written = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(written.mcpServers).sort()).toEqual(["docs", "neox-hub"]);
    expect((await service.getSnapshot()).mcp[0]?.router).toBe("direct");

    await service.setMcpRouter("docs", false);
    const shared = JSON.parse(await readFile(file, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(shared.mcpServers)).toEqual(["neox-hub"]);
    expect((await service.getSnapshot()).mcp[0]?.router).toBeUndefined();
  });

  test("keeps a local server out of the carried library and keeps it here", async () => {
    await service.saveMcpServer(null, {
      name: "mine",
      transport: "stdio",
      command: "mine",
      agents: [],
      local: true,
    });
    expect((await service.getSnapshot()).mcp[0]?.local).toBe(true);

    await service.setMcpLocal("mine", false);
    expect((await service.getSnapshot()).mcp[0]?.local).toBeUndefined();
  });

  test("turns a skill off here alone, and writes none of it", async () => {
    const source = path.join(root, "skill-source");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: One\n---\n");
    await service.importSkill(source);
    await service.setSkillAgents("skill-source", ["claude"]);

    const skillsDir = path.join(home, ".claude", "skills");
    expect(await stat(path.join(skillsDir, "skill-source")).catch(() => null)).not.toBeNull();

    await service.setSkillHere("skill-source", false);
    const off = await service.getSnapshot();
    expect(off.skills[0]?.offHere).toBe(true);
    expect(await stat(path.join(skillsDir, "skill-source")).catch(() => null)).toBeNull();

    await service.setSkillHere("skill-source", true);
    expect(await stat(path.join(skillsDir, "skill-source")).catch(() => null)).not.toBeNull();
  });

  test("hands a shared skill over to the library, and back", async () => {
    const shared = path.join(home, ".agents", "skills", "shared-one");
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(shared, "SKILL.md"), "---\ndescription: Shared\n---\n");

    await service.handOverSkills(["shared-one"]);
    const libraryDir = path.join(neolixHome, "library", "skills", "shared-one");
    expect(await stat(libraryDir).then((info) => info.isDirectory())).toBe(true);
    expect(await stat(shared).catch(() => null)).toBeNull();
    expect((await service.getSnapshot()).skills[0]?.name).toBe("shared-one");

    await service.handBackSkill("shared-one");
    expect(await stat(shared).then((info) => info.isDirectory())).toBe(true);
    expect(await lstat(libraryDir).then((info) => info.isSymbolicLink())).toBe(true);

    const back = await service.getSnapshot();
    expect(back.skills[0]?.shared).toBe(shared);
    expect(back.skills[0]?.sharedElsewhere).toBeUndefined();
    expect(back.skills[0]?.always).toContain("codex");
  });

  test("reports a shared entry that only links to the library's folder", async () => {
    const source = path.join(root, "linked-skill");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Linked\n---\n");
    await service.importSkill(source);

    const sharedDir = path.join(home, ".agents", "skills");
    await mkdir(sharedDir, { recursive: true });
    await symlink(
      path.join(neolixHome, "library", "skills", "linked-skill"),
      path.join(sharedDir, "linked-skill"),
      "dir",
    );

    const view = await service.getSnapshot();
    expect(view.skills[0]?.shared).toBe(path.join(sharedDir, "linked-skill"));
    expect(view.skills[0]?.sharedElsewhere).toBe(true);
    expect(view.skills[0]?.always).toEqual(expect.arrayContaining(["codex", "opencode"]));
  });

  test("counts only the agents that can read ~/.agents/skills", async () => {
    const source = path.join(root, "reader-skill");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Readers\n---\n");
    await service.importSkill(source);
    await service.handBackSkill("reader-skill");

    const paths = resolveLibraryPaths(neolixHome);
    const stored = await readLibrary(paths.dataFile);
    if (stored === null) {
      throw new Error("the library was not written");
    }
    const target = (id: string, extra: Partial<LibraryAgentTarget> = {}): LibraryAgentTarget => ({
      id,
      name: id,
      icon: id,
      instructionsPath: "",
      skillsDir: path.join(home, `.${id}`, "skills"),
      ...extra,
    });
    const views = await listLibrarySkills(stored, paths, {
      homeDir: home,
      targets: [
        target("codex"),
        target("gemini", { gone: true }),
        target("crush", { desktop: true }),
        target("pi", { sharedToo: true }),
        target("omp"),
        target("zcode", { skillsDir: path.join(home, ".agents", "skills") }),
      ],
    });
    // Uninstalled (gemini) and desktop (crush) agents don't count, while
    // SharedToo (pi) and the shared folder itself (zcode) do.
    expect(views[0]?.always).toEqual(["codex", "pi", "zcode"]);
  });

  test("marks a Pi or omp new enough as reading ~/.agents/skills", async () => {
    const versionedHome = path.join(root, "versioned-home");
    const versions: Record<string, string | null> = { pi: "0.54.0", omp: "10.9.0" };
    const versioned = createLibraryService({
      neolixHome: versionedHome,
      homeDir: home,
      env,
      agentVersion: async (agent) => versions[agent] ?? null,
    });
    const source = path.join(root, "version-skill");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Version\n---\n");
    await versioned.importSkill(source);
    await versioned.handBackSkill("version-skill");

    const view = await versioned.getSnapshot();
    // Pi 0.54.0 reads the shared folder; omp 10.9.0 is before 11.
    expect(view.skills[0]?.always).toContain("pi");
    expect(view.skills[0]?.always).not.toContain("omp");

    versions.pi = "0.53.9";
    versions.omp = "11.0.0";
    const homeB = path.join(root, "versioned-user-b");
    await mkdir(homeB, { recursive: true });
    const older = createLibraryService({
      neolixHome: path.join(root, "versioned-home-b"),
      homeDir: homeB,
      env,
      agentVersion: async (agent) => versions[agent] ?? null,
    });
    await older.importSkill(source);
    await older.handBackSkill("version-skill");
    const olderView = await older.getSnapshot();
    expect(olderView.skills[0]?.always).not.toContain("pi");
    expect(olderView.skills[0]?.always).toContain("omp");
  });

  test("settles an agent's own skill: set aside for the library's, or kept", async () => {
    const source = path.join(root, "skill-two");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\ndescription: Two\n---\n");
    await service.importSkill(source);

    const own = path.join(home, ".claude", "skills", "skill-two");
    await mkdir(own, { recursive: true });
    await writeFile(path.join(own, "SKILL.md"), "mine\n");

    // A sync, when the agent is ticked, finds the agent's own folder in the way.
    const ticked = await service.setSkillAgents("skill-two", ["claude"]);
    expect(ticked.result.problems).toEqual([
      expect.objectContaining({ agent: "claude", what: "skill:skill-two", own: true }),
    ]);

    await service.settleSkill("skill-two", "claude", false);
    // The agent's own folder is set aside, and the library's linked in its place.
    expect(await lstat(own).then((info) => info.isSymbolicLink())).toBe(true);
    const settled = await service.getSnapshot();
    expect(settled.skills[0]?.agents).toEqual(["claude"]);
    const after = await service.syncNow();
    expect(after.result.problems).toEqual([]);
    await expect(
      stat(path.join(neolixHome, "library", "backups", "set-aside")),
    ).resolves.toBeTruthy();

    await service.settleSkill("skill-two", "claude", true);
    expect((await service.getSnapshot()).skills[0]?.agents).toEqual([]);
  });

  test("keeps another computer's same-named server aside, and settles it", async () => {
    await service.saveMcpServer(null, {
      name: "mine",
      transport: "stdio",
      command: "here",
      agents: [],
      local: true,
    });
    const file = path.join(neolixHome, "library", "library.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as {
      away?: unknown[];
      mcp: { name: string; command: string }[];
    };
    stored.away = [{ name: "mine", transport: "stdio", command: "theirs", agents: [] }];
    await writeFile(file, JSON.stringify(stored));

    // Shared here again: this computer's server wins and the kept-aside one goes.
    const sharedAgain = createLibraryService({ neolixHome, homeDir: home, env });
    await sharedAgain.setMcpLocal("mine", false);
    const sharedView = await sharedAgain.getSnapshot();
    expect(sharedView.mcp.find((server) => server.name === "mine")?.command).toBe("here");
    expect((JSON.parse(await readFile(file, "utf8")) as { away?: unknown[] }).away).toBeUndefined();

    // Removed here: the other computer's comes in.
    const restored = createLibraryService({ neolixHome, homeDir: home, env });
    await restored.saveMcpServer(null, {
      name: "mine",
      transport: "stdio",
      command: "here",
      agents: [],
      local: true,
    });
    const storedAgain = JSON.parse(await readFile(file, "utf8")) as { away?: unknown[] };
    storedAgain.away = [{ name: "mine", transport: "stdio", command: "theirs", agents: [] }];
    await writeFile(file, JSON.stringify(storedAgain));
    const afterRemove = createLibraryService({ neolixHome, homeDir: home, env });
    await afterRemove.removeMcpServer("mine");
    const view = await afterRemove.getSnapshot();
    expect(view.mcp.find((server) => server.name === "mine")?.command).toBe("theirs");
  });

  test("looks for the agents again on refreshTargets", async () => {
    const before = await service.getSnapshot();
    expect(before.agents.some((agent) => agent.id === "cursor")).toBe(false);

    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await service.refreshTargets();

    const after = await service.getSnapshot();
    expect(after.agents.some((agent) => agent.id === "cursor")).toBe(true);
  });
});
