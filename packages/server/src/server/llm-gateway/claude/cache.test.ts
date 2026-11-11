import { describe, expect, it } from "vitest";
import {
  CACHE_MARKS_DROPPED_HEADER,
  droppedMarksHeader,
  readClientCacheMarks,
  splitTextAtMarks,
  wantsClientCacheMarks,
} from "./cache.js";

describe("wantsClientCacheMarks", () => {
  it("reads the caller's opt-in header, whatever its case", () => {
    expect(wantsClientCacheMarks({ "x-neolix-cache-marks": "client" })).toBe(true);
    expect(wantsClientCacheMarks({ "X-Neolix-Cache-Marks": " Client " })).toBe(true);
    expect(wantsClientCacheMarks({ "x-magpie-cache-marks": "client" })).toBe(true);
    expect(wantsClientCacheMarks({ "X-Magpie-Cache-Marks": " CLIENT " })).toBe(true);
    expect(wantsClientCacheMarks({ "x-neolix-cache-marks": "server" })).toBe(false);
    expect(wantsClientCacheMarks({})).toBe(false);
  });
});

describe("readClientCacheMarks", () => {
  it("reads marks on the system, the messages and the tools", () => {
    const marks = readClientCacheMarks({
      system: [
        { type: "text", text: "alpha", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "beta" },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
      tools: [{ name: "a" }, { name: "b", cache_control: { type: "ephemeral" } }],
    });
    expect(marks.system).toEqual([{ end: 5, ttl: "1h" }]);
    expect(marks.messages.get(0)).toEqual([{ end: 6, ttl: "5m" }]);
    expect(marks.tools).toBe(1);
    expect(marks.dropped).toBe(0);
  });

  it("drops a mark on a block with no text, and counts it", () => {
    const marks = readClientCacheMarks({
      system: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(marks.system).toEqual([]);
    expect(marks.dropped).toBe(1);
    expect(droppedMarksHeader(marks)).toEqual({ [CACHE_MARKS_DROPPED_HEADER]: "1" });
  });

  it("takes an unknown TTL as five minutes", () => {
    const marks = readClientCacheMarks({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "x", cache_control: { type: "ephemeral", ttl: "2h" } }],
        },
      ],
    });
    expect(marks.messages.get(0)).toEqual([{ end: 1, ttl: "5m" }]);
  });
});

describe("splitTextAtMarks", () => {
  it("splits at each mark and leaves the tail unmarked", () => {
    expect(
      splitTextAtMarks("abcdef", [
        { end: 2, ttl: "5m" },
        { end: 4, ttl: "1h" },
      ]),
    ).toEqual([{ text: "ab", ttl: "5m" }, { text: "cd", ttl: "1h" }, { text: "ef" }]);
  });

  it("ignores marks past the text", () => {
    expect(splitTextAtMarks("ab", [{ end: 9, ttl: "1h" }])).toEqual([{ text: "ab" }]);
  });
});
