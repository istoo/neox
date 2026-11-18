import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkQoder,
  loadQoderAccounts,
  type QoderAccount,
  type QoderIdentityOptions,
} from "./qoder.js";

interface RouteAnswer {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Stub {
  baseUrl: string;
  requests: Recorded[];
  close: () => Promise<void>;
}

type Route = (request: Recorded) => RouteAnswer;

function start(routes: Record<string, Route>): Promise<Stub> {
  const requests: Recorded[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const recorded: Recorded = {
      method: request.method ?? "",
      path: url.pathname,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    requests.push(recorded);
    const route = routes[url.pathname];
    if (route === undefined) {
      response.writeHead(404);
      response.end();
      return;
    }
    const answer = route(recorded);
    response.writeHead(answer.status ?? 200, {
      "content-type": "application/json",
      ...answer.headers,
    });
    response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/sash/api/v1/me/campaigns`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function account(overrides: Partial<QoderAccount> = {}): QoderAccount {
  return {
    key: "qoder|u1",
    user: "Ann",
    uid: "u1",
    deviceToken: "dt-1",
    access: "at-1",
    lingma: false,
    site: "qoder",
    authKey: "qoder",
    ...overrides,
  };
}

function identity(overrides: Partial<QoderIdentityOptions> = {}): QoderIdentityOptions {
  return {
    platform: "linux",
    arch: "x64",
    home: "/nonexistent-neolix-home",
    opt: "/nonexistent-neolix-opt",
    env: { QODER_RUNTIME_INFO: "/fake/runtime-info" },
    runRuntime: async () => '{"machineToken":"mt-1","machineType":"5"}\n',
    ...overrides,
  };
}

function missingRuntime(): QoderIdentityOptions {
  return {
    platform: "linux",
    arch: "x64",
    home: "/nonexistent-neolix-home",
    opt: "/nonexistent-neolix-opt",
    env: {},
  };
}

const CAMPAIGNS = "/sash/api/v1/me/campaigns";

const stubs: Stub[] = [];

async function stub(routes: Record<string, Route>): Promise<Stub> {
  const started = await start(routes);
  stubs.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((entry) => entry.close()));
});

const NOW = () => new Date("2026-01-02T03:04:05.000Z");

function campaigns(list: Array<Record<string, unknown>>): RouteAnswer {
  return { body: { campaigns: list } };
}

function claimable(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: "c1",
    actionType: "CLAIM_BENEFIT",
    claimStatus: "CLAIMABLE",
    benefit: { amount: 100 },
    ...overrides,
  };
}

describe("checkQoder", () => {
  it("claims a claimable campaign with the machine identity", async () => {
    const server = await stub({
      [CAMPAIGNS]: () => campaigns([claimable()]),
      [`${CAMPAIGNS}/c1/claim`]: () => ({
        body: { status: "CLAIMED", benefit: { amount: 100 } },
      }),
    });
    await expect(
      checkQoder({
        account: account(),
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toEqual({ outcome: "claimed", credit: 100 });

    expect(server.requests.map((entry) => entry.path)).toEqual([
      CAMPAIGNS,
      `${CAMPAIGNS}/c1/claim`,
    ]);
    const list = server.requests[0];
    expect(list.method).toBe("GET");
    expect(list.body).toBe("");
    expect(list.headers.authorization).toBe("Bearer dt-1");
    expect(list.headers["cosy-clienttype"]).toBe("10");
    expect(list.headers["user-agent"]).toBe("Qoder");
    expect(list.headers["cosy-machinetoken"]).toBe("mt-1");
    expect(list.headers["cosy-machinetype"]).toBe("5");
    const claim = server.requests[1];
    expect(claim.method).toBe("POST");
    expect(claim.body).toBe("{}");
  });

  it("asks the helper with environment 3, and passes the uid on stdin off Linux", async () => {
    const server = await stub({
      [CAMPAIGNS]: () => campaigns([claimable()]),
      [`${CAMPAIGNS}/c1/claim`]: () => ({ body: { status: "CLAIMED" } }),
    });
    let called: { file: string; args: string[]; stdin?: string; timeoutMs: number } | undefined;
    await checkQoder({
      account: account(),
      baseUrl: server.baseUrl,
      now: NOW,
      identity: identity({
        platform: "darwin",
        home: "/tmp",
        env: { QODER_RUNTIME_INFO: "/fake/runtime-info" },
        runRuntime: async (input) => {
          called = input;
          return '{"machineToken":"mt-1","machineType":"5"}\nsecond line\n';
        },
      }),
    });
    expect(called).toEqual({
      file: path.resolve("/fake/runtime-info"),
      args: ["3", "--account-stdin"],
      stdin: '{"account":"u1"}\n',
      timeoutMs: 20_000,
    });
  });

  it("says done for a campaign already claimed today", async () => {
    const server = await stub({
      [CAMPAIGNS]: () => campaigns([claimable({ claimStatus: "CLAIMED" })]),
    });
    await expect(
      checkQoder({
        account: account(),
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toEqual({ outcome: "done", credit: 100 });
    expect(server.requests).toHaveLength(1);
  });

  it("says inactive when no daily campaign is offered", async () => {
    const server = await stub({ [CAMPAIGNS]: () => campaigns([]) });
    const result = await checkQoder({
      account: account(),
      baseUrl: server.baseUrl,
      now: NOW,
      identity: identity(),
    });
    expect(result.outcome).toBe("inactive");
    expect(result.msg).toContain("no daily credits campaign");
  });

  it("keeps 401/403 as a sign-in failure and doesn't rotate", async () => {
    const server = await stub({ [CAMPAIGNS]: () => ({ status: 401, body: "{}" }) });
    await expect(
      checkQoder({
        account: account(),
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toMatchObject({
      outcome: "failed",
      msg: expect.stringContaining("sign in again"),
    });
    expect(server.requests).toHaveLength(1);
  });

  it("keeps a claim that didn't say CLAIMED as a failure", async () => {
    const server = await stub({
      [CAMPAIGNS]: () => campaigns([claimable()]),
      [`${CAMPAIGNS}/c1/claim`]: () => ({ body: { status: "PENDING" } }),
    });
    await expect(
      checkQoder({
        account: account(),
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toEqual({ outcome: "failed", msg: "claim: PENDING" });
  });

  it("says ineligible when this machine has no Qoder runtime", async () => {
    const server = await stub({});
    const result = await checkQoder({
      account: account(),
      baseUrl: server.baseUrl,
      now: NOW,
      identity: missingRuntime(),
    });
    expect(result.outcome).toBe("ineligible");
    expect(result.msg).toContain("device identity runtime not found");
    expect(result.until).toBe("2026-01-02T16:00:00.000Z");
    expect(server.requests).toHaveLength(0);
  });

  it("says ineligible when the helper can't be read", async () => {
    const server = await stub({});
    const result = await checkQoder({
      account: account(),
      baseUrl: server.baseUrl,
      now: NOW,
      identity: identity({
        runRuntime: async () => {
          throw new Error("boom");
        },
      }),
    });
    expect(result.outcome).toBe("ineligible");
    expect(result.msg).toContain("could not read device identity");
    expect(server.requests).toHaveLength(0);
  });

  it("goes on without the identity on Qoder CN when the helper is missing", async () => {
    const cnBase = "/sash/api/v1/me/campaigns";
    const server = await stub({
      [cnBase]: () => campaigns([claimable()]),
      [`${cnBase}/c1/claim`]: () => ({ body: { status: "CLAIMED" } }),
    });
    await expect(
      checkQoder({
        account: account({ site: "qoder-cn", key: "qoder-cn|u1" }),
        baseUrl: server.baseUrl,
        now: NOW,
        identity: missingRuntime(),
      }),
    ).resolves.toEqual({ outcome: "claimed", credit: 100 });
    expect(server.requests[0].headers["cosy-machinetoken"]).toBeUndefined();
    expect(server.requests[1].headers["cosy-machinetoken"]).toBeUndefined();
  });

  it("says ineligible on Qoder CN's missing helper when nothing is offered", async () => {
    const server = await stub({ [CAMPAIGNS]: () => campaigns([]) });
    const result = await checkQoder({
      account: account({ site: "qoder-cn", key: "qoder-cn|u1" }),
      baseUrl: server.baseUrl,
      now: NOW,
      identity: missingRuntime(),
    });
    expect(result.outcome).toBe("ineligible");
    expect(result.msg).toContain("Qoder CN check-in: device identity runtime not found");
  });

  it("says inactive for a Lingma dedicated domain", async () => {
    const server = await stub({});
    await expect(
      checkQoder({
        account: account({ lingma: true }),
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toEqual({
      outcome: "inactive",
      msg: "a Lingma 1.0 dedicated domain has no daily credits",
    });
    expect(server.requests).toHaveLength(0);
  });
});

describe("renewal", () => {
  async function authFile(entry: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const file = path.join(dir, "plugin-auth.json");
    await writeFile(file, JSON.stringify({ qoder: entry }), "utf8");
    return file;
  }

  it("rotates a refused device token once and writes it back", async () => {
    const authPath = await authFile({
      type: "oauth",
      access: "at-1",
      deviceToken: "dt-1",
      deviceRefresh: "dr-1",
      uid: "u1",
    });
    let lists = 0;
    const server = await stub({
      [CAMPAIGNS]: () => {
        lists += 1;
        return lists === 1 ? { status: 401, body: {} } : campaigns([claimable()]);
      },
      [`${CAMPAIGNS}/c1/claim`]: () => ({
        body: { status: "CLAIMED", benefit: { amount: 100 } },
      }),
      "/api/v1/deviceToken/refresh": () => ({
        body: { token: "dt-2", refresh_token: "dr-2", expires_in: 3600 },
      }),
    });
    await expect(
      checkQoder({
        account: account({ deviceRefresh: "dr-1" }),
        authPath,
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toEqual({ outcome: "claimed", credit: 100 });

    expect(server.requests.map((entry) => entry.path)).toEqual([
      CAMPAIGNS,
      "/api/v1/deviceToken/refresh",
      CAMPAIGNS,
      `${CAMPAIGNS}/c1/claim`,
    ]);
    const refresh = server.requests[1];
    expect(refresh.method).toBe("POST");
    expect(refresh.body).toBe('{"refresh_token":"dr-1"}');
    expect(refresh.headers.accept).toBe("application/json");
    expect(refresh.headers.authorization).toBeUndefined();
    expect(server.requests[2].headers.authorization).toBe("Bearer dt-2");
    expect(server.requests[3].headers.authorization).toBe("Bearer dt-2");

    const saved = JSON.parse(await readFile(authPath, "utf8")) as {
      qoder: Record<string, unknown>;
    };
    expect(saved.qoder.deviceToken).toBe("dt-2");
    expect(saved.qoder.deviceRefresh).toBe("dr-2");
    expect(saved.qoder.access).toBe("at-1");
  });

  it("keeps the refusal when the rotation is refused too", async () => {
    const authPath = await authFile({
      type: "oauth",
      access: "at-1",
      deviceToken: "dt-1",
      deviceRefresh: "dr-1",
      uid: "u1",
    });
    const server = await stub({
      [CAMPAIGNS]: () => ({ status: 401, body: "{}" }),
      "/api/v1/deviceToken/refresh": () => ({ status: 401, body: {} }),
    });
    await expect(
      checkQoder({
        account: account({ deviceRefresh: "dr-1" }),
        authPath,
        baseUrl: server.baseUrl,
        now: NOW,
        identity: identity(),
      }),
    ).resolves.toMatchObject({ outcome: "failed", msg: expect.stringContaining("sign in again") });
    expect(server.requests.map((entry) => entry.path)).toEqual([
      CAMPAIGNS,
      "/api/v1/deviceToken/refresh",
    ]);
    const saved = JSON.parse(await readFile(authPath, "utf8")) as {
      qoder: Record<string, unknown>;
    };
    expect(saved.qoder.deviceToken).toBe("dt-1");
    expect(saved.qoder.deviceRefresh).toBe("dr-1");
  });
});

describe("loadQoderAccounts", () => {
  it("reads both sites once per uid, with the device token and lingma flag", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const authPath = path.join(dir, "plugin-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        qoder: {
          type: "oauth",
          access: "a",
          deviceToken: "dt-a",
          deviceRefresh: "dr-a",
          uid: "u1",
          accountId: "Ann",
        },
        "qoder#again": { type: "oauth", access: "b", deviceToken: "dt-b", uid: "u1" },
        "qoder-cn": {
          type: "oauth",
          access: "c",
          deviceToken: "dt-c",
          uid: "u2",
          lingma: true,
        },
        "trae-cn": { type: "oauth", access: "d", uid: "u3" },
      }),
    );
    const accounts = await loadQoderAccounts({ authPath });
    expect(accounts.map((entry) => entry.key)).toEqual(["qoder|u1", "qoder-cn|u2"]);
    expect(accounts[0]).toMatchObject({
      user: "Ann",
      deviceToken: "dt-a",
      deviceRefresh: "dr-a",
      lingma: false,
      site: "qoder",
    });
    expect(accounts[1]).toMatchObject({
      user: "u2",
      deviceToken: "dt-c",
      lingma: true,
      site: "qoder-cn",
    });
  });
});
