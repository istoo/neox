import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * myna's uninstall package (magpie/internal/uninstall/uninstall.go:1): put
 * every agent Neolix wired back the way it was, remove what Neolix registered
 * with the system, then remove its files — in that order. Deleting the
 * files first leaves an agent pointed at a gateway that is gone, which is
 * what made the original myna bug report (#Jevik_AI).
 *
 * The executable is left where it is: a running program cannot delete
 * itself everywhere, and the user put it there.
 */

export interface UninstallStep {
  what: string;
  error: string | null;
}

export interface UninstallReport {
  agents: UninstallStep[];
  system: UninstallStep[];
  data: UninstallStep[];
  /** Folders left on purpose, each with the reason. */
  kept: UninstallStep[];
}

export function uninstallFailed(report: UninstallReport): boolean {
  return [...report.agents, ...report.system, ...report.data].some((step) => step.error !== null);
}

/** The report as lines, for the terminal and the app's log. */
export function describeUninstallReport(report: UninstallReport): string[] {
  const lines: string[] = [];
  const line = (kind: string, step: UninstallStep): void => {
    lines.push(
      step.error === null ? `✓ ${kind} ${step.what}` : `! ${kind} ${step.what}: ${step.error}`,
    );
  };
  for (const step of report.agents) line("disconnected", step);
  for (const step of report.system) line("removed", step);
  for (const step of report.data) line("deleted", step);
  for (const step of report.kept) lines.push(`· kept ${step.what}: ${step.error ?? ""}`);
  return lines;
}

export interface UninstallAgent {
  provider: string;
  label: string;
}

export interface UninstallDeps {
  /** Neolix's own folders, as {@link resolveNeolixDataDirectories} computes them. */
  dataDirectories: readonly string[];
  listAgents(): Promise<UninstallAgent[]>;
  disconnectAgent(agent: UninstallAgent): Promise<void>;
  disableAutostart(): Promise<void>;
  /** Stops whatever holds the data open, called after autostart and before deletion. */
  beforeRemoveData?(): Promise<void>;
  /** Removes a whole path; the default is fs.rm(recursive, force). */
  removePath?(target: string): Promise<void>;
  /** Paths inside a data directory that are kept, with why. */
  keepPaths?: readonly { path: string; why: string }[];
}

async function removePath(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/** Whether p can be one of Neolix's folders: never the home, a root, or relative. */
export function isRemovablePath(target: string, home: string): boolean {
  if (!target || !path.isAbsolute(target)) {
    return false;
  }
  const resolved = path.resolve(target);
  if (path.dirname(resolved) === resolved) {
    return false;
  }
  return !home || !isWithin(home, resolved);
}

/** Whether p is dir or inside it. */
export function isWithin(target: string, dir: string): boolean {
  const relative = path.relative(dir, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Neolix's own folders: $NEOLIX_HOME, and nothing it doesn't own. */
export function resolveNeolixDataDirectories(input: {
  neolixHome: string;
  homeDir: string;
}): string[] {
  return isRemovablePath(input.neolixHome, input.homeDir) ? [path.resolve(input.neolixHome)] : [];
}

async function directoryHasContent(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        return true;
      }
      if (await directoryHasContent(path.join(dir, entry.name))) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Removes dir but keep, which is inside it. */
export async function removeAllBut(dir: string, keep: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(dir, entry);
    if (path.resolve(target) === path.resolve(keep)) {
      continue;
    }
    if (isWithin(keep, target)) {
      await removeAllBut(target, keep);
      continue;
    }
    await removePath(target);
  }
}

/** Disconnects every agent, removes the system's records, then deletes the data. */
export async function runUninstall(deps: UninstallDeps): Promise<UninstallReport> {
  const report: UninstallReport = { agents: [], system: [], data: [], kept: [] };
  const remove = deps.removePath ?? removePath;

  let agents: UninstallAgent[] = [];
  try {
    agents = await deps.listAgents();
  } catch (error) {
    report.agents.push({
      what: "Agents",
      error: error instanceof Error ? error.message : String(error),
    });
  }
  for (const agent of agents) {
    try {
      await deps.disconnectAgent(agent);
      report.agents.push({ what: agent.label, error: null });
    } catch (error) {
      report.agents.push({
        what: agent.label,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    await deps.disableAutostart();
    report.system.push({ what: "open at login", error: null });
  } catch (error) {
    report.system.push({
      what: "open at login",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (deps.beforeRemoveData) {
    try {
      await deps.beforeRemoveData();
      report.system.push({ what: "background service", error: null });
    } catch (error) {
      report.system.push({
        what: "background service",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const keeps = deps.keepPaths ?? [];
  for (const directory of deps.dataDirectories) {
    const keep = keeps.find((entry) => isWithin(entry.path, directory));
    try {
      if (keep) {
        await removeAllBut(directory, keep.path);
        report.kept.push({ what: keep.path, error: keep.why });
      } else {
        await remove(directory);
      }
      report.data.push({ what: directory, error: null });
    } catch (error) {
      report.data.push({
        what: directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/** The Library folder stays while it holds skills, servers or hooks agents use. */
export async function libraryKeepPath(
  neolixHome: string,
): Promise<{ path: string; why: string } | null> {
  const library = path.join(neolixHome, "library");
  return (await directoryHasContent(library))
    ? { path: library, why: "skills and servers your agents use from Neox's Library" }
    : null;
}
