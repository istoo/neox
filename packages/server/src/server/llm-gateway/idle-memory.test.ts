import { describe, expect, it } from "vitest";
import { IdleMemory } from "./idle-memory.js";

describe("IdleMemory", () => {
  it("asks for a collection once nothing has been in flight for the rest", async () => {
    let released = 0;
    const idle = new IdleMemory(20, () => {
      released += 1;
    });
    idle.begin();
    idle.end();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(released).toBe(1);
    idle.dispose();
  });

  it("waits for the request in flight", async () => {
    let released = 0;
    const idle = new IdleMemory(20, () => {
      released += 1;
    });
    idle.begin();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(released).toBe(0);
    idle.end();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(released).toBe(1);
    idle.dispose();
  });

  it("does not release when disposed before the rest ends", async () => {
    let released = 0;
    const idle = new IdleMemory(20, () => {
      released += 1;
    });
    idle.begin();
    idle.end();
    idle.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(released).toBe(0);
  });
});
