import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import type { LibraryMcpServer, LibrarySnapshot } from "@neolix/protocol/library";
import { connectToDaemon } from "../../utils/client.js";
import { selectDaemonTarget } from "../../utils/daemon-target.js";
import { addJsonAndDaemonHostOptions, globalDaemonSelectors } from "../../utils/command-options.js";
import { toCommandError, type CommandOptions } from "../../output/index.js";

const LIBRARY_USAGE = `neox library                     what the library gives each agent: instructions, MCP servers, skills
  neox library sync                write it into the agents again (after one is installed, or edited by hand)
  neox library instructions        print the shared instructions
  neox library instructions set <file|->   replace them with a file's text (- for stdin)
  neox library instructions agents <a,b…|none>   the agents that get them
  neox library mcp add <name> <url | command args…> [agents=a,b…] [--local]
  neox library mcp agents <name> <a,b…|none>
  neox library mcp local <name> on|off   keep it to this computer: a sync or a backup never carries it
  neox library mcp rm <name>
  neox library mcp router on|off   give each agent one MCP server, Neox, in place of the library's
  neox library mcp router share <name> shared|direct   with the router on, share the server or keep it each agent's own
  neox library skill agents <name> <a,b…|none>
  neox library skill off-here|on-here <name>   switch it on this computer alone
  neox library skill hand-over <name…>|--all   move skills kept in ~/.agents/skills into the library
  neox library skill hand-back <name>   …and back into ~/.agents/skills
  neox library skill rm <name>|--all|--gone [--yes]
  neox library skill use-library|keep-own <name> <agent>   settle an agent's own skill against the library's
  neox library skill update [name] fetch a skill from GitHub again; with no name, every one from there
  neox library skill how link|copy [agent]   give skills as links to the library's or as copies
  neox library skill how default <agent>     the agent goes the library's way again
  neox library skill where agents|shared     skills go to the agents ticked, or also into ~/.agents/skills
  neox library rtk                 which agents run their shell commands through RTK
  neox library rtk on|off <agent>  switch it
  neox library rtk install [distro]   install RTK (Homebrew, winget, or RTK's own script; in a WSL distro when named)
  neox library rtk upgrade         bring RTK up to its latest release
  neox library rtk path            put RTK on the PATH the agents get, when it isn't`;

class CliError extends Error {}

export interface LibraryCommandOptions extends CommandOptions {
  host?: string;
}

