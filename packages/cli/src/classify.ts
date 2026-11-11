import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type CliInvocation =
  | { kind: "cli"; argv: string[] }
  | { kind: "open-project"; resolvedPath: string; hint?: string };

export function isPathLikeArg(arg: string): boolean {
  return (
    arg === "." ||
    arg === ".." ||
    arg.startsWith("./") ||
    arg.startsWith("../") ||
    arg.startsWith("/") ||
    arg === "~" ||
    arg.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(arg)
  );
}

export function expandUserPath(inputPath: string): string {
  if (inputPath === "~") {
    return homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(homedir(), inputPath.slice(2));
  }

  return inputPath;
}

export function isExistingDirectory(input: { pathArg: string; cwd: string }): boolean {
  const resolvedPath = path.resolve(input.cwd, expandUserPath(input.pathArg));

  if (!existsSync(resolvedPath)) {
    return false;
  }

  return statSync(resolvedPath).isDirectory();
}

export function classifyInvocation(input: {
  argv: string[];
  knownCommands: ReadonlySet<string>;
  /** The commands named after an agent (`neolix claude`), which a folder of that name wins over. */
  agentCommands?: ReadonlySet<string>;
  cwd: string;
}): CliInvocation {
  const [firstArg] = input.argv;
  if (!firstArg) {
    return { kind: "cli", argv: input.argv };
  }

  if (firstArg.startsWith("-")) {
    return { kind: "cli", argv: input.argv };
  }

  if (input.knownCommands.has(firstArg)) {
    // myna's agent form gives way to a folder of the same name: Neolix's own
    // `neolix <folder>` opens it, and the hint says where the agent settings are.
    if (input.agentCommands?.has(firstArg) === true) {
      const projectPath = resolveDirectory({ pathArg: firstArg, cwd: input.cwd });
      if (projectPath !== null) {
        return {
          kind: "open-project",
          resolvedPath: projectPath,
          hint: `要查看 agent 设置用 neox agents ${firstArg}`,
        };
      }
    }
    return { kind: "cli", argv: input.argv };
  }

  if (isExistingDirectory({ pathArg: firstArg, cwd: input.cwd })) {
    return {
      kind: "open-project",
      resolvedPath: path.resolve(input.cwd, expandUserPath(firstArg)),
    };
  }

  return { kind: "cli", argv: input.argv };
}

function resolveDirectory(input: { pathArg: string; cwd: string }): string | null {
  if (!isExistingDirectory(input)) return null;
  return path.resolve(input.cwd, expandUserPath(input.pathArg));
}
