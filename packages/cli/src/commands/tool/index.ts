import chalk from "chalk";
import { Command } from "commander";
import { resolveGatewayTarget } from "../mcp/gateway.js";
import {
  findTool,
  firstSentence,
  isRequired,
  listTools,
  type ListedTool,
  paramNames,
  paramShape,
  unknownTool,
  wordsParam,
} from "./catalog.js";
import { answerText, callTool, parseToolArgs, saveMade } from "./call.js";

/**
 * `neolix tools` and `neolix tool`: Neolix's own MCP tools from the terminal,
 * as myna's `myna tools` and `myna tool` do (myna internal/cli/tool_cli.go).
 */

const TOOLS_USAGE = `usage:
  neox tools                  every tool Neox's MCP servers give agents, with its parameters
  neox tools <name>           one tool: what it does and each parameter
  neox tool <name> [--<param> <value>…] [<words>…] [-o <file|folder>] [--json]
                                call one through the running Neox, as an agent's MCP call is

  A parameter is --<param> <value> or --<param>=<value> (- and _ alike); a list
  parameter is given once per item. The words left over are the tool's one required
  text (generate_image's prompt, web_search's query, analyze_image's image), else its
  prompt. A file named in a parameter is read by Neox on this computer.
  An image or video the tool makes is saved: -o names a file or a folder (with --n 2 or
  more a number is added to the name), else it goes in this folder, named from the
  prompt; a file that is there is never written over. Text is printed. --json prints
  the tool's answer as it came and saves nothing.
  An unknown parameter, or a missing required one, is refused before anything is
  called. It asks the gateway at the address in the daemon's config (or NEOLIX_GATEWAY
  for another one).`;

function failure(error: unknown): void {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function targetOf(
  command: Command,
): Promise<Awaited<ReturnType<typeof resolveGatewayTarget>>> {
  const home = command.optsWithGlobals().home;
  return resolveGatewayTarget(typeof home === "string" ? { home } : {});
}

function parameterLine(tool: ListedTool): string {
  return paramNames(tool)
    .map((name) => {
      const param = tool.inputSchema.properties[name] ?? {};
      let text = `--${name} ${paramShape(param)}`;
      if (isRequired(tool, name)) {
        text += " (required)";
      }
      return text;
    })
    .join("  ");
}

function printToolList(tools: ListedTool[], notes: string[]): void {
  let server = "";
  for (const tool of tools) {
    if (tool.server !== server) {
      if (server !== "") {
        process.stdout.write("\n");
      }
      server = tool.server;
      process.stdout.write(`${chalk.bold(server)}\n`);
    }
    process.stdout.write(`  ${tool.name.padEnd(20)} ${firstSentence(tool.description)}\n`);
    const parameters = parameterLine(tool);
    if (parameters !== "") {
      process.stdout.write(`  ${"".padEnd(20)} ${chalk.gray(parameters)}\n`);
    }
  }
  if (tools.length === 0) {
    process.stdout.write(`${chalk.gray("  no tools: the Neox running has none on")}\n`);
  }
  for (const note of notes) {
    process.stdout.write(`${chalk.gray(`  ${note}`)}\n`);
  }
  process.stdout.write(
    `${chalk.gray("\nneolix tools <name> for one in full · neox tool <name> --<param> <value> … to call it")}\n`,
  );
}

function printToolHelp(tool: ListedTool): void {
  process.stdout.write(
    `${chalk.bold(tool.name)}  ${chalk.gray(`(${tool.server}, ${tool.path})`)}\n`,
  );
  process.stdout.write(`  ${tool.description.split(/\s+/).filter(Boolean).join(" ")}\n\n`);
  for (const name of paramNames(tool)) {
    const param = tool.inputSchema.properties[name] ?? {};
    let head = `  --${name} ${paramShape(param)}`;
    if (isRequired(tool, name)) {
      head += "  required";
    }
    process.stdout.write(`${head}\n`);
    const description = (param.description ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (description !== "") {
      process.stdout.write(`${chalk.gray(`      ${description}`)}\n`);
    }
  }
  const words = wordsParam(tool);
  if (words !== "") {
    process.stdout.write(
      `\n  the words after the name are its --${words}: neox tool ${tool.name} <${words}>\n`,
    );
  }
}

export function createToolsCommand(): Command {
  return new Command("tools")
    .description("The tools Neox's MCP servers give agents, and their parameters")
    .usage("[<name>]")
    .addHelpText("before", TOOLS_USAGE)
    .argument("[args...]")
    .allowUnknownOption(true)
    .action(async (args: string[] | undefined, _options: unknown, command: Command) => {
      try {
        const values = args ?? [];
        for (const value of values) {
          if (value.startsWith("-")) {
            throw new Error(`unknown flag ${value} (neox tools [<name>])`);
          }
        }
        if (values.length > 1) {
          throw new Error("neox tools takes one tool's name at most (neox tools [<name>])");
        }
        const { tools, notes } = await listTools(await targetOf(command));
        if (values.length === 1) {
          const name = values[0] ?? "";
          const tool = findTool(tools, name);
          if (tool === undefined) {
            throw unknownTool(name, tools, notes);
          }
          printToolHelp(tool);
          return;
        }
        printToolList(tools, notes);
      } catch (error) {
        failure(error);
      }
    });
}

export function createToolCommand(): Command {
  return new Command("tool")
    .description("Call one of Neox's MCP tools, as an agent's MCP call is")
    .usage("<name> [--<param> <value>…] [<words>…] [-o <file|folder>] [--json]")
    .addHelpText("before", TOOLS_USAGE)
    .argument("[args...]")
    .allowUnknownOption(true)
    .action(async (args: string[] | undefined, _options: unknown, command: Command) => {
      try {
        const values = args ?? [];
        const name = values[0];
        if (name === undefined || name.startsWith("-")) {
          throw new Error(
            "neox tool needs a tool's name first: neox tool <name> --<param> <value> … (neox tools lists them)",
          );
        }
        const target = await targetOf(command);
        const { tools, notes } = await listTools(target);
        const tool = findTool(tools, name);
        if (tool === undefined) {
          throw unknownTool(name, tools, notes);
        }
        const call = await parseToolArgs(tool, values.slice(1));
        const answer = await callTool(target, tool, call.args, {
          say: (text) => process.stderr.write(`${chalk.gray(text)}\n`),
        });
        if (call.json) {
          process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
          if (answer.isError) {
            throw new Error(`${tool.name} answered with an error`);
          }
          return;
        }
        if (answer.isError) {
          throw new Error(answerText(answer).trim());
        }
        process.stdout.write(answerText(answer));
        const prompt =
          typeof call.args.prompt === "string" && call.args.prompt !== ""
            ? call.args.prompt
            : tool.name;
        const saved = await saveMade({
          target,
          cwd: process.cwd(),
          answer,
          output: call.output,
          prompt,
        });
        for (const file of saved) {
          process.stdout.write(`${chalk.green("saved")} ${file}\n`);
        }
      } catch (error) {
        failure(error);
      }
    });
}

export { TOOLS_USAGE };
