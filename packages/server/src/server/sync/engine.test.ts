import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openData } from "./archive.js";
import { SyncEngine } from "./engine.js";
import { saveSyncConfig } from "./config.js";
import { usageDevice, usageReport } from "./usage.js";

interface FakeFile {
  body: Buffer;
  etag: string;
}

/** A WebDAV folder in memory, enough for the sync engine (myna `dav_test.go`). */
class FakeDav {
  private readonly files = new Map<string, FakeFile>();
  private readonly server: Server;
  private nextEtag = 0;
  private status = 0;
  base = "";

  constructor() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (typeof address === "string" || address === null) {
      throw new Error("no address");
    }
    this.base = `http://127.0.0.1:${address.port}/dav/neolix`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Forces the next answer's status, for the rate-limit and damage tests. */
  failOnce(status: number): void {
    this.status = status;
  }

  corrupt(name: string): void {
    const file = this.files.get(name);
    if (file) {
      file.body = Buffer.from("not a sync file");
      file.etag = this.etag();
    }
  }

  names(): string[] {
    return [...this.files.keys()];
  }

  body(name: string): Buffer | undefined {
    return this.files.get(name)?.body;
  }

  private etag(): string {
    this.nextEtag += 1;
    return `"${this.nextEtag}"`;
  }

  private nameOf(url: string): string {
    const pathname = new URL(url, "http://x").pathname;
    return decodeURIComponent(pathname.replace("/dav/neolix/", ""));
  }