export function createLibraryCommand(): Command {
  const command = new Command("library")
    .description("Instructions, MCP servers, skills and RTK for every agent")
    .action(async (_options: unknown, cmd: Command) => {
      await withLibrary(cmd, (library) => printStatus(library));
    });
  // cli.ts adds these to every top-level command; adding them here keeps the
  // command testable on its own and makes --home/--host before a leaf work.
  addJsonAndDaemonHostOptions(command);

  command
    .command("sync")
    .description("Write the library into the agents again")
    .action(async (_options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        const { result } = await client.syncLibrary();
        console.log(
          "✓",
          result.changed.length === 0
            ? "every agent already had the library"
            : `wrote the library into ${result.changed.length} agent${result.changed.length === 1 ? "" : "s"}`,
        );
        for (const problem of result.problems) {
          console.error("!", problem.agent, problem.what, problem.error);
        }
      });
    });

  const instructions = command.command("instructions").description("The shared instructions");
  instructions.action(async (_options: unknown, cmd: Command) => {
    await withLibrary(cmd, (library) => {
      const text = library.instructions.shared;
      process.stdout.write(text);
      if (text !== "" && !text.endsWith("\n")) {
        process.stdout.write("\n");
      }
    });
  });
  instructions
    .command("set")
    .argument("<file>", "a file's text, or - for stdin")
    .action(async (file: string, _options: unknown, cmd: Command) => {
      const text = file === "-" ? await readStdin() : await readFile(file, "utf8");
      await withLibrary(cmd, async (_, client) => {
        await client.saveLibraryInstructions({ shared: text });
        console.log("✓ the shared instructions are replaced");
      });
    });
  instructions
    .command("agents")
    .argument("<agents>", "a,b… or none")
    .action(async (agents: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.saveLibraryInstructions({ agents: agentList(agents) });
        console.log("✓ the instructions go to", shownAgents(agents));
      });
    });

  const mcp = command.command("mcp").description("The library's MCP servers");
  mcp
    .command("add")
    .argument("<name>")
    .argument("<target...>", "a URL, or a command and its arguments")
    .option("--local", "keep it to this computer (not carried by a backup)")
    .action(async (name: string, target: string[], options: { local?: boolean }, cmd: Command) => {
      let agents: string[] | null = null;
      const parts: string[] = [];
      for (const value of target) {
        if (value.startsWith("agents=")) {
          agents = agentList(value.slice("agents=".length));
        } else {
          parts.push(value);
        }
      }
      const server = serverOf(name, parts);
      await withLibrary(cmd, async (_, client) => {
        if (agents !== null) {
          server.agents = agents;
        }
        if (options.local === true) {
          server.local = true;
        }
        await client.saveLibraryMcpServer(server);
        console.log("✓", server.name, "is in the library");
        if (server.agents.length === 0) {
          console.log(
            "  no agent is given it yet: neox library mcp agents",
            server.name,
            "<agents>",
          );
        }
      });
    });
  mcp
    .command("agents")
    .argument("<name>")
    .argument("<agents>", "a,b… or none")
    .action(async (name: string, agents: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.setLibraryMcpAgents(name, agentList(agents));
        console.log("✓", name, "goes to", shownAgents(agents));
      });
    });
  mcp
    .command("local")
    .argument("<name>")
    .argument("<on|off>")
    .action(async (name: string, on: string, _options: unknown, cmd: Command) => {
      if (on !== "on" && on !== "off") {
        throw new CliError("local is on or off");
      }
      await withLibrary(cmd, async (_, client) => {
        await client.setLibraryMcpLocal(name, on === "on");
        console.log(
          "✓",
          name,
          on === "on"
            ? "stays on this computer: a sync or a backup carries it nowhere"
            : "is carried by a sync and a backup again",
        );
      });
    });
  mcp
    .command("rm")
    .argument("<name>")
    .action(async (name: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.removeLibraryMcpServer(name);
        console.log("✓", name, "is out of the library and the agents");
      });
    });
  const router = mcp.command("router").description("One Neox MCP server in place of the library's");
  router.command("on").action(async (_options: unknown, cmd: Command) => {
    await withLibrary(cmd, async (_, client) => {
      await client.setLibraryMcpHub(true);
      console.log("✓ each agent gets Neox, which runs the library's servers");
    });
  });
  router.command("off").action(async (_options: unknown, cmd: Command) => {
    await withLibrary(cmd, async (_, client) => {
      await client.setLibraryMcpHub(false);
      console.log("✓ each agent gets the library's servers as its own entries");
    });
  });
  router
    .command("share")
    .argument("<name>")
    .argument("<shared|direct>")
    .action(async (name: string, mode: string, _options: unknown, cmd: Command) => {
      if (mode !== "shared" && mode !== "direct") {
        throw new CliError("router is shared or direct");
      }
      await withLibrary(cmd, async (_, client) => {
        await client.setLibraryMcpRouter(name, mode === "direct");
        console.log(
          "✓",
          name,
          mode === "direct"
            ? "keeps each agent's own entry, as with the router off"
            : "is shared through Neox with the router on",
        );
      });
    });

  const skill = command.command("skill").description("The library's skills");
  skill
    .command("agents")
    .argument("<name>")
    .argument("<agents>", "a,b… or none")
    .action(async (name: string, agents: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.setLibrarySkillAgents(name, agentList(agents));
        console.log("✓", name, "goes to", shownAgents(agents));
      });
    });
  skill
    .command("off-here")
    .argument("<name>")
    .action(async (name: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.setLibrarySkillHere(name, false);
        console.log("✓", name, "is off on this computer alone");
      });
    });
  skill
    .command("on-here")
    .argument("<name>")
    .action(async (name: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.setLibrarySkillHere(name, true);
        console.log("✓", name, "is on here again");
      });
    });
  skill
    .command("hand-over")
    .argument("[names...]")
    .option("--all")
    .action(async (names: string[], options: { all?: boolean }, cmd: Command) => {
      if (options.all !== true && names.length === 0) {
        throw new CliError(`usage:\n  ${LIBRARY_USAGE}`);
      }
      await withLibrary(cmd, async (_, client) => {
        const { result } = await client.handOverLibrarySkills(options.all === true ? null : names);
        console.log(
          "✓",
          options.all === true ? "every skill the library has" : names.join(", "),
          "is handed over to the library",
        );
        for (const problem of result.problems) {
          console.error("!", problem.what, problem.error);
        }
      });
    });
  skill
    .command("hand-back")
    .argument("<name>")
    .action(async (name: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.handBackLibrarySkill(name);
        console.log("✓", name, "is back in ~/.agents/skills, the library linking to it");
      });
    });
  skill
    .command("rm")
    .argument("[name]")
    .option("--all")
    .option("--yes")
    .option("--gone")
    .action(
      async (
        name: string | undefined,
        options: { all?: boolean; gone?: boolean; yes?: boolean },
        cmd: Command,
      ) => {
        if (options.all === true || options.gone === true) {
          await withLibrary(cmd, async (library, client) => {
            const picked =
              options.all === true
                ? library.skills
                : library.skills.filter((entry) => entry.gone === true);
            if (picked.length === 0) {
              console.log(
                "✓",
                options.all === true
                  ? "the library has no skills"
                  : "no skill is removed from its source",
              );
              return;
            }
            const names = picked.map((entry) => entry.name);
            await confirmRemoval(
              options.all === true
                ? `Remove all ${names.length} skill${names.length === 1 ? "" : "s"} (${names.join(", ")}) from the library and every agent?`
                : `Remove ${names.length} skill${names.length === 1 ? "" : "s"} removed from their source (${names.join(", ")}) from the library and every agent?`,
              options.yes === true,
            );
            let removed = 0;
            for (const one of names) {
              try {
                await client.removeLibrarySkill(one);
                removed += 1;
              } catch (error) {
                console.error("!", one, error instanceof Error ? error.message : String(error));
              }
            }
            console.log("✓", removed, `skill${removed === 1 ? "" : "s"} removed`);
          });
          return;
        }
        if (name === undefined) {
          throw new CliError(`usage:\n  ${LIBRARY_USAGE}`);
        }
        await withLibrary(cmd, async (_, client) => {
          await client.removeLibrarySkill(name);
          console.log("✓", name, "is out of the library and the agents");
        });
      },
    );
  skill
    .command("update")
    .argument("[name]")
    .option("--replace-edits")
    .action(async (name: string | undefined, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.updateLibrarySkills(name === undefined ? null : [name]);
        console.log("✓ updated", name ?? "every skill from GitHub");
      });
    });
  const how = skill.command("how").description("Skills as links or as copies");
  how
    .command("default")
    .argument("<agent>")
    .action(async (agent: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.setLibrarySkillOptions({ skillHow: { [agent]: "link" } });
        console.log("✓", agent, "goes the library's way again");
      });
    });
  for (const value of ["link", "copy"] as const) {
    how
      .command(value)
      .argument("[agent]")
      .action(async (agent: string | undefined, _options: unknown, cmd: Command) => {
        await withLibrary(cmd, async (_, client) => {
          await client.setLibrarySkillOptions(
            agent === undefined
              ? { copySkills: value === "copy" }
              : { skillHow: { [agent]: value } },
          );
          console.log(
            "✓",
            agent ?? "every agent",
            "gets skills as",
            value === "copy" ? "copies" : "links",
          );
        });
      });
  }
  skill
    .command("where")
    .argument("<where>", "agents or shared")
    .action(async (where: string, _options: unknown, cmd: Command) => {
      if (where !== "agents" && where !== "shared") {
        throw new CliError("where is agents or shared");
      }
      await withLibrary(cmd, async (_, client) => {
        await client.setLibrarySkillOptions({ sharedSkills: where === "shared" });
        console.log(
          "✓ skills go to",
          where === "shared" ? "the agents and ~/.agents/skills" : "the agents ticked",
        );
      });
    });
  skill
    .command("use-library")
    .argument("<name>")
    .argument("<agent>")
    .action(async (name: string, agent: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.settleLibrarySkill(name, agent, false);
        console.log(
          "✓",
          agent,
          "gets the library's",
          name,
          "; its own is set aside with the backups",
        );
      });
    });
  skill
    .command("keep-own")
    .argument("<name>")
    .argument("<agent>")
    .action(async (name: string, agent: string, _options: unknown, cmd: Command) => {
      await withLibrary(cmd, async (_, client) => {
        await client.settleLibrarySkill(name, agent, true);
        console.log("✓", agent, "keeps its own", name, "and is off the library's");
      });
    });

  const rtk = command.command("rtk").description("RTK for the agents' shell commands");
  rtk.action(async (_options: unknown, cmd: Command) => {
    await withRtk(cmd, (status) => {
      console.log(status.installed ? `RTK ${status.version ?? ""}` : "RTK isn't installed");
      if (status.path !== null) {
        console.log("  at", status.path);
      }
      for (const agent of status.agents) {
        console.log(`  ${agent.on ? "on " : "off"} ${agent.name}`);
      }
    });
  });
  rtk
    .command("on")
    .argument("<agent>")
    .action(async (agent: string, _options: unknown, cmd: Command) => {
      await withRtk(cmd, async (_, client) => {
        const status = await client.setLibraryRtk(agent, true);
        console.log("✓", agentName(status.rtk, agent), "runs its shell commands through RTK");
      });
    });
  rtk
    .command("off")
    .argument("<agent>")
    .action(async (agent: string, _options: unknown, cmd: Command) => {
      await withRtk(cmd, async (_, client) => {
        const status = await client.setLibraryRtk(agent, false);
        console.log(
          "✓",
          agentName(status.rtk, agent),
          "doesn't run its shell commands through RTK",
        );
      });
    });
  rtk
    .command("install")
    .argument("[distro]")
    .action(async (distro: string | undefined, _options: unknown, cmd: Command) => {
      await withRtk(cmd, async (_, client) => {
        const { run } = await client.runLibraryRtk(
          "install",
          distro === undefined ? {} : { distro },
        );
        console.log(run.ok ? "✓ RTK is installed" : "RTK's installer failed", run.output);
      });
    });
  rtk.command("upgrade").action(async (_options: unknown, cmd: Command) => {
    await withRtk(cmd, async (_, client) => {
      const { run } = await client.runLibraryRtk("upgrade");
      console.log(run.ok ? "✓ RTK is upgraded" : "RTK's upgrade failed", run.output);
    });
  });
  rtk.command("path").action(async (_options: unknown, cmd: Command) => {
    await withRtk(cmd, (status) => {
      if (status.pathHint === undefined) {
        console.log("RTK is on the PATH the agents get");
      } else {
        console.log("put RTK on the agents' PATH:", status.pathHint);
      }
    });
  });

  return command;
}

