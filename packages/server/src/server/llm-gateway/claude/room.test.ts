import { describe, expect, it } from "vitest";
import { ClaudeRoom, ClaudeRoomFullError, runsForMemory, runsMostFor } from "./room.js";

describe("runsForMemory", () => {
  it("sizes the bound from the memory, 128 MiB a process and 256 MiB kept", () => {
    expect(runsForMemory(512 * (1 << 20))).toBe(2);
    expect(runsForMemory(1024 * (1 << 20))).toBe(6);
    expect(runsForMemory(1 << 20)).toBe(1);
  });

  it("bounds by memory only where it is known", () => {
    expect(runsMostFor("linux", 1024 * (1 << 20))).toBe(6);
    expect(runsMostFor("darwin", 1024 * (1 << 20))).toBe(0);
    expect(runsMostFor("linux", 0)).toBe(0);
  });
});

describe("ClaudeRoom", () => {
  it("hands out at most its places and frees them on release", async () => {
    const room = new ClaudeRoom({ most: 1 });
    const release = await room.take();
    expect(room.live).toBe(1);
    const second = room.take();
    expect(room.waiting).toBe(1);
    release(false);
    const releaseSecond = await second;
    expect(room.live).toBe(1);
    releaseSecond(false);
    expect(room.live).toBe(0);
  });

  it("lets a run go for room when it is full", async () => {
    let releaseFirst: ((left: boolean) => void) | null = null;
    const room = new ClaudeRoom({
      most: 1,
      onPressure: () => {
        room.leave();
        releaseFirst?.(true);
        return true;
      },
    });
    releaseFirst = await room.take();
    const second = await room.take();
    expect(room.live).toBe(1);
    second(false);
    expect(room.live).toBe(0);
  });

  it("answers 503 when no room comes in time", async () => {
    const room = new ClaudeRoom({ most: 1, waitMs: 10 });
    const release = await room.take();
    await expect(room.take()).rejects.toBeInstanceOf(ClaudeRoomFullError);
    await expect(room.take()).rejects.toMatchObject({ status: 503 });
    release(false);
  });

  it("counts a run the bridge asked to end as leaving", async () => {
    const room = new ClaudeRoom({ most: 1 });
    const release = await room.take();
    room.leave();
    expect(room.leaving).toBe(1);
    release(true);
    expect(room.live).toBe(0);
    expect(room.leaving).toBe(0);
  });
});
