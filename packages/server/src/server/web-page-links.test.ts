import { describe, expect, it } from "vitest";
import { webPageLinks } from "./web-page.js";

const KEY = "abcdefghijklmnop";

describe("web page links with an address and TLS", () => {
  it("links to the address it is bound to, over HTTPS with a certificate", () => {
    const links = webPageLinks({
      mode: "local",
      port: 3430,
      key: KEY,
      addr: "127.0.0.1:8443",
      tlsCert: "/certs/page.pem",
      tlsKey: "/certs/page.key",
    });
    expect(links.link).toBe(`https://127.0.0.1:8443/?k=${KEY}`);
    expect(links.network).toEqual([]);
  });

  it("gives a non-loopback address as the link and as a network link", () => {
    const local = webPageLinks({
      mode: "local",
      port: 3430,
      key: KEY,
      addr: "192.168.1.5:3430",
    });
    expect(local.link).toBe(`http://192.168.1.5:3430/?k=${KEY}`);
    expect(local.network).toEqual([`http://192.168.1.5:3430/?k=${KEY}`]);
  });

  it("keeps the mode's own address when none is set", () => {
    const links = webPageLinks({ mode: "local", port: 3444, key: KEY });
    expect(links.link).toBe(`http://127.0.0.1:3444/?k=${KEY}`);
  });

  it("spells an IPv6 address in brackets", () => {
    const links = webPageLinks({
      mode: "local",
      port: 3430,
      key: KEY,
      addr: "::1:3431",
    });
    expect(links.link).toContain("[::1]:3431");
  });
});
