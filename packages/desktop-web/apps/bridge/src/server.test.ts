import { HttpServerRequest } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { isPageOrigin } from "./server.ts";

function requestFor(host: string) {
  return HttpServerRequest.fromWeb(new Request(`http://${host}/rpc`, { headers: { host } }));
}

describe("bridge socket origin", () => {
  it("accepts loopback origins with or without a Host filter upstream", () => {
    const request = requestFor("127.0.0.1:7899");
    expect(isPageOrigin(request, "http://127.0.0.1:7899", false)).toBe(true);
    expect(isPageOrigin(request, "http://localhost:5733", true)).toBe(true);
  });

  it("accepts the page's own non-loopback origin only behind a Host filter", () => {
    const request = requestFor("neox.lan:3430");
    expect(isPageOrigin(request, "http://neox.lan:3430", true)).toBe(true);
    // Standalone: nothing filtered Host, so a rebound name must not pass as same-origin.
    expect(isPageOrigin(request, "http://neox.lan:3430", false)).toBe(false);
  });

  it("rejects a foreign origin even behind a Host filter", () => {
    const request = requestFor("neox.lan:3430");
    expect(isPageOrigin(request, "https://evil.example", true)).toBe(false);
  });
});
