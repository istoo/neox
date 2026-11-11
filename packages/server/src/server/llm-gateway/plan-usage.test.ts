import { describe, expect, it } from "vitest";
import type { GatewayProvider } from "./config.js";
import { planLookupOf, readPlanUsage, tc3Sign, volcSign } from "./plan-usage.js";

function provider(overrides: Partial<GatewayProvider> = {}): GatewayProvider {
  return {
    id: "p",
    protocol: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    accounts: [],
    models: [],
    maxAccounts: undefined,
    queueWaitMs: 0,
    sink: false,
    priceRate: 1,
    ...overrides,
  };
}

describe("the plan a provider is on", () => {
  it("is Ark's Coding Plan or Agent Plan, in the host's region", () => {
    expect(planLookupOf(provider({ accessKeyId: "ak", secretAccessKey: "sk" }))).toEqual({
      kind: "read",
      source: {
        vendor: "volcengine",
        plan: "Coding Plan",
        region: "cn-beijing",
        action: "GetCodingPlanUsage",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      },
    });
    const agent = planLookupOf(
      provider({
        baseUrl: "https://ark.cn-shanghai.volces.com/api/plan/v3",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      }),
    );
    expect(agent).toMatchObject({
      kind: "read",
      source: { action: "GetAFPUsage", region: "cn-shanghai" },
    });
  });

  it("is not on pay as you go, another vendor or another path", () => {
    expect(
      planLookupOf(provider({ baseUrl: "https://ark.cn-beijing.volces.com/api/v3" })),
    ).toBeNull();
    expect(
      planLookupOf(provider({ baseUrl: "https://relay.example.com/api/coding/v3" })),
    ).toBeNull();
  });

  it("is TokenHub's Token Plan on its /plan endpoints", () => {
    expect(
      planLookupOf(
        provider({
          baseUrl: "https://tokenhub.tencentmaas.com/plan/v3",
          accessKeyId: "id",
          secretAccessKey: "key",
        }),
      ),
    ).toMatchObject({ kind: "read", source: { vendor: "tencent", region: "ap-guangzhou" } });
    expect(
      planLookupOf(provider({ baseUrl: "https://TokenHub-Intl.tencentmaas.com/plan/v3/" })),
    ).toEqual({
      kind: "no-key",
      vendor: "tencent",
      plan: "Token Plan Enterprise",
      region: "ap-singapore",
      action: null,
    });
    expect(planLookupOf(provider({ baseUrl: "https://tokenhub.tencentmaas.com/v1" }))).toBeNull();
  });

  it("asks for the access key when the plan endpoint has none", () => {
    expect(planLookupOf(provider())).toEqual({
      kind: "no-key",
      vendor: "volcengine",
      plan: "Coding Plan",
      region: "cn-beijing",
      action: "GetCodingPlanUsage",
    });
  });
});

describe("the control plane's signatures", () => {
  it("signs Ark's request as volc-sdk-golang does", () => {
    const now = Date.parse("2026-10-09T08:30:15Z");
    const cases = [
      {
        region: "cn-beijing",
        action: "GetCodingPlanUsage",
        signature: "deb80c0cd8bd77768ca40f6d47c7204621c0994428f6ab77e23b76e15dc4c047",
      },
      {
        region: "cn-shanghai",
        action: "GetAFPUsage",
        signature: "8a241be0996c93de4dfcd9e8b1db37494bf63170804fcaebe8380ff7dca2bb23",
      },
    ];
    for (const item of cases) {
      const signed = volcSign(
        "AKLTexample",
        "c2VjcmV0LWV4YW1wbGU=",
        item.region,
        new URLSearchParams({ Action: item.action, Version: "2024-01-01" }),
        "{}",
        now,
      );
      expect(signed.authorization).toContain(
        `Credential=AKLTexample/20261009/${item.region}/ark/request`,
      );
      expect(signed.authorization).toContain(
        "SignedHeaders=content-type;host;x-content-sha256;x-date",
      );
      expect(signed.authorization.endsWith(`Signature=${item.signature}`)).toBe(true);
      expect(signed.xDate).toBe("20261009T083015Z");
      expect(signed.contentSha).toBe(
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      );
    }
  });

  it("signs Tencent's request as its signing doc does", () => {
    const id = `AKID${"*".repeat(32)}`;
    const key = "*".repeat(32);
    const payload = `{"Limit": 1, "Filters": [{"Values": ["\\u672a\\u547d\\u540d"], "Name": "instance-name"}]}`;
    expect(
      tc3Sign(
        id,
        key,
        "cvm",
        "cvm.tencentcloudapi.com",
        "DescribeInstances",
        payload,
        1551113065000,
      ),
    ).toBe(
      `TC3-HMAC-SHA256 Credential=${id}/2019-02-25/cvm/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=10b1a37a7301a02ca19a647ad722d5e43b4b3cff309d421d85b46093f6ab6c4f`,
    );
  });
});

