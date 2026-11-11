import { WsRpcError } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { errorCodeOf, localizeRpcError, translateErrorMessage } from "./errors";
import { setLanguagePreference } from "./index";

afterEach(() => {
  setLanguagePreference("system");
});

describe("bridge error translation", () => {
  it("translates a labeled failure and its interpolation values", () => {
    setLanguagePreference("zh-CN");
    expect(
      translateErrorMessage({
        message: "Uncommitted changes block checkout to main.",
        code: "neolix.error.git.checkout-blocked-by-changes",
        params: { branch: "main", files: "a.ts" },
      }),
    ).toBe("未提交的更改阻止切换到 main。");
  });

  it("falls back to the message when this build has no key for the code", () => {
    setLanguagePreference("zh-CN");
    expect(translateErrorMessage({ message: "daemon down", code: "neolix.error.unmapped" })).toBe(
      "daemon down",
    );
  });

  it("leaves uncoded failures alone", () => {
    expect(translateErrorMessage(new Error("Socket closed"))).toBe("Socket closed");
  });

  it("localizes a WsRpcError in place and keeps its code", () => {
    setLanguagePreference("zh-CN");
    const error = new WsRpcError({
      message: "That saved host no longer exists.",
      code: "neolix.error.host.saved-missing",
    });
    const localized = localizeRpcError(error);
    expect(localized.message).toBe("该已保存主机已不存在。");
    expect(errorCodeOf(localized)).toBe("neolix.error.host.saved-missing");
    expect(localized).toBeInstanceOf(WsRpcError);
  });

  it("translates the shared not-supported code", () => {
    setLanguagePreference("zh-CN");
    expect(
      translateErrorMessage({
        message: "Neox does not support pullRequests.setPinned yet.",
        code: "neolix.not-supported",
        params: { method: "pullRequests.setPinned" },
      }),
    ).toBe("当前 Neox 版本尚不支持此操作。");
  });
});
