import { describe, expect, it } from "vitest";
import {
  GatewaySubscriptionAddRequestSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages";

describe("Factory subscription add protocol", () => {
  it("parses a key add request and the account it answers with", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "gateway.subscription.add.request",
        requestId: "request-1",
        agent: "factory",
        key: "fk-abcdefgh12345678",
      }).success,
    ).toBe(true);
    expect(
      GatewaySubscriptionAddRequestSchema.parse({
        type: "gateway.subscription.add.request",
        requestId: "request-2",
        agent: "factory",
        key: "fk-abcdefgh12345678",
      }).agent,
    ).toBe("factory");
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "gateway.subscription.add.response",
        payload: {
          requestId: "request-3",
          ok: true,
          account: {
            id: "factory:one",
            agent: "factory",
            user: "one@example.test",
            plan: null,
            region: "eu",
            orgId: "org-1",
            lapsed: null,
            addedAt: 1,
          },
        },
      }).success,
    ).toBe(true);
  });

  it("parses making a saved account first", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "gateway.subscription.switch.request",
        requestId: "request-5",
        agent: "gemini",
        user: "one@example.test",
      }).success,
    ).toBe(true);
    expect(
      SessionOutboundMessageSchema.safeParse({
        type: "gateway.subscription.switch.response",
        payload: { requestId: "request-6", ok: true },
      }).success,
    ).toBe(true);
  });

  it("keeps a refusal's error, with no account", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "gateway.subscription.add.response",
      payload: { requestId: "request-4", ok: false, error: "Factory did not take this key" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.payload).toMatchObject({ ok: false });
  });
});
