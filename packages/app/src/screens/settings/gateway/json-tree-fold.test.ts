import { beforeEach, describe, expect, it } from "vitest";
import { jsonNodeOpen, rememberJsonNode, resetJsonFolds } from "./json-tree-fold";

beforeEach(() => {
  resetJsonFolds();
});

describe("JSON tree folds", () => {
  it("draws every node open until the reader folds one", () => {
    expect(jsonNodeOpen("call-1|request", "")).toBe(true);
    expect(jsonNodeOpen("call-1|request", "/messages/0/content")).toBe(true);
  });

  it("remembers a fold and an unfold", () => {
    rememberJsonNode("call-1|request", "/messages", false);
    expect(jsonNodeOpen("call-1|request", "/messages")).toBe(false);

    rememberJsonNode("call-1|request", "/messages", true);
    expect(jsonNodeOpen("call-1|request", "/messages")).toBe(true);
  });

  it("keeps one body's folds out of another's", () => {
    rememberJsonNode("call-1|request", "/messages", false);

    expect(jsonNodeOpen("call-1|response", "/messages")).toBe(true);
    expect(jsonNodeOpen("call-2|request", "/messages")).toBe(true);
  });
});
