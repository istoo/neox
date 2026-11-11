import { describe, expect, it } from "vitest";
import { writeSystemCredential } from "./credential.js";

const URL = "http://127.0.0.1:6768/v1";
const KEY = "test-gateway-key";

interface Call {
  command: string;
  args: string[];
  input?: string;
}

function recorder(): {
  calls: Call[];
  run: (c: string, a: string[], i?: string) => Promise<string>;
} {
  const calls: Call[] = [];
  return {
    calls,
    run: async (command, args, input) => {
      const call: Call = { command, args };
      if (input !== undefined) call.input = input;
      calls.push(call);
      return "";
    },
  };
}

describe("writeSystemCredential", () => {
  it("writes an Internet Password on macOS", async () => {
    const { calls, run } = recorder();
    await writeSystemCredential(URL, KEY, "darwin", run);
    expect(calls).toEqual([
      {
        command: "security",
        args: ["add-internet-password", "-U", "-s", URL, "-a", "Bearer", "-w", KEY],
      },
    ]);
  });

  it("writes a Secret Service item on Linux, with the key on stdin", async () => {
    const { calls, run } = recorder();
    await writeSystemCredential(URL, KEY, "linux", run);
    expect(calls).toEqual([
      {
        command: "secret-tool",
        args: ["store", "--label=zed-github-account", "url", URL, "username", "Bearer"],
        input: KEY,
      },
    ]);
  });

  it("writes a generic credential on Windows, with the key on stdin", async () => {
    const { calls, run } = recorder();
    await writeSystemCredential(URL, KEY, "win32", run);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("powershell");
    expect(calls[0]?.args).toContain(`zed:url=${URL}`);
    expect(calls[0]?.args.join("\n")).toContain("CredWriteW");
    expect(calls[0]?.input).toBe(KEY);
  });

  it("says so on a platform it cannot write", async () => {
    const { run } = recorder();
    await expect(writeSystemCredential(URL, KEY, "freebsd", run)).rejects.toThrow("not supported");
  });
});