  /** The folder a PROPFIND asks about, "" for the sync folder. */
  private prefixOf(url: string): string {
    const pathname = new URL(url, "http://x").pathname.replace(/\/+$/, "");
    if (pathname === "/dav/neolix") {
      return "";
    }
    return decodeURIComponent(pathname.replace("/dav/neolix/", ""));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.status !== 0) {
      response.writeHead(this.status).end();
      this.status = 0;
      return;
    }
    const method = request.method ?? "GET";
    if (method === "MKCOL") {
      response.writeHead(201).end();
      return;
    }
    if (method === "PROPFIND") {
      const prefix = this.prefixOf(request.url ?? "/");
      const body = [...this.files.entries()]
        .filter(([name]) =>
          prefix.length > 0 ? name.startsWith(`${prefix}/`) : !name.includes("/"),
        )
        .map(([name, file]) => {
          const leaf = prefix.length > 0 ? name.slice(prefix.length + 1) : name;
          return (
            `<d:response><d:href>/dav/neolix/${encodeURIComponent(prefix ? `${prefix}/${leaf}` : leaf)}</d:href>` +
            `<d:propstat><d:prop><d:getetag>${file.etag}</d:getetag>` +
            `<d:getlastmodified>${new Date().toUTCString()}</d:getlastmodified>` +
            `<d:resourcetype/></d:prop></d:propstat></d:response>`
          );
        })
        .join("");
      response
        .writeHead(207, { "content-type": "application/xml" })
        .end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${body}</d:multistatus>`);
      return;
    }
    const name = this.nameOf(request.url ?? "/");
    if (method === "GET") {
      const file = this.files.get(name);
      if (!file) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { etag: file.etag }).end(file.body);
      return;
    }
    if (method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const existing = this.files.get(name);
      const ifMatch = request.headers["if-match"];
      const ifNoneMatch = request.headers["if-none-match"];
      if (typeof ifMatch === "string" && existing?.etag !== ifMatch) {
        response.writeHead(412).end();
        return;
      }
      if (ifNoneMatch === "*" && existing) {
        response.writeHead(412).end();
        return;
      }
      const etag = this.etag();
      this.files.set(name, { body: Buffer.concat(chunks), etag });
      response.writeHead(existing ? 204 : 201, { etag }).end();
      return;
    }
    if (method === "DELETE") {
      this.files.delete(name);
      response.writeHead(204).end();
      return;
    }
    response.writeHead(405).end();
  }
}

const homes: string[] = [];
const servers: FakeDav[] = [];

async function home(name: string, files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `neolix-sync-${name}-`));
  homes.push(dir);
  for (const [relPath, value] of Object.entries(files)) {
    const target = path.join(dir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  }
  return dir;
}

async function configure(homeDir: string, server: FakeDav, extra: Record<string, unknown> = {}) {
  await saveSyncConfig(homeDir, {
    enabled: true,
    url: server.base,
    passphrase: "correct horse battery staple",
    keys: false,
    parts: { sources: true, settings: true, profiles: true, models: true, library: true },
    intervalMinutes: 3,
    device: path.basename(homeDir),
    ...extra,
  });
}

async function dav(): Promise<FakeDav> {
  const server = new FakeDav();
  await server.start();
  servers.push(server);
  return server;
}

async function read(homeDir: string, relPath: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(homeDir, relPath), "utf8"));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  await Promise.all(homes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const GATEWAY = {
  version: 1,
  enabled: true,
  providers: [
    {
      id: "lab",
      label: "Lab",
      protocol: "anthropic",
      baseUrl: "https://api.example/v1",
      apiKey: "sk-secret",
      accounts: [],
      queueWaitMs: 0,
      sink: false,
      priceRate: 1,
      models: [{ id: "m1", label: "M1" }],
    },
  ],
  groups: [],
};

describe("SyncEngine", { timeout: 60_000 }, () => {
  it("pushes this computer's setup, and another computer brings it in", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    const b = await home("b", { "gateway.json": { version: 1 } });
    await configure(a, remote);
    await configure(b, remote);

    const first = await new SyncEngine(a).run();
    expect(first.error).toBeUndefined();
    expect(remote.names().some((name) => name.startsWith("sources."))).toBe(true);

    const second = await new SyncEngine(b).run();
    expect(second.error).toBeUndefined();
    const gateway = (await read(b, "gateway.json")) as {
      providers: { id: string; label: string }[];
    };
    expect(gateway.providers[0]).toMatchObject({ id: "lab", label: "Lab" });
    expect(second.notice?.here).toContain("sources");
  });

  it("keeps API keys out of a keyless part", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    await configure(a, remote);
    await new SyncEngine(a).run();
    const name = remote.names().find((entry) => entry.startsWith("sources."));
    expect(name).toBeDefined();
    const sealed = remote.body(name!);
    expect(sealed).toBeDefined();
    // The sealed bytes must not carry the key in clear text.
    expect(sealed!.includes(Buffer.from("sk-secret"))).toBe(false);
  });

  it("pushes a local change and pulls a remote one", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    const b = await home("b", { "gateway.json": GATEWAY });
    await configure(a, remote);
    await configure(b, remote);
    await new SyncEngine(a).run();
    await new SyncEngine(b).run();

    const changed = {
      ...GATEWAY,
      providers: [{ ...GATEWAY.providers[0], label: "Renamed" }],
    };
    await writeFile(path.join(b, "gateway.json"), `${JSON.stringify(changed, null, 2)}\n`);
    const pushed = await new SyncEngine(b).run();
    expect(pushed.error).toBeUndefined();
    expect(pushed.notice).toBeUndefined();

    const pulled = await new SyncEngine(a).run();
    expect(pulled.error).toBeUndefined();
    expect(pulled.notice?.here).toContain("sources");
    const gateway = (await read(a, "gateway.json")) as { providers: { label: string }[] };
    expect(gateway.providers[0]?.label).toBe("Renamed");
  });

  it("keeps the newer side on a conflict and saves the replaced copy", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    const b = await home("b", { "gateway.json": GATEWAY });
    await configure(a, remote);
    await configure(b, remote);
    await new SyncEngine(a).run();
    await new SyncEngine(b).run();

    // Both change the same part; B's change is older than A's push.
    const aChanged = { ...GATEWAY, providers: [{ ...GATEWAY.providers[0], label: "From A" }] };
    const bChanged = { ...GATEWAY, providers: [{ ...GATEWAY.providers[0], label: "From B" }] };
    await writeFile(path.join(b, "gateway.json"), `${JSON.stringify(bChanged, null, 2)}\n`);
    await utimes(
      path.join(b, "gateway.json"),
      new Date(Date.now() - 60_000),
      new Date(Date.now() - 60_000),
    );
    await writeFile(path.join(a, "gateway.json"), `${JSON.stringify(aChanged, null, 2)}\n`);
    await new SyncEngine(a).run();
    const bResult = await new SyncEngine(b).run();

    expect(bResult.error).toBeUndefined();
    expect(bResult.notice?.here).toContain("sources");
    const gateway = (await read(b, "gateway.json")) as { providers: { label: string }[] };
    expect(gateway.providers[0]?.label).toBe("From A");
    const saved = await readdir(path.join(b, "sync"));
    expect(saved.some((name) => name.includes("this-computer-sources"))).toBe(true);
  });

  it("mirrors a deleted library file to the other computer", async () => {
    const remote = await dav();
    const library = {
      version: 1,
      instructions: { agents: [], sets: [], active: "" },
      mcp: [],
      skills: [],
      hooks: [],
      subagents: [],
      applied: {},
    };
    const a = await home("a", {
      "library/library.json": library,
      "library/instructions/one.md": "# One\n",
    });
    const b = await home("b", { "library/library.json": library });
    await configure(a, remote);
    await configure(b, remote);
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    await expect(readFile(path.join(b, "library", "instructions", "one.md"), "utf8")).resolves.toBe(
      "# One\n",
    );

    await rm(path.join(a, "library", "instructions", "one.md"));
    // The engine reads the change time from the directory's files; force it.
    await utimes(path.join(a, "library", "library.json"), new Date(), new Date());
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    const pulled = await new SyncEngine(b).run();
    expect(pulled.error).toBeUndefined();
    await expect(
      readFile(path.join(b, "library", "instructions", "one.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a joining computer's unseen gateway keys", async () => {
    const remote = await dav();
    const a = await home("a", {
      "gateway.json": {
        ...GATEWAY,
        keys: [{ key: "gw-shared", label: "shared", models: [] }],
      },
    });
    const b = await home("b", {
      "gateway.json": {
        ...GATEWAY,
        keys: [
          { key: "gw-shared", label: "shared", models: [] },
          { key: "gw-b-only", label: "b only", models: [] },
        ],
      },
    });
    await configure(a, remote, { keys: true });
    await configure(b, remote, { keys: true });
    expect((await new SyncEngine(a).run()).error).toBeUndefined();

    const joined = await new SyncEngine(b).run();
    expect(joined.error).toBeUndefined();
    const bGateway = (await read(b, "gateway.json")) as { keys: { key: string }[] };
    expect(bGateway.keys.map((entry) => entry.key)).toEqual(["gw-shared", "gw-b-only"]);

    // The merged store goes up on the next sync, and A keeps both.
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    const aGateway = (await read(a, "gateway.json")) as { keys: { key: string }[] };
    expect(aGateway.keys.map((entry) => entry.key).sort()).toEqual(["gw-b-only", "gw-shared"]);
  });

  it("rebuilds a damaged remote file from the cached copy", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    const b = await home("b", { "gateway.json": GATEWAY });
    await configure(a, remote);
    await configure(b, remote);
    await new SyncEngine(a).run();
    await new SyncEngine(b).run();

    const name = remote.names().find((entry) => entry.startsWith("sources."));
    remote.corrupt(name!);
    const changed = { ...GATEWAY, providers: [{ ...GATEWAY.providers[0], label: "Repaired" }] };
    await writeFile(path.join(b, "gateway.json"), `${JSON.stringify(changed, null, 2)}\n`);
    const result = await new SyncEngine(b).run();
    expect(result.error).toBeUndefined();
    expect(await readdir(path.join(b, "sync"))).toEqual(
      expect.arrayContaining([expect.stringContaining("server-damaged")]),
    );
  });

  it("restores the server's version and can undo it", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    const b = await home("b", { "gateway.json": GATEWAY });
    await configure(a, remote);
    await configure(b, remote);
    await new SyncEngine(a).run();
    await new SyncEngine(b).run();

    const v2 = { ...GATEWAY, providers: [{ ...GATEWAY.providers[0], label: "Second" }] };
    await writeFile(path.join(a, "gateway.json"), `${JSON.stringify(v2, null, 2)}\n`);
    await new SyncEngine(a).run();

    const restored = await new SyncEngine(b).restoreRemote();
    expect(restored.error).toBeUndefined();
    const afterRestore = (await read(b, "gateway.json")) as { providers: { label: string }[] };
    expect(afterRestore.providers[0]?.label).toBe("Second");

    const undone = await new SyncEngine(b).undo();
    expect(undone.error).toBeUndefined();
    const afterUndo = (await read(b, "gateway.json")) as { providers: { label: string }[] };
    expect(afterUndo.providers[0]?.label).toBe("Lab");
  });

  it("keeps an agent field put back here as this computer's own", async () => {
    const remote = await dav();
    const agents = (arg: string) => ({
      agents: { providers: { claude: { command: { mode: "append", args: [arg] } } } },
    });
    const a = await home("a", { "config.json": agents("one") });
    const b = await home("b", { "config.json": agents("two") });
    await configure(a, remote);
    await configure(b, remote);
    expect((await new SyncEngine(a).run()).error).toBeUndefined();

    // B's env is written over by the sync; putting it back makes it B's own.
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    await writeFile(path.join(b, "config.json"), `${JSON.stringify(agents("two"), null, 2)}\n`);
    const kept = await new SyncEngine(b).run();
    expect(kept.error).toBeUndefined();
    expect(kept.own).toEqual([{ agent: "claude", field: "command" }]);

    // A later change on A reaches B's other fields, not this one.
    await writeFile(path.join(a, "config.json"), `${JSON.stringify(agents("three"), null, 2)}\n`);
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    const bConfig = (await read(b, "config.json")) as {
      agents: { providers: { claude: { command: { args?: string[] } } } };
    };
    expect(bConfig.agents.providers.claude.command.args?.[0]).toBe("two");

    // Follow the others gives the field back: the server's value comes in.
    const followed = await new SyncEngine(b).follow();
    expect(followed.error).toBeUndefined();
    expect(followed.own).toBeUndefined();
    const afterFollow = (await read(b, "config.json")) as {
      agents: { providers: { claude: { command: { args?: string[] } } } };
    };
    expect(afterFollow.agents.providers.claude.command.args?.[0]).toBe("three");
  });

  it("mirrors a sign-in removed on one computer to the other", async () => {
    const remote = await dav();
    const accounts = {
      "gateway/codex-accounts.json": [
        { id: "codex:one", accountId: "one", expiresAt: 10, addedAt: 1 },
      ],
    };
    const a = await home("a", { ...accounts, "gateway.json": GATEWAY });
    const b = await home("b", { ...accounts, "gateway.json": GATEWAY });
    await configure(a, remote, { keys: true });
    await configure(b, remote, { keys: true });
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    expect((await new SyncEngine(b).run()).error).toBeUndefined();

    // B removes the account; the server follows, and then A does too.
    await rm(path.join(b, "gateway", "codex-accounts.json"));
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    await expect(readFile(path.join(a, "gateway", "codex-accounts.json"), "utf8")).resolves.toBe(
      "[]\n",
    );

    // B's removal is not undone by A's copy coming back.
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    await expect(
      readFile(path.join(b, "gateway", "codex-accounts.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("brings in a sign-in added on another computer, keeping the ones here", async () => {
    const remote = await dav();
    const one = { id: "codex:one", accountId: "one", expiresAt: 10, addedAt: 1 };
    const two = { id: "codex:two", accountId: "two", expiresAt: 10, addedAt: 2 };
    const a = await home("a", {
      "gateway/codex-accounts.json": [one, two],
      "gateway.json": GATEWAY,
    });
    const b = await home("b", {
      "gateway/codex-accounts.json": [one],
      "gateway.json": GATEWAY,
    });
    await configure(a, remote, { keys: true });
    await configure(b, remote, { keys: true });
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    const bAccounts = (await read(b, "gateway/codex-accounts.json")) as { id: string }[];
    expect(bAccounts.map((account) => account.id).sort()).toEqual(["codex:one", "codex:two"]);
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    const aAccounts = (await read(a, "gateway/codex-accounts.json")) as { id: string }[];
    expect(aAccounts.map((account) => account.id).sort()).toEqual(["codex:one", "codex:two"]);
  });

  it("shares each computer's usage days with the other", async () => {
    const remote = await dav();
    const record = (costUsd: number) =>
      `${JSON.stringify({
        time: new Date().toISOString(),
        requested: "m1",
        provider: "lab",
        account: null,
        model: "m1",
        protocol: "anthropic",
        status: 200,
        ok: true,
        inputTokens: 10,
        outputTokens: 5,
        attempts: 1,
        durationMs: 10,
        costUsd,
        priced: true,
        key: null,
      })}\n`;
    const a = await home("a", {
      "gateway.json": GATEWAY,
      "gateway-usage.jsonl": record(0.1),
    });
    const b = await home("b", {
      "gateway.json": GATEWAY,
      "gateway-usage.jsonl": record(0.2),
    });
    await configure(a, remote);
    await configure(b, remote);
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    expect((await new SyncEngine(b).run()).error).toBeUndefined();
    expect((await new SyncEngine(a).run({ force: true })).error).toBeUndefined();

    const names = remote
      .names()
      .filter((name) => name.startsWith("usage/") && name.endsWith(".neolix-usage"));
    expect(names).toHaveLength(2);
    const costs: number[] = [];
    for (const name of names) {
      const body = remote.body(name);
      expect(body?.toString("utf8")).not.toContain("lab");
      const shared = JSON.parse(
        openData(body!, "correct horse battery staple").toString("utf8"),
      ) as { computer: string; calls: { cost: number }[] };
      costs.push(shared.calls[0]!.cost);
    }
    expect(costs.sort()).toEqual([0.1, 0.2]);

    const device = await usageDevice(a, path.basename(a));
    const report = await usageReport(a, device);
    expect(report.devices).toHaveLength(2);
    expect(report.computers?.map((computer) => computer.id).sort()).toEqual(
      ["this", (await usageDevice(b, path.basename(b))).id].sort(),
    );
    expect(report.calls).toBe(2);
  });

  it("shares usage every 15 minutes unless a sync is asked for", async () => {
    const remote = await dav();
    const call = (costUsd: number) => ({
      time: new Date().toISOString(),
      requested: "m1",
      provider: "lab",
      account: null,
      model: "m1",
      protocol: "anthropic",
      status: 200,
      ok: true,
      inputTokens: 10,
      outputTokens: 5,
      attempts: 1,
      durationMs: 10,
      costUsd,
      priced: true,
      key: null,
    });
    const a = await home("a", {
      "gateway.json": GATEWAY,
      "gateway-usage.jsonl": `${JSON.stringify(call(0.1))}\n`,
    });
    await configure(a, remote);
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    const name = remote
      .names()
      .find((entry) => entry.startsWith("usage/") && entry.endsWith(".neolix-usage"));
    expect(name).toBeDefined();
    const before = remote.body(name!)!.toString("hex");

    await writeFile(
      path.join(a, "gateway-usage.jsonl"),
      `${JSON.stringify(call(0.1))}\n${JSON.stringify(call(0.2))}\n`,
    );
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    expect(remote.body(name!)!.toString("hex")).toBe(before);

    expect((await new SyncEngine(a).run({ force: true })).error).toBeUndefined();
    expect(remote.body(name!)!.toString("hex")).not.toBe(before);
  });

  it("offers this computer's setup over a damaged server file, keeping that file", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    const b = await home("b", { "gateway.json": GATEWAY });
    await configure(a, remote);
    await configure(b, remote);
    expect((await new SyncEngine(a).run()).error).toBeUndefined();
    const name = remote.names().find((entry) => entry.startsWith("sources."));
    remote.corrupt(name!);

    // B never read the file, so it has no copy to rebuild from: the setup
    // here can go up over it instead.
    const damaged = await new SyncEngine(b).run();
    expect(damaged.error).toMatch(/can't be read/);
    expect(damaged.serverFile).toEqual({ replace: true });

    const uploaded = await new SyncEngine(b).upload();
    expect(uploaded.error).toBeUndefined();
    expect(uploaded.serverFile).toBeUndefined();
    expect(remote.names().some((entry) => entry.startsWith("sources."))).toBe(true);
    // The server's file was kept in the sync folder before it was replaced.
    expect(await readdir(path.join(b, "sync"))).toEqual(
      expect.arrayContaining([expect.stringContaining("server-sources.")]),
    );
  });

  it("records a rate-limited answer as the sync's error", async () => {
    const remote = await dav();
    const a = await home("a", { "gateway.json": GATEWAY });
    await configure(a, remote);
    remote.failOnce(429);
    const result = await new SyncEngine(a).run();
    expect(result.error).toMatch(/limiting/);
  });
});
