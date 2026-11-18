import { describe, expect, it } from "vitest";

import { createWebAppTransportFactory, WebAppSocket } from "./web-app-socket.js";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

describe("in-process web app socket", () => {
  it("opens asynchronously and carries frames in both directions", async () => {
    let socket: WebAppSocket | null = null;
    const transport = createWebAppTransportFactory((created) => {
      socket = created;
      created.openClient();
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });
    expect(socket).toBeInstanceOf(WebAppSocket);

    const received: Array<{ data: unknown; isBinary: boolean }> = [];
    transport.onMessage((data, isBinary) => received.push({ data, isBinary }));
    let opened = false;
    transport.onOpen(() => {
      opened = true;
    });
    expect(opened).toBe(false);
    await flush();
    expect(opened).toBe(true);

    const inbound: Array<{ data: unknown; isBinary: boolean }> = [];
    socket!.on("message", (data, isBinary) => inbound.push({ data, isBinary }));

    transport.send("first");
    expect(inbound).toEqual([]);
    await flush();
    expect(inbound).toEqual([{ data: "first", isBinary: false }]);

    socket!.send("second");
    expect(received).toEqual([]);
    await flush();
    expect(received).toEqual([{ data: "second", isBinary: false }]);
  });

  it("preserves binary frames as Uint8Array on both sides", async () => {
    let opened: WebAppSocket | null = null;
    const transport = createWebAppTransportFactory((socket) => {
      opened = socket;
      socket.openClient();
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });
    expect.soft(opened).not.toBeNull();

    const inbound: Array<{ data: unknown; isBinary: boolean }> = [];
    const received: Array<{ data: unknown; isBinary: boolean }> = [];
    transport.onMessage((data, isBinary) => received.push({ data, isBinary }));
    opened!.on("message", (data, isBinary) => inbound.push({ data, isBinary }));
    await flush();

    transport.send(new Uint8Array([7, 8]));
    opened!.send(new Uint8Array([9, 10]).buffer);
    await flush();

    expect(inbound).toEqual([{ data: new Uint8Array([7, 8]), isBinary: true }]);
    expect(received).toHaveLength(1);
    expect(received[0]?.isBinary).toBe(true);
    expect(Array.from(received[0]?.data as Uint8Array)).toEqual([9, 10]);
  });

  it("counts buffered bytes until delivery and clears them", async () => {
    let opened: WebAppSocket | null = null;
    createWebAppTransportFactory((socket) => {
      opened = socket;
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });

    opened!.send("abc");
    opened!.send(new Uint8Array([1, 2]));
    expect(opened!.bufferedAmount).toBe(5);
    await flush();
    expect(opened!.bufferedAmount).toBe(0);
  });

  it("delivers close once to both sides", async () => {
    let opened: WebAppSocket | null = null;
    const transport = createWebAppTransportFactory((socket) => {
      opened = socket;
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });

    let serverCloses = 0;
    let clientCloses = 0;
    opened!.on("close", () => serverCloses++);
    opened!.once("close", () => serverCloses++);
    transport.onClose(() => clientCloses++);

    opened!.close(1000, "done");
    expect(opened!.readyState).toBe(3);
    await flush();
    expect(serverCloses).toBe(2);
    expect(clientCloses).toBe(1);

    let error: Error | undefined;
    opened!.send("late", (failure) => {
      error = failure;
    });
    expect(error?.message).toBe("Web app socket is closed");
  });

  it("lets the client close the daemon side", async () => {
    let opened: WebAppSocket | null = null;
    const transport = createWebAppTransportFactory((socket) => {
      opened = socket;
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });

    let serverClose: unknown[] | null = null;
    let clientClosed = false;
    opened!.on("close", (...args) => {
      serverClose = args;
    });
    transport.onClose(() => {
      clientClosed = true;
    });

    transport.close(1001, "bye");
    await flush();
    expect(opened!.readyState).toBe(3);
    expect(serverClose).toEqual([1001, "bye"]);
    expect(clientClosed).toBe(true);
  });

  it("isolates a throwing bridge handler from the daemon", async () => {
    let opened: WebAppSocket | null = null;
    const transport = createWebAppTransportFactory((socket) => {
      opened = socket;
      socket.openClient();
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });
    await flush();

    const errors: unknown[] = [];
    transport.onMessage(() => {
      throw new Error("bridge bug");
    });
    transport.onError((error) => errors.push(error));

    expect(() => opened!.send("payload")).not.toThrow();
    await flush();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("bridge bug");
    expect(opened!.readyState).toBe(1);
  });

  it("isolates a throwing daemon listener from the bridge", async () => {
    let opened: WebAppSocket | null = null;
    const transport = createWebAppTransportFactory((socket) => {
      opened = socket;
      socket.openClient();
      return Promise.resolve();
    })({ url: "ws://daemon/ws" });
    await flush();

    const errors: unknown[] = [];
    opened!.on("message", () => {
      throw new Error("session bug");
    });
    opened!.on("error", (error) => errors.push(error));

    expect(() => transport.send("payload")).not.toThrow();
    await flush();
    expect((errors[0] as Error).message).toBe("session bug");
  });

  it("reports a refused attach to the bridge", async () => {
    const transport = createWebAppTransportFactory(() =>
      Promise.reject(new Error("shutting down")),
    )({ url: "ws://daemon/ws" });

    const errors: unknown[] = [];
    let closed = false;
    transport.onError((error) => errors.push(error));
    transport.onClose(() => {
      closed = true;
    });
    await flush();
    expect((errors[0] as Error).message).toBe("shutting down");
    expect(closed).toBe(true);
    expect(() => transport.send("x")).toThrow("Web app socket not open");
  });
});
