import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentInstallCatalogEntry } from "./catalog.js";
import { AgentInstallService } from "./service.js";

/**
 * Every test installs through fake executables on a temporary PATH. Nothing
 * here may reach a real package manager or the network.
 */
const posixOnly = process.platform === "win32" ? it.skip : it;

interface FakeHost {
  dir: string;
  env: NodeJS.ProcessEnv;
}

const hosts: FakeHost[] = [];

async function fakeHost(scripts: Record<string, string>): Promise<FakeHost> {
  const dir = await mkdtemp(join(tmpdir(), "neolix-install-"));
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\n${body}\n`, "utf8");
    await chmod(file, 0o755);
  }
  // The system directories are there for `sleep` in the timeout case; the only
  // commands any test names are the fakes written above.
  const env: NodeJS.ProcessEnv = { PATH: `${dir}:/usr/bin:/bin`, NEOLIX_INSTALL_TEST: "yes" };
  const host = { dir, env };
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => rm(host.dir, { recursive: true, force: true })));
});

function catalog(
  command: string,
  extra: Partial<AgentInstallCatalogEntry> = {},
): AgentInstallCatalogEntry[] {
  return [
    {
      provider: "fake",
      url: null,
      commands: { posix: [{ id: "script", via: "script", command }] },
      ...extra,
    },
  ];
}

describe("AgentInstallService.list", () => {
  const entry: AgentInstallCatalogEntry = {
    provider: "fake",
    url: "https://example.test",
    commands: {
      posix: [{ id: "script", via: "script", command: "fake-install" }],
      win32: [{ id: "powershell", via: "powershell", command: "fake-install.ps1" }],
    },
  };

  it("offers the commands of the host platform only", () => {
    const mac = new AgentInstallService({ platform: "darwin", catalog: [entry] });
    expect(mac.list()).toEqual([
      {
        provider: "fake",
        // Not a Neolix provider, so the manifest has no label to lend it.
        name: "fake",
        description: "",
        url: "https://example.test",
        commands: [{ id: "script", via: "script", command: "fake-install" }],
      },
    ]);
    const windows = new AgentInstallService({ platform: "win32", catalog: [entry] });
    expect(windows.list()[0]?.commands.map((command) => command.id)).toEqual(["powershell"]);
  });

  it("lists the vendor's uninstall lines when it has them", () => {
    const withUninstall: AgentInstallCatalogEntry = {
      ...entry,
      uninstall: {
        posix: [{ id: "script", via: "script", command: "fake-uninstall" }],
      },
    };
    const mac = new AgentInstallService({ platform: "darwin", catalog: [withUninstall] });
    expect(mac.list()[0]?.uninstallCommands).toEqual([
      { id: "script", via: "script", command: "fake-uninstall" },
    ]);
    const windows = new AgentInstallService({ platform: "win32", catalog: [withUninstall] });
    expect(windows.list()[0]?.uninstallCommands).toBeUndefined();
  });
});

describe("AgentInstallService.uninstall", () => {
  posixOnly("runs the default uninstall line and reports its output", async () => {
    const host = await fakeHost({ "fake-remove": "echo removing\nexit 0" });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("true", {
        uninstall: { posix: [{ id: "script", via: "script", command: "fake-remove" }] },
      }),
    });

    const result = await service.uninstall({ provider: "fake" });

    expect(result).toMatchObject({ provider: "fake", ok: true, exitCode: 0, error: null });
    expect(result.output).toContain("removing");
  });

  posixOnly("names the requested uninstall line", async () => {
    const host = await fakeHost({ "fake-remove": "echo picked" });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("true", {
        uninstall: {
          posix: [
            { id: "first", via: "script", command: "fake-remove" },
            { id: "second", via: "script", command: "fake-remove" },
          ],
        },
      }),
    });

    const result = await service.uninstall({ provider: "fake", commandId: "second" });

    expect(result.ok).toBe(true);
  });

  it("refuses a provider with no uninstall line", async () => {
    const service = new AgentInstallService({ platform: "darwin", catalog: catalog("true") });

    const result = await service.uninstall({ provider: "fake" });

    expect(result).toMatchObject({ ok: false, exitCode: null, output: "" });
    expect(result.error).toContain("uninstall");
  });

  it("refuses an uninstall line this platform doesn't offer", async () => {
    const service = new AgentInstallService({
      platform: "win32",
      catalog: catalog("true", {
        uninstall: { posix: [{ id: "script", via: "script", command: "fake-remove" }] },
      }),
    });

    const result = await service.uninstall({ provider: "fake" });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });
});

describe("AgentInstallService installed-record", () => {
  posixOnly("records an install it ran, and only that copy may be removed", async () => {
    const host = await fakeHost({
      "fake-install": "echo installed",
      "fake-remove": "echo removed",
    });
    const stateFile = join(host.dir, "installs.json");
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: [
        {
          provider: "fake",
          url: null,
          commands: { posix: [{ id: "script", via: "script", command: "fake-install" }] },
          uninstall: { posix: [{ id: "script", via: "script", command: "fake-remove" }] },
        },
      ],
      stateFile,
    });

    expect(service.list()[0]?.installed).toBeUndefined();
    expect(await service.run({ provider: "fake", commandId: "script" })).toMatchObject({
      ok: true,
    });
    expect(service.list()[0]?.installed).toBe(true);

    expect(await service.uninstall({ provider: "fake" })).toMatchObject({ ok: true });
    expect(service.list()[0]?.installed).toBeUndefined();
  });

  posixOnly("refuses to remove a copy Neox did not install", async () => {
    const host = await fakeHost({ "fake-remove": "echo removed" });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("true", {
        uninstall: { posix: [{ id: "script", via: "script", command: "fake-remove" }] },
      }),
      stateFile: join(host.dir, "installs.json"),
    });

    const result = await service.uninstall({ provider: "fake" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not install");
    expect(result.error).toContain("fake-remove");
  });
});

describe("AgentInstallService.run", () => {
  posixOnly("captures stdout and stderr from a successful install", async () => {
    const host = await fakeHost({
      "fake-ok": "echo installing\necho warning >&2\nexit 0",
    });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("fake-ok"),
    });

    const result = await service.run({ provider: "fake", commandId: "script" });

    expect(result).toMatchObject({ provider: "fake", ok: true, exitCode: 0, error: null });
    expect(result.output).toContain("installing");
    expect(result.output).toContain("warning");
  });

  posixOnly("reports the exit code of a failed install", async () => {
    const host = await fakeHost({
      "fake-fail": "echo nope >&2\nexit 3",
    });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("fake-fail"),
    });

    const result = await service.run({ provider: "fake", commandId: "script" });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.error).toContain("3");
    expect(result.output).toContain("nope");
  });

  posixOnly("stops an install that runs past its timeout", async () => {
    const host = await fakeHost({
      "fake-slow": "echo started\nsleep 30\necho never",
    });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("fake-slow"),
      timeoutMs: 1_500,
    });

    const startedAt = Date.now();
    const result = await service.run({ provider: "fake", commandId: "script" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not finish");
    expect(result.output).toContain("started");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  posixOnly("refuses a second install while one is running", async () => {
    const host = await fakeHost({ "fake-slow": "echo started\nsleep 1" });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("fake-slow"),
      timeoutMs: 10_000,
    });

    const first = service.run({ provider: "fake", commandId: "script" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await service.run({ provider: "fake", commandId: "script" });
    const firstResult = await first;

    expect(second.ok).toBe(false);
    expect(second.error).toContain("already running");
    expect(firstResult.ok).toBe(true);
  });

  posixOnly("passes the host environment to the command", async () => {
    const host = await fakeHost({ "fake-env": "echo $NEOLIX_INSTALL_TEST" });
    const service = new AgentInstallService({
      platform: "darwin",
      env: host.env,
      catalog: catalog("fake-env"),
    });

    const result = await service.run({ provider: "fake", commandId: "script" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("yes");
  });

  it("refuses a provider the catalog does not know", async () => {
    const service = new AgentInstallService({ platform: "darwin", catalog: catalog("true") });

    const result = await service.run({ provider: "unknown", commandId: "script" });

    expect(result).toMatchObject({ ok: false, exitCode: null, output: "" });
    expect(result.error).not.toBeNull();
  });

  it("refuses a command the catalog does not offer for this platform", async () => {
    const service = new AgentInstallService({
      platform: "win32",
      catalog: catalog("nowhere"),
    });

    const result = await service.run({ provider: "fake", commandId: "script" });

    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });
});
