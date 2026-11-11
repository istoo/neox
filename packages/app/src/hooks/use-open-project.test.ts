import { describe, expect, it } from "vitest";
import {
  cloneGithubProjectDirectly,
  getOpenProjectFailureMessageKey,
  getOpenProjectFailureReason,
  openProjectDirectly,
} from "@/hooks/open-project";
import type { ProjectDescriptor } from "@/stores/session-store";

const SERVER_ID = "server-1";
const PROJECT_PATH = "/repo/project";

function buildProjectPayload() {
  return {
    projectId: "project-1",
    projectDisplayName: "project",
    projectRootPath: PROJECT_PATH,
    projectKind: "git" as const,
  };
}

interface RecordedProject {
  serverId: string;
  project: ProjectDescriptor;
}

interface RecordedHydrated {
  serverId: string;
  hydrated: boolean;
}

interface RecordedClone {
  repo: string;
  targetDirectory: string;
  cloneProtocol?: "https" | "ssh";
}

function createFakeSession() {
  const projects: RecordedProject[] = [];
  const hydrated: RecordedHydrated[] = [];
  return {
    projects,
    hydrated,
    upsertProject: (serverId: string, project: ProjectDescriptor) => {
      projects.push({ serverId, project });
    },
    setHasHydratedWorkspaces: (serverId: string, value: boolean) => {
      hydrated.push({ serverId, hydrated: value });
    },
  };
}

function createFakeGithubCloneClient(project: ReturnType<typeof buildProjectPayload> | null) {
  const clones: RecordedClone[] = [];
  return {
    clones,
    cloneGithubProject: async (input: RecordedClone) => {
      clones.push(input);
      return {
        requestId: "request-3",
        repo: "owner/project",
        checkoutPath: PROJECT_PATH,
        error: project ? null : "Project registration failed",
        project,
      };
    },
  };
}

describe("openProjectDirectly", () => {
  it("adds the project and marks workspaces hydrated without opening a workspace", async () => {
    const session = createFakeSession();
    const projectPayload = buildProjectPayload();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: true,
      client: {
        addProject: async () => ({
          requestId: "request-1",
          error: null,
          project: projectPayload,
        }),
      },
      upsertProject: session.upsertProject,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: true, project: projectPayload });
    expect(session.projects).toEqual([
      {
        serverId: SERVER_ID,
        project: {
          projectId: "project-1",
          projectKey: null,
          projectDisplayName: "project",
          projectCustomName: null,
          projectCustomIconRevision: null,
          projectKind: "git",
          projectRootPath: PROJECT_PATH,
        },
      },
    ]);
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
  });

  it("fails before sending when the host does not support adding projects without workspaces", async () => {
    const session = createFakeSession();
    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: false,
      client: {
        addProject: async () => ({
          requestId: "request-unsupported",
          error: null,
          project: buildProjectPayload(),
        }),
      },
      upsertProject: session.upsertProject,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      reason: "host_upgrade_required",
      errorCode: null,
      error: "Update the host to add projects without creating a workspace.",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });

  it("does not add a project when addProject fails", async () => {
    const session = createFakeSession();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: true,
      client: {
        addProject: async () => ({
          requestId: "request-2",
          error: "Directory not found: /repo/project",
          errorCode: "directory_not_found" as const,
          project: null,
        }),
      },
      upsertProject: session.upsertProject,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      reason: "directory_not_found",
      errorCode: "directory_not_found",
      error: "Directory not found: /repo/project",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });
});

describe("cloneGithubProjectDirectly", () => {
  it("registers a cloned GitHub project without creating a workspace", async () => {
    const session = createFakeSession();
    const projectPayload = buildProjectPayload();
    const github = createFakeGithubCloneClient(projectPayload);

    const result = await cloneGithubProjectDirectly({
      serverId: SERVER_ID,
      repo: "owner/project",
      targetDirectory: "~/workspace",
      cloneProtocol: "https",
      isConnected: true,
      client: github,
      upsertProject: session.upsertProject,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: true, project: projectPayload });
    expect(github.clones).toEqual([
      {
        repo: "owner/project",
        targetDirectory: "~/workspace",
        cloneProtocol: "https",
      },
    ]);
    expect(session.projects).toEqual([
      {
        serverId: SERVER_ID,
        project: {
          ...projectPayload,
          projectCustomName: null,
          projectKey: null,
          projectCustomIconRevision: null,
        },
      },
    ]);
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
  });

  it("does not register a project when cloning fails", async () => {
    const session = createFakeSession();
    const github = createFakeGithubCloneClient(null);

    const result = await cloneGithubProjectDirectly({
      serverId: SERVER_ID,
      repo: "owner/project",
      targetDirectory: "~/workspace",
      cloneProtocol: "https",
      isConnected: true,
      client: github,
      upsertProject: session.upsertProject,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      reason: "open_failed",
      errorCode: null,
      error: "Project registration failed",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });
});

describe("getOpenProjectFailureReason", () => {
  it("keeps the known directory-not-found failure reason", () => {
    expect(
      getOpenProjectFailureReason({
        ok: false,
        reason: "directory_not_found",
        errorCode: "directory_not_found",
        error: "Directory not found: /missing",
      }),
    ).toBe("directory_not_found");
  });

  it("uses the generic failure reason for untyped project-open failures", () => {
    expect(
      getOpenProjectFailureReason({
        ok: false,
        reason: "open_failed",
        errorCode: null,
        error: "boom",
      }),
    ).toBe("open_failed");
  });
});

describe("getOpenProjectFailureMessageKey", () => {
  it("maps an unavailable host to the shared host-disconnected copy", () => {
    expect(
      getOpenProjectFailureMessageKey({
        ok: false,
        reason: "host_unavailable",
        errorCode: null,
        error: null,
      }),
    ).toBe("sidebar.workspace.toasts.hostDisconnected");
  });

  it("maps an outdated host and open failures to translated copy", () => {
    expect(
      getOpenProjectFailureMessageKey({
        ok: false,
        reason: "host_upgrade_required",
        errorCode: null,
        error: "Update the host",
      }),
    ).toBe("openProject.errors.hostUpgradeRequired");
    expect(
      getOpenProjectFailureMessageKey({
        ok: false,
        reason: "open_failed",
        errorCode: null,
        error: "boom",
      }),
    ).toBe("projectPicker.errors.open_failed");
  });

  it("returns no message for successes", () => {
    expect(
      getOpenProjectFailureMessageKey({
        ok: true,
        project: buildProjectPayload(),
      }),
    ).toBeNull();
  });
});

describe("openProjectDirectly host state", () => {
  it("reports an unavailable host instead of a generic open failure", async () => {
    const session = createFakeSession();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: false,
      canAddProject: true,
      client: null,
      upsertProject: session.upsertProject,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      reason: "host_unavailable",
      errorCode: null,
      error: null,
    });
  });
});
