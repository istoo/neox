import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import type {
  ProjectGithubCloneProtocol,
  ProjectAddResponse,
  WorkspaceProjectDescriptorPayload,
} from "@neolix/protocol/messages";
import { normalizeProjectDescriptor, type ProjectDescriptor } from "@/stores/session-store";

type OpenProjectPayload = ProjectAddResponse["payload"];
type OpenProjectErrorCode = NonNullable<OpenProjectPayload["errorCode"]>;

export interface OpenProjectSuccess {
  ok: true;
  project: WorkspaceProjectDescriptorPayload;
}

export type OpenProjectFailureReason =
  | "host_unavailable"
  | "host_upgrade_required"
  | "directory_not_found"
  | "open_failed";

export interface OpenProjectFailure {
  ok: false;
  reason: OpenProjectFailureReason;
  errorCode: OpenProjectErrorCode | null;
  error: string | null;
}

export type OpenProjectResult = OpenProjectSuccess | OpenProjectFailure;
export type { ProjectGithubCloneProtocol };

const OPEN_PROJECT_FAILURE_MESSAGE_KEYS: Record<OpenProjectFailureReason, string> = {
  host_unavailable: "sidebar.workspace.toasts.hostDisconnected",
  host_upgrade_required: "openProject.errors.hostUpgradeRequired",
  directory_not_found: "projectPicker.errors.directory_not_found",
  open_failed: "projectPicker.errors.open_failed",
};

export function getOpenProjectFailureMessageKey(result: OpenProjectResult): string | null {
  return result.ok ? null : OPEN_PROJECT_FAILURE_MESSAGE_KEYS[result.reason];
}

export function getOpenProjectFailureReason(
  result: OpenProjectResult,
): OpenProjectFailureReason | null {
  return result.ok ? null : result.reason;
}

export interface OpenProjectDirectlyInput {
  serverId: string;
  projectPath: string;
  isConnected: boolean;
  canAddProject: boolean;
  client: Pick<DaemonClient, "addProject"> | null;
  upsertProject: (serverId: string, project: ProjectDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

interface ProjectRegistrationCallbacks {
  serverId: string;
  isConnected: boolean;
  upsertProject: (serverId: string, project: ProjectDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

export interface RegisterProjectDescriptorInput {
  serverId: string;
  project: WorkspaceProjectDescriptorPayload;
  upsertProject: (serverId: string, project: ProjectDescriptor) => void;
  setHasHydratedWorkspaces: (serverId: string, hydrated: boolean) => void;
}

export function registerProjectDescriptor(input: RegisterProjectDescriptorInput): boolean {
  const serverId = input.serverId.trim();
  if (!serverId) return false;
  input.upsertProject(serverId, normalizeProjectDescriptor(input.project));
  input.setHasHydratedWorkspaces(serverId, true);
  return true;
}

export interface CloneGithubProjectDirectlyInput extends ProjectRegistrationCallbacks {
  repo: string;
  targetDirectory: string;
  cloneProtocol?: ProjectGithubCloneProtocol;
  client: Pick<DaemonClient, "cloneGithubProject"> | null;
}

export async function openProjectDirectly(
  input: OpenProjectDirectlyInput,
): Promise<OpenProjectResult> {
  const normalizedServerId = input.serverId.trim();
  const trimmedPath = input.projectPath.trim();
  if (!normalizedServerId || !trimmedPath || !input.client || !input.isConnected) {
    return { ok: false, reason: "host_unavailable", errorCode: null, error: null };
  }

  if (!input.canAddProject) {
    return {
      ok: false,
      reason: "host_upgrade_required",
      errorCode: null,
      error: "Update the host to add projects without creating a workspace.",
    };
  }

  const payload = await input.client.addProject(trimmedPath);
  if (payload.error || !payload.project) {
    return {
      ok: false,
      reason: payload.errorCode === "directory_not_found" ? "directory_not_found" : "open_failed",
      errorCode: payload.errorCode ?? null,
      error: payload.error,
    };
  }

  const registered = registerProjectDescriptor({
    serverId: normalizedServerId,
    project: payload.project,
    upsertProject: input.upsertProject,
    setHasHydratedWorkspaces: input.setHasHydratedWorkspaces,
  });
  return registered
    ? { ok: true, project: payload.project }
    : {
        ok: false,
        reason: "open_failed",
        errorCode: null,
        error: "Unable to register project",
      };
}

export async function cloneGithubProjectDirectly(
  input: CloneGithubProjectDirectlyInput,
): Promise<OpenProjectResult> {
  const normalizedServerId = input.serverId.trim();
  const trimmedRepo = input.repo.trim();
  const trimmedTargetDirectory = input.targetDirectory.trim();
  if (
    !normalizedServerId ||
    !trimmedRepo ||
    !trimmedTargetDirectory ||
    !input.client ||
    !input.isConnected
  ) {
    return { ok: false, reason: "host_unavailable", errorCode: null, error: null };
  }

  const payload = await input.client.cloneGithubProject({
    repo: trimmedRepo,
    targetDirectory: trimmedTargetDirectory,
    ...(input.cloneProtocol ? { cloneProtocol: input.cloneProtocol } : {}),
  });
  if (payload.error || !payload.project) {
    return { ok: false, reason: "open_failed", errorCode: null, error: payload.error };
  }

  const registered = registerProjectDescriptor({
    serverId: normalizedServerId,
    project: payload.project,
    upsertProject: input.upsertProject,
    setHasHydratedWorkspaces: input.setHasHydratedWorkspaces,
  });
  return registered
    ? { ok: true, project: payload.project }
    : {
        ok: false,
        reason: "open_failed",
        errorCode: null,
        error: "Unable to register project",
      };
}
