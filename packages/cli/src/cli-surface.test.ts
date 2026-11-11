import { describe, expect, it, vi } from "vitest";
import { createCli } from "./cli.js";
import { agentHelpText, fieldsOf } from "./commands/agent-config/shared.js";

describe("root command", () => {
  it("rejects an unknown command instead of opening the desktop app", async () => {
    // Passthrough mode makes any desktop launch throw its own error, so a
    // regression here fails the assertion instead of opening a real window.
    vi.stubEnv("NEOLIX_DESKTOP_CLI", "1");
    try {
      for (const argv of [["statsu"], ["accounts --json"]]) {
        await expect(createCli().parseAsync(argv, { from: "user" })).rejects.toThrow(
          `unknown command '${argv[0]}'`,
        );
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("canonical CLI surface", () => {
  it.each(["send", "agent send"])("%s accepts an explicit behavior override", async (path) => {
    const cli = createCli();
    const owner =
      path === "send" ? cli : cli.commands.find((command) => command.name() === "agent")!;
    const send = owner.commands.find((command) => command.name() === "send")!;
    send.action(() => {});
    await send.parseAsync(["target", "message", "--behavior", "interrupt"], { from: "user" });
    expect(send.opts().behavior).toBe("interrupt");
    await send.parseAsync(["target", "message", "--behavior", "steer"], { from: "user" });
    expect(send.opts().behavior).toBe("steer");
    send.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(
      send.parseAsync(["target", "message", "--behavior", "queue"], { from: "user" }),
    ).rejects.toThrow();
  });

  it("offers daemon host selection as a global option", () => {
    expect(createCli().helpInformation()).toContain("--host <host>");
  });

  it("shows project, workspace, and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("project");
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).not.toContain("worktree");
  });

  it("offers identical top-level and daemon config reload commands", () => {
    const cli = createCli();
    const reload = cli.commands.find((command) => command.name() === "reload");
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    const nestedReload = daemon?.commands.find((command) => command.name() === "reload");

    expect(reload?.helpInformation()).toContain("--host <host>");
    expect(reload?.helpInformation()).toContain("--json");
    expect(nestedReload?.helpInformation()).toContain("--host <host>");
    expect(nestedReload?.helpInformation()).toContain("--json");
  });

  it("names explicit workspace creation without exposing older syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--new-workspace <local|worktree>");
    expect(help).not.toContain("--isolation");
    expect(help).not.toContain("--worktree <name>");
  });

  it("offers the worktree creation options on run", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--worktree-mode <mode>");
    expect(help).toContain("--worktree-slug <slug>");
    expect(help).toContain("--new-branch <name>");
    expect(help).toContain("--branch <name>");
    expect(help).toContain("--pr-number <n>");
    expect(help).toContain("--forge <forge>");
  });

  it("uses --no-wait for execution, --internal for visibility, and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--no-wait");
    expect(help).not.toContain("--background");
    expect(help).not.toContain("--background");
    expect(help).not.toContain("--detach");
  });

  it("hides internal agents and workspaces from listings unless --internal is passed", () => {
    const cli = createCli();
    const ls = cli.commands.find((command) => command.name() === "ls");
    const workspace = cli.commands.find((command) => command.name() === "workspace");
    const workspaceLs = workspace?.commands.find((command) => command.name() === "ls");
    const workspaceCreate = workspace?.commands.find((command) => command.name() === "create");

    expect(ls?.helpInformation()).toContain("--background");
    expect(workspaceLs?.helpInformation()).toContain("--background");
    expect(workspaceCreate?.helpInformation()).toContain("--background");
  });

  it("offers thinking configuration when running, updating, and scheduling agents", () => {
    const cli = createCli();
    const run = cli.commands.find((command) => command.name() === "run");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const update = agent?.commands.find((command) => command.name() === "update");
    const schedule = cli.commands.find((command) => command.name() === "schedule");
    const scheduleCreate = schedule?.commands.find((command) => command.name() === "create");

    expect(run?.helpInformation()).toContain("--thinking <id>");
    expect(update?.helpInformation()).toContain("--thinking <id>");
    expect(scheduleCreate?.helpInformation()).toContain("--thinking <id>");
  });

  it("offers opening an existing agent in the desktop app", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const open = agent?.commands.find((command) => command.name() === "open");

    expect(open?.helpInformation()).toContain("<agent-id>");
    expect(open?.helpInformation()).toContain("--server <server-id>");
  });

  it("offers the complete local plugin lifecycle", () => {
    const plugin = createCli().commands.find((command) => command.name() === "plugin");

    expect(plugin?.commands.map((command) => command.name())).toEqual([
      "init",
      "ls",
      "status",
      "logs",
      "install",
      "update",
      "reload",
      "enable",
      "disable",
      "remove",
    ]);
    expect(
      plugin?.commands.find((command) => command.name() === "init")?.helpInformation(),
    ).toContain("--id <id>");
    expect(
      plugin?.commands.find((command) => command.name() === "install")?.helpInformation(),
    ).toContain("--id <id>");
  });
});

