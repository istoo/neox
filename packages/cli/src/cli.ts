import { createHostCommand } from "./commands/host/index.js";
import { pairCommand } from "./commands/daemon/pair.js";
import { Command, Option } from "commander";
import { createAgentCommand } from "./commands/agent/index.js";
import { createDaemonCommand } from "./commands/daemon/index.js";
import { createPermitCommand } from "./commands/permit/index.js";
import { createUsageCommand } from "./commands/usage/index.js";
import { createStatuslineCommand } from "./commands/statusline/index.js";
import { createSessionsCommand } from "./commands/sessions/index.js";
import { createAccountsCommand } from "./commands/accounts/index.js";
import { createClaudeCodeCommand } from "./commands/claude-code/index.js";
import {
  createPresetsCommand,
  createProviderCommand,
  createProvidersCommand,
} from "./commands/provider/index.js";
import { createModelCommand } from "./commands/model/index.js";
import { createAgentSettingsCommands } from "./commands/agent-config/index.js";
import { createWebCommand } from "./commands/web/index.js";
import {
  createCpuCommand,
  createGoroutinesCommand,
  createHealthcheckCommand,
  createHeapCommand,
  createLogCommand,
} from "./commands/diagnostics/index.js";
import { createPluginCommand } from "./commands/plugin/index.js";
import { createProjectCommand } from "./commands/project/index.js";
import { createScheduleCommand } from "./commands/schedule/index.js";
import { createSpeechCommand } from "./commands/speech/index.js";
import { createScriptCommand } from "./commands/script/index.js";
import { createTerminalCommand } from "./commands/terminal/index.js";
import { createWorktreeCommand } from "./commands/worktree/index.js";
import { createWorkspaceCommand } from "./commands/workspace/index.js";
import { createHeartbeatCommand } from "./commands/heartbeat/index.js";
import { createHubCommand } from "./commands/hub/index.js";
import { createHooksCommand } from "./commands/hooks.js";
import { createLibraryCommand } from "./commands/library/index.js";
import { createMcpCommand } from "./commands/mcp/index.js";
import { createToolCommand, createToolsCommand } from "./commands/tool/index.js";
import { createGatewayKeyCommand } from "./commands/gateway-key/index.js";
import { createGatewayCommand } from "./commands/gateway/index.js";
import { createGroupCommand, createGroupsCommand } from "./commands/group/index.js";
import { createSearchCommand } from "./commands/search/index.js";
import { createLicensesCommand } from "./commands/licenses.js";
import { createSyncCommands } from "./commands/sync/index.js";
import { createCatalogSyncCommand } from "./commands/sync/catalog.js";
import { createSettingsCommand } from "./commands/settings/index.js";
import { createUninstallCommand } from "./commands/uninstall.js";
import { createTuiCommand } from "./commands/tui/index.js";
import {
  createAutostartCommand,
  createPanelCommand,
  createTrayCommand,
  createUpdateCommand,
  runAppLaunch,
  shouldOpenDesktopApp,
} from "./commands/desktop.js";
import { codexRelayCommand } from "./commands/codex-relay.js";
import { startCommand as daemonStartCommand } from "./commands/daemon/start.js";
import { daemonStatusCommand } from "./commands/daemon/status.js";
import { daemonRestartCommand } from "./commands/daemon/restart.js";
import { daemonReloadCommand } from "./commands/daemon/reload.js";
import { addLsOptions, runLsCommand } from "./commands/agent/ls.js";
import { addRunOptions, runRunCommand } from "./commands/agent/run.js";
import { addLogsOptions, runLogsCommand } from "./commands/agent/logs.js";
import { addDeleteOptions, runDeleteCommand } from "./commands/agent/delete.js";
import { addStopOptions, runStopCommand } from "./commands/agent/stop.js";
import { addSendOptions, runSendCommand } from "./commands/agent/send.js";
import { addInspectOptions, runInspectCommand } from "./commands/agent/inspect.js";
import { addWaitOptions, runWaitCommand } from "./commands/agent/wait.js";
import { addArchiveOptions, runArchiveCommand } from "./commands/agent/archive.js";
import { addAttachOptions, runAttachCommand } from "./commands/agent/attach.js";
import { addImportOptions, runImportCommand } from "./commands/agent/import.js";
import { withOutput } from "./output/index.js";
import type { CommandOptions } from "./output/index.js";
import { runCloneCommand } from "./commands/clone.js";
import { onboardCommand, runOnboard } from "./commands/onboard.js";
import {
  addDaemonHostOption,
  addJsonAndDaemonHostOptions,
  withGlobalOptions,
} from "./utils/command-options.js";
import { resolveCliVersion } from "./version.js";

