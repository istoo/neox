import { describe, expect, it } from "vitest";

import {
  imageExtension,
  prepareDroppedPathsForTerminal,
  prepareTerminalPath,
  toShellSafeFileName,
} from "./terminalFileDrop";

describe("terminalFileDrop", () => {
  it("quotes POSIX paths and strips shell-dangerous characters", () => {
    expect(prepareTerminalPath("/tmp/plain.txt")).toBe("'/tmp/plain.txt'");
    expect(prepareTerminalPath("/tmp/My File.txt")).toBe("'/tmp/My File.txt'");
    expect(prepareTerminalPath("/tmp/$(whoami).txt")).toBe("'/tmp/(whoami).txt'");
    expect(prepareTerminalPath("/tmp/it's.txt")).toBe("'/tmp/it\\'s.txt'");
    expect(prepareDroppedPathsForTerminal(["/repo/a", "/repo/b"])).toBe("'/repo/a' '/repo/b'");
  });

  it("only quotes Windows paths that contain a space", () => {
    expect(prepareTerminalPath("C:\\repo\\a.txt")).toBe("C:\\repo\\a.txt");
    expect(prepareTerminalPath("C:\\repo\\a b.txt")).toBe('"C:\\repo\\a b.txt"');
  });

  it("keeps uploaded file names shell-safe and names clipboard images", () => {
    expect(toShellSafeFileName("my shot (1).png")).toBe("my_shot__1_.png");
    expect(imageExtension("image/jpeg")).toBe("jpg");
    expect(imageExtension("image/png")).toBe("png");
    expect(imageExtension("image/svg+xml")).toBe("svg");
  });
});
