import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MINIMAX_SIGN_SECRET,
  checkMinimax,
  loadMinimaxAccounts,
  type MinimaxAccount,
} from "./minimax.js";

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
        baseUrl: `http://127.0.0.1:${port}/minimax-cloud/api/v1/signin`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function account(overrides: Partial<MinimaxAccount> = {}): MinimaxAccount {
  return {
    key: "minimax-code|u1",
    user: "Solo",
    uid: "u1",
    access: "tok-1",
    site: "minimax-code",
    authKey: "minimax-code",
    ...overrides,
  };
}

const STATUS = "/minimax-cloud/api/v1/signin/status";
const CLAIM = "/minimax-cloud/api/v1/signin/claim";
const SECONDS = Math.floor(Date.parse("2026-01-02T03:04:05.000Z") / 1000);

const stubs: Stub[] = [];

async function stub(routes: Record<string, Route>): Promise<Stub> {
  const started = await start(routes);
  stubs.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((entry) => entry.close()));
});

function panel(days: Array<Record<string, unknown>>): RouteAnswer {
  return {
    body: {
      base_resp: { status_code: 0, status_msg: "" },
      data: { days },
    },
  };
}

function run(server: Stub) {
  return checkMinimax({
    account: account(),
    baseUrl: server.baseUrl,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
}

describe("checkMinimax", () => {
  it("says done when today's panel day is claimed", async () => {
    const server = await stub({
      [STATUS]: () =>
        panel([
          { day_no: 2, points: 10, status: 1, is_today: false },
          { day_no: 3, points: 20, status: 3, is_today: true },
        ]),
    });
    await expect(run(server)).resolves.toEqual({ outcome: "done", credit: 20, streak: 3 });
  });

  it("claims a claimable day and keeps the claim's own day and credits", async () => {
    const server = await stub({
      [STATUS]: () => panel([{ day_no: 3, points: 20, status: 2, is_today: true }]),
      [CLAIM]: () => ({
        body: {
          base_resp: { status_code: 0, status_msg: "" },
          data: { claim_result: 1, day_no: 4, points: 40 },
        },
      }),
    });
    await expect(run(server)).resolves.toEqual({ outcome: "claimed", credit: 40, streak: 4 });
    expect(server.requests.map((entry) => entry.path)).toEqual([STATUS, CLAIM]);
    expect(server.requests[1].body).toBe("{}");
  });

  it("says done when the claim answers it was already claimed today", async () => {
    const server = await stub({
      [STATUS]: () => panel([{ day_no: 3, points: 20, status: 2, is_today: true }]),
      [CLAIM]: () => ({
        body: {
          base_resp: { status_code: 0, status_msg: "" },
          data: { claim_result: 2, day_no: 0, points: 0 },
        },
      }),
    });
    await expect(run(server)).resolves.toEqual({ outcome: "done", credit: 20, streak: 3 });
  });

  it("says inactive when the panel has no today, and ineligible when closed", async () => {
    const none = await stub({ [STATUS]: () => panel([]) });
    await expect(run(none)).resolves.toEqual({ outcome: "inactive" });

    const closed = await stub({
      [STATUS]: () => panel([{ day_no: 3, points: 20, status: 4, is_today: true }]),
    });
    await expect(run(closed)).resolves.toEqual({
      outcome: "ineligible",
      msg: "today's check-in is closed for this account",
    });
  });

  it("keeps a base_resp error as a failure", async () => {
    const server = await stub({
      [STATUS]: () => ({ body: { base_resp: { status_code: 1001, status_msg: "nope" } } }),
    });
    await expect(run(server)).resolves.toEqual({ outcome: "failed", msg: "code 1001: nope" });
  });

  it("asks for a new sign-in on a 401 or the expired header", async () => {
    const unauthorized = await stub({ [STATUS]: () => ({ status: 401, body: "{}" }) });
    const refused = await run(unauthorized);
    expect(refused.outcome).toBe("failed");
    expect(refused.msg).toContain("sign in again");

    const expired = await stub({
      [STATUS]: () => ({
        body: panel([{ day_no: 3, points: 20, status: 2, is_today: true }]),
        headers: { "x-magpie-sign-in": "expired" },
      }),
    });
    await expect(run(expired)).resolves.toMatchObject({
      outcome: "failed",
      msg: expect.stringContaining("expired"),
    });
  });

  it("signs each request with the timestamp and the page's secret", async () => {
    const server = await stub({
      [STATUS]: () => panel([{ day_no: 3, points: 20, status: 2, is_today: true }]),
      [CLAIM]: () => ({
        body: {
          base_resp: { status_code: 0, status_msg: "" },
          data: { claim_result: 1, day_no: 3, points: 20 },
        },
      }),
    });
    await run(server);
    expect(server.requests).toHaveLength(2);
    for (const [index, request] of server.requests.entries()) {
      const body = index === 0 ? "" : "{}";
      const signature = createHash("md5")
        .update(`${SECONDS}${MINIMAX_SIGN_SECRET}${body}`)
        .digest("hex");
      expect(request.headers["x-timestamp"]).toBe(String(SECONDS));
      expect(request.headers["x-signature"]).toBe(signature);
      expect(request.headers.authorization).toBe("Bearer tok-1");
      expect(request.headers.accept).toBe("application/json");
      expect(request.path).toMatch(/\/signin\/(status|claim)$/);
    }
  });
});

describe("loadMinimaxAccounts", () => {
  it("reads both sites, preferring realUserID, once per uid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const authPath = path.join(dir, "plugin-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "minimax-code": {
          type: "oauth",
          access: "a",
          realUserID: "r1",
          uid: "u1",
          accountId: "Solo",
        },
        "minimax-code#second": { type: "oauth", access: "b", uid: "u2" },
        "minimax-code-global": {
          type: "oauth",
          access: "c",
          realUserID: "r3",
          uid: "u3",
          accountId: "Globe",
        },
        "minimax-code-global#again": { type: "oauth", access: "d", realUserID: "r3", uid: "u3" },
        "minimax-code#no-id": { type: "oauth", access: "e" },
        workbuddy: { type: "oauth", access: "f", uid: "u9" },
      }),
    );
    const accounts = await loadMinimaxAccounts({ authPath });
    expect(accounts.map((entry) => entry.key)).toEqual([
      "minimax-code|r1",
      "minimax-code|u2",
      "minimax-code-global|r3",
    ]);
    expect(accounts[0]).toMatchObject({ user: "Solo", access: "a", site: "minimax-code" });
    expect(accounts[2]).toMatchObject({
      user: "Globe",
      access: "c",
      site: "minimax-code-global",
    });
  });
});