const VERSION = resolveCliVersion();

export function createCli(): Command {
  const program = new Command();

  program
    .name("neox")
    .description("Neox CLI - control your AI coding agents from the command line")
    .version(VERSION, "-v, --version", "output the version number")
    // Global output options
    .option("-o, --format <format>", "output format: table, json, yaml", "table")
    .option("--json", "output in JSON format (alias for --format json)")
    .option("-q, --quiet", "minimal output (IDs only)")
    .option("--no-headers", "omit table headers")
    .option("--no-color", "disable colored output");
  addDaemonHostOption(program);

  // myna with no arguments opens the app (internal/cli/main.go:46). A headless
  // server or a machine without the app keeps Neolix's onboarding path, which is
  // how it ran before the desktop app existed.
  program.action(
    withGlobalOptions(async (options: CommandOptions, command: Command) => {
      // Commander hands an unrecognised command name to the root action as an
      // operand. Only a bare `neolix` may open the app or onboarding; a typo
      // such as `neolix statsu` must fail instead of launching a new window.
      const [unknown] = command.args;
      if (unknown !== undefined) {
        throw new Error(`unknown command '${unknown}'. See 'neox --help'.`);
      }
      if (shouldOpenDesktopApp()) {
        runAppLaunch();
        return;
      }
      await runOnboard(options);
    }),
  );

  program.addCommand(createHostCommand());
  for (const command of createSyncCommands()) {
    program.addCommand(command);
  }
  // myna's `myna sync`: the vendors' model lists again.
  program.addCommand(createCatalogSyncCommand());

  // Primary agent commands (top-level)
  addJsonAndDaemonHostOptions(addLsOptions(program.command("ls"))).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(addRunOptions(program.command("run"))).action(
    withOutput(runRunCommand),
  );

  addJsonAndDaemonHostOptions(addImportOptions(program.command("import"))).action(
    withOutput(runImportCommand),
  );

  addJsonAndDaemonHostOptions(
    program
      .command("clone")
      .description("Clone a GitHub repo and register it as a Neox workspace")
      .argument("<repo>", "GitHub repo in owner/repo format or a full git remote URL")
      .requiredOption("--dir <path>", "Parent directory to clone into (for example: ~/workspace)"),
  )
    .addOption(
      new Option("--protocol <protocol>", "Protocol for owner/repo shorthand repositories").choices(
        ["https", "ssh"],
      ),
    )
    .action(withOutput(runCloneCommand));

  addDaemonHostOption(addAttachOptions(program.command("attach"))).action(
    withGlobalOptions(runAttachCommand),
  );

  addDaemonHostOption(addLogsOptions(program.command("logs"))).action(
    withGlobalOptions(runLogsCommand),
  );

  addJsonAndDaemonHostOptions(addStopOptions(program.command("stop"))).action(
    withOutput(runStopCommand),
  );

  addJsonAndDaemonHostOptions(addDeleteOptions(program.command("delete"))).action(
    withOutput(runDeleteCommand),
  );

  addJsonAndDaemonHostOptions(addSendOptions(program.command("send"))).action(
    withOutput(runSendCommand),
  );

  addJsonAndDaemonHostOptions(addInspectOptions(program.command("inspect"))).action(
    withOutput(runInspectCommand),
  );

  addJsonAndDaemonHostOptions(addWaitOptions(program.command("wait"))).action(
    withOutput(runWaitCommand),
  );

  addJsonAndDaemonHostOptions(addArchiveOptions(program.command("archive"))).action(
    withOutput(runArchiveCommand),
  );

  // Top-level local daemon shortcuts
  program.addCommand(onboardCommand());
  program.addCommand(daemonStartCommand());
  program.addCommand(createTuiCommand());
  program.addCommand(createHooksCommand());
  program.addCommand(createLibraryCommand());
  program.addCommand(createMcpCommand());
  program.addCommand(createToolsCommand());
  program.addCommand(createToolCommand());
  program.addCommand(createGatewayKeyCommand());
  program.addCommand(createGatewayCommand());
  program.addCommand(createSettingsCommand());
  program.addCommand(createGroupCommand());
  // myna's `myna groups` lists what `myna group` changes (main.go:524-527).
  program.addCommand(createGroupsCommand());
  program.addCommand(createLicensesCommand());
  program.addCommand(createUninstallCommand());
  // The desktop app's own commands (myna cli/main.go:46-49, 162-171).
  program.addCommand(createTrayCommand());
  program.addCommand(createPanelCommand());
  program.addCommand(createAutostartCommand());
  program.addCommand(createUpdateCommand());
  // Started by the daemon itself when it quits; see codex-relay.ts.
  program.addCommand(codexRelayCommand());

  program.addCommand(daemonStatusCommand());
  program.addCommand(daemonRestartCommand());
  program.addCommand(daemonReloadCommand());
  program.addCommand(pairCommand());

  // Advanced agent commands (less common operations)
  program.addCommand(createAgentCommand());

  // Daemon commands
  program.addCommand(createDaemonCommand());
  program.addCommand(createHubCommand());

  // Chat commands

  // Terminal commands
  program.addCommand(createTerminalCommand());

  // Workspace script commands
  program.addCommand(createScriptCommand());

  // Schedule commands
  program.addCommand(createScheduleCommand());
  program.addCommand(createHeartbeatCommand());

  // Permission commands
  program.addCommand(createPermitCommand());

  // Provider commands
  program.addCommand(createProviderCommand());
  // myna's `myna providers` and `myna presets`: the gateway's own vendors.
  program.addCommand(createProvidersCommand());
  program.addCommand(createPresetsCommand());
  program.addCommand(createModelCommand());
  // myna's `search`: the web search APIs a model's search goes to.
  program.addCommand(createSearchCommand());
  // myna's agent commands: `agents`, `visible`, the profile verbs, and one
  // command per agent (`neolix claude [model]`, `neolix codex default`).
  for (const command of createAgentSettingsCommands()) {
    program.addCommand(command);
  }
  program.addCommand(createWebCommand());
  program.addCommand(createHeapCommand());
  program.addCommand(createCpuCommand());
  program.addCommand(createGoroutinesCommand());
  program.addCommand(createHealthcheckCommand());
  program.addCommand(createLogCommand());
  program.addCommand(createUsageCommand());
  program.addCommand(createStatuslineCommand());
  program.addCommand(createSessionsCommand());
  // myna's `myna accounts`: the subscriptions Neolix signed in to itself.
  program.addCommand(createAccountsCommand());
  program.addCommand(createClaudeCodeCommand());
  program.addCommand(createPluginCommand());

  // Speech model commands
  program.addCommand(createSpeechCommand());

  // Workspace commands
  program.addCommand(createProjectCommand());
  program.addCommand(createWorkspaceCommand());
  // COMPAT(worktreeCli): legacy command alias added before workspace was the product unit.
  // Added in v0.2.0; remove after 2027-01-17.
  program.addCommand(createWorktreeCommand(), { hidden: true });

  // Stop root parsing at the command so `plugin update --version` belongs to update.
  // Keep global options available after a command, as they were before positional parsing.
  program.enablePositionalOptions();
  for (const command of program.commands) {
    for (const option of program.options) {
      if (option.long === "--version") continue;
      if (!command.options.some((local) => local.long === option.long)) command.addOption(option);
      if (option.long === "--home" || option.long === "--host") continue;
      command.on(`option:${option.name()}`, () => {
        const key = option.attributeName();
        program.setOptionValueWithSource(key, command.opts()[key], "cli");
      });
    }
    if (command.name() !== "plugin")
      command.version(VERSION, "-v, --version", "output the version number");
  }

  const enforceSelectorDuplicates = (command: Command) => {
    for (const option of command.options) {
      if (option.long !== "--home" && option.long !== "--host") continue;
      option.argParser((value: string, previous: string | undefined) => {
        if (previous !== undefined && previous !== value)
          throw {
            code: "TARGET_AMBIGUOUS",
            message: `Conflicting duplicate ${option.long} selectors.`,
          };
        return value;
      });
    }
    command.commands.forEach(enforceSelectorDuplicates);
  };
  enforceSelectorDuplicates(program);
  return program;
}
