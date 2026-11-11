import {
  ProjectDevServerEvent,
  ProjectDiscoverScriptsResult,
  ProjectListDevServersResult,
  ProjectRestartDevServerResult,
  ProjectRunDevServerResult,
  ProjectStopDevServerResult,
  WS_METHODS,
} from "@synara/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import { makeDevServerHandlers, scriptNameFromCommand } from "./devServersRpc.ts";
import type { AnyHandler } from "./stubs.ts";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, never>);
}

const workspaces = [
  {
    id: "ws_1",
    projectId: "prj_1",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    scripts: [{ scriptName: "dev", lifecycle: "stopped" as const }],
  },
];

function makeHarness(options: { scripts?: unknown[] } = {}) {
  const calls: Array<[string, unknown]> = [];
  const lastRead = { path: "" };
  const tree: Record<string, unknown> = {
    "/repo/package.json": { name: "root", scripts: { dev: "vite", build: "tsc" } },
    "/repo/packages/web/package.json": {
      name: "web",
      scripts: { dev: "vite --port 3000" },
    },
  };
  const directories: Record<string, Array<{ name: string; kind: "file" | "directory" }>> = {
    ".": [
      { name: "packages", kind: "directory" },
      { name: "node_modules", kind: "directory" },
    ],
    packages: [{ name: "web", kind: "directory" }],
    "packages/web": [{ name: "src", kind: "directory" }],
    "packages/web/src": [],
  };
  const client = {
    readFile: async (cwd: string, relativePath: string) => {
      lastRead.path = relativePath;
      if (relativePath === "pnpm-lock.yaml") return { bytes: new Uint8Array([0]) };
      const value = tree[`${cwd}/${relativePath}`];
      if (value === undefined) throw new Error("not found");
      return { bytes: new TextEncoder().encode(JSON.stringify(value)) };
    },
    listDirectory: async (_cwd: string, relativePath: string) => {
      const entries = directories[relativePath];
      if (!entries) throw new Error("not a directory");
      return {
        entries: entries.map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          path: entry.name,
        })),
      };
    },
    fetchWorkspaces: async () => ({
      entries: [
        {
          ...workspaces[0],
          scripts: options.scripts ?? workspaces[0]?.scripts ?? [],
        },
      ],
    }),
    startWorkspaceScriptWithStatus: async (workspaceId: string, scriptName: string) => {
      calls.push(["startWorkspaceScriptWithStatus", { workspaceId, scriptName }]);
      return {
        requestId: "r",
        workspaceId,
        scriptName,
        script: { scriptName, lifecycle: "running", terminalId: "terminal_1" },
        error: null,
      };
    },
    stopWorkspaceScript: async (workspaceId: string, scriptName: string) => {
      calls.push(["stopWorkspaceScript", { workspaceId, scriptName }]);
      return { requestId: "r", workspaceId, scriptName, script: null, error: null };
    },
    createTerminal: async (cwd: string, name: string, _requestId?: string, opts?: unknown) => {
      calls.push(["createTerminal", { cwd, name, opts }]);
      return { requestId: "r", terminal: { id: "terminal_custom", cwd }, error: null };
    },
    killTerminal: async (terminalId: string) => {
      calls.push(["killTerminal", terminalId]);
      return { requestId: "r", terminalId, success: true };
    },
    on: (_type: string, _handler: unknown) => () => {},
  };
  const model = { client } as unknown as BridgeModel;
  return { handlers: makeDevServerHandlers(model), calls, lastRead };
}

describe("devServersRpc discovery", () => {
  it("scans package.json files and reports runnable commands", async () => {
    const { handlers } = makeHarness();
    const result = await run<ProjectDiscoverScriptsResult>(
      handlers[WS_METHODS.projectsDiscoverScripts],
      { cwd: "/repo", depth: 3 },
    );
    const encoded = encode(ProjectDiscoverScriptsResult, result) as ProjectDiscoverScriptsResult;
    expect(encoded.targets).toEqual([
      {
        cwd: "/repo",
        relativePath: ".",
        packageJsonPath: "package.json",
        packageName: "root",
        scripts: [
          { name: "dev", command: "pnpm run dev" },
          { name: "build", command: "pnpm run build" },
        ],
      },
      {
        cwd: "/repo/packages/web",
        relativePath: "packages/web",
        packageJsonPath: "packages/web/package.json",
        packageName: "web",
        scripts: [{ name: "dev", command: "pnpm run dev" }],
      },
    ]);
  });

  it("recognizes the commands it emits", () => {
    expect(scriptNameFromCommand("pnpm run dev")).toBe("dev");
    expect(scriptNameFromCommand("npm run start:web")).toBe("start:web");
    expect(scriptNameFromCommand("vite")).toBe("vite");
    expect(scriptNameFromCommand("node scripts/serve.js")).toBeNull();
  });
});