it("preserves omitted and explicit false workspace background intent", () => {
  const readOptions = (args: string[]) => {
    const workspace = createCli().commands.find((command) => command.name() === "workspace")!;
    const create = workspace.commands.find((command) => command.name() === "create")!;
    create.parseOptions(args);
    return create.opts();
  };
  expect(readOptions([]).background).toBeUndefined();
  expect(readOptions(["--background"]).background).toBe(true);
  expect(readOptions(["--no-background"]).background).toBe(false);
});

describe("provider command surface", () => {
  it("offers myna's gateway provider verbs beside the agent provider ones", () => {
    const provider = createCli().commands.find((command) => command.name() === "provider");
    const verbs = provider?.commands.map((command) => command.name()) ?? [];
    for (const verb of [
      "add",
      "set",
      "key",
      "icon",
      "fallback",
      "models",
      "refresh",
      "refresh-every",
      "auto-include",
      "account-models",
      "account-cap",
      "pool",
      "account-concurrency",
      "spend-cap",
      "account-weight",
      "queue",
      "rpm",
      "at-once",
      "quota-rest",
      "rest-cap",
      "listed",
      "off",
      "on",
      "test",
      "rm",
    ]) {
      expect(verbs).toContain(verb);
    }
    expect(verbs).toContain("ls");
    expect(verbs).toContain("diagnostic");
  });

  it("offers providers and presets as top-level commands", () => {
    const names = createCli().commands.map((command) => command.name());
    expect(names).toContain("providers");
    expect(names).toContain("presets");
  });
});

describe("library command surface", () => {
  function names(command: { commands: Array<{ name(): string }> }): string[] {
    return command.commands.map((one) => one.name());
  }

  it("offers myna's library groups", () => {
    const library = createCli().commands.find((command) => command.name() === "library");
    expect(library).toBeDefined();
    expect(names(library!)).toEqual(
      expect.arrayContaining(["sync", "instructions", "mcp", "skill", "rtk"]),
    );
    const mcp = library!.commands.find((command) => command.name() === "mcp")!;
    expect(names(mcp)).toEqual(expect.arrayContaining(["add", "agents", "local", "rm", "router"]));
    const skill = library!.commands.find((command) => command.name() === "skill")!;
    expect(names(skill)).toEqual(
      expect.arrayContaining([
        "agents",
        "off-here",
        "on-here",
        "hand-over",
        "hand-back",
        "rm",
        "update",
        "how",
        "where",
        "use-library",
        "keep-own",
      ]),
    );
    const rtk = library!.commands.find((command) => command.name() === "rtk")!;
    expect(names(rtk)).toEqual(expect.arrayContaining(["on", "off", "install", "upgrade", "path"]));
  });
});

describe("model command surface", () => {
  it("offers the model subcommands the gateway config backs", () => {
    const model = createCli().commands.find((command) => command.name() === "model");
    expect(model).toBeDefined();
    expect(model!.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "name",
        "names",
        "price",
        "prices",
        "context",
        "output",
        "spec",
        "specs",
        "suffix",
        "compact",
        "efforts",
        "wire",
        "wires",
        "id",
        "ids",
        "alias",
        "aliases",
        "disable",
        "enable",
        "disabled",
      ]),
    );
  });
});

