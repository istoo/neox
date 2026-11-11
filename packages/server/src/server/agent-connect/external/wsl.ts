import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWslDistros, wslUncPath } from "../../external-sessions/wsl.js";

const run = promisify(execFile);

// debt: node:child_process has no asynchronous wsl.exe look in a running
// distro beyond one probe per snapshot (cached for a minute), which is one
// bounded command; myna keeps its probe on disk across restarts.

/** An agent myna looks for inside a WSL distro (internal/agent/wsl.go's wslKinds). */
export interface WslKind {
  id: string;
  name: string;
  icon: string;
  /** Its folder under $HOME and its command: either one says it is there. */
  dir?: string;
  bin?: string;
}

export const WSL_KINDS: WslKind[] = [
  { id: "codex", name: "Codex", icon: "openai", dir: ".codex", bin: "codex" },
  { id: "pi", name: "Pi", icon: "pi", dir: ".pi", bin: "pi" },
  { id: "omo", name: "OmO", icon: "omo", dir: ".omo", bin: "omo" },
  {
    id: "prime-agent",
    name: "Prime Agent",
    icon: "prime-agent",
    dir: ".prime/agent",
    bin: "prime-agent",
  },
  { id: "stepcode", name: "StepCode", icon: "stepcode", dir: ".stepcode" },
  { id: "claude", name: "Claude Code", icon: "claude-color", dir: ".claude", bin: "claude" },
  {
    id: "opencode",
    name: "OpenCode",
    icon: "opencode",
    dir: ".config/opencode",
    bin: "opencode",
  },
  { id: "mimocode", name: "MiMo Code", icon: "mimocode", dir: ".config/mimocode", bin: "mimo" },
  { id: "kimi", name: "Kimi Code", icon: "kimi", dir: ".kimi-code", bin: "kimi" },
  { id: "qwen", name: "Qwen Code", icon: "qwen-color", dir: ".qwen", bin: "qwen" },
  { id: "omp", name: "omp", icon: "omp", dir: ".omp", bin: "omp" },
  { id: "crush", name: "Crush", icon: "crush", dir: ".config/crush", bin: "crush" },
  { id: "hermes", name: "Hermes Agent", icon: "hermes", dir: ".hermes", bin: "hermes" },
  { id: "morph", name: "Mister Morph", icon: "morph", dir: ".morph" },
  { id: "grok", name: "Grok Build", icon: "grok", dir: ".grok" },
  { id: "droid", name: "Droid", icon: "droid", dir: ".factory", bin: "droid" },
  { id: "fx", name: "fx", icon: "fx", dir: ".fx" },
  {
    id: "commandcode",
    name: "Command Code",
    icon: "commandcode",
    dir: ".commandcode",
    bin: "command-code",
  },
  {
    id: "minimax-code",
    name: "MiniMax Code",
    icon: "minimax-color",
    dir: ".minimax",
    bin: "mcode",
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    icon: "deepseek-color",
    dir: ".dsh",
    bin: "dsh",
  },
  { id: "empryo", name: "Empryo", icon: "empryo", dir: ".empryo", bin: "empryo" },
  { id: "ante", name: "Ante", icon: "ante", dir: ".ante", bin: "ante" },
  { id: "muse", name: "Muse Code", icon: "muse", dir: ".config/muse", bin: "muse" },
  { id: "qoder", name: "Qoder", icon: "qoder", dir: ".qoder", bin: "qodercli" },
  { id: "qoder-cn", name: "Qoder CN", icon: "qoder", dir: ".qoder-cn", bin: "qoderclicn" },
  {
    id: "codebuddy",
    name: "CodeBuddy Code",
    icon: "codebuddy-color",
    dir: ".codebuddy",
    bin: "codebuddy",
  },
  { id: "cline", name: "Cline", icon: "cline", dir: ".cline", bin: "cline" },
  { id: "atomcode", name: "AtomCode", icon: "atomcode", dir: ".atomcode", bin: "atomcode" },
  { id: "snow", name: "Snow CLI", icon: "snow", dir: ".snow", bin: "snow" },
  { id: "gemini", name: "Gemini CLI", icon: "geminicli-color", bin: "gemini" },
  {
    id: "agy",
    name: "Antigravity CLI",
    icon: "antigravity-color",
    dir: ".gemini/antigravity-cli",
    bin: "agy",
  },
  { id: "goose", name: "Goose", icon: "goose", dir: ".config/goose" },
  { id: "mothx", name: "MothX", icon: "mothx", dir: ".mothx", bin: "mothx" },
  { id: "penguin", name: "PenguinHarness", icon: "penguin-color", dir: ".penguin", bin: "penguin" },
  { id: "reasonix", name: "Reasonix", icon: "reasonix-color", bin: "reasonix" },
];

/** A row of an agent living in a running WSL distro. */
export interface WslRow {
  provider: string;
  name: string;
  icon: string;
  distro: string;
  /** Its home as the distro spells it, and as Windows opens it. */
  home: string;
  uncHome: string;
  /** The gateway as the distro reaches it. */
  baseUrl: string;
  /** A named omp profile this row is (myna's `omp#<name>` rows). */
  variant?: string;
}

export interface WslDeps {
  platform?: NodeJS.Platform;
  /** Whether Settings' Detect agents in WSL is on. */
  enabled?: boolean;
  /** `wsl.exe -l -v`, decoded. */
  list?: () => Promise<string>;
  /** Runs a script in a distro and answers its stdout. */
  probe?: (distro: string) => Promise<string>;
}