type LibraryClient = Awaited<ReturnType<typeof connectToDaemon>>;

/** The daemon this command was pointed at with --home/--host. */
function libraryTarget(cmd: Command) {
  return selectDaemonTarget(globalDaemonSelectors(cmd), process.env);
}

/** The library prints prose; --json would be a promise it cannot keep. */
function refuseJson(cmd: Command): void {
  const options = cmd.optsWithGlobals() as { json?: boolean; format?: string };
  if (options.json === true || options.format === "json" || process.argv.includes("--json")) {
    throw new CliError(
      "neox library has no JSON output: drop --json (the daemon's library RPC carries the data)",
    );
  }
}

async function withLibrary(
  cmd: Command,
  run: (library: LibrarySnapshot, client: LibraryClient) => void | Promise<void>,
): Promise<void> {
  refuseJson(cmd);
  const client = await connectToDaemon({ target: libraryTarget(cmd) }).catch((error: unknown) => {
    throw new CliError(`Cannot connect to the daemon: ${toCommandError(error).message}`);
  });
  try {
    const { library } = await client.getLibrary();
    await run(library, client);
  } finally {
    await client.close?.();
  }
}

async function withRtk(
  cmd: Command,
  run: (
    status: Awaited<ReturnType<LibraryClient["getLibraryRtk"]>>["rtk"],
    client: LibraryClient,
  ) => void | Promise<void>,
): Promise<void> {
  refuseJson(cmd);
  const client = await connectToDaemon({ target: libraryTarget(cmd) }).catch((error: unknown) => {
    throw new CliError(`Cannot connect to the daemon: ${toCommandError(error).message}`);
  });
  try {
    const { rtk } = await client.getLibraryRtk();
    await run(rtk, client);
  } finally {
    await client.close?.();
  }
}