describe("sync and backup command surface", () => {
  it("offers myna's backup, restore and three remotes", () => {
    const names = createCli().commands.map((command) => command.name());
    expect(names).toEqual(expect.arrayContaining(["backup", "restore", "webdav", "s3", "github"]));
  });

  it("keeps myna's backup flags and optional file", () => {
    const backup = createCli().commands.find((command) => command.name() === "backup")!;
    expect(backup.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(["--no-keys", "--no-library", "--sign-ins", "--home"]),
    );
    expect(backup.registeredArguments.map((argument) => argument.name())).toEqual(["file"]);
  });

  it("offers myna's sync for the vendor model lists", () => {
    const sync = createCli().commands.find((command) => command.name() === "sync")!;
    expect(sync.description()).toMatch(/model lists/);
  });

  it("takes the remote actions myna takes", () => {
    for (const name of ["webdav", "s3", "github"]) {
      const remote = createCli().commands.find((command) => command.name() === name)!;
      expect(remote.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
      expect(remote.description()).toMatch(/every computer/);
      expect(remote.helpInformation()).toContain("restore, undo, upload, dismiss");
    }
  });
});

describe("MCP tools", () => {
  it("offers listing and calling Neox's own MCP tools", () => {
    const cli = createCli();
    const tools = cli.commands.find((command) => command.name() === "tools")!;
    const tool = cli.commands.find((command) => command.name() === "tool")!;
    expect(tools.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
    expect(tool.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
    expect(tool.helpInformation()).toContain("--<param> <value>");
    expect(tools.helpInformation()).toContain("Usage: neox tools [<name>]");
  });
});

describe("routing groups and gateway keys", () => {
  it("offers the group command myna's routing takes", () => {
    const group = createCli().commands.find((command) => command.name() === "group")!;
    expect(group.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
    expect(group.description()).toMatch(/Routing groups/);
  });

  it("offers myna's groups command that lists them", () => {
    const groups = createCli().commands.find((command) => command.name() === "groups");
    expect(groups).toBeDefined();
    expect(groups!.description()).toMatch(/Routing groups/);
  });

  it("offers the gateway key verbs myna takes", () => {
    const keys = createCli().commands.find((command) => command.name() === "gateway-key")!;
    expect(keys.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "oidc",
        "list",
        "add",
        "rotate",
        "remove",
        "limit",
        "models",
        "accounts",
        "quotas",
        "access",
        "move",
        "issue",
        "issuer",
      ]),
    );
  });
});

describe("search, provider import and switch-only", () => {
  it("offers the search APIs myna's search command takes", () => {
    const search = createCli().commands.find((command) => command.name() === "search")!;
    expect(search.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
    expect(search.description()).toMatch(/search APIs/);
    expect(search.helpInformation()).toContain("[args...]");
  });

  it("offers provider import and accounts switch-only", () => {
    const provider = createCli().commands.find((command) => command.name() === "provider")!;
    const imported = provider.commands.find((command) => command.name() === "import")!;
    expect(imported.registeredArguments.map((argument) => argument.name())).toEqual(["link"]);
    expect(imported.helpInformation()).toContain("--yes");
    const accounts = createCli().commands.find((command) => command.name() === "accounts")!;
    const switchOnly = accounts.commands.find((command) => command.name() === "switch-only")!;
    expect(switchOnly.registeredArguments.map((argument) => argument.name())).toEqual([
      "agent",
      "on|off",
    ]);
  });
});

describe("settings", () => {
  it("offers myna's settings verbs", () => {
    const settings = createCli().commands.find((command) => command.name() === "settings")!;
    expect(settings.commands.map((command) => command.name())).toEqual([
      "list",
      "get",
      "set",
      "reset",
    ]);
    expect(settings.helpInformation()).toContain("--json");
    expect(settings.helpInformation()).toContain("--home <path>");
    const get = settings.commands.find((command) => command.name() === "get")!;
    expect(get.helpInformation()).toContain("--json");
  });
});

describe("subscription accounts", () => {
  it("offers myna's accounts verbs", () => {
    const accounts = createCli().commands.find((command) => command.name() === "accounts")!;
    expect(accounts.registeredArguments.map((argument) => argument.name())).toEqual(["agent"]);
    expect(accounts.commands.map((command) => command.name())).toEqual([
      "add",
      "import",
      "refresh",
      "project",
      "alias",
      "switch",
      "remove",
      "discovery",
      "switch-only",
      "checkin",
      "subscriptions",
    ]);
    const add = accounts.commands.find((command) => command.name() === "add")!;
    expect(add.helpInformation()).toContain("--host <host>");
    const importCommand = accounts.commands.find((command) => command.name() === "import")!;
    expect(importCommand.helpInformation()).toContain("--yes");
    expect(importCommand.helpInformation()).toContain("--from-codex");
  });

  it("offers installing and removing the Claude Code a subscription is served with", () => {
    const claudeCode = createCli().commands.find((command) => command.name() === "claude-code")!;
    expect(claudeCode.commands.map((command) => command.name())).toEqual(["install", "remove"]);
    const install = claudeCode.commands.find((command) => command.name() === "install")!;
    expect(install.helpInformation()).toContain("--yes");
    const remove = claudeCode.commands.find((command) => command.name() === "remove")!;
    expect(remove.helpInformation()).toContain("--yes");
  });
});

describe("usage and statusline surface", () => {
  it("offers myna's usage report under neox usage report", () => {
    const usage = createCli().commands.find((command) => command.name() === "usage")!;
    const report = usage.commands.find((command) => command.name() === "report")!;
    expect(report).toBeDefined();
    const help = report.helpInformation();
    expect(help).toContain("[period]");
    expect(help).toContain("--csv");
    expect(help).toContain("--account <name>");
    expect(help).toContain("--days <n>");
    expect(help).toContain("--last <duration>");
  });

  it("offers myna's status line", () => {
    const statusline = createCli().commands.find((command) => command.name() === "statusline")!;
    expect(statusline).toBeDefined();
    expect(statusline.helpInformation()).toContain("[names...]");
  });
});

describe("sessions command surface", () => {
  it("offers myna's sessions flags and the read consent", () => {
    const sessions = createCli().commands.find((command) => command.name() === "sessions");
    expect(sessions).toBeDefined();
    const help = sessions!.helpInformation();
    expect(help).toContain("--days");
    expect(help).toContain("--model <model>");
    expect(help).toContain("--folder <folder>");
    expect(help).toContain("--limit <n>");

    const read = sessions!.commands.find((command) => command.name() === "read");
    expect(read).toBeDefined();
    expect(read!.helpInformation()).toContain("[on|off all|<agent>...]");

    const relocate = sessions!.commands.find((command) => command.name() === "relocate-claude");
    expect(relocate).toBeDefined();
    expect(relocate!.helpInformation()).toContain("--from <path>");
    expect(relocate!.helpInformation()).toContain("--confirm <token>");
  });
});

describe("agent settings surface", () => {
  it("offers myna's agents, visible, profile verbs and one command per agent", () => {
    const cli = createCli();
    const names = cli.commands.map((command) => command.name());
    for (const verb of ["agents", "models", "visible", "profiles", "save", "use", "rename", "rm"]) {
      expect(names).toContain(verb);
    }
    for (const id of ["claude", "codex", "opencode", "pi", "copilot", "aside"]) {
      expect(names).toContain(id);
    }
    const claude = cli.commands.find((command) => command.name() === "claude")!;
    expect(claude.aliases()).toContain("cc");
    expect(claude.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
    expect(claude.description()).toMatch(/fields/);
    const visible = cli.commands.find((command) => command.name() === "visible")!;
    expect(visible.registeredArguments.map((argument) => argument.name())).toEqual(["args"]);
    // `neolix <agent> <field> [value|default]` takes myna's fields.
    expect(fieldsOf("claude").map((field) => field.key)).toEqual([
      "model",
      "effort",
      "ultracode",
      "subagent",
      "subagent_effort",
      "auto_mode",
      "login",
      "statusline",
    ]);
    expect(agentHelpText("codex", "Codex")).toContain("neox codex <field> <value>  set it");
    expect(agentHelpText("opencode", "OpenCode")).toContain("fields: model, small");
  });
});

describe("bin aliases", () => {
  it("installs the Neox and Neolix commands", async () => {
    const { readFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin?: Record<string, string> };
    expect(packageJson.bin).toEqual({
      neox: "bin/neolix",
      neolix: "bin/neolix",
    });
    expect(existsSync(new URL("../bin/neolix", import.meta.url))).toBe(true);
  });
});

describe("diagnostics and log surface", () => {
  it("offers Neox's heap, cpu, goroutines, healthcheck and log", () => {
    const names = createCli().commands.map((command) => command.name());
    expect(names).toEqual(
      expect.arrayContaining(["heap", "cpu", "goroutines", "healthcheck", "log", "web"]),
    );
    const daemon = createCli().commands.find((command) => command.name() === "daemon")!;
    expect(daemon.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["web", "install", "uninstall"]),
    );
  });
});
