import { verify } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkTrae, loadTraeAccounts, ugDevice, type TraeAccount } from "./trae.js";

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
        baseUrl: `http://127.0.0.1:${port}/trae/api/v2/ug/checkin_credits`,
        requests,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

function account(overrides: Partial<TraeAccount> = {}): TraeAccount {
  return {
    key: "trae-cn|u1",
    user: "Ann",
    uid: "u1",
    access: "jwt-1",
    deviceId: "123456789012345",
    authKey: "trae-cn",
    ...overrides,
  };
}

const STATUS = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM = "/trae/api/v2/ug/checkin_credits/claim";

const stubs: Stub[] = [];

async function stub(routes: Record<string, Route>): Promise<Stub> {
  const started = await start(routes);
  stubs.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((entry) => entry.close()));
});

function serverClaims(server: Stub): number {
  return server.requests.filter((entry) => entry.path === CLAIM).length;
}

function serverDevice(request: Recorded): string {
  return String(request.headers["x-device-id"] ?? "");
}

function statusAnswer(body: Record<string, unknown>): RouteAnswer {
  return { body: { code: 0, message: "", enable: true, checked_in: false, ...body } };
}

describe("ugDevice", () => {
  it("keeps a 15-digit id and derives one otherwise", () => {
    expect(ugDevice({ deviceId: "123456789012345", uid: "u1" })).toBe("123456789012345");
    expect(ugDevice({ deviceId: "abc", uid: "u1" })).toBe("962674108392275");
    expect(ugDevice({ deviceId: "abc", uid: "u1" })).toMatch(/^[1-9]\d{14}$/);
    expect(ugDevice({ deviceId: "abc", uid: "u2" })).not.toBe(
      ugDevice({ deviceId: "abc", uid: "u1" }),
    );
  });
});