describe("devServersRpc lifecycle", () => {
  it("starts a configured workspace script", async () => {
    const { handlers, calls } = makeHarness();
    const result = await run<ProjectRunDevServerResult>(handlers[WS_METHODS.projectsRunDevServer], {
      projectId: "prj_1",
      command: "pnpm run dev",
      cwd: "/repo",
    });
    const encoded = encode(ProjectRunDevServerResult, result) as ProjectRunDevServerResult;
    expect(encoded.server).toMatchObject({
      projectId: "prj_1",
      command: "dev",
      cwd: "/repo",
      status: "running",
    });
    expect(calls).toEqual([
      ["startWorkspaceScriptWithStatus", { workspaceId: "ws_1", scriptName: "dev" }],
    ]);
  });

  it("runs a command that is not a configured script in a terminal", async () => {
    const { handlers, calls } = makeHarness({ scripts: [] });
    const result = await run<ProjectRunDevServerResult>(handlers[WS_METHODS.projectsRunDevServer], {
      projectId: "prj_1",
      command: "node scripts/serve.js",
      cwd: "/repo",
    });
    const encoded = encode(ProjectRunDevServerResult, result) as ProjectRunDevServerResult;
    expect(encoded.server.command).toBe("node scripts/serve.js");
    expect(calls[0]?.[0]).toBe("createTerminal");
  });

  it("lists running scripts and stops the project's scripts", async () => {
    const { handlers, calls } = makeHarness({
      scripts: [{ scriptName: "dev", lifecycle: "running", terminalId: "terminal_1" }],
    });
    const listed = await run<ProjectListDevServersResult>(
      handlers[WS_METHODS.projectsListDevServers],
      {},
    );
    expect(
      (encode(ProjectListDevServersResult, listed) as ProjectListDevServersResult).servers,
    ).toEqual([
      {
        projectId: "prj_1",
        command: "dev",
        cwd: "/repo",
        pid: null,
        startedAt: expect.any(String),
        status: "running",
        scriptName: "dev",
        terminalId: "terminal_1",
        port: null,
        urls: [],
      },
    ]);

    const stopped = await run<ProjectStopDevServerResult>(
      handlers[WS_METHODS.projectsStopDevServer],
      { projectId: "prj_1" },
    );
    expect(encode(ProjectStopDevServerResult, stopped)).toEqual({ stopped: true });
    expect(calls).toEqual([["stopWorkspaceScript", { workspaceId: "ws_1", scriptName: "dev" }]]);
  });

  it("emits a snapshot when a client subscribes", async () => {
    const { handlers } = makeHarness({
      scripts: [{ scriptName: "dev", lifecycle: "running", terminalId: "terminal_1" }],
    });
    const stream = handlers[WS_METHODS.subscribeProjectDevServerEvents]!(
      {},
      {},
    ) as Stream.Stream<ProjectDevServerEvent>;
    const events = [...(await Effect.runPromise(Stream.runCollect(Stream.take(stream, 1))))];
    const encoded = encode(ProjectDevServerEvent, events[0]) as ProjectDevServerEvent;
    expect(encoded.type).toBe("snapshot");
    if (encoded.type === "snapshot") expect(encoded.servers).toHaveLength(1);
  });

  it("projects the service's three routes and direct port", async () => {
    const { handlers } = makeHarness({
      scripts: [
        {
          scriptName: "web",
          lifecycle: "running",
          terminalId: "terminal_web",
          hostname: "neolix",
          port: 5173,
          localProxyUrl: "http://web.example.localhost",
          publicProxyUrl: "https://web-abc.public.example",
        },
      ],
    });
    const listed = await run<ProjectListDevServersResult>(
      handlers[WS_METHODS.projectsListDevServers],
      {},
    );
    const server = (encode(ProjectListDevServersResult, listed) as ProjectListDevServersResult)
      .servers[0];
    expect(server?.hostname).toBe("neolix");
    expect(server?.port).toBe(5173);
    expect(server?.terminalId).toBe("terminal_web");
    expect(server?.urls).toEqual([
      { kind: "public", label: "web-abc.public.example", url: "https://web-abc.public.example" },
      { kind: "neolix", label: "web.example.localhost", url: "http://web.example.localhost" },
      { kind: "direct", label: "localhost:5173", url: "http://localhost:5173" },
    ]);
  });

  it("restarts a command that runs in a daemon terminal", async () => {
    const { handlers, calls } = makeHarness({ scripts: [] });
    await run<ProjectRunDevServerResult>(handlers[WS_METHODS.projectsRunDevServer], {
      projectId: "prj_1",
      command: "node scripts/serve.js",
      cwd: "/repo",
    });
    const result = await run<ProjectRestartDevServerResult>(
      handlers[WS_METHODS.projectsRestartDevServer],
      { projectId: "prj_1" },
    );
    expect(encode(ProjectRestartDevServerResult, result)).toEqual({ restarted: true });
    expect(calls.map(([name]) => name)).toEqual([
      "createTerminal",
      "killTerminal",
      "createTerminal",
    ]);
  });
});
