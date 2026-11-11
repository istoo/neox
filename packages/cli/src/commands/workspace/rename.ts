import type { Command } from "commander";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";
import type { CommandError, OutputSchema, SingleResult } from "../../output/index.js";

interface WorkspaceRenameResult {
  workspaceId: string;
  /** Raw title override; null once it has been reset to the derived name. */
  title: string | null;
}

const workspaceRenameSchema: OutputSchema<WorkspaceRenameResult> = {
  idField: "workspaceId",
  columns: [
    { header: "WORKSPACE ID", field: "workspaceId", width: 20 },
    { header: "TITLE", field: "title", width: 30 },
  ],
};

export interface WorkspaceRenameOptions {
  host?: string;
  daemonTarget: import("../../utils/daemon-target.js").DaemonTarget;
  reset?: boolean;
}

/**
 * Resolve the title to send to the daemon. Null clears the override and
 * reverts the workspace to its branch- or directory-derived name.
 */
export function resolveWorkspaceTitle(input: { title?: string; reset?: boolean }): string | null {
  const title = input.title?.trim() ?? "";
  if (input.reset) {
    if (input.title !== undefined) {
      throw {
        code: "INVALID_OPTIONS",
        message: "--reset cannot be combined with a title",
        details: "Pass a title to rename the workspace, or --reset to revert to the derived name",
      } satisfies CommandError;
    }
    return null;
  }
  if (title.length === 0) {
    throw {
      code: "MISSING_TITLE",
      message: "Title cannot be empty",
      details: "Usage: neox workspace rename <workspace-id> <title> | --reset",
    } satisfies CommandError;
  }
  return title;
}

export async function runRenameCommand(
  workspaceId: string,
  titleArg: string | undefined,
  options: WorkspaceRenameOptions,
  _command: Command,
): Promise<SingleResult<WorkspaceRenameResult>> {
  const title = resolveWorkspaceTitle({ title: titleArg, reset: options.reset });

  const client = await connectToDaemon({ target: options.daemonTarget }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ target: options.daemonTarget, error });
  });
  try {
    const applied = await client.setWorkspaceTitle(workspaceId, title);
    return {
      type: "single",
      data: { workspaceId, title: applied.title },
      schema: workspaceRenameSchema,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "WORKSPACE_RENAME_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
