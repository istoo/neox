import { describe, expect, it } from "vitest";
import { discoverWslRows, parseWslProbe, parseWslProvider } from "./wsl.js";

const LISTING = [
  "  NAME      STATE           VERSION",
  "* Ubuntu    Running         2",
  "  Debian    Stopped         2",
  "",
].join("\r\n");

const PROBE = [
  "home:/home/reader",
  "dir:.dsh",
  "bin:claude",
  "route:default via 172.20.0.1 dev eth0 proto kernel",
  "net:nat",
  "",
].join("\n");

describe("WSL agents", () => {
  it("lists a running distro's agents, naming the gateway as the distro reaches it", async () => {
    const probed: string[] = [];
    const rows = await discoverWslRows("http://127.0.0.1:6767", {
      platform: "win32",
      enabled: true,
      list: async () => LISTING,
      probe: async (distro) => {
        probed.push(distro);
        return PROBE;
      },
    });
    expect(probed).toEqual(["Ubuntu"]);
    expect(rows.map((row) => row.provider)).toEqual(["claude@wsl:Ubuntu", "dsh@wsl:Ubuntu"]);
    const dsh = rows.find((row) => row.provider === "dsh@wsl:Ubuntu");
    expect(dsh).toMatchObject({
      distro: "Ubuntu",
      home: "/home/reader",
      uncHome: "\\\\wsl.localhost\\Ubuntu\\home\\reader",
      baseUrl: "http://172.20.0.1:6767",
    });
  });

  it("keeps 127.0.0.1 under mirrored networking", async () => {
    const probe = parseWslProbe(
      "home:/home/reader\ndir:.dsh\nnet:mirrored\n",
      "http://127.0.0.1:6767",
    );
    expect(probe.baseUrl).toBe("http://127.0.0.1:6767");
  });

  it("looks in no distro off Windows or with the setting off", async () => {
    const deps = { list: async () => LISTING, probe: async () => PROBE };
    expect(await discoverWslRows("http://127.0.0.1:6767", { platform: "darwin", ...deps })).toEqual(
      [],
    );
    expect(
      await discoverWslRows("http://127.0.0.1:6767", {
        platform: "win32",
        enabled: false,
        ...deps,
      }),
    ).toEqual([]);
  });

  it("lists omp's named profiles as rows of their own", async () => {
    const rows = await discoverWslRows("http://127.0.0.1:6767", {
      platform: "win32",
      enabled: true,
      list: async () => LISTING,
      probe: async () =>
        ["home:/home/reader", "dir:.omp", "omp-profile:work", "omp-profile:side", ""].join("\n"),
    });
    expect(rows.map((row) => row.provider)).toEqual([
      "omp@wsl:Ubuntu",
      "omp#side@wsl:Ubuntu",
      "omp#work@wsl:Ubuntu",
    ]);
    expect(rows.find((row) => row.provider === "omp#work@wsl:Ubuntu")).toMatchObject({
      name: "omp · work (WSL: Ubuntu)",
      icon: "omp",
      variant: "work",
    });
  });

  it("reads a row's driver and distro out of its id", () => {
    expect(parseWslProvider("dsh@wsl:Ubuntu")).toEqual({ driver: "dsh", distro: "Ubuntu" });
    expect(parseWslProvider("prime-agent@wsl:Ubuntu-24.04")).toEqual({
      driver: "prime-agent",
      distro: "Ubuntu-24.04",
    });
    expect(parseWslProvider("dsh")).toBeNull();
    expect(parseWslProvider("@wsl:Ubuntu")).toBeNull();
  });
});
