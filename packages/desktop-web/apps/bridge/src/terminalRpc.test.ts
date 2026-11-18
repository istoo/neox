import { TerminalEvent, TerminalSessionSnapshot, WS_METHODS, WsRpcError } from "@synara/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";

import type { BridgeModel } from "./model.ts";
import { makeTerminalHandlers } from "./terminalRpc.ts";
import type { AnyHandler } from "./stubs.ts";

const THREAD_ID = "8a1f0e6c-0d0e-4c64-9d61-1d2f6f9b7c11";

const encode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.encodeUnknownSync(schema as never)(value);

const tick = (ms = 10) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function run<A>(handler: AnyHandler | undefined, payload: unknown): Promise<A> {
  if (!handler) throw new Error("handler is missing");
  return Effect.runPromise(handler(payload, {}) as Effect.Effect<A, WsRpcError>);
}

function makeFakeClient(options: { terminals?: Array<Record<string, unknown>> } = {}) {
  const encoder = new TextEncoder();
  const created: Array<{ cwd: string; name: string; options: unknown }> = [];
  const killed: string[] = [];
  const inputs: Array<[string, unknown]> = [];
  const heartbeats: Array<Record<string, unknown>> = [];
  // Call order matters: the size claim has to reach the daemon before the subscription that
  // triggers the replay snapshot, or the replay is serialized at the old PTY size.
  const calls: string[] = [];
  let receiver: ((event: unknown) => void) | undefined;
  let observers: Array<(message: unknown) => void> = [];
  let terminalObservers: Array<{ update(message: unknown): void }> = [];
  let nextId = 1;
  let features: Record<string, boolean> = {};

  const client = {
    getLastServerInfoMessage: () => ({ features }),
    listTerminals: async () => ({ terminals: options.terminals ?? [] }),
    createTerminal: async (cwd: string, name: string, _requestId?: string, options?: unknown) => {
      created.push({ cwd, name, options });
      const id = `daemon-${nextId++}`;
      return { terminal: { id, name, cwd, workspaceId: "ws-1" }, error: null, requestId: "r" };
    },
    observeTerminal: (daemonId: string, receive: (event: unknown) => void) => {
      calls.push(`observe:${daemonId}`);
      receiver = receive;
      setTimeout(() => {
        receive({ type: "replay", replay: { type: "begin" } });
        receive({ type: "replay", replay: { type: "data", data: encoder.encode("$ ") } });
        receive({ type: "replay", replay: { type: "end" } });
      }, 0);
      return {
        subscriptionId: "sub-1",
        ready: Promise.resolve({
          terminalId: daemonId,
          slot: 1,
          subscriptionId: "sub-1",
          error: null,
          requestId: "r",
        }),
        subscribe: (observer: { update(message: unknown): void }) => {
          observers.push(observer.update);
          return () => {
            observers = observers.filter((update) => update !== observer.update);
          };
        },
        release: async () => {},
      };
    },
    observeTerminals: (input: { cwd: string }) => ({
      subscriptionId: "terminals-1",
      ready: Promise.resolve({
        subscriptionId: "terminals-1",
        cwd: input.cwd,
        terminals: options.terminals ?? [],
      }),
      subscribe: (observer: { update(message: unknown): void }) => {
        terminalObservers.push(observer);
        return () => {
          terminalObservers = terminalObservers.filter((entry) => entry !== observer);
        };
      },
      release: async () => {},
    }),
    sendTerminalInput: (daemonId: string, message: unknown) => {
      calls.push(`input:${daemonId}`);
      inputs.push([daemonId, message]);
    },
    killTerminal: async (daemonId: string) => {
      killed.push(daemonId);
      return { terminalId: daemonId, success: true, requestId: "r" };
    },
    sendHeartbeat: (params: Record<string, unknown>) => {
      heartbeats.push(params);
    },
  };

  return {
    client,
    created,
    killed,
    inputs,
    heartbeats,
    calls,
    setFeatures: (next: Record<string, boolean>) => {
      features = next;
    },
    output: (text: string) => receiver?.({ type: "output", data: encoder.encode(text) }),
    exit: (error?: string, exitCode?: number) => {
      for (const update of observers) {
        update({
          type: "terminal_stream_exit",
          payload: {
            terminalId: "daemon-1",
            ...(error ? { error } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
          },
        });
      }
    },
    activity: (terminalId: string, activity: unknown) => {
      for (const observer of terminalObservers) {
        observer.update({
          type: "terminals_changed",
          payload: { cwd: "/repo", terminals: [{ id: terminalId, activity }] },
        });
      }
    },
  };
}

function makeHandlers(fake: ReturnType<typeof makeFakeClient>) {
  const model = { client: fake.client } as unknown as BridgeModel;
  return makeTerminalHandlers(model);
}

function collectEvents(handlers: Record<string, AnyHandler>, count: number) {
  const stream = handlers[WS_METHODS.subscribeTerminalEvents]!(
    {},
    {},
  ) as Stream.Stream<TerminalEvent>;
  return Effect.runPromise(Stream.runCollect(Stream.take(stream, count))).then((chunk) => [
    ...chunk,
  ]);
}

describe("terminalRpc", () => {
  it("opens a daemon terminal, folds the initial replay into the snapshot, and emits started", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    const eventsPromise = collectEvents(handlers, 1);
    await tick(0);

    const snapshot = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 100,
      rows: 30,
    });
    const events = await eventsPromise;

    expect(snapshot).toMatchObject({
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo",
      status: "running",
      pid: null,
      history: "$ ",
      exitCode: null,
      exitSignal: null,
    });
    expect(() => encode(TerminalSessionSnapshot, snapshot)).not.toThrow();
    expect(fake.created[0]).toMatchObject({
      cwd: "/repo",
      name: `synara:${THREAD_ID}:default`,
      options: { size: { cols: 100, rows: 30 } },
    });
    expect(events.map((event) => event.type)).toEqual(["started"]);
    expect(() => encode(TerminalEvent, events[0])).not.toThrow();
  });

  it("forwards daemon terminal activity and the PTY exit code", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    const eventsPromise = collectEvents(handlers, 3);
    await tick(0);

    await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 100,
      rows: 30,
    });
    fake.activity("daemon-1", { state: "working", changedAt: 1 });
    fake.exit(undefined, 7);
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual(["started", "activity", "exited"]);
    expect(events[1]).toMatchObject({
      type: "activity",
      hasRunningSubprocess: true,
      agentState: "running",
    });
    expect(events[2]).toMatchObject({ type: "exited", exitCode: 7, exitSignal: null });
    for (const event of events) expect(() => encode(TerminalEvent, event)).not.toThrow();
  });

  it("reports only a live session's daemon terminal in focus heartbeats", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);

    await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 100,
      rows: 30,
    });

    await run<void>(handlers[WS_METHODS.terminalFocusHeartbeat], {
      threadId: THREAD_ID,
      terminalId: "default",
      appVisible: true,
    });
    expect(fake.heartbeats.at(-1)).toMatchObject({
      deviceType: "web",
      focusedAgentId: null,
      focusedTerminalId: "daemon-1",
      appVisible: true,
    });
    expect(fake.heartbeats.at(-1)?.lastActivityAt).toEqual(expect.any(String));

    // A caller-supplied terminal id the bridge never opened clears focus instead
    // of naming a daemon terminal it does not own.
    await run<void>(handlers[WS_METHODS.terminalFocusHeartbeat], {
      threadId: THREAD_ID,
      terminalId: "forged",
      appVisible: true,
    });
    expect(fake.heartbeats.at(-1)).toMatchObject({
      focusedTerminalId: null,
      appVisible: true,
    });

    await run<void>(handlers[WS_METHODS.terminalFocusHeartbeat], {
      threadId: THREAD_ID,
      terminalId: "default",
      appVisible: false,
    });
    expect(fake.heartbeats.at(-1)).toMatchObject({
      focusedTerminalId: null,
      appVisible: false,
    });

    fake.exit();
    await tick(0);
    await run<void>(handlers[WS_METHODS.terminalFocusHeartbeat], {
      threadId: THREAD_ID,
      terminalId: "default",
      appVisible: true,
    });
    expect(fake.heartbeats.at(-1)).toMatchObject({ focusedTerminalId: null });
  });

  it("attaches to a host-owned terminal without creating or killing it", async () => {
    const fake = makeFakeClient({
      terminals: [{ id: "daemon-script", name: "script", cwd: "/repo" }],
    });
    const handlers = makeHandlers(fake);

    const snapshot = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      terminalId: "view",
      cwd: "/repo",
      cols: 100,
      rows: 30,
      attachToDaemonTerminalId: "daemon-script",
    });

    expect(snapshot).toMatchObject({ terminalId: "view", cwd: "/repo", history: "$ " });
    expect(fake.created).toHaveLength(0);
    expect(fake.calls).toContain("observe:daemon-script");

    await run(handlers[WS_METHODS.terminalClose], {
      threadId: THREAD_ID,
      terminalId: "view",
    });
    expect(fake.killed).toEqual([]);
  });

  it("reports the daemon's grapheme width table on the snapshot", async () => {
    const fake = makeFakeClient();
    fake.setFeatures({ "terminal-grapheme-widths": true });
    const handlers = makeHandlers(fake);

    const snapshot = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
    });

    expect(snapshot.characterWidths).toBe("graphemes");
    expect(() => encode(TerminalSessionSnapshot, snapshot)).not.toThrow();
  });

  it("keeps Unicode 11 for a daemon that does not advertise grapheme widths", async () => {
    const fake = makeFakeClient();
    fake.setFeatures({ "terminal-grapheme-widths": false });
    const handlers = makeHandlers(fake);

    const snapshot = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
    });

    expect(snapshot.characterWidths).toBe("unicode11");
  });

  it("returns the live session on a repeat open instead of creating another PTY", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });
    const second = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 120,
      rows: 40,
    });
    expect(fake.created).toHaveLength(1);
    expect(second.history).toBe("$ ");
  });

  it("starts the profile command when the daemon terminal is created", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      terminalId: "profile-1",
      cwd: "/repo",
      profile: { name: "Claude Code", command: "claude", args: ["--fast"] },
      cols: 100,
      rows: 30,
    });
    expect(fake.created[0]).toMatchObject({
      cwd: "/repo",
      options: {
        command: "claude",
        args: ["--fast"],
        size: { cols: 100, rows: 30 },
      },
    });
  });

  it("forwards live output as an ordered output event", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    const eventsPromise = collectEvents(handlers, 2);
    await tick(0);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });

    fake.output("hello\r\n");
    const events = await eventsPromise;

    expect(events.map((event) => event.type)).toEqual(["started", "output"]);
    const output = events[1];
    expect(output).toMatchObject({ type: "output", threadId: THREAD_ID, terminalId: "default" });
    if (output?.type === "output") {
      expect(output.data).toBe("hello\r\n");
      expect(output.byteLength).toBe(7);
    }
    expect(() => encode(TerminalEvent, output)).not.toThrow();
  });

  it("writes input and resizes the daemon PTY", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });

    await run(handlers[WS_METHODS.terminalWrite], {
      threadId: THREAD_ID,
      terminalId: "default",
      data: "ls\r",
    });
    await run(handlers[WS_METHODS.terminalResize], {
      threadId: THREAD_ID,
      terminalId: "default",
      cols: 132,
      rows: 43,
    });

    expect(fake.inputs).toEqual([
      ["daemon-1", { type: "input", data: "ls\r" }],
      ["daemon-1", { type: "resize", cols: 132, rows: 43, intent: "update" }],
    ]);
  });

  it("reports a PTY exit and an observation error as distinct events", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    const eventsPromise = collectEvents(handlers, 2);
    await tick(0);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });

    fake.exit();
    const events = await eventsPromise;

    expect(events.at(-1)).toMatchObject({
      type: "exited",
      threadId: THREAD_ID,
      terminalId: "default",
      exitCode: null,
      exitSignal: null,
    });
    expect(() => encode(TerminalEvent, events.at(-1))).not.toThrow();
  });

  it("closes the mapped daemon terminal", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });
    await run(handlers[WS_METHODS.terminalClose], {
      threadId: THREAD_ID,
      terminalId: "default",
      deleteHistory: true,
    });
    expect(fake.killed).toEqual(["daemon-1"]);
  });

  it("restarts by killing the old PTY and creating a fresh one", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });
    const snapshot = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalRestart], {
      threadId: THREAD_ID,
      terminalId: "default",
      cwd: "/repo",
      cols: 90,
      rows: 25,
    });
    expect(fake.killed).toEqual(["daemon-1"]);
    expect(fake.created).toHaveLength(2);
    expect(snapshot.history).toBe("$ ");
    expect(() => encode(TerminalSessionSnapshot, snapshot)).not.toThrow();
  });

  it("clears the local transcript and rejects writes to a closed terminal", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });
    await run(handlers[WS_METHODS.terminalClear], { threadId: THREAD_ID, terminalId: "default" });
    const snapshot = await run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
    });
    expect(snapshot.history).toBe("");

    await run(handlers[WS_METHODS.terminalClose], { threadId: THREAD_ID, terminalId: "default" });
    await expect(
      run(handlers[WS_METHODS.terminalWrite], {
        threadId: THREAD_ID,
        terminalId: "default",
        data: "x",
      }),
    ).rejects.toMatchObject({ code: "neolix.error.terminal.not-open" });
  });

  it("applies the renderer size to a reattached PTY", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], { threadId: THREAD_ID, cwd: "/repo" });
    await run(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 120,
      rows: 40,
    });
    expect(fake.created).toHaveLength(1);
    expect(fake.inputs).toEqual([
      ["daemon-1", { type: "resize", cols: 120, rows: 40, intent: "claim" }],
    ]);
  });

  it("claims the renderer size before subscribing to the daemon terminal", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 100,
      rows: 30,
    });
    // A resize with `intent: "update"` from a client that never claimed the size is dropped by
    // the daemon, so the size would stay at whatever the PTY was created with and zsh would wrap
    // the prompt and echoed input at the wrong column.
    expect(fake.inputs).toEqual([
      ["daemon-1", { type: "resize", cols: 100, rows: 30, intent: "claim" }],
    ]);
    expect(fake.calls).toEqual(["input:daemon-1", "observe:daemon-1"]);
  });

  it("keeps later fits effective after the open claimed the size", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await run(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
      cols: 100,
      rows: 30,
    });
    await run(handlers[WS_METHODS.terminalResize], {
      threadId: THREAD_ID,
      terminalId: "default",
      cols: 132,
      rows: 43,
    });
    expect(fake.inputs).toEqual([
      ["daemon-1", { type: "resize", cols: 100, rows: 30, intent: "claim" }],
      ["daemon-1", { type: "resize", cols: 132, rows: 43, intent: "update" }],
    ]);
  });

  it("queues a resize that arrives before the PTY exists", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    const opening = run<TerminalSessionSnapshot>(handlers[WS_METHODS.terminalOpen], {
      threadId: THREAD_ID,
      cwd: "/repo",
    });
    // The renderer's ResizeObserver can fire between open starting and the daemon terminal being
    // created; that size must be replayed rather than rejected.
    await run(handlers[WS_METHODS.terminalResize], {
      threadId: THREAD_ID,
      terminalId: "default",
      cols: 105,
      rows: 28,
    });
    await opening;
    // The queued size is the renderer's latest, so the open claims it rather than the size the
    // open call captured (none here).
    expect(fake.inputs).toEqual([
      ["daemon-1", { type: "resize", cols: 105, rows: 28, intent: "claim" }],
    ]);
  });

  it("rejects a resize when no open is in flight", async () => {
    const fake = makeFakeClient();
    const handlers = makeHandlers(fake);
    await expect(
      run(handlers[WS_METHODS.terminalResize], {
        threadId: THREAD_ID,
        terminalId: "default",
        cols: 100,
        rows: 30,
      }),
    ).rejects.toMatchObject({ code: "neolix.error.terminal.not-open" });
  });
});