describe("checkTrae", () => {
  it("says done when the status is already in", async () => {
    const server = await stub({
      [STATUS]: () => statusAnswer({ checked_in: true, credits: 100 }),
    });
    await expect(checkTrae({ account: account(), baseUrl: server.baseUrl })).resolves.toEqual({
      outcome: "done",
      credit: 100,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: STATUS,
      body: JSON.stringify({ req_source: 1 }),
    });
    expect(server.requests[0].headers.authorization).toBe("Cloud-IDE-JWT jwt-1");
    expect(server.requests[0].headers["x-device-id"]).toBe("123456789012345");
    expect(server.requests[0].headers["x-device-brand"]).toBe(
      "ASUS TUF Gaming A15 FA507RM_FA507RM",
    );
    expect(server.requests[0].headers["x-device-type"]).toBe("Windows");
    expect(server.requests[0].headers["x-os-version"]).toBe("10.0.22631");
    expect(server.requests[0].headers["x-app-version"]).toBe("0.1.69");
    expect(String(server.requests[0].headers["user-agent"])).toContain("TRAE-SOLO-CN/0.1.69");
    expect(server.requests[0].headers.accept).toBe("application/json");
    expect(server.requests[0].headers["content-type"]).toBe("application/json");
  });

  it("claims, then reads the status back as proof", async () => {
    let reads = 0;
    const server = await stub({
      [STATUS]: () => {
        reads += 1;
        return reads === 1
          ? statusAnswer({ checked_in: false, credits: 0 })
          : statusAnswer({ checked_in: true, credits: 100 });
      },
      [CLAIM]: () => ({ body: { code: 0, message: "success" } }),
    });
    await expect(checkTrae({ account: account(), baseUrl: server.baseUrl })).resolves.toEqual({
      outcome: "claimed",
      credit: 100,
    });
    expect(server.requests.map((entry) => entry.path)).toEqual([STATUS, CLAIM, STATUS]);
    expect(server.requests[1].body).toBe(JSON.stringify({ req_source: 1 }));
  });

  it("takes the claim's own credits before the status's", async () => {
    let reads = 0;
    const server = await stub({
      [STATUS]: () => {
        reads += 1;
        return reads === 1
          ? statusAnswer({ checked_in: false })
          : statusAnswer({ checked_in: true, credits: 100 });
      },
      [CLAIM]: () => ({ body: { code: 0, extra_credits: 50 } }),
    });
    await expect(checkTrae({ account: account(), baseUrl: server.baseUrl })).resolves.toEqual({
      outcome: "claimed",
      credit: 50,
    });
  });

  it("says nothing is claimed again when the read-back isn't in", async () => {
    const server = await stub({
      [STATUS]: () => statusAnswer({ checked_in: false }),
      [CLAIM]: () => ({ body: { code: 0 } }),
    });
    const result = await checkTrae({ account: account(), baseUrl: server.baseUrl });
    expect(result.outcome).toBe("ineligible");
    expect(result.msg).toContain("nothing is claimed again today");
  });

  it("claims once more in the client-less shape after a 9074, and can win", async () => {
    let reads = 0;
    let claims = 0;
    const server = await stub({
      [STATUS]: () => {
        reads += 1;
        return reads === 1 ? statusAnswer({}) : statusAnswer({ checked_in: true, credits: 100 });
      },
      [CLAIM]: () => {
        claims += 1;
        return claims === 1
          ? { body: { code: 9074, message: "too many taking part" } }
          : { body: { code: 0 } };
      },
    });
    const result = await checkTrae({ account: account(), baseUrl: server.baseUrl });
    expect(result).toEqual({ outcome: "claimed", credit: 100 });
    expect(server.requests.map((entry) => entry.path)).toEqual([STATUS, CLAIM, CLAIM, STATUS]);
    const first = server.requests[1];
    const second = server.requests[2];
    expect(first.headers["x-market-user-id"]).toBeUndefined();
    expect(first.headers["x-device-id"]).toBe("123456789012345");
    expect(second.headers["x-user-region"]).toBe("CN");
    expect(second.headers["x-market-user-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.headers["x-device-id"]).toMatch(/^\d{15}$/);
    expect(second.headers.authorization).toBe("Cloud-IDE-JWT jwt-1");
    expect(second.body).toBe("{}");
  });

  it("keeps a 9074 on the second claim as the day's answer", async () => {
    const refused = await stub({
      [STATUS]: () => statusAnswer({}),
      [CLAIM]: () => ({ body: { code: 9074, message: "too many taking part" } }),
    });
    const result = await checkTrae({ account: account(), baseUrl: refused.baseUrl });
    expect(result.outcome).toBe("ineligible");
    expect(result.msg).toContain("9074");
    expect(serverClaims(refused)).toBe(2);
    // The device named is the client-less shape's, which the second
    // claim went on.
    expect(result.msg).toContain(serverDevice(refused.requests[2]));
  });

  it("keeps 9095 as an answer for the day, naming the device", async () => {
    const checked = await stub({
      [STATUS]: () => statusAnswer({}),
      [CLAIM]: () => ({ body: { code: 9095, message: "this device has checked in today" } }),
    });
    const second = await checkTrae({ account: account(), baseUrl: checked.baseUrl });
    expect(second.outcome).toBe("ineligible");
    expect(second.msg).toContain("123456789012345");
  });

  it("says inactive while the check-in is off", async () => {
    const server = await stub({ [STATUS]: () => statusAnswer({ enable: false }) });
    await expect(checkTrae({ account: account(), baseUrl: server.baseUrl })).resolves.toEqual({
      outcome: "inactive",
    });
  });

  it("asks for a new sign-in on a 401 or code 1001", async () => {
    const unauthorized = await stub({ [STATUS]: () => ({ status: 401, body: "" }) });
    await expect(
      checkTrae({ account: account(), baseUrl: unauthorized.baseUrl }),
    ).resolves.toMatchObject({
      outcome: "failed",
      msg: expect.stringContaining("sign in again"),
    });

    const signedOut = await stub({ [STATUS]: () => ({ body: { code: 1001, message: "no" } }) });
    await expect(
      checkTrae({ account: account(), baseUrl: signedOut.baseUrl }),
    ).resolves.toMatchObject({
      outcome: "failed",
      msg: expect.stringContaining("sign in again"),
    });
  });

  it("keeps a non-200 or unreadable answer as a failure", async () => {
    const broken = await stub({ [STATUS]: () => ({ status: 500, body: "" }) });
    const failed = await checkTrae({ account: account(), baseUrl: broken.baseUrl });
    expect(failed).toMatchObject({ outcome: "failed", msg: "HTTP 500" });

    const html = await stub({ [STATUS]: () => ({ body: "<html>nope</html>" }) });
    const unreadable = await checkTrae({ account: account(), baseUrl: html.baseUrl });
    expect(unreadable.outcome).toBe("failed");
    expect(unreadable.msg).toContain("unreadable reply");
  });
});

describe("renewal", () => {
  async function authFile(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const file = path.join(dir, "plugin-auth.json");
    await writeFile(
      file,
      JSON.stringify({
        "trae-cn": {
          type: "oauth",
          access: "jwt-1",
          refresh: "rt-1",
          expires: 1,
          uid: "u1",
          deviceId: "123456789012345",
          machineId: "m1",
        },
      }),
      "utf8",
    );
    return file;
  }

  it("renews through the device-bound exchange and writes it back", async () => {
    const authPath = await authFile();
    const server = await stub({
      "/trae/api/v3/oauth/ExchangeToken": () => ({
        body: { Result: { Token: "jwt-2", RefreshToken: "rt-2", TokenExpireAt: 4102444800 } },
      }),
      [STATUS]: () => statusAnswer({ checked_in: true, credits: 5 }),
    });
    await expect(
      checkTrae({
        account: account({
          expires: 1,
          refresh: "rt-1",
          machineId: "m1",
          authHost: new URL(server.baseUrl).origin,
        }),
        authPath,
        baseUrl: server.baseUrl,
      }),
    ).resolves.toEqual({ outcome: "done", credit: 5 });

    const [renewal, firstStatus] = server.requests;
    expect(renewal?.path).toBe("/trae/api/v3/oauth/ExchangeToken");
    const body = JSON.parse(renewal?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      ClientID: "en1oxy7wnw8j9n",
      ClientSecret: "",
      RefreshToken: "rt-1",
      IDEVersion: "0.1.64",
    });
    const info = body.DeviceInfo as Record<string, string>;
    expect(info.DeviceID).toBe("123456789012345");
    expect(info.MachineID).toBe("m1");
    expect(info.DevicePublicKey).toContain("BEGIN PUBLIC KEY");
    const proof = body.DeviceProof as Record<string, unknown>;
    expect(typeof proof.Signature).toBe("string");
    expect(proof.Timestamp).toBeTypeOf("number");
    expect(proof.Nonce).toBeTypeOf("string");
    expect(firstStatus?.headers.authorization).toBe("Cloud-IDE-JWT jwt-2");

    const saved = JSON.parse(await readFile(authPath, "utf8")) as {
      "trae-cn": Record<string, unknown>;
    };
    expect(saved["trae-cn"].access).toBe("jwt-2");
    expect(saved["trae-cn"].refresh).toBe("rt-2");
    expect(saved["trae-cn"].expires).toBe(4102444800000);
    expect(saved["trae-cn"].devicePrivateKey).toContain("BEGIN PRIVATE KEY");
    expect(saved["trae-cn"].devicePublicKey).toContain("BEGIN PUBLIC KEY");

    // The proof verifies against the key saved with the account, so the
    // next renewal signs as the same device.
    const signed = [
      "POST",
      "/trae/api/v3/oauth/ExchangeToken",
      String(body.ClientID),
      "rt-1",
      String(proof.Timestamp),
      String(proof.Nonce),
    ].join("\n");
    expect(
      verify(
        "sha256",
        Buffer.from(signed),
        String(saved["trae-cn"].devicePublicKey),
        Buffer.from(String(proof.Signature), "base64"),
      ),
    ).toBe(true);
  });

  it("falls back to the plain exchange when the device-bound one is refused", async () => {
    const server = await stub({
      "/trae/api/v3/oauth/ExchangeToken": () => ({ status: 404, body: {} }),
      "/cloudide/api/v3/trae/oauth/ExchangeToken": () => ({
        body: { Result: { Token: "jwt-3", RefreshToken: "rt-3" } },
      }),
      [STATUS]: () => statusAnswer({ checked_in: true }),
    });
    await expect(
      checkTrae({
        account: account({
          expires: 1,
          refresh: "rt-1",
          authHost: new URL(server.baseUrl).origin,
        }),
        baseUrl: server.baseUrl,
      }),
    ).resolves.toEqual({ outcome: "done" });

    expect(server.requests.map((entry) => entry.path)).toEqual([
      "/trae/api/v3/oauth/ExchangeToken",
      "/trae/api/v3/oauth/ExchangeToken",
      "/cloudide/api/v3/trae/oauth/ExchangeToken",
      STATUS,
    ]);
    expect(server.requests[3]?.headers.authorization).toBe("Cloud-IDE-JWT jwt-3");
  });

  it("keeps the token there is when the renewal fails", async () => {
    const server = await stub({
      "/trae/api/v3/oauth/ExchangeToken": () => ({ status: 500, body: {} }),
      "/cloudide/api/v3/trae/oauth/ExchangeToken": () => ({ status: 500, body: {} }),
      [STATUS]: () => statusAnswer({ checked_in: true }),
    });
    await expect(
      checkTrae({
        account: account({
          expires: 1,
          refresh: "rt-1",
          authHost: new URL(server.baseUrl).origin,
        }),
        baseUrl: server.baseUrl,
      }),
    ).resolves.toEqual({ outcome: "done" });
    expect(server.requests.at(-1)?.headers.authorization).toBe("Cloud-IDE-JWT jwt-1");
  });
});

describe("loadTraeAccounts", () => {
  it("reads the trae-cn sign-ins, once per uid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "neolix-myna-auth-"));
    const authPath = path.join(dir, "plugin-auth.json");
    await writeFile(
      authPath,
      JSON.stringify({
        "trae-cn": {
          type: "oauth",
          access: "a",
          refresh: "r",
          expires: 1,
          uid: "u1",
          deviceId: "123456789012345",
          accountId: "Ann",
        },
        "trae-cn#again": { type: "oauth", access: "b", uid: "u1", accountId: "Ann" },
        "trae-cn#second": { type: "oauth", access: "c", uid: "u2" },
        "trae-global": { type: "oauth", access: "d", uid: "u3" },
      }),
    );
    const accounts = await loadTraeAccounts({ authPath });
    expect(accounts.map((entry) => entry.key)).toEqual(["trae-cn|u1", "trae-cn|u2"]);
    expect(accounts[0]).toMatchObject({
      user: "Ann",
      access: "a",
      deviceId: "123456789012345",
    });
    expect(accounts[1].user).toBe("u2");
  });
});
