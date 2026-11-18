import { describe, expect, it } from "vitest";

import {
  canonicalHeaderName,
  cleanHeaderList,
  headerNameProblem,
  headerPassable,
  validHeaderName,
} from "./gatewayHeaderPassthrough.logic";

describe("gateway header passthrough names", () => {
  it("writes a name as HTTP spells it", () => {
    expect(canonicalHeaderName(" x-trace ")).toBe("X-Trace");
    expect(canonicalHeaderName("X-ONEAPI-REQUEST-ID")).toBe("X-Oneapi-Request-Id");
    expect(canonicalHeaderName("")).toBe("");
  });

  it("accepts an HTTP token and rejects anything else", () => {
    expect(validHeaderName("X-Trace")).toBe(true);
    expect(validHeaderName("Anthropic-Beta")).toBe(true);
    expect(validHeaderName("X-Tenant_Id.1")).toBe(true);
    expect(validHeaderName("")).toBe(false);
    expect(validHeaderName("Bad Header")).toBe(false);
    expect(validHeaderName("Bad:Header")).toBe(false);
    expect(validHeaderName("Bad,Header")).toBe(false);
    expect(validHeaderName("X-Ünicode")).toBe(false);
    expect(validHeaderName("X-Trace\n")).toBe(false);
  });

  it("keeps the names the daemon never passes on out of a reply list", () => {
    expect(headerNameProblem("", "reply")).toBeNull();
    expect(headerNameProblem("X-Trace", "reply")).toBeNull();
    expect(headerNameProblem("X-Oneapi-Request-Id", "reply")).toBeNull();
    expect(headerNameProblem("Cache-Control", "reply")).toBe("reserved");
    expect(headerNameProblem("Authorization", "reply")).toBe("reserved");
    expect(headerNameProblem("Content-Length", "reply")).toBe("reserved");
    expect(headerNameProblem("X-Neolix-Call", "reply")).toBe("reserved");
    expect(headerNameProblem("bad header", "reply")).toBe("invalid");
  });

  it("keeps credentials and connection headers out of a request list", () => {
    expect(headerNameProblem("Anthropic-Beta", "request")).toBeNull();
    expect(headerNameProblem("User-Agent", "request")).toBeNull();
    expect(headerNameProblem("Cache-Control", "request")).toBeNull();
    expect(headerNameProblem("X-Api-Key", "request")).toBe("reserved");
    expect(headerNameProblem("Cookie", "request")).toBe("reserved");
    expect(headerNameProblem("Accept", "request")).toBe("reserved");
    expect(headerNameProblem("x-magpie-id", "request")).toBe("reserved");
    expect(headerNameProblem("bad/name", "request")).toBe("invalid");
  });

  it("tells passable names from the ones each list refuses", () => {
    expect(headerPassable("x-trace", "reply")).toBe(true);
    expect(headerPassable("cache-control", "reply")).toBe(false);
    expect(headerPassable("cache-control", "request")).toBe(true);
    expect(headerPassable("authorization", "request")).toBe(false);
  });

  it("saves canonical names once and drops what cannot be passed", () => {
    expect(
      cleanHeaderList(
        ["x-trace", " X-Trace ", "Cache-Control", "bad header", "", "x-oneapi-request-id"],
        "reply",
      ),
    ).toEqual(["X-Trace", "X-Oneapi-Request-Id"]);
    expect(cleanHeaderList(["x-tenant", "x-tenant", "Accept", "authorization"], "request")).toEqual(
      ["X-Tenant"],
    );
  });
});
