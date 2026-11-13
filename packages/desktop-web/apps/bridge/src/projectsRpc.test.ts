import { ProjectCreateCommand } from "@synara/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import type { DaemonClient } from "./neolix.ts";
import {
  makeProjectHandlers,
  projectProvisionFromGitHubHandler,
  toNeolixScripts,
} from "./projectsRpc.ts";

const CREATE = {
  type: "project.create",
  commandId: "2f0e7a3c-6d3b-4a44-9f71-6d3b5a44a0c1",
  projectId: "5b0f6e2a-7c1d-4e2b-9a63-0f1e2d3c4b5a",
  kind: "project",
  title: "Neox",
  workspaceRoot: "/repo",
  createdAt: "2026-11-08T00:00:00.000Z",
};

interface Fakes {
  readonly added?: Record<string, unknown>;
  readonly created?: Record<string, unknown>;
  readonly cloned?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
}

function makeHandlers(fakes: Fakes = {}) {
  const calls: Array<[string, unknown]> = [];
  const client = {
    addProject: async (cwd: string) => {
      calls.push(["addProject", cwd]);
      return fakes.added ?? { project: { projectId: "prj_1", projectRootPath: cwd }, error: null };
    },
    createProjectDirectory: async (input: unknown) => {
      calls.push(["createProjectDirectory", input]);
      return fakes.created ?? { project: { projectId: "prj_2" }, error: null };
    },
    removeProject: async (projectId: string) => {
      calls.push(["removeProject", projectId]);
      return { removedWorkspaceIds: [] };
    },
    renameProject: async (projectId: string, name: string | null) => {
      calls.push(["renameProject", { projectId, name }]);
      return { customName: name };
    },
    cloneGithubProject: async (input: unknown) => {
      calls.push(["cloneGithubProject", input]);
      return (
        fakes.cloned ?? {
          repo: "acme/widget",
          checkoutPath: "/clones/widget",
          project: { projectId: "prj_clone" },
          error: null,
        }
      );
    },
    readProjectConfig: async (repoRoot: string) => {
      calls.push(["readProjectConfig", repoRoot]);
      return fakes.config ?? { ok: true, config: null, revision: null };
    },
    writeProjectConfig: async (input: unknown) => {
      calls.push(["writeProjectConfig", input]);
      return { ok: true, config: null, revision: null };
    },
  } as unknown as DaemonClient;
  const aliases = new Map<string, string>();
  const kinds: Record<string, string> = { prj_1: "project", prj_home: "chat" };
  const resolve = (id: string) => aliases.get(id) ?? id;
  const reloads: string[] = [];
  const model = {
    client,
    aliasProject: (clientId: string, daemonId: string) => aliases.set(clientId, daemonId),
    resolveProjectId: resolve,
    projectKind: (id: string) => kinds[resolve(id)],
    projectRoot: () => "/repo",
    reloadProjects: async () => {
      reloads.push("reload");
    },
  } as unknown as BridgeModel;
  const pins = new Map<string, boolean>();
  const projectPins = {
    isPinned: (projectId: string) => pins.get(projectId) === true,
    setPinned: async (projectId: string, pinned: boolean) => {
      calls.push(["setPinned", { projectId, pinned }]);
      pins.set(projectId, pinned);
    },
  };
  return {
    handlers: makeProjectHandlers(model, { projectPins }),
    calls,
    aliases,
    pins,
    model,
    reloads,
  };
}

async function call<T>(
  handlers: Record<string, (payload: unknown, options: unknown) => unknown>,
  method: string,
  payload: unknown,
): Promise<T> {
  return Effect.runPromise(handlers[method]!(payload, undefined) as Effect.Effect<T, never>);
}

const renameTo = (projectId: string, title: string) => ({
  type: "project.meta.update",
  commandId: "cmd-meta",
  projectId,
  title,
});

const action = (name: string, command: string) => ({ id: name, name, command });

const writtenConfig = (calls: Array<[string, unknown]>) =>
  (
    calls.find(([name]) => name === "writeProjectConfig")?.[1] as
      | { config: Record<string, unknown> }
      | undefined
  )?.config;

