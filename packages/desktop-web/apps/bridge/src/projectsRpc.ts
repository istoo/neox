// Project add/remove for the Synara front end. The front end does not have separate project
// CRUD RPCs: it sends `project.create` / `project.delete` through `orchestration.dispatchCommand`
// (see apps/web/src/lib/projectCreation.ts and projectDelete.ts). These handlers carry those two
// commands to the daemon's project registry, which then publishes `project.update`; BridgeModel
// reloads from that event. The dialog's project name is applied as a daemon rename, and pins —
// which the registry has no field for — are kept in the bridge.
import * as path from "node:path";
import {
  WsRpcError,
  type GitHubProjectProvisionInput,
  type GitHubProjectProvisionPhase,
  type GitHubProjectProvisionProgressEvent,
  type GitHubProjectProvisionResult,
} from "@synara/contracts";
import { Effect, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import { bridgeError, codedError, fromPromise } from "./rpcErrors.ts";
import { notSupported, type AnyHandler } from "./stubs.ts";

interface ProjectCreateCommand {
  readonly type: "project.create";
  readonly commandId: string;
  readonly projectId: string;
  readonly title?: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly additionalFolders?: ReadonlyArray<string>;
  readonly isPinned?: boolean;
}

interface ProjectDeleteCommand {
  readonly type: "project.delete";
  readonly commandId: string;
  readonly projectId: string;
}

interface ProjectMetaUpdateCommand {
  readonly type: "project.meta.update";
  readonly commandId: string;
  readonly projectId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: unknown;
  readonly scripts?: unknown;
  readonly isPinned?: boolean;
  readonly spaceId?: string | null;
}

/** Project fields the daemon's project registry has no place for. */
const UNSUPPORTED_META_FIELDS = [
  "workspaceRoot",
  "defaultModelSelection",
  "scripts",
  "spaceId",
] as const;

/** Project pins live in the bridge, not in the daemon's project registry. */
export interface ProjectPinStore {
  isPinned(projectId: string): boolean;
  setPinned(projectId: string, pinned: boolean): Promise<void>;
}

interface NeolixProjectDescriptor {
  readonly projectId: string;
  readonly projectRootPath: string;
}

interface AddProjectPayload {
  readonly project: NeolixProjectDescriptor | null;
  readonly error: string | null;
  readonly errorCode?: string | null;
}

interface CreateProjectDirectoryPayload {
  readonly project: NeolixProjectDescriptor | null;
  readonly error: string | null;
}

/**
 * `createWorkspaceRootIfMissing` only matters when the folder is absent: the daemon's add route
 * rejects a missing directory, while its create-directory route registers the new folder.
 */
async function addProject(client: DaemonClient, command: ProjectCreateCommand): Promise<string> {
  const workspaceRoot = command.workspaceRoot.trim();
  if (!workspaceRoot) {
    throw bridgeError("project.path-empty", "Project folder path is empty.");
  }

  const added = (await client.addProject(workspaceRoot)) as unknown as AddProjectPayload;
  if (added.project) return added.project.projectId;
  if (added.errorCode === "directory_not_found" && command.createWorkspaceRootIfMissing === true) {
    const created = (await client.createProjectDirectory({
      parentPath: path.dirname(workspaceRoot),
      name: path.basename(workspaceRoot),
    })) as unknown as CreateProjectDirectoryPayload;
    if (created.project) return created.project.projectId;
    if (created.error) {
      throw bridgeError("project.create-directory-failed", created.error, {
        detail: created.error,
      });
    }
  }
  if (added.errorCode === "directory_not_found") {
    // VS Code's Open Folder does not create the directory, and neither do we unless the
    // caller explicitly opted in. Name the missing path so the dialog can say so.
    throw bridgeError(
      "project.directory-missing",
      `Project directory does not exist: ${workspaceRoot}`,
      {
        path: workspaceRoot,
      },
    );
  }
  throw bridgeError(
    "project.add-failed",
    added.error ?? "The project folder could not be added.",
    added.error === null ? undefined : { detail: added.error },
  );
}

export function makeProjectHandlers(
  model: BridgeModel,
  options: { readonly projectPins?: ProjectPinStore } = {},
): Record<string, AnyHandler> {
  const client = model.client;
  return {
    "project.create": (payload) => {
      const command = payload as ProjectCreateCommand;
      // Neox project records own one root; dropping the extra folders would silently create a
      // project that does not match what the user asked for.
      if ((command.additionalFolders?.length ?? 0) > 0) {
        return Effect.fail(notSupported("project.create with additionalFolders"));
      }
      return fromPromise("project.create", async () => {
        const projectId = await addProject(client, command);
        model.aliasProject(command.projectId, projectId);
        // The daemon names a registered project after its folder; the dialog's name is only
        // carried by `title`, so it has to be applied as a rename when it differs.
        const title = command.title?.trim();
        if (title && title !== path.basename(command.workspaceRoot.trim())) {
          await client.renameProject(projectId, title);
        }
        if (command.isPinned === true) await options.projectPins?.setPinned(projectId, true);
        return { projectId, created: true };
      });
    },

    "project.delete": (payload) =>
      fromPromise("project.delete", async () => {
        const command = payload as ProjectDeleteCommand;
        await client.removeProject(model.resolveProjectId(command.projectId));
        return { projectId: command.projectId };
      }),

    "project.meta.update": (payload) => {
      const command = payload as ProjectMetaUpdateCommand;
      const projectId = model.resolveProjectId(command.projectId);
      const currentKind = model.projectKind(projectId);
      const unsupported: string[] = UNSUPPORTED_META_FIELDS.filter(
        (field) => command[field] !== undefined,
      );
      if (command.kind !== undefined && command.kind !== currentKind) unsupported.push("kind");
      // Failing the whole command beats applying part of it and reporting success.
      if (unsupported.length > 0) {
        return Effect.fail(notSupported(`project.meta.update ${unsupported.join(", ")}`));
      }
      if (command.isPinned !== undefined && !options.projectPins) {
        return Effect.fail(notSupported("project.meta.update isPinned"));
      }
      return fromPromise("project.meta.update", async () => {
        // The Home chat container is shared by every chat; the client names it after each new
        // chat, which the thread title already carries, so the container keeps its own name.
        if (command.title !== undefined && currentKind !== "chat") {
          await client.renameProject(projectId, command.title);
        }
        if (command.isPinned !== undefined) {
          await options.projectPins?.setPinned(projectId, command.isPinned);
        }
        return { projectId };
      });
    },
  };
}

const PROVISION_PHASE_MESSAGES: Record<GitHubProjectProvisionPhase, string> = {
  validating: "Checking the repository",
  "resolving-access": "Resolving repository access",
  cloning: "Cloning the repository",
  verifying: "Verifying the checkout",
  registering: "Adding the project",
};

/** `owner/repo` needs a protocol; a complete remote URL already carries one. */
function cloneProtocolFor(repository: string): "https" | undefined {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(repository) ? undefined : "https";
}

/** The folder name the daemon derives from the repository, matching its clone handler. */
function cloneRepoName(repository: string): string {
  const trimmed = repository.trim().replace(/\.git$/i, "");
  const pathPart = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^git@[^:]+:/i, "");
  return pathPart.split("/").findLast((segment) => segment.length > 0) ?? "";
}

