import { beforeEach, describe, expect, it } from "vitest";

import {
  JSON_CHILD_PAGE,
  JSON_LAZY_CHILD_THRESHOLD,
  jsonDefaultOpen,
  jsonEntries,
  jsonNodeOpen,
  parseJsonBody,
  primitiveText,
  rememberJsonNode,
  resetJsonFolds,
  valueCopyText,
} from "./jsonTree.logic";

beforeEach(() => {
  resetJsonFolds();
});

describe("parseJsonBody", () => {
  it("parses an object or an array body", () => {
    expect(parseJsonBody('{"model":"claude"}')).toEqual({ model: "claude" });
    expect(parseJsonBody(" [1, 2] ")).toEqual([1, 2]);
  });

  it("leaves text, truncated JSON and bare primitives to the plain body view", () => {
    expect(parseJsonBody("REQUEST BODY")).toBeNull();
    expect(parseJsonBody('{"messages": [')).toBeNull();
    expect(parseJsonBody("42")).toBeNull();
    expect(parseJsonBody('"text"')).toBeNull();
  });
});

describe("JSON tree folds", () => {
  it("draws small objects open and large ones folded until asked for", () => {
    expect(jsonDefaultOpen(0)).toBe(true);
    expect(jsonDefaultOpen(JSON_LAZY_CHILD_THRESHOLD)).toBe(true);
    expect(jsonDefaultOpen(JSON_LAZY_CHILD_THRESHOLD + 1)).toBe(false);
    expect(jsonNodeOpen("call-1|request", "", 2)).toBe(true);
    expect(jsonNodeOpen("call-1|request", "", JSON_LAZY_CHILD_THRESHOLD + 1)).toBe(false);
  });

  it("remembers a fold and an unfold by body and path", () => {
    rememberJsonNode("call-1|request", "/messages", false);
    expect(jsonNodeOpen("call-1|request", "/messages", 1)).toBe(false);

    rememberJsonNode("call-1|request", "/messages", true);
    expect(jsonNodeOpen("call-1|request", "/messages", 1)).toBe(true);

    rememberJsonNode("call-1|request", "/large", true);
    expect(jsonNodeOpen("call-1|request", "/large", JSON_LAZY_CHILD_THRESHOLD + 1)).toBe(true);
  });

  it("keeps one body's folds out of another's", () => {
    rememberJsonNode("call-1|request", "/messages", false);

    expect(jsonNodeOpen("call-1|response", "/messages", 1)).toBe(true);
    expect(jsonNodeOpen("call-2|request", "/messages", 1)).toBe(true);
  });
});

describe("JSON tree rows", () => {
  it("names object entries and array positions in order", () => {
    expect(jsonEntries({ b: 1, a: 2 })).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    expect(jsonEntries(["x", "y"])).toEqual([
      ["0", "x"],
      ["1", "y"],
    ]);
  });

  it("copies strings as written and everything else as JSON", () => {
    expect(valueCopyText("hello")).toBe("hello");
    expect(valueCopyText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(valueCopyText([1, 2])).toBe("[\n  1,\n  2\n]");
  });

  it("draws primitives as JSON literals", () => {
    expect(primitiveText("x")).toBe('"x"');
    expect(primitiveText(1)).toBe("1");
    expect(primitiveText(true)).toBe("true");
    expect(primitiveText(null)).toBe("null");
    expect(primitiveText(undefined)).toBe("undefined");
  });

  it("draws a large container's children a page at a time", () => {
    expect(JSON_CHILD_PAGE).toBeGreaterThanOrEqual(50);
  });
});
