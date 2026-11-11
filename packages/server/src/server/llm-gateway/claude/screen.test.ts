import { describe, expect, it } from "vitest";
import { ScreenGrid } from "./screen.js";

describe("ScreenGrid", () => {
  it("draws text at the cursor", () => {
    const grid = new ScreenGrid(20, 3);
    grid.write("hello");
    expect(grid.text().split("\n")[0]).toBe("hello");
  });

  it("moves the cursor before drawing over a cell", () => {
    const grid = new ScreenGrid(20, 3);
    grid.write("abcde\r\u001b[2CX");
    expect(grid.text().split("\n")[0]).toBe("abXde");
  });

  it("erases what a line no longer holds", () => {
    const grid = new ScreenGrid(10, 2);
    grid.write("abcdef\r\u001b[K");
    expect(grid.text().split("\n")[0]).toBe("");
  });

  it("scrolls when the screen is full", () => {
    const grid = new ScreenGrid(8, 2);
    grid.write("one\r\ntwo\r\nthree");
    expect(grid.text()).toBe("two\nthree");
  });

  it("keeps an escape a read cut in the middle for the next write", () => {
    const grid = new ScreenGrid(10, 2);
    grid.write("\u001b[");
    grid.write("2Jhi");
    expect(grid.text().split("\n")[0]).toBe("hi");
  });

  it("ignores modes and keyboard protocols", () => {
    const grid = new ScreenGrid(10, 2);
    grid.write("\u001b[?2004habc");
    expect(grid.text().split("\n")[0]).toBe("abc");
  });

  it("puts a wide character in two cells", () => {
    const grid = new ScreenGrid(6, 1);
    grid.write("中a");
    expect(grid.text()).toBe("中a");
  });
});
