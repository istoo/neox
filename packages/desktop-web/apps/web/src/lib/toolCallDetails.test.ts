import { describe, expect, it } from "vitest";

import { deriveToolFailureSummary, deriveWorkLogToolDetails } from "./toolCallDetails";

describe("deriveToolFailureSummary", () => {
  it("reads Claude's leading exit code and skips it for the excerpt", () => {
    expect(
      deriveToolFailureSummary({
        kind: "command",
        title: "Command run",
        output: {
          output:
            "Exit code 2\nugrep: warning: missing.txt: No such file or directory\n1:def add(a, b):",
        },
      }),
    ).toEqual({
      exitCode: 2,
      excerpt: "ugrep: warning: missing.txt: No such file or directory",
    });
  });

  it("prefers a structured exit code and stderr", () => {
    expect(
      deriveToolFailureSummary({
        kind: "command",
        title: "Command run",
        output: { stdout: "partial", stderr: "\nzsh: command not found: rg\n", exitCode: 127 },
      }),
    ).toEqual({ exitCode: 127, excerpt: "zsh: command not found: rg" });
  });

  it("reports nothing when the call carried no output", () => {
    expect(deriveToolFailureSummary(undefined)).toEqual({ exitCode: null, excerpt: null });
  });
});

describe("Neox bridge tool data", () => {
  it("expands an edit into its diff and the replaced text", () => {
    const details = deriveWorkLogToolDetails({
      label: "Edit",
      itemType: "file_change",
      changedFiles: ["a.ts"],
      payload: {
        data: {
          input: { file_path: "a.ts", old_string: "x", new_string: "y" },
          unifiedDiff: "-x\n+y",
        },
      },
    });
    expect(details).toMatchObject({
      kind: "file-change",
      diff: "-x\n+y",
      edits: [{ path: "a.ts", oldText: "x", newText: "y" }],
    });
  });

  it("splits a shell call into its command, output and exit code", () => {
    const details = deriveWorkLogToolDetails({
      label: "Bash",
      itemType: "command_execution",
      command: "ls",
      payload: { data: { input: { command: "ls" }, rawOutput: { output: "a\n", exitCode: 1 } } },
    });
    expect(details).toMatchObject({ kind: "command", output: { output: "a\n", exitCode: 1 } });
  });
});

describe("tool output exit-code suffixes", () => {
  it("preserves a large whitespace run inside raw output", () => {
    const stdout = `start${" ".repeat(23_980)}end`;
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output).toEqual({ stdout });
  });

  it.each([
    ["  output\n", "  output\n", undefined],
    ["  output\n <exited with exit code 2>\n", "  output", 2],
    ["\toutput\r\n<EXITED WITH EXIT CODE 000>\t", "\toutput", 0],
    ["<exited with exit code 1>", undefined, 1],
    ["<exited with exit code -1>", "<exited with exit code -1>", undefined],
    ["<exited with exit code 1> later", "<exited with exit code 1> later", undefined],
    ["<exited with exit code 1>\n<exited with exit code 2>", "<exited with exit code 1>", 2],
    ["\n\t", undefined, undefined],
  ])("preserves raw stdout and parses only the final suffix: %j", (stdout, output, exitCode) => {
    const details = deriveWorkLogToolDetails({
      label: "Command",
      command: "run",
      detail: stdout,
      payload: { data: { rawOutput: { stdout } } },
    });
    expect(details?.output?.stdout).toBe(output);
    expect(details?.output?.exitCode).toBe(exitCode);
  });
});