describe("reading a plan", () => {
  it("reads Ark's Coding Plan windows", async () => {
    const now = 1_760_000_000_000;
    const reading = await readPlanUsage(
      {
        vendor: "volcengine",
        plan: "Coding Plan",
        region: "cn-beijing",
        action: "GetCodingPlanUsage",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      },
      {
        now,
        fetch: async () =>
          new Response(
            JSON.stringify({
              ResponseMetadata: {},
              Result: {
                QuotaUsage: [
                  { Level: "session", Percent: 10.5, ResetTimestamp: 1_758_100_000 },
                  { Level: "weekly", Percent: 41, ResetTimestamp: 1_758_200_000 },
                  { Level: "monthly", Percent: 62, ResetTimestamp: 1_758_300_000 },
                ],
              },
            }),
          ),
      },
    );

    const card = reading.cards[0]!;
    expect(reading.cards).toHaveLength(1);
    expect(card.error).toBeUndefined();
    expect(card.id).toBe("coding");
    expect(card.plan).toBe("Coding Plan");
    expect(card.windows.map((window) => window.id)).toEqual([
      "plan-session",
      "plan-weekly",
      "plan-month",
    ]);
    expect(card.windows[0]).toMatchObject({ usedPercent: 10.5, windowMs: 5 * 3_600_000 });
    expect(card.windows[0]?.resetsAt).toBe(1_758_100_000_000);
  });

  it("reads Ark's Agent Plan windows told as used of quota, with its tier", async () => {
    const reading = await readPlanUsage(
      {
        vendor: "volcengine",
        plan: "Agent Plan",
        region: "cn-shanghai",
        action: "GetAFPUsage",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      },
      {
        now: 1_760_000_000_000,
        fetch: async () =>
          new Response(
            JSON.stringify({
              Result: {
                Tier: "Pro",
                AFPFiveHour: { Used: 25, Quota: 100, ResetTime: "2026-11-06T10:00:00Z" },
                AFPWeekly: { Percent: "30", ResetTimestamp: 1_758_000_000_000 },
                AFPMonthly: { Used: 0, Total: 0 },
              },
            }),
          ),
      },
    );

    const card = reading.cards[0]!;
    expect(card.id).toBe("afp");
    expect(card.plan).toBe("Agent Plan Pro");
    expect(card.windows.map((window) => window.id)).toEqual(["plan-session", "plan-weekly"]);
    expect(card.windows[0]).toMatchObject({
      usedPercent: 25,
      remaining: 75,
      limit: 100,
    });
    expect(card.windows[1]?.usedPercent).toBe(30);
  });

  it("reads Tencent's Token Plan cycle, in credits, one card per team", async () => {
    const calls: string[] = [];
    const reading = await readPlanUsage(
      {
        vendor: "tencent",
        plan: "Token Plan Enterprise",
        region: "ap-guangzhou",
        action: null,
        accessKeyId: "id",
        secretAccessKey: "key",
      },
      {
        now: Date.parse("2026-11-06T00:00:00Z"),
        fetch: async (_url, init) => {
          const action = new Headers(init?.headers).get("X-TC-Action") ?? "";
          calls.push(action);
          if (action === "DescribeTokenPlanList") {
            return new Response(
              JSON.stringify({
                Response: {
                  TokenPlanSet: [
                    {
                      TeamId: "t1",
                      Name: "Team One",
                      Status: "enable",
                      ProductType: "enterprise",
                      PackageInfo: { CycleQuota: 1000, TotalUsed: 250 },
                    },
                  ],
                },
              }),
            );
          }
          return new Response(
            JSON.stringify({
              Response: {
                TokenSummary: {
                  CycleStartTime: "2026-10-06T00:00:00Z",
                  CycleEndTime: "2026-11-06T00:00:00Z",
                },
              },
            }),
          );
        },
      },
    );

    expect(calls).toEqual(["DescribeTokenPlanList", "DescribeTokenPlan"]);
    const card = reading.cards[0]!;
    expect(reading.cards).toHaveLength(1);
    expect(card.id).toBe("t1");
    expect(card.plan).toBe("Token Plan Enterprise");
    expect(card.user).toBeUndefined();
    expect(card.error).toBeUndefined();
    expect(card.windows).toHaveLength(1);
    expect(card.windows[0]).toMatchObject({
      id: "plan-month-credits",
      usedPercent: 25,
      remaining: 750,
      limit: 1000,
    });
    expect(card.windows[0]?.resetsAt).toBe(Date.parse("2026-11-06T00:00:00Z"));
    expect(card.windows[0]?.windowMs).toBe(31 * 24 * 3_600_000);
  });

  it("gives a multi-team Token Plan one card per team, as myna does", async () => {
    const reading = await readPlanUsage(
      {
        vendor: "tencent",
        plan: "Token Plan Enterprise",
        region: "ap-singapore",
        action: null,
        accessKeyId: "id",
        secretAccessKey: "key",
      },
      {
        now: Date.parse("2026-11-06T00:00:00Z"),
        fetch: async (_url, init) => {
          const action = new Headers(init?.headers).get("X-TC-Action") ?? "";
          if (action === "DescribeTokenPlanList") {
            return new Response(
              JSON.stringify({
                Response: {
                  TokenPlanSet: [
                    {
                      TeamId: "t1",
                      Name: "Team One",
                      Status: "enable",
                      ProductType: "enterprise",
                      PackageInfo: { CycleQuota: 1000, TotalUsed: 250 },
                    },
                    {
                      TeamId: "t2",
                      Name: "Team Two",
                      Status: "frozen",
                      ProductType: "enterprise-auto",
                      PackageInfo: { CycleQuota: 500, TotalUsed: 100 },
                    },
                  ],
                },
              }),
            );
          }
          return new Response(
            JSON.stringify({
              Response: {
                TokenSummary: {
                  CycleStartTime: "2026-10-06T00:00:00Z",
                  CycleEndTime: "2026-11-06T00:00:00Z",
                },
              },
            }),
          );
        },
      },
    );

    expect(
      reading.cards.map((card) => ({ id: card.id, plan: card.plan, user: card.user })),
    ).toEqual([
      { id: "t1", plan: "Token Plan Enterprise", user: "Team One" },
      { id: "t2", plan: "Token Plan Enterprise · frozen", user: "Team Two" },
    ]);
    expect(reading.cards[1]?.windows[0]).toMatchObject({
      id: "plan-month-tokens",
      usedPercent: 20,
      limit: 500,
    });
  });

  it("says what Ark answered when the key is refused", async () => {
    const reading = await readPlanUsage(
      {
        vendor: "volcengine",
        plan: "Coding Plan",
        region: "cn-beijing",
        action: "GetCodingPlanUsage",
        accessKeyId: "ak",
        secretAccessKey: "sk",
      },
      {
        fetch: async () =>
          new Response(
            JSON.stringify({
              ResponseMetadata: {
                Error: { Code: "InvalidAccessKey", Message: "the key is not known" },
              },
            }),
          ),
      },
    );

    expect(reading.cards[0]?.windows).toEqual([]);
    const error = reading.cards[0]?.error ?? "";
    expect(error).toContain("InvalidAccessKey");
    expect(error).toContain("AccessKey ID");
  });
});
