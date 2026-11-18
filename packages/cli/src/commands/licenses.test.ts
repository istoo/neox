import { THIRD_PARTY_NOTICES } from "@neolix/protocol/generated/third-party-notices";
import { describe, expect, it, vi } from "vitest";
import { createLicensesCommand } from "./licenses.js";

describe("neox licenses", () => {
  it("prints the generated notices, including the desktop-web frontend dependencies", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await createLicensesCommand().parseAsync([], { from: "user" });
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    write.mockRestore();
    expect(output).toBe(
      THIRD_PARTY_NOTICES.endsWith("\n") ? THIRD_PARTY_NOTICES : `${THIRD_PARTY_NOTICES}\n`,
    );
    expect(output).toMatch(/^mermaid \d/m);
    expect(output).toMatch(/^monaco-editor \d/m);
  });
});