describe("projectsRpc", () => {
  it("adds the project folder through the daemon registry", async () => {
    // The payload is the contract's own shape; the handler must not need extra fields.
    const command = Schema.decodeUnknownSync(ProjectCreateCommand)(CREATE);
    const { handlers, calls, aliases, reloads } = makeHandlers();
    const result = await call<{ projectId: string; created: boolean }>(
      handlers,
      "project.create",
      command,
    );
    expect(result).toEqual({ projectId: "prj_1", created: true });
    expect(calls).toEqual([
      ["addProject", "/repo"],
      // The dialog's name is not the folder name, so it is applied as a rename.
      ["renameProject", { projectId: "prj_1", name: "Neox" }],
    ]);
    // The daemon does not announce the registration; the bridge must refresh the shell itself.
    expect(reloads).toEqual(["reload"]);
    // Later commands still name the id the client minted.
    expect(aliases.get(String(command.projectId))).toBe("prj_1");
  });

  it("creates a missing folder before adding it", async () => {
    const { handlers, calls } = makeHandlers({
      added: {
        project: null,
        error: "Directory not found: /missing",
        errorCode: "directory_not_found",
      },
    });
    const result = await call<{ projectId: string }>(handlers, "project.create", {
      ...CREATE,
      workspaceRoot: "/workspace/new-project",
      createWorkspaceRootIfMissing: true,
    });
    expect(result.projectId).toBe("prj_2");
    expect(calls).toEqual([
      ["addProject", "/workspace/new-project"],
      ["createProjectDirectory", { parentPath: "/workspace", name: "new-project" }],
      ["renameProject", { projectId: "prj_2", name: "Neox" }],
    ]);
  });

  it("surfaces the daemon error when the folder cannot be added", async () => {
    const { handlers } = makeHandlers({
      added: { project: null, error: "permission denied", errorCode: null },
    });
    await expect(
      Effect.runPromise(
        handlers["project.create"]!(CREATE, undefined) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("permission denied"),
      code: "neolix.error.project.add-failed",
      params: { detail: "permission denied" },
    });
  });

  it("refuses extra folders instead of silently dropping them", async () => {
    const { handlers, calls } = makeHandlers();
    await expect(
      Effect.runPromise(
        handlers["project.create"]!(
          { ...CREATE, additionalFolders: ["/other"] },
          undefined,
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
    expect(calls).toEqual([]);
  });

  it("removes a project by the id the shell snapshot exposes", async () => {
    const { handlers, calls, reloads } = makeHandlers();
    const result = await call<{ projectId: string }>(handlers, "project.delete", {
      type: "project.delete",
      commandId: "cmd-del",
      projectId: "prj_1",
    });
    expect(result).toEqual({ projectId: "prj_1" });
    expect(calls).toEqual([["removeProject", "prj_1"]]);
    expect(reloads).toEqual(["reload"]);
  });

  it("renames a project and leaves the shared Home chat container named as it is", async () => {
    const { handlers, calls, aliases, reloads } = makeHandlers();
    aliases.set("client-home", "prj_home");
    await call(handlers, "project.meta.update", renameTo("prj_1", "Renamed"));
    await call(handlers, "project.meta.update", renameTo("client-home", "Renamed"));
    expect(calls).toEqual([["renameProject", { projectId: "prj_1", name: "Renamed" }]]);
    // Both commands refresh the shell; the Home container's skipped rename still re-emits it.
    expect(reloads).toEqual(["reload", "reload"]);
  });

  it("refuses project fields the daemon cannot store", async () => {
    const { handlers, calls } = makeHandlers();
    await expect(
      Effect.runPromise(
        handlers["project.meta.update"]!(
          {
            type: "project.meta.update",
            commandId: "c",
            projectId: "prj_1",
            title: "x",
            workspaceRoot: "/elsewhere",
          },
          undefined,
        ) as Effect.Effect<unknown, never>,
      ),
    ).rejects.toMatchObject({ code: "neolix.not-supported" });
    expect(calls).toEqual([]);
  });

  it("keeps a project pin in the bridge and reports success", async () => {
    const { handlers, calls, pins, reloads } = makeHandlers();
    await call(handlers, "project.meta.update", {
      type: "project.meta.update",
      commandId: "c",
      projectId: "prj_1",
      isPinned: true,
    });
    expect(calls).toEqual([["setPinned", { projectId: "prj_1", pinned: true }]]);
    expect(pins.get("prj_1")).toBe(true);
    expect(reloads).toEqual(["reload"]);
  });

  it("does not rename a project whose title already matches its folder", async () => {
    const { handlers, calls } = makeHandlers();
    await call(handlers, "project.create", { ...CREATE, workspaceRoot: "/workspace/Neox" });
    expect(calls).toEqual([["addProject", "/workspace/Neox"]]);
  });
});

describe("toNeolixScripts", () => {
  it("maps the client's actions to neox.json script entries", () => {
    expect(
      toNeolixScripts([action("dev", "vite"), action("ping", "echo pong")], undefined),
    ).toEqual({ dev: { command: "vite" }, ping: { command: "echo pong" } });
  });

  it("keeps the keys the client does not model on entries it already knows", () => {
    const existing = { server: { type: "service", port: 3000, command: "old" } };
    expect(toNeolixScripts([action("server", "node server.js")], existing)).toEqual({
      server: { type: "service", port: 3000, command: "node server.js" },
    });
  });

  it("drops entries the client removed, and entries without a name or command", () => {
    const existing = { gone: { type: "service", command: "x" } };
    expect(toNeolixScripts([action("  ", "x"), action("ok", "  ")], existing)).toEqual({});
  });
});

describe("project.meta.update scripts", () => {
  const update = (handlers: ReturnType<typeof makeHandlers>["handlers"], scripts: unknown[]) =>
    call(handlers, "project.meta.update", {
      type: "project.meta.update",
      commandId: "c",
      projectId: "prj_1",
      scripts,
    });

  it("writes the actions into neox.json", async () => {
    const { handlers, calls } = makeHandlers();
    await update(handlers, [
      { id: "dev", name: "dev", command: "vite", runOnWorktreeCreate: false },
    ]);
    expect(writtenConfig(calls)).toEqual({ scripts: { dev: { command: "vite" } } });
  });

  it("maps run-on-worktree-create to the config's worktree setup and back", async () => {
    const { handlers, calls } = makeHandlers();
    await update(handlers, [
      { id: "dev", name: "dev", command: "vite", runOnWorktreeCreate: false },
      { id: "setup", name: "setup", command: "bun install", runOnWorktreeCreate: true },
    ]);
    expect(writtenConfig(calls)).toEqual({
      scripts: { dev: { command: "vite" }, setup: { command: "bun install" } },
      worktree: { setup: "bun install" },
    });
  });

  it("clears a setup the actions own, but keeps a hand-written one", async () => {
    const owned = makeHandlers({
      config: {
        ok: true,
        revision: { mtimeMs: 1, size: 1 },
        config: {
          scripts: { setup: { command: "bun install" } },
          worktree: { setup: "bun install", teardown: "rm -rf node_modules" },
        },
      },
    });
    await update(owned.handlers, [
      { id: "setup", name: "setup", command: "bun install", runOnWorktreeCreate: false },
    ]);
    expect(writtenConfig(owned.calls)).toEqual({
      scripts: { setup: { command: "bun install" } },
      worktree: { teardown: "rm -rf node_modules" },
    });

    const unowned = makeHandlers({
      config: {
        ok: true,
        revision: { mtimeMs: 1, size: 1 },
        config: { scripts: {}, worktree: { setup: "make deps" } },
      },
    });
    await update(unowned.handlers, [
      { id: "dev", name: "dev", command: "vite", runOnWorktreeCreate: false },
    ]);
    expect(writtenConfig(unowned.calls)).toEqual({
      scripts: { dev: { command: "vite" } },
      worktree: { setup: "make deps" },
    });
  });
});

describe("projects.provisionFromGitHub", () => {
  const runProvision = async (
    handlers: ReturnType<typeof makeHandlers>,
    payload: Record<string, unknown>,
  ) => {
    const stream = projectProvisionFromGitHubHandler(handlers.model)(
      payload,
      undefined,
    ) as unknown as Stream.Stream<Record<string, unknown>, unknown>;
    return Effect.runPromise(
      Stream.runCollect(stream).pipe(Effect.map((events) => Array.from(events))),
    );
  };

  const INPUT = {
    operationId: "op-1",
    repository: "acme/widget",
    destinationParent: "/clones",
    directoryName: "widget",
    commandId: "cmd-1",
    projectId: "client-project",
    newProjectSpaceId: null,
    defaultModelSelection: { provider: "codex", model: "gpt-5" },
    createdAt: "2026-11-08T00:00:00.000Z",
  };

  it("clones through the daemon and completes with the checkout's project", async () => {
    const fake = makeHandlers();
    const events = await runProvision(fake, INPUT);
    expect(fake.calls).toEqual([
      [
        "cloneGithubProject",
        // The daemon appends the repo's own folder name to the parent it is given.
        { repo: "acme/widget", targetDirectory: "/clones", cloneProtocol: "https" },
      ],
    ]);
    expect(fake.reloads).toEqual(["reload"]);
    expect(fake.aliases.get("client-project")).toBe("prj_clone");
    expect(events.at(-1)).toMatchObject({
      kind: "completed",
      result: {
        operationId: "op-1",
        repository: "acme/widget",
        workspaceRoot: "/clones/widget",
        projectId: "prj_clone",
        checkout: "created",
      },
    });
    expect(events.slice(0, -1).map((event) => event.kind)).toEqual(["phase", "phase", "phase"]);
  });

  it("surfaces the daemon error instead of hanging", async () => {
    const fake = makeHandlers({
      cloned: { repo: "acme/missing", checkoutPath: null, project: null, error: "not found" },
    });
    await expect(
      runProvision(fake, { ...INPUT, repository: "acme/missing", directoryName: "missing" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("not found") });
  });

  it("rejects a folder name that the daemon would not derive", async () => {
    const fake = makeHandlers();
    await expect(runProvision(fake, { ...INPUT, directoryName: "renamed" })).rejects.toMatchObject({
      message: expect.stringContaining("must match the repository name"),
    });
    expect(fake.calls).toEqual([]);
  });

  it("rejects a folder name that could escape the destination", async () => {
    const fake = makeHandlers();
    await expect(
      runProvision(fake, { ...INPUT, directoryName: "../escape" }),
    ).rejects.toMatchObject({ message: expect.stringContaining("cannot contain slashes") });
    expect(fake.calls).toEqual([]);
  });
});
