import { describe, expect, it } from "vitest";
import {
  WorkspaceAutomationBlockedError,
  assertWorkspaceAutomationAllowed,
  formatWorkspaceAutomationBlockedMessage,
} from "./workspace-automation-gate.js";

describe("workspace automation gate", () => {
  it("refuses executable repository automation for a cross-repository change request", () => {
    expect(() =>
      assertWorkspaceAutomationAllowed({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/neolix",
      }),
    ).toThrowError(
      new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/neolix",
      }),
    );
  });

  it("allows executable repository automation for ordinary workspaces", () => {
    expect(() => assertWorkspaceAutomationAllowed(undefined)).not.toThrow();
  });

  it.each([
    ["github", "PR"],
    ["gitea", "PR"],
    ["forgejo", "PR"],
    ["gitlab", "MR"],
  ])("uses the %s change request noun", (forge, noun) => {
    expect(
      formatWorkspaceAutomationBlockedMessage({
        kind: "change_request",
        forge,
        number: 42,
        headRepository: "contributor/neolix",
      }),
    ).toBe(`Scripts are blocked for ${noun} #42 from contributor/neolix. Run setup to allow them.`);
  });
});
