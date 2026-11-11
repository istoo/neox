import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readProviderBalance, VENDOR_BALANCES } from "./balance.js";

let server: Server | undefined;
const restoreVendors: (() => void)[] = [];

afterEach(async () => {
  for (const restore of restoreVendors.splice(0)) {
    restore();
  }
  if (server !== undefined) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

interface Seen {
  url: string;
  method: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function serve(status: number, body: string): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((request, response) => {
    let received = "";
    request.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    request.on("end", () => {
      seen.push({
        url: request.url ?? "",
        method: request.method,
        headers: request.headers,
        body: received,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("no server address");
  }
  return { base: `http://127.0.0.1:${address.port}`, seen };
}

/** Points a vendor's default endpoint at a local server, for one test. */
function pointVendor(host: string, url: string): void {
  const vendor = VENDOR_BALANCES.find((entry) => entry.hosts.includes(host));
  if (vendor === undefined) {
    throw new Error(`no vendor for ${host}`);
  }
  const before = vendor.url;
  vendor.url = () => url;
  restoreVendors.push(() => {
    vendor.url = before;
  });
}

/** Reads a provider on `host` through its vendor default, pointed at `base`. */
async function readVendor(
  host: string,
  base: string,
): Promise<Awaited<ReturnType<typeof readProviderBalance>>> {
  pointVendor(host, `${base}/balance`);
  return await readProviderBalance({
    baseUrls: [`https://${host}/v1`],
    apiKey: "abc",
  });
}

describe("readProviderBalance", () => {
  it("reads the amount at the named path, asking with the key", async () => {
    const { base, seen } = await serve(200, JSON.stringify({ data: { balance: 12.5 } }));
    const result = await readProviderBalance({
      balanceUrl: `${base}/user/balance`,
      balancePath: "data.balance",
      apiKey: "test-key",
    });
    expect(result).toEqual({ amount: "12.5" });
    expect(seen[0]?.url).toBe("/user/balance");
    expect(seen[0]?.headers.authorization).toBe("Bearer test-key");
  });

  it("puts the key in the URL where it is asked for", async () => {
    const { base, seen } = await serve(200, JSON.stringify({ balance: "¥9.00" }));
    const result = await readProviderBalance({
      balanceUrl: `${base}/k/{key}/balance`,
      apiKey: "abc",
    });
    expect(result).toEqual({ amount: "¥9.00" });
    expect(seen[0]?.url).toBe("/k/abc/balance");
    expect(seen[0]?.headers.authorization).toBe("Bearer abc");
  });

  it("knows the usual field names when no path is given", async () => {
    const first = await serve(200, JSON.stringify({ data: { total_balance: 3 } }));
    expect(await readProviderBalance({ balanceUrl: `${first.base}/b` })).toEqual({
      amount: "3",
    });
  });

  it("says why when the amount is not there", async () => {
    const { base } = await serve(200, JSON.stringify({ data: { other: 1 } }));
    const result = await readProviderBalance({
      balanceUrl: `${base}/b`,
      balancePath: "data.balance",
    });
    expect(result.amount).toBeNull();
    expect(result.error).toContain("data.balance");
  });

  it("says why when the endpoint refuses", async () => {
    const { base } = await serve(401, "{}");
    const result = await readProviderBalance({ balanceUrl: `${base}/b` });
    expect(result.amount).toBeNull();
    expect(result.error).toContain("401");
  });

  it("refuses anything but an http URL", async () => {
    expect((await readProviderBalance({ balanceUrl: "file:///etc/passwd" })).error).toContain(
      "http",
    );
  });
});

describe("vendor defaults", () => {
  it("reads DeepSeek's currencies, money left first", async () => {
    const { base } = await serve(
      200,
      JSON.stringify({
        balance_infos: [
          { currency: "USD", total_balance: "3.5" },
          { currency: "CNY", total_balance: "110.00" },
        ],
      }),
    );
    expect(await readVendor("api.deepseek.com", base)).toEqual({
      amount: "¥110.00 · $3.50",
    });
  });

  it("reads Moonshot's balance in the currency of the host", async () => {
    const body = JSON.stringify({ code: 0, data: { available_balance: 49.58 } });
    const cn = await serve(200, body);
    expect(await readVendor("api.moonshot.cn", cn.base)).toEqual({ amount: "¥49.58" });
    const ai = await serve(200, body);
    expect(await readVendor("api.moonshot.ai", ai.base)).toEqual({ amount: "$49.58" });
  });

  it("takes OpenRouter's usage out of its credits", async () => {
    const { base } = await serve(
      200,
      JSON.stringify({ data: { total_credits: 20, total_usage: 3.5 } }),
    );
    expect(await readVendor("openrouter.ai", base)).toEqual({ amount: "$16.50" });
  });

  it("reads SiliconFlow's balance, and says when its query is retired", async () => {
    const live = await serve(200, JSON.stringify({ data: { totalBalance: "88.88" } }));
    expect(await readVendor("api.siliconflow.cn", live.base)).toEqual({ amount: "¥88.88" });
    const gone = await serve(410, JSON.stringify({ code: 20092, data: null }));
    const result = await readVendor("api.siliconflow.com", gone.base);
    expect(result.amount).toBeNull();
    expect(result.error).toContain("retired");
  });

  it("reads StepFun's balance", async () => {
    const { base } = await serve(200, JSON.stringify({ balance: 26 }));
    expect(await readVendor("api.stepfun.com", base)).toEqual({ amount: "¥26.00" });
  });

  it("adds Command Code's month, bought and free credits", async () => {
    const body = JSON.stringify({
      credits: { monthlyCredits: 5, purchasedCredits: 2, freeCredits: 1 },
    });
    const { base } = await serve(200, body);
    expect(await readVendor("api.commandcode.ai", base)).toEqual({ amount: "$8.00" });
  });

  it("reads Ollama's bought credits, and nothing when none were bought", async () => {
    const bought = await serve(200, JSON.stringify({ purchased: { balance_usd: 4 } }));
    expect(await readVendor("ollama.com", bought.base)).toEqual({ amount: "$4.00" });
    const included = await serve(200, JSON.stringify({ included: { balance_usd: 4 } }));
    expect((await readVendor("ollama.com", included.base)).amount).toBeNull();
  });

  it("reads AiHubMix's remaining amount, and says a key without a limit has none", async () => {
    const left = await serve(200, JSON.stringify({ object: "list", total_usage: 12.5 }));
    expect(await readVendor("aihubmix.com", left.base)).toEqual({ amount: "$12.50" });
    const unlimited = await serve(200, JSON.stringify({ total_usage: -1 }));
    expect((await readVendor("aihubmix.com", unlimited.base)).amount).toBeNull();
  });

  it("reads Zhipu's and Z.ai's account report", async () => {
    const body = JSON.stringify({ code: 200, data: { availableBalance: 12.3 } });
    const zhipu = await serve(200, body);
    expect(await readVendor("open.bigmodel.cn", zhipu.base)).toEqual({ amount: "¥12.30" });
    const zai = await serve(200, body);
    expect(await readVendor("api.z.ai", zai.base)).toEqual({ amount: "$12.30" });
  });

  it("asks no vendor balance for a GLM Coding Plan's endpoints", async () => {
    const result = await readProviderBalance({
      baseUrls: ["https://open.bigmodel.cn/api/coding/paas/v4"],
      apiKey: "abc",
    });
    expect(result.amount).toBeNull();
    expect(result.error).toBe("No balance URL");
  });

  it("knows no default for a relay", async () => {
    const result = await readProviderBalance({
      baseUrls: ["https://relay.example.com/v1"],
      apiKey: "abc",
    });
    expect(result.error).toBe("No balance URL");
  });
});

describe("a balance endpoint the user names", () => {
  it("is asked with POST and no body when the user says so", async () => {
    const { base, seen } = await serve(200, JSON.stringify({ balance: 1 }));
    const result = await readProviderBalance({
      balanceUrl: `${base}/b`,
      balancePath: "balance",
      apiKey: "abc",
      method: "POST",
    });
    expect(result).toEqual({ amount: "1" });
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe("");
  });

  it("asks an account token in place of the key", async () => {
    const { base, seen } = await serve(200, JSON.stringify({ balance: 1 }));
    await readProviderBalance({
      balanceUrl: `${base}/b`,
      balancePath: "balance",
      apiKey: "abc",
      token: "xyz",
    });
    expect(seen[0]?.headers.authorization).toBe("Bearer xyz");
  });

  it("reads new-api's key query in the units it reports", async () => {
    const { base } = await serve(200, JSON.stringify({ data: { total_available: 2500000 } }));
    const result = await readProviderBalance({
      balanceUrl: `${base}/api/usage/token`,
      apiKey: "abc",
    });
    expect(result).toEqual({ amount: "5" });
  });

  it("keeps the path the user wrote over the panel's default", async () => {
    const { base } = await serve(200, JSON.stringify({ data: { total_available: 2500000 } }));
    const result = await readProviderBalance({
      balanceUrl: `${base}/api/usage/token`,
      balancePath: "data.total_available",
      apiKey: "abc",
    });
    expect(result).toEqual({ amount: "2500000" });
  });
});