describe("renewal", () => {
  it("renews an expired sign-in at the OAuth host and writes it back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const authPath = path.join(dir, "plugin-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "minimax-code": {
          type: "oauth",
          access: "old",
          refresh: "r1",
          realUserID: "u1",
          expires: 1,
        },
      }),
      "utf8",
    );
    const server = await stub({
      "/oauth2/token": () => ({
        body: { access_token: "new-tok", refresh_token: "r2", expires_in: 3600 },
      }),
      [STATUS]: () => panel([{ day_no: 3, points: 10, status: 3, is_today: true }]),
    });
    await expect(
      checkMinimax({
        account: account({ access: "old", refresh: "r1", expires: 1 }),
        authPath,
        baseUrl: server.baseUrl,
        accountUrl: new URL(server.baseUrl).origin,
      }),
    ).resolves.toMatchObject({ outcome: "done" });
    const refresh = server.requests[0];
    expect(refresh.path).toBe("/oauth2/token");
    expect(refresh.body).toContain("grant_type=refresh_token");
    expect(refresh.body).toContain("refresh_token=r1");
    expect(refresh.body).toContain("client_id=mcode-public");
    expect(server.requests[1].headers.authorization).toBe("Bearer new-tok");
    const saved = JSON.parse(await readFile(authPath, "utf8")) as {
      "minimax-code": Record<string, unknown>;
    };
    expect(saved["minimax-code"].access).toBe("new-tok");
    expect(saved["minimax-code"].refresh).toBe("r2");
  });
});