const PROBE = (() => {
  const lines = ['echo "home:$HOME"'];
  for (const kind of WSL_KINDS) {
    if (kind.dir !== undefined) {
      lines.push(`[ -d "$HOME/${kind.dir}" ] && echo "dir:${kind.dir}"`);
    }
    if (kind.bin !== undefined) {
      lines.push(`command -v ${kind.bin} >/dev/null 2>&1 && echo "bin:${kind.bin}"`);
    }
  }
  lines.push(
    // omp's named profiles, each an agent of its own (myna's wslAgentsOf)
    'for p in "$HOME/.omp/profiles"/*/agent; do [ -d "$p" ] && echo "omp-profile:$(basename "${p%/agent}")"; done',
    "ip route show default 2>/dev/null | head -n1 | sed 's/^/route:/'",
    'command -v wslinfo >/dev/null 2>&1 && echo "net:$(wslinfo --networking-mode 2>/dev/null)"',
    "true",
  );
  return lines.join("; ");
})();

/** The gateway's address from inside a distro: its own loopback under mirrored networking. */
function distroBaseUrl(baseUrl: string, probe: string): string {
  let net = "";
  let route = "";
  for (const line of probe.split("\n")) {
    if (line.startsWith("net:")) net = line.slice(4).trim().toLowerCase();
    if (line.startsWith("route:")) route = line.slice(6).trim();
  }
  const loopback = net === "mirrored" || net === "consomme" || net === "virtioproxy";
  if (loopback) return baseUrl;
  // Under NAT the distro reaches Windows at its default gateway.
  const host = /default\s+via\s+(\S+)/.exec(route)?.[1];
  if (host === undefined) return baseUrl;
  try {
    const url = new URL(baseUrl);
    url.hostname = host;
    return url.toString().replace(/\/$/, "");
  } catch {
    return baseUrl;
  }
}

/** Reads a running distro's probe: its home, what of WSL_KINDS it has, and the gateway there. */
export function parseWslProbe(
  output: string,
  baseUrl: string,
): { home: string; has: Set<string>; ompProfiles: Set<string>; baseUrl: string } {
  let home = "";
  const has = new Set<string>();
  const ompProfiles = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("home:")) home = line.slice(5).trim();
    else if (line.startsWith("omp-profile:")) ompProfiles.add(line.slice(12).trim());
    else if (line.startsWith("dir:") || line.startsWith("bin:")) has.add(line.trim());
  }
  return { home, has, ompProfiles, baseUrl: distroBaseUrl(baseUrl, output) };
}

/**
 * The agents of the running WSL distros (myna's wslAgents): each one is a
 * row `id@wsl:<distro>`. A stopped distro is never looked in — asking for
 * its home starts it.
 */
export async function discoverWslRows(baseUrl: string, deps: WslDeps = {}): Promise<WslRow[]> {
  if ((deps.platform ?? process.platform) !== "win32" || deps.enabled === false) return [];
  let listing: string;
  try {
    listing = await (deps.list ?? listDistros)();
  } catch {
    return [];
  }
  const rows: WslRow[] = [];
  for (const distro of parseWslDistros(listing)) {
    if (!distro.running) continue;
    let output: string;
    try {
      output = await (deps.probe ?? ((name: string) => probeDistro(name)))(distro.name);
    } catch {
      continue;
    }
    const probe = parseWslProbe(output, baseUrl);
    if (probe.home.length === 0) continue;
    for (const kind of WSL_KINDS) {
      const found =
        (kind.dir !== undefined && probe.has.has(`dir:${kind.dir}`)) ||
        (kind.bin !== undefined && probe.has.has(`bin:${kind.bin}`));
      if (!found) continue;
      rows.push({
        provider: `${kind.id}@wsl:${distro.name}`,
        name: `${kind.name} (WSL: ${distro.name})`,
        icon: kind.icon,
        distro: distro.name,
        home: probe.home,
        uncHome: wslUncPath(distro.name, probe.home),
        baseUrl: probe.baseUrl,
      });
    }
    for (const profile of [...probe.ompProfiles].sort()) {
      rows.push({
        provider: `omp#${profile}@wsl:${distro.name}`,
        name: `omp · ${profile} (WSL: ${distro.name})`,
        icon: "omp",
        distro: distro.name,
        home: probe.home,
        uncHome: wslUncPath(distro.name, probe.home),
        baseUrl: probe.baseUrl,
        variant: profile,
      });
    }
  }
  return rows;
}

async function listDistros(): Promise<string> {
  const { stdout } = await run("wsl.exe", ["-l", "-v"], {
    encoding: "buffer",
    windowsHide: true,
    timeout: 10_000,
  });
  return Buffer.from(stdout).toString("utf16le");
}

async function probeDistro(distro: string): Promise<string> {
  const { stdout } = await run("wsl.exe", ["-d", distro, "-e", "sh", "-lc", PROBE], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return stdout;
}

/** The provider id a row has, and the driver id and distro it names. */
export function parseWslProvider(provider: string): { driver: string; distro: string } | null {
  const at = provider.indexOf("@wsl:");
  if (at <= 0 || at === provider.length - 5) return null;
  return { driver: provider.slice(0, at), distro: provider.slice(at + 5) };
}
