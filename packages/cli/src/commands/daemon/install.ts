import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import {
  installPlan,
  removeServiceFile,
  serviceFile,
  serviceInstalled,
  statusCommands,
  uninstallPlan,
  unsupportedService,
  writeServiceFile,
  type ServiceSpec,
} from "./service.js";

/**
 * `neolix daemon install|uninstall` and the service line of `daemon status`,
 * myna's daemon_cli.go:125-160. The file and commands are built by
 * service.ts; only a user running the command touches the system.
 */

/** The program a service runs: this CLI, in the foreground. */
export function serviceSpec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  const entry = process.argv[1] === undefined ? "neox" : path.resolve(process.argv[1]);
  const env = [`PATH=${process.env.PATH ?? ""}`];
  if (process.env.NEOLIX_HOME !== undefined) {
    env.push(`NEOLIX_HOME=${process.env.NEOLIX_HOME}`);
  }
  return {
    platform: process.platform,
    home: homedir(),
    ...(process.env.XDG_CONFIG_HOME === undefined
      ? {}
      : { xdgConfigHome: process.env.XDG_CONFIG_HOME }),
    exe: process.execPath,
    args: [entry, "daemon", "run"],
    env,
    ...overrides,
  };
}

function run(command: string[]): { ok: boolean; output: string } {
  const [exe, ...args] = command as [string, ...string[]];
  const result = spawnSync(exe, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

export async function runDaemonInstall(spec: ServiceSpec = serviceSpec()): Promise<void> {
  const plan = installPlan(spec);
  writeServiceFile(plan, spec.home);
  for (const command of plan.commands) {
    const result = run(command);
    // A bootout of an agent that was not loaded is no failure (myna's unload).
    if (!result.ok && !(command[1] === "bootout" || command[2] === "disable")) {
      throw new Error(`${command.join(" ")}: ${result.output || "failed"}`);
    }
  }
  console.log("✓", "the Neox daemon is installed and runs at login");
  console.log(`  ${plan.file}`);
  console.log(`  logs: ${plan.logs}`);
}

export async function runDaemonUninstall(spec: ServiceSpec = serviceSpec()): Promise<void> {
  const plan = uninstallPlan(spec);
  for (const command of plan.commands) {
    run(command);
  }
  removeServiceFile(plan.file);
  console.log("✓", "the Neox daemon service is removed");
}

/** The service's own state, for `daemon status`; null when not installed. */
export function serviceStatus(spec: ServiceSpec = serviceSpec()): string | null {
  if (!serviceInstalled(spec)) {
    return null;
  }
  const file = serviceFile(spec);
  const commands = statusCommands(spec.platform);
  for (const command of commands) {
    const result = run(command);
    if (result.ok && result.output !== "") {
      return `${file} · ${result.output.split("\n")[0]?.trim() ?? ""}`;
    }
    if (!result.ok) {
      return `${file} · not loaded`;
    }
  }
  return `${file} · installed`;
}

export function daemonInstallCommand(): Command {
  return new Command("install")
    .description("install the daemon as a service of this user, started at login")
    .action(async () => {
      const spec = serviceSpec();
      if (spec.platform !== "darwin" && spec.platform !== "linux") {
        throw unsupportedService(spec.platform);
      }
      await runDaemonInstall(spec);
    });
}

export function daemonUninstallCommand(): Command {
  return new Command("uninstall").description("remove the daemon's service").action(async () => {
    const spec = serviceSpec();
    if (spec.platform !== "darwin" && spec.platform !== "linux") {
      throw unsupportedService(spec.platform);
    }
    await runDaemonUninstall(spec);
  });
}
