import { describe, expect, it } from "vitest";
import { redactDiagnostic } from "./diagnostics.js";

describe("redactDiagnostic", () => {
  it("hides app deep links, which can carry pairing data", () => {
    const redacted = redactDiagnostic(
      "opened neolix://app/pair#offer=eyJzZWNyZXQiOiJ4In0 from the CLI",
    );
    expect(redacted).toBe("opened neolix://[redacted] from the CLI");
  });
});