function printStatus(library: LibrarySnapshot): void {
  console.log("Library", library.dir);
  console.log(
    `  ${library.counts.mcp} MCP servers, ${library.counts.skills} skills, ${library.counts.rtk} RTK agents`,
  );
  for (const agent of library.agents) {
    console.log(`  ${agent.name}`);
  }
}

async function confirmRemoval(question: string, yes: boolean): Promise<void> {
  if (yes) {
    return;
  }
  if (process.stdin.isTTY !== true) {
    throw new CliError(`${question}\n  run it with --yes to do so without being asked`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} [y/N] `);
  prompt.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CliError("nothing removed");
  }
}

function agentList(value: string): string[] {
  if (value === "none") {
    return [];
  }
  return value
    .split(",")
    .map((one) => one.trim())
    .filter((one) => one.length > 0);
}

function shownAgents(value: string): string {
  return value === "none" ? "no agent" : value;
}

function agentName(
  status: Awaited<ReturnType<LibraryClient["getLibraryRtk"]>>["rtk"],
  id: string,
): string {
  return status.agents.find((agent) => agent.id === id)?.name ?? id;
}

function serverOf(name: string, parts: string[]): LibraryMcpServer {
  const first = parts[0] ?? "";
  if (/^https?:\/\//.test(first)) {
    return { name, transport: "http", url: first, agents: [] };
  }
  if (first === "") {
    throw new CliError(`usage:\n  ${LIBRARY_USAGE}`);
  }
  return {
    name,
    transport: "stdio",
    command: first,
    args: parts.slice(1),
    agents: [],
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}