function provisionError(
  token: string,
  message: string,
  params?: Readonly<Record<string, string | number>>,
): WsRpcError {
  return codedError(token, message, params, { retryable: false });
}

/**
 * `projects.provisionFromGitHub`: clone through the daemon, then register the checkout as a
 * project. The RPC is a stream, so the phase events keep the dialog's progress text moving and
 * the terminal `completed` event carries the result. A failure ends the stream with a typed
 * error instead of leaving the dialog waiting forever.
 */
export function projectProvisionFromGitHubHandler(model: BridgeModel): AnyHandler {
  return (payload) => {
    const input = payload as GitHubProjectProvisionInput;
    const operationId = input.operationId;
    const repository = input.repository.trim();
    const directoryName = input.directoryName.trim();
    // The dialog's field only allows a folder name; reject separators so the clone can never
    // land outside the destination the user chose.
    if (directoryName === "" || directoryName === "." || directoryName === "..") {
      return Stream.fail(
        provisionError(
          "github-provision.folder-name-required",
          "Choose a folder name for the clone.",
        ),
      );
    }
    if (/[/\\]/.test(directoryName)) {
      return Stream.fail(
        provisionError(
          "github-provision.folder-name-slashes",
          "The folder name cannot contain slashes.",
        ),
      );
    }
    const destinationParent = input.destinationParent.trim();
    // The daemon expects the parent directory and appends the repository's own folder name.
    // The dialog shows that name read-only, so a mismatch only comes from a direct caller.
    const repoName = cloneRepoName(repository);
    if (repoName === "" || directoryName !== repoName) {
      return Stream.fail(
        provisionError(
          "github-provision.folder-name-mismatch",
          `The folder name must match the repository name${repoName ? ` (${repoName})` : ""}.`,
          repoName ? { name: repoName } : undefined,
        ),
      );
    }
    const targetDirectory = destinationParent;
    const phase = (value: GitHubProjectProvisionPhase): GitHubProjectProvisionProgressEvent => ({
      operationId,
      kind: "phase",
      phase: value,
      message: PROVISION_PHASE_MESSAGES[value],
    });

    const clone = Effect.tryPromise({
      try: async () => {
        const cloneProtocol = cloneProtocolFor(repository);
        const payload = await model.client.cloneGithubProject({
          repo: repository,
          targetDirectory,
          ...(cloneProtocol ? { cloneProtocol } : {}),
        });
        if (payload.error || !payload.project || !payload.checkoutPath) {
          throw codedError(
            "github-provision.clone-failed",
            `GitHub clone failed: ${payload.error ?? "the daemon returned no checkout"}`,
            payload.error === null || payload.error === undefined
              ? undefined
              : { detail: payload.error },
            { retryable: false },
          );
        }
        model.aliasProject(input.projectId, payload.project.projectId);
        // The dialog waits for the registered project to reach the shell snapshot; reload here
        // rather than relying on the daemon's update event arriving first.
        await model.reloadProjects().catch(() => undefined);
        // The contract's ids are branded strings; the daemon values already satisfy them.
        const result = {
          operationId,
          repository: payload.repo,
          workspaceRoot: payload.checkoutPath,
          projectId: payload.project.projectId,
          checkout: "created",
        } as GitHubProjectProvisionResult;
        return {
          operationId,
          kind: "completed",
          result,
        } as GitHubProjectProvisionProgressEvent;
      },
      catch: (cause) =>
        cause instanceof WsRpcError
          ? cause
          : codedError(
              "github-provision.clone-failed",
              `GitHub clone failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              { detail: cause instanceof Error ? cause.message : String(cause) },
              { retryable: false },
            ),
    });

    // The daemon reports clone progress only when the whole clone finishes, so the opening
    // phases publish what the dialog shows while the long-running call is in flight.
    return Stream.concat(
      Stream.fromIterable([phase("validating"), phase("resolving-access"), phase("cloning")]),
      Stream.fromEffect(clone),
    );
  };
}
