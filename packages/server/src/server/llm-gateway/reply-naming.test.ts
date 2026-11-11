import {
  namedModelResponse,
  replyNameFor,
  replyNamingOf,
  ReplyNamingTidy,
} from "./reply-naming.js";

describe("what a reply's model says", () => {
  it("reads the setting, with memberModel beside it", () => {
    expect(replyNamingOf({})).toBe("asked");
    expect(replyNamingOf({ memberModel: true })).toBe("member");
    expect(replyNamingOf({ replyModel: "vendor", memberModel: true })).toBe("vendor");
  });

  it("names the asked model when the request went out under another", () => {
    expect(
      replyNameFor({ naming: "asked", asked: "fast", wire: "model-a", providerId: "local" }),
    ).toBe("fast");
    expect(
      replyNameFor({ naming: "asked", asked: "model-a", wire: "model-a", providerId: "local" }),
    ).toBeNull();
    expect(
      replyNameFor({ naming: "member", asked: "fast", wire: "model-a", providerId: "local" }),
    ).toBe("local/model-a");
    expect(
      replyNameFor({ naming: "vendor", asked: "fast", wire: "model-a", providerId: "local" }),
    ).toBeNull();
  });

  it("rewrites each protocol's own model path", () => {
    expect(namedModelResponse({ model: "m" }, "asked", "openai")).toEqual({ model: "asked" });
    expect(
      namedModelResponse(
        { model: "m", response: { model: "m", id: "r" } },
        "asked",
        "openai-responses",
      ),
    ).toEqual({ model: "asked", response: { model: "asked", id: "r" } });
    expect(
      namedModelResponse({ model: "m", message: { model: "m", id: "r" } }, "asked", "anthropic"),
    ).toEqual({ model: "asked", message: { model: "asked", id: "r" } });
    expect(namedModelResponse({ modelVersion: "m" }, "asked", "gemini")).toEqual({
      modelVersion: "asked",
    });
  });

  it("leaves a reply with the vendor's text alone", () => {
    const body = { model: "deepseek-v4.1-flash-1017" };
    expect(namedModelResponse(body, null, "openai")).toBe(body);
    expect(namedModelResponse({ model: "same" }, "same", "openai")).toEqual({ model: "same" });
  });

  it("rewrites a relayed stream's events", () => {
    const tidy = new ReplyNamingTidy("local/model-a", "openai");
    const line = 'data: {"id":"c1","model":"model-a","choices":[]}';
    expect(tidy.write(`${line}\n\n`)).toBe(
      'data: {"id":"c1","model":"local/model-a","choices":[]}\n\n',
    );
    expect(tidy.write('data: {"choices":[]}\n\n')).toBe('data: {"choices":[]}\n\n');
  });
});
import { describe, expect, it } from "vitest";
import { replyNamingFor, requestResponseModel } from "./reply-naming.js";

describe("requestResponseModel", () => {
  it("reads the neolix and magpie forms of the request header", () => {
    expect(requestResponseModel({ "x-neolix-response-model": "member" })).toBe("member");
    expect(requestResponseModel({ "x-magpie-response-model": "Vendor" })).toBe("vendor");
    expect(requestResponseModel({ "x-neolix-response-model": "  ASKED " })).toBe("asked");
  });

  it("ignores unknown values, arrays, and absent headers", () => {
    expect(requestResponseModel({ "x-neolix-response-model": "nonsense" })).toBeUndefined();
    expect(requestResponseModel({ "x-neolix-response-model": ["member"] })).toBeUndefined();
    expect(requestResponseModel({})).toBeUndefined();
  });
});

describe("replyNamingFor", () => {
  it("a request's own ask wins over the setting, for every agent (myna member.go:76)", () => {
    expect(replyNamingFor({ requestHeader: "vendor", config: { replyModel: "member" } })).toBe(
      "vendor",
    );
    expect(replyNamingFor({ requestHeader: "member", config: { replyModel: "vendor" } })).toBe(
      "member",
    );
  });

  it("falls back to the setting's pick, then to asked", () => {
    expect(replyNamingFor({ requestHeader: undefined, config: { replyModel: "member" } })).toBe(
      "member",
    );
    expect(replyNamingFor({ requestHeader: "nonsense", config: { memberModel: true } })).toBe(
      "member",
    );
    expect(replyNamingFor({ requestHeader: undefined, config: {} })).toBe("asked");
  });
});
