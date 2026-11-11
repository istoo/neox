import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkbuddy, loadWorkbuddyAccounts, type WorkbuddyAccount } from "./workbuddy.js";

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
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function account(overrides: Partial<WorkbuddyAccount> = {}): WorkbuddyAccount {
  return {
    key: "workbuddy|u1",
    user: "Ann",
    uid: "u1",
    access: "tok-1",
    authKey: "workbuddy",
    ...overrides,
  };
}

const STATUS = "/v2/billing/meter/checkin-activity-status";
const CLAIM = "/v2/billing/meter/daily-checkin";
const SUMMARY = "/billing/meter/get-user-resource-summary";

const stubs: Stub[] = [];

async function stub(routes: Record<string, Route>): Promise<Stub> {
  const started = await start(routes);
  stubs.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((entry) => entry.close()));
});

function status(data: Record<string, unknown>): RouteAnswer {
  return { body: { code: 0, msg: "", data } };
}

describe("checkWorkbuddy", () => {
  it("says done when today is already in, with the credits and the streak", async () => {
    const server = await stub({
      [STATUS]: () =>
        status({ active: true, today_checked_in: true, today_credit: 5, streak_days: "3" }),
    });
    const result = await checkWorkbuddy({ account: account(), baseUrl: server.baseUrl });
    expect(result).toEqual({ outcome: "done", credit: 5, streak: 3 });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "POST", path: STATUS, body: "{}" });
    expect(server.requests[0].headers.authorization).toBe("Bearer tok-1");
    expect(server.requests[0].headers["x-user-id"]).toBe("u1");
    expect(server.requests[0].headers["user-agent"]).toBe("WorkBuddy/5.9.3");
    expect(server.requests[0].headers["x-product"]).toBe("SaaS");
    expect(server.requests[0].headers["x-ide-type"]).toBe("WorkBuddy");
    expect(server.requests[0].headers["x-domain"]).toBe(new URL(server.baseUrl).host);
    expect(server.requests[0].headers.accept).toBe("application/json");
    expect(server.requests[0].headers["content-type"]).toBe("application/json");
  });

  it("claims when the event runs and today's isn't in", async () => {
    const server = await stub({
      [STATUS]: () => status({ active: true, today_checked_in: false, streak_days: 3 }),
      [CLAIM]: () => ({
        body: { code: 0, data: { credit: 7, streak_days: 4, message: "signed" } },
      }),
    });
    const result = await checkWorkbuddy({ account: account(), baseUrl: server.baseUrl });
    expect(result).toEqual({ outcome: "claimed", credit: 7, streak: 4, msg: "signed" });
    expect(server.requests.map((entry) => entry.path)).toEqual([STATUS, CLAIM]);
    expect(server.requests[1].body).toBe("{}");
  });

  it("says inactive while no event runs", async () => {
    const server = await stub({ [STATUS]: () => status({ active: false }) });
    await expect(checkWorkbuddy({ account: account(), baseUrl: server.baseUrl })).resolves.toEqual({
      outcome: "inactive",
    });
  });

  it("keeps the vendor's own refusal as an answer for the day", async () => {
    const ineligible = await stub({
      [STATUS]: () => status({ active: true, today_checked_in: false }),
      [CLAIM]: () => ({ body: { code: 1002, msg: "not eligible" } }),
    });
    await expect(
      checkWorkbuddy({ account: account(), baseUrl: ineligible.baseUrl }),
    ).resolves.toEqual({ outcome: "ineligible", msg: "not eligible" });

    const already = await stub({
      [STATUS]: () => status({ active: true, today_checked_in: false }),
      [CLAIM]: () => ({ body: { code: 1001, msg: "today's is in" } }),
    });
    await expect(checkWorkbuddy({ account: account(), baseUrl: already.baseUrl })).resolves.toEqual(
      { outcome: "done", msg: "today's is in" },
    );

    const ended = await stub({
      [STATUS]: () => status({ active: true, today_checked_in: false }),
      [CLAIM]: () => ({ body: { code: 1003, msg: "the event is over" } }),
    });
    await expect(checkWorkbuddy({ account: account(), baseUrl: ended.baseUrl })).resolves.toEqual({
      outcome: "inactive",
      msg: "the event is over",
    });
  });

  it("says own-app when the check-in alone refuses a 401", async () => {
    const server = await stub({
      [STATUS]: () => ({ status: 401, body: "<html>Unauthorized</html>" }),
      [SUMMARY]: () => ({ body: { code: 0, msg: "", data: {} } }),
    });
    const result = await checkWorkbuddy({ account: account(), baseUrl: server.baseUrl });
    expect(result.outcome).toBe("own-app");
    expect(result.msg).toContain("WorkBuddy's own app");
    expect(server.requests.map((entry) => entry.path)).toEqual([STATUS, SUMMARY]);
    expect(server.requests[1].headers.authorization).toBe("Bearer tok-1");
  });

  it("asks for a new sign-in when the credits refuse the 401 too", async () => {
    const server = await stub({
      [STATUS]: () => ({ status: 401, body: "" }),
      [SUMMARY]: () => ({ status: 401, body: "" }),
    });
    const result = await checkWorkbuddy({ account: account(), baseUrl: server.baseUrl });
    expect(result.outcome).toBe("failed");
    expect(result.msg).toContain("sign in to it again");
  });

  it("keeps another refusal as a failure to try again", async () => {
    const server = await stub({ [STATUS]: () => ({ status: 500, body: "{}" }) });
    const result = await checkWorkbuddy({ account: account(), baseUrl: server.baseUrl });
    expect(result).toMatchObject({ outcome: "failed", msg: "HTTP 500" });
    expect(result.offline).toBeUndefined();
  });

  it("marks a request that never reached the vendor offline", async () => {
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
    const result = await checkWorkbuddy({
      account: account(),
      baseUrl: "http://127.0.0.1:1",
      fetch: (() => Promise.reject(failure)) as typeof fetch,
    });
    expect(result.outcome).toBe("failed");
    expect(result.offline).toBe(true);
    expect(result.msg).toContain("ENOTFOUND");
  });
});

