import { runProcess } from "./process-run.js";

export type CredentialRunner = (command: string, args: string[], input?: string) => Promise<string>;

const WINDOWS_SCRIPT = [
  "$key = [Console]::In.ReadToEnd()",
  'Add-Type @"',
  "using System;",
  "using System.Runtime.InteropServices;",
  "public class NeolixCred {",
  "  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
  "  public struct CREDENTIALW {",
  "    public uint Flags; public uint Type; public string TargetName; public string Comment;",
  "    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;",
  "    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;",
  "    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;",
  "  }",
  '  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
  "  public static extern bool CredWriteW(ref CREDENTIALW credential, uint flags);",
  "}",
  '"@',
  "$bytes = [Text.Encoding]::UTF8.GetBytes($key.TrimEnd())",
  "$blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)",
  "[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)",
  "$c = New-Object NeolixCred+CREDENTIALW",
  "$c.Type = 1",
  "$c.TargetName = $args[0]",
  "$c.UserName = 'Bearer'",
  "$c.CredentialBlobSize = $bytes.Length",
  "$c.CredentialBlob = $blob",
  "$c.Persist = 2",
  "if (-not [NeolixCred]::CredWriteW([ref]$c, 0)) { exit 1 }",
].join("\n");

/**
 * Stores a gateway key where an app reads it from the OS credential store:
 * macOS's Internet Password, Linux's Secret Service and Windows' generic
 * credential, as myna does. Zed reads the key by the API URL.
 */
export async function writeSystemCredential(
  url: string,
  key: string,
  platform: NodeJS.Platform = process.platform,
  run: CredentialRunner = runProcess,
): Promise<void> {
  const fail = (cause: unknown): never => {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`credential store: ${message}`, { cause });
  };
  try {
    if (platform === "darwin") {
      await run("security", ["add-internet-password", "-U", "-s", url, "-a", "Bearer", "-w", key]);
      return;
    }
    if (platform === "linux") {
      await run(
        "secret-tool",
        ["store", "--label=zed-github-account", "url", url, "username", "Bearer"],
        key,
      );
      return;
    }
    if (platform === "win32") {
      await run(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT, `zed:url=${url}`],
        key,
      );
      return;
    }
  } catch (cause) {
    fail(cause);
  }
  throw new Error(`credential store: not supported on ${platform}`);
}
