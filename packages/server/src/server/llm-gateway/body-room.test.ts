import { describe, expect, it } from "vitest";
import { BODY_ROOM_FREE, BodyRoom, BodyRoomFull, defaultRoomSize } from "./body-room.js";

const MB = 1 << 20;

describe("BodyRoom", () => {
  it("lets small bodies through without counting", async () => {
    const room = new BodyRoom(() => ({ bytes: 100 * MB, why: "test" }));
    await room.take("a", BODY_ROOM_FREE - 1);
    expect(room.heldBytes()).toBe(0);
    expect(room.waiting()).toBe(0);
  });

  it("holds room for a body until its request ends", async () => {
    const room = new BodyRoom(() => ({ bytes: 100 * MB, why: "test" }));
    await room.take("a", 40 * MB);
    expect(room.heldBytes()).toBe(40 * MB);
    room.release("a");
    expect(room.heldBytes()).toBe(0);
  });

  it("makes room by waiting for the bodies before it to end", async () => {
    const room = new BodyRoom(() => ({ bytes: 100 * MB, why: "test" }));
    await room.take("a", 60 * MB);
    let letIn = false;
    const second = (async () => {
      await room.take("b", 60 * MB);
      letIn = true;
    })();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(letIn).toBe(false);
    expect(room.waiting()).toBe(1);
    room.release("a");
    await second;
    expect(letIn).toBe(true);
    expect(room.heldBytes()).toBe(60 * MB);
  });

  it("lets a body bigger than the whole room in alone", async () => {
    const room = new BodyRoom(() => ({ bytes: 64 * MB, why: "test" }));
    await room.take("big", 80 * MB);
    expect(room.heldBytes()).toBe(80 * MB);
  });

  it("refuses a body no room freed for in time", async () => {
    const room = new BodyRoom(() => ({ bytes: 100 * MB, why: "test" }), 20);
    await room.take("a", 60 * MB);
    await expect(room.take("b", 60 * MB)).rejects.toBeInstanceOf(BodyRoomFull);
    room.release("a");
  });

  it("lets a request that went while waiting leave the queue", async () => {
    const room = new BodyRoom(() => ({ bytes: 100 * MB, why: "test" }), 5_000);
    await room.take("a", 60 * MB);
    const abort = new AbortController();
    const waiting = room.take("b", 60 * MB, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toBeDefined();
    expect(room.waiting()).toBe(0);
    room.release("a");
  });
});

describe("defaultRoomSize", () => {
  it("is at least 64 MiB", () => {
    expect(defaultRoomSize().bytes).toBeGreaterThanOrEqual(64 * MB);
  });
});
