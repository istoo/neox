import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The system's manual proxy, as myna reads it (internal/netproxy):
 * macOS's `scutil --proxy` (the dictionary CFNetwork uses), Windows'
 * Internet Options registry key, and nothing elsewhere (a desktop there
 * publishes its proxy as *_PROXY to every app).
 */
export interface SystemProxy {
  /** The address URL requests follow: HTTPS, else HTTP, else SOCKS. */
  url: string;
  /** The plain-http entry alone; SOCKS-capable clients read it. */
  http: string;
  /** The SOCKS entry alone. */
  socks: string;
  /** Hosts the system sends around the proxy. */
  bypass: string[];
}

export type SystemProxyProbe = () => SystemProxy;

const EMPTY: SystemProxy = { url: "", http: "", socks: "", bypass: [] };

/**
 * Read the system proxy on this platform; a failed read is no proxy. It
 * runs a tool, so it is asynchronous and its caller keeps the last value
 * meanwhile (myna reads it in a goroutine for the same reason).
 */
export async function readSystemProxy(
  platform: NodeJS.Platform = process.platform,
): Promise<SystemProxy> {
  try {
    if (platform === "darwin") {
      const { stdout } = await run("scutil", ["--proxy"], {
        encoding: "utf8",
        timeout: 10_000,
      });
      return parseScutil(stdout);
    }
    if (platform === "win32") {
      return await readWindowsRegistry();
    }
  } catch {
    // A tool that isn't there, or doesn't answer, is a failed read: myna
    // keeps what it read before and this caller falls back to no proxy.
  }
  return EMPTY;
}

/**
 * `scutil --proxy` as a Proxy. HTTPS wins over HTTP over SOCKS for the
 * address (myna's scutil.go:parseScutil); HTTP and SOCKS are each entry
 * alone.
 */
export function parseScutil(out: string): SystemProxy {
  const values = new Map<string, string>();
  const bypass: string[] = [];
  let inList = false;
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (inList) {
      if (line === "}") {
        inList = false;
      } else {
        const separator = line.indexOf(" : ");
        if (separator >= 0) {
          bypass.push(line.slice(separator + 3).trim());
        }
      }
      continue;
    }
    const separator = line.indexOf(" : ");
    if (separator < 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (key === "ExceptionsList") {
      inList = true;
      continue;
    }
    values.set(key, line.slice(separator + 3).trim());
  }
  const entry = (key: string, scheme: string): string => {
    if (values.get(`${key}Enable`) !== "1") {
      return "";
    }
    const host = values.get(`${key}Proxy`) ?? "";
    if (host === "") {
      return "";
    }
    const port = values.get(`${key}Port`) ?? "";
    const address = port === "" ? host : `${withBrackets(host)}:${port}`;
    return `${scheme}://${address}`;
  };
  const http = entry("HTTP", "http");
  const socks = entry("SOCKS", "socks5");
  for (const url of [entry("HTTPS", "http"), http, socks]) {
    if (url !== "") {
      return { url, http, socks, bypass };
    }
  }
  return EMPTY;
}

function withBrackets(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Internet Options' ProxyServer ("host:port", or "http=h:p;https=h:p;
 * socks=h:p") and ProxyOverride ("a;*.b;<local>"), as myna's windows.go
 * reads them. HTTP is the entry alone only while it is one address for
 * every protocol, matching reqwest's reading.
 */
export function parseWindows(server: string, override: string): SystemProxy {
  const text = server.trim();
  if (text === "") {
    return EMPTY;
  }
  const bypass = override
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!text.includes("=")) {
    const url = text.includes("://") ? text : `http://${text}`;
    return { url, http: url, socks: "", bypass };
  }
  const entries = new Map<string, string>();
  for (const part of text.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0) {
      entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
    }
  }
  const entry = (key: string, scheme: string): string => {
    const value = entries.get(key) ?? "";
    if (value === "") {
      return "";
    }
    return value.includes("://") ? value : `${scheme}://${value}`;
  };
  const socks = entry("socks", "socks5");
  for (const url of [entry("https", "http"), entry("http", "http"), socks]) {
    if (url !== "") {
      return { url, http: entry("http", "http"), socks, bypass };
    }
  }
  return EMPTY;
}

/** Windows' manual proxy from HKCU, through reg.exe (myna: system_windows.go). */
async function readWindowsRegistry(): Promise<SystemProxy> {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const query = async (name: string): Promise<string> => {
    try {
      const { stdout } = await run("reg", ["query", key, "/v", name], {
        encoding: "utf8",
        timeout: 5_000,
      });
      const match = /^\s{2,}\S+\s+REG_\w+\s+(.*)$/m.exec(stdout);
      return match?.[1]?.trim() ?? "";
    } catch {
      return "";
    }
  };
  if ((await query("ProxyEnable")) !== "0x1") {
    return EMPTY;
  }
  return parseWindows(await query("ProxyServer"), await query("ProxyOverride"));
}
