import { describe, expect, it } from "vitest";

import type { GatewayConfig } from "~/lib/gatewayTypes";
import type { Translator } from "~/lib/errorLocalization";

import {
  describeGatewayDraftIssue,
  invalidWarmAts,
  isProxyAddress,
  isWarmAt,
  localizeGatewaySaveError,
  validateGatewayDraft,
} from "./gatewayDraftValidation";

const t: Translator = (key, values) =>
  values === undefined ? key : `${key}|${JSON.stringify(values)}`;

function config(patch: Partial<GatewayConfig>): GatewayConfig {
  return { version: 1, ...patch };
}

function zodDump(path: Array<string | number>, code: string): string {
  return `Invalid gateway config: ${JSON.stringify([{ path, code }])}`;
}

describe("gatewayDraftValidation", () => {
  it("accepts the proxy forms the daemon accepts", () => {
    expect(isProxyAddress("direct")).toBe(true);
    expect(isProxyAddress("http://127.0.0.1:7890")).toBe(true);
    expect(isProxyAddress("127.0.0.1:7890")).toBe(true);
    expect(isProxyAddress("socks5h://127.0.0.1:1080")).toBe(true);
    expect(isProxyAddress("ftp://127.0.0.1")).toBe(false);
    expect(isProxyAddress("not a proxy")).toBe(false);
  });

  it("accepts only HH:MM warm-up times", () => {
    expect(isWarmAt("06:00")).toBe(true);
    expect(isWarmAt("23:59")).toBe(true);
    expect(isWarmAt("99:99")).toBe(false);
    expect(isWarmAt("6:00")).toBe(false);
    expect(invalidWarmAts("06:00, 99:99, 18:30")).toEqual(["99:99"]);
  });

  it("finds the rows that would fail the daemon schema", () => {
    const issues = validateGatewayDraft(
      config({
        groups: [{ id: "fast", members: [] }],
        masking: { enabled: false, rules: [{ kind: " ", pattern: "" }] },
        budget: { monthlyUsd: 0 },
        proxy: "ftp://127.0.0.1",
      }),
    );
    expect(issues).toEqual([
      { kind: "group-members", groupId: "fast", index: 0 },
      { kind: "mask-kind", line: 1 },
      { kind: "budget" },
      { kind: "proxy" },
    ]);
    expect(issues.map((issue) => describeGatewayDraftIssue(issue, t))).toEqual([
      'gateway:error_group_members|{"id":"fast"}',
      'gateway:error_mask_kind|{"line":1}',
      "gateway:error_budget",
      "gateway:error_proxy",
    ]);
  });

  it("rejects a group id the daemon cannot store before saving", () => {
    const issues = validateGatewayDraft(
      config({ groups: [{ id: "QA-group", members: ["source/model"] }] }),
    );
    expect(issues).toEqual([{ kind: "group-invalid", groupId: "QA-group", index: 0 }]);
    expect(issues.map((issue) => describeGatewayDraftIssue(issue, t))).toEqual([
      'gateway:error_group_invalid|{"id":"QA-group"}',
    ]);
  });

  it("localizes Zod's save dump without showing it raw", () => {
    expect(
      localizeGatewaySaveError(
        new Error(zodDump(["groups", 0, "members"], "too_small")),
        config({
          groups: [{ id: "fast", members: [] }],
        }),
        t,
      ),
    ).toBe('gateway:error_group_members|{"id":"fast"}');
    expect(
      localizeGatewaySaveError(
        new Error(zodDump(["masking", "rules", 2, "kind"], "too_small")),
        undefined,
        t,
      ),
    ).toBe('gateway:error_mask_kind|{"line":3}');
    expect(
      localizeGatewaySaveError(
        new Error(zodDump(["budget", "monthlyUsd"], "too_small")),
        undefined,
        t,
      ),
    ).toBe("gateway:error_budget");
    expect(
      localizeGatewaySaveError(
        new Error(zodDump(["otel", "endpoint"], "invalid_format")),
        undefined,
        t,
      ),
    ).toBe("gateway:error_otel_endpoint");
    expect(
      localizeGatewaySaveError(new Error("Invalid gateway config: not json"), undefined, t),
    ).toBe("Invalid gateway config: not json");
  });
});
