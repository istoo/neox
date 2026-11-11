import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "./config.js";
import type { OidcRule } from "./oidc.js";
import {
  OIDC_DEFAULT_TTL_SECONDS,
  OIDC_GITHUB_ISSUER,
  removeOidcRule,
  saveOidcRule,
} from "./oidc-rules.js";

function config(keys: unknown[]): GatewayConfig {
  return GatewayConfigSchema.parse({ keys });
}

function carrying(base: GatewayConfig, rules: OidcRule[]): GatewayConfig {
  return GatewayConfigSchema.parse({ ...base, oidc: { rules } });
}

const issuing = config([{ key: "sk-ci", label: "ci", issues: true }]);

describe("OIDC rules", () => {
  it("defaults to GitHub, the rule's own audience, and an hour", () => {
    const { rule, rules } = saveOidcRule(issuing, {
      key: "ci",
      claims: { repository: "owner/name" },
    });
    expect(rule.id).toMatch(/^[0-9a-f]{12}$/);
    expect(rule.issuer).toBe(OIDC_GITHUB_ISSUER);
    expect(rule.audience).toBe(`neolix-${rule.id}`);
    expect(rule.ttlSeconds).toBe(OIDC_DEFAULT_TTL_SECONDS);
    expect(rules).toHaveLength(1);
  });

  it("refuses an issuer that is not an https URL without query or fragment", () => {
    const claims = { repository: "owner/name" };
    for (const issuer of [
      "http://token.example",
      "https://token.example?x=1",
      "https://token.example#frag",
      "not a url",
    ]) {
      expect(() => saveOidcRule(issuing, { key: "ci", issuer, claims })).toThrow(/issuer/);
    }
  });

  it("refuses a rule with no claim, and a GitHub rule with no repository", () => {
    expect(() => saveOidcRule(issuing, { key: "ci", claims: {} })).toThrow(/claim/);
    expect(() => saveOidcRule(issuing, { key: "ci", claims: { ref: "refs/heads/main" } })).toThrow(
      /repository/,
    );
    expect(() => saveOidcRule(issuing, { key: "ci", claims: { repository: "owner/*" } })).toThrow(
      /wildcard/,
    );
  });

  it("refuses a key that is missing, plain, or not allowed to issue", () => {
    expect(() => saveOidcRule(issuing, { key: "nope", claims: { repository: "o/n" } })).toThrow(
      /no gateway key/,
    );
    expect(() =>
      saveOidcRule(config(["sk-ci"]), { key: "sk-ci", claims: { repository: "o/n" } }),
    ).toThrow(/can't issue/);
    expect(() =>
      saveOidcRule(config([{ key: "sk-ci", issues: false }]), {
        key: "sk-ci",
        claims: { repository: "o/n" },
      }),
    ).toThrow(/can't issue/);
    expect(() =>
      saveOidcRule(config([{ key: "sk-ci", issues: true, issuer: "sk-root" }]), {
        key: "sk-ci",
        claims: { repository: "o/n" },
      }),
    ).toThrow(/can't issue/);
  });

  it("bounds the lifetime from a minute to thirty days", () => {
    const claims = { repository: "owner/name" };
    expect(() => saveOidcRule(issuing, { key: "ci", claims, ttlSeconds: 30 })).toThrow(/minute/);
    expect(() => saveOidcRule(issuing, { key: "ci", claims, ttlSeconds: 31 * 24 * 3600 })).toThrow(
      /30 days/,
    );
  });

  it("changes a rule by id, keeping its audience unless one is given", () => {
    const first = saveOidcRule(issuing, {
      key: "ci",
      claims: { repository: "owner/name" },
      audience: "builds",
    });
    const carryingFirst = carrying(issuing, first.rules);
    const changed = saveOidcRule(carryingFirst, {
      id: first.rule.id,
      key: "ci",
      claims: { repository: "owner/other" },
    });
    expect(changed.rule.id).toBe(first.rule.id);
    expect(changed.rule.audience).toBe("builds");
    expect(changed.rule.claims).toEqual({ repository: "owner/other" });
    expect(changed.rules).toHaveLength(1);
    expect(() => saveOidcRule(issuing, { id: "missing", key: "ci", claims: {} })).toThrow();
  });

  it("removes by id and refuses one that is not there", () => {
    const { rule, rules } = saveOidcRule(issuing, { key: "ci", claims: { repository: "o/n" } });
    const withRule = carrying(issuing, rules);
    expect(removeOidcRule(withRule, rule.id).rules).toEqual([]);
    expect(() => removeOidcRule(carrying(issuing, []), rule.id)).toThrow(/no rule/);
  });
});
