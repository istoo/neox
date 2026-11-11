import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  exportBackup,
  listBackups,
  loadAutoConfig,
  restoreBackup,
  runAutoBackup,
  saveAutoConfig,
} from "./backup.js";

const homes: string[] = [];

const GATEWAY = {
  version: 1,
  providers: [
    {
      id: "lab",
      label: "Lab",
      protocol: "anthropic",
      baseUrl: "https://api.example/v1",
      apiKey: "{{SECRET_q7m2xw9p}}",
      accounts: [],
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
      models: [],
    },
  ],
  groups: [],
};

async function home(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `neolix-backup-${name}-`));
  homes.push(dir);
  await writeFile(path.join(dir, "gateway.json"), `${JSON.stringify(GATEWAY, null, 2)}\n`);
  await mkdir(path.join(dir, "library", "instructions"), { recursive: true });
  await writeFile(
    path.join(dir, "library", "library.json"),
    `${JSON.stringify(
      {
        version: 1,
        instructions: { agents: [], sets: [], active: "" },
        mcp: [
          {
            name: "srv",
            transport: "stdio",
            command: "x",
            agents: ["claude"],
            env: { TOKEN: "{{SECRET_2mb7q1ra}}" },
          },
        ],
        skills: [],
        hooks: [],
        subagents: [],
        applied: {},
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(dir, "library", "instructions", "a.md"), "# A\n");
  return dir;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// Sealing runs scrypt; the default 5s is tight while other suites build.
describe("backup", { timeout: 20_000 }, () => {
  it("exports a sealed backup and restores it over a changed setup", async () => {
    const dir = await home("restore");
    const written = await exportBackup({
      neolixHome: dir,
      passphrase: "correct horse",
      keys: false,
    });
    const sealed = await readFile(written.file);
    expect(sealed.includes(Buffer.from("Lab"))).toBe(false);

    await writeFile(
      path.join(dir, "gateway.json"),
      `${JSON.stringify({ version: 1, providers: [] }, null, 2)}\n`,
    );
    await rm(path.join(dir, "library", "instructions", "a.md"));

    const result = await restoreBackup({
      neolixHome: dir,
      file: written.file,
      passphrase: "correct horse",
      keys: false,
    });
    expect(result.parts).toEqual(expect.arrayContaining(["sources", "library"]));
    const gateway = JSON.parse(await readFile(path.join(dir, "gateway.json"), "utf8")) as {
      providers: { id: string }[];
    };
    expect(gateway.providers[0]?.id).toBe("lab");
    await expect(readFile(path.join(dir, "library", "instructions", "a.md"), "utf8")).resolves.toBe(
      "# A\n",
    );
    // What was here before the restore is kept.
    expect(result.saved).toBeDefined();
  });

  it("refuses a wrong passphrase", async () => {
    const dir = await home("wrong-pass");
    const written = await exportBackup({ neolixHome: dir, passphrase: "right", keys: false });
    await expect(
      restoreBackup({ neolixHome: dir, file: written.file, passphrase: "wrong", keys: false }),
    ).rejects.toThrow(/can't be opened/);
  });

  it("leaves credentials out unless asked", async () => {
    const dir = await home("keys");
    const keyless = await exportBackup({ neolixHome: dir, passphrase: "pass", keys: false });
    const keyed = await exportBackup({ neolixHome: dir, passphrase: "pass", keys: true });
    const keylessBytes = await readFile(keyless.file);
    const keyedBytes = await readFile(keyed.file);
    // Neither sealed file is readable, but the keyed one is larger: its
    // provider key and library env travel inside.
    expect(keyedBytes.byteLength).toBeGreaterThan(keylessBytes.byteLength);
  });

  it("writes automatic backups and keeps the configured number", async () => {
    const dir = await home("auto");
    expect(await listBackups(dir)).toEqual([]);
    await saveAutoConfig(dir, { enabled: true, everyHours: 1, keep: 2, keys: false });
    const first = await runAutoBackup(dir, "pass");
    expect(first?.auto).toBe(true);
    const again = await runAutoBackup(dir, "pass");
    expect(again).toBeNull(); // not due yet
    const config = await loadAutoConfig(dir);
    expect(config).toEqual({
      enabled: true,
      everyHours: 1,
      keep: 2,
      keys: false,
      signIns: false,
      dir: "",
    });
    const auto = (await listBackups(dir)).filter((entry) => entry.auto);
    expect(auto).toHaveLength(1);
    await expect(readFile(auto[0]!.file)).resolves.toBeInstanceOf(Buffer);
  });

  it("carries the sign-ins only when asked", async () => {
    const dir = await home("signins");
    await mkdir(path.join(dir, "gateway"), { recursive: true });
    await writeFile(
      path.join(dir, "gateway", "codex-accounts.json"),
      `${JSON.stringify([{ id: "codex:one", accountId: "one", expiresAt: 1, addedAt: 1 }])}\n`,
    );
    const plain = await exportBackup({ neolixHome: dir, passphrase: "pass", keys: false });
    const carried = await exportBackup({
      neolixHome: dir,
      passphrase: "pass",
      keys: false,
      signIns: true,
    });
    expect((await readFile(carried.file)).byteLength).toBeGreaterThan(
      (await readFile(plain.file)).byteLength,
    );

    const target = await home("signins-target");
    await restoreBackup({
      neolixHome: target,
      file: carried.file,
      passphrase: "pass",
      keys: false,
      signIns: true,
    });
    const accounts = JSON.parse(
      await readFile(path.join(target, "gateway", "codex-accounts.json"), "utf8"),
    ) as { id: string }[];
    expect(accounts[0]?.id).toBe("codex:one");
  }, 20_000);

  it("keeps automatic backups in the folder set", async () => {
    const dir = await home("autodir");
    const folder = path.join(dir, "elsewhere");
    await saveAutoConfig(dir, {
      enabled: true,
      everyHours: 1,
      keep: 2,
      keys: false,
      signIns: false,
      dir: folder,
    });
    const entry = await runAutoBackup(dir, "pass");
    expect(entry?.file.startsWith(`${folder}${path.sep}`)).toBe(true);
    expect(await listBackups(dir)).toEqual([]);
    expect((await listBackups(dir, folder)).some((backup) => backup.auto)).toBe(true);
  });
});
