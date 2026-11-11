import { describe, expect, it } from "vitest";

import { gatewayOrigin, parseListen } from "./gatewayHelpers";

describe("parseListen", () => {
  it("treats a loopback listener as reachable from this computer only", () => {
    const listen = parseListen("127.0.0.1:6768");
    expect(gatewayOrigin(listen)).toBe("http://127.0.0.1:6768");
    expect(listen.lanReachable).toBe(false);
  });

  it("treats every-interface and network listeners as reachable from other computers", () => {
    expect(parseListen("0.0.0.0:6767").lanReachable).toBe(true);
    const network = parseListen("192.168.1.20:6767");
    expect(network.lanReachable).toBe(true);
    expect(gatewayOrigin(network)).toBe("http://192.168.1.20:6767");
  });

  it("never calls a socket or an unreadable listener reachable", () => {
    expect(parseListen("/tmp/neolix.sock")).toMatchObject({ socket: true, lanReachable: false });
    expect(parseListen(null).lanReachable).toBe(false);
  });
});