describe("loadWorkbuddyAccounts", () => {
  it("reads myna's WorkBuddy sign-ins, once per uid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const authPath = path.join(dir, "plugin-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        workbuddy: {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: 1,
          accountId: "Ann",
          uid: "u1",
        },
        "workbuddy#second": {
          type: "oauth",
          access: "b",
          refresh: "r",
          expires: 1,
          accountId: "Bob",
          uid: "u2",
        },
        "workbuddy#again": {
          type: "oauth",
          access: "c",
          refresh: "r",
          expires: 1,
          accountId: "Ann",
          uid: "u1",
        },
        "workbuddy-ai#x": { type: "oauth", access: "d", refresh: "r", expires: 1, uid: "u3" },
        "workbuddy-ai": { type: "api", key: "k" },
        "minimax-code": { type: "oauth", access: "e", uid: "u9" },
      }),
    );
    const accounts = await loadWorkbuddyAccounts({ authPath });
    expect(accounts).toHaveLength(2);
    expect(accounts.map((entry) => entry.key)).toEqual(["workbuddy|u1", "workbuddy|u2"]);
    expect(accounts[0]).toMatchObject({ user: "Ann", access: "a" });
    expect(accounts[1]).toMatchObject({ user: "Bob", access: "b" });
  });

  it("is no accounts when the file is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    await expect(
      loadWorkbuddyAccounts({ authPath: path.join(dir, "plugin-auth.json") }),
    ).resolves.toEqual([]);
  });
});

describe("renewal", () => {
  it("renews a sign-in about to end and writes it back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const authPath = path.join(dir, "plugin-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        workbuddy: { type: "oauth", access: "old", refresh: "r1", uid: "u1", expires: 1 },
      }),
      "utf8",
    );
    const server = await stub({
      "/v2/plugin/auth/token/refresh": () => ({
        body: { code: 0, data: { accessToken: "new-tok", refreshToken: "r2", expiresIn: 3600 } },
      }),
      [STATUS]: () =>
        status({ active: true, today_checked_in: true, today_credit: 100, streak_days: 1 }),
    });
    await expect(
      checkWorkbuddy({
        account: account({ access: "old", refresh: "r1", expires: 1 }),
        authPath,
        baseUrl: server.baseUrl,
      }),
    ).resolves.toEqual({ outcome: "done", credit: 100, streak: 1 });
    expect(server.requests[0].path).toBe("/v2/plugin/auth/token/refresh");
    expect(server.requests[0].headers["x-refresh-token"]).toBe("r1");
    expect(server.requests[0].headers["x-auth-refresh-source"]).toBe("plugin");
    expect(server.requests[1].headers.authorization).toBe("Bearer new-tok");
    const saved = JSON.parse(await readFile(authPath, "utf8")) as {
      workbuddy: Record<string, unknown>;
    };
    expect(saved.workbuddy.access).toBe("new-tok");
    expect(saved.workbuddy.refresh).toBe("r2");
  });

  it("keeps the token there is when the renewal fails", async () => {
    const server = await stub({
      "/v2/plugin/auth/token/refresh": () => ({ status: 500, body: {} }),
      [STATUS]: () => status({ active: true, today_checked_in: true }),
    });
    await expect(
      checkWorkbuddy({
        account: account({ access: "old", refresh: "r1", expires: 1 }),
        baseUrl: server.baseUrl,
      }),
    ).resolves.toEqual({ outcome: "done" });
    expect(server.requests[1].headers.authorization).toBe("Bearer old");
  });
});
