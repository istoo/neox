import { promises as fs } from "node:fs";
import path from "node:path";
import { readTextOrNull } from "../config-files.js";
import type { ConnectEnvironment } from "../drivers.js";
import { configHome, writeText } from "./helpers.js";

const OPEN = "# >>> neolix agy >>>";
const CLOSE = "# <<< neolix agy <<<";

type ShellKind = "posix" | "fish" | "powershell";

interface ShellProfile {
  path: string;
  kind: ShellKind;
}

/** Every profile myna would write: the shells the reader actually has. */
function candidateProfiles(environment: ConnectEnvironment): ShellProfile[] {
  const home = environment.homeDir;
  const zdot = environment.env.ZDOTDIR?.trim();
  const out: ShellProfile[] = [
    {
      path: path.join(zdot && path.isAbsolute(zdot) ? zdot : home, ".zshrc"),
      kind: "posix",
    },
    { path: path.join(home, ".bashrc"), kind: "posix" },
    { path: path.join(home, ".bash_profile"), kind: "posix" },
    { path: path.join(configHome(environment), "fish", "config.fish"), kind: "fish" },
  ];
  if ((environment.platform ?? process.platform) === "win32") {
    const documents = path.join(home, "Documents");
    out.push(
      {
        path: path.join(documents, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
        kind: "powershell",
      },
      {
        path: path.join(documents, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
        kind: "powershell",
      },
    );
  }
  return out;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The profiles to write: the ones that are here, or the one shell a terminal opens. */
async function targetProfiles(environment: ConnectEnvironment): Promise<ShellProfile[]> {
  const candidates = candidateProfiles(environment);
  const present: ShellProfile[] = [];
  for (const profile of candidates) {
    if (await exists(profile.path)) present.push(profile);
  }
  if (present.length > 0) return present;
  const shell = path.basename(environment.env.SHELL?.trim() ?? "");
  const createByShell: Record<string, (profile: ShellProfile) => boolean> = {
    zsh: (profile) => profile.path.endsWith(".zshrc"),
    bash: (profile) => profile.path.endsWith(".bashrc"),
    fish: (profile) => profile.kind === "fish",
  };
  const matches = createByShell[shell];
  const create = matches === undefined ? undefined : candidates.find(matches);
  if (create === undefined) {
    throw new Error(
      `Neox adds the agy function to zsh, bash or fish profiles; $SHELL is ${shell || "unset"}.`,
    );
  }
  return [create];
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function posixFunction(environment: ConnectEnvironment, model: string | null): string[] {
  const key = shellQuote(environment.apiKey);
  const base = shellQuote(environment.baseUrl);
  const modelArg = model === null ? "" : ` --model ${shellQuote(model)}`;
  return [
    "function agy {",
    '  case " $* " in',
    `    *" --model "*|*" --model="*) GEMINI_API_KEY=${key} GOOGLE_GEMINI_BASE_URL=${base} command agy "$@" ;;`,
    `    *) GEMINI_API_KEY=${key} GOOGLE_GEMINI_BASE_URL=${base} command agy${modelArg} "$@" ;;`,
    "  esac",
    "}",
  ];
}

function fishFunction(environment: ConnectEnvironment, model: string | null): string[] {
  const key = shellQuote(environment.apiKey);
  const base = shellQuote(environment.baseUrl);
  return [
    "function agy",
    `  set -lx GEMINI_API_KEY ${key}`,
    `  set -lx GOOGLE_GEMINI_BASE_URL ${base}`,
    "  if contains -- --model $argv",
    "    command agy $argv",
    "  else",
    `    command agy${model === null ? "" : ` --model ${shellQuote(model)}`} $argv`,
    "  end",
    "end",
  ];
}

function powershellFunction(environment: ConnectEnvironment, model: string | null): string[] {
  const key = shellQuote(environment.apiKey).replace(/'/g, "''");
  const base = shellQuote(environment.baseUrl).replace(/'/g, "''");
  const modelArg = model === null ? "" : ` --model '${model.replace(/'/g, "''")}'`;
  return [
    "function agy {",
    "  $real = Get-Command agy -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
    "  if (-not $real) { Write-Error 'agy is not installed'; return }",
    "  $wasKey = $env:GEMINI_API_KEY",
    "  $wasBase = $env:GOOGLE_GEMINI_BASE_URL",
    `  $env:GEMINI_API_KEY = '${key}'`,
    `  $env:GOOGLE_GEMINI_BASE_URL = '${base}'`,
    "  try {",
    "    $hasModel = @($args | Where-Object { \"$_\" -match '^--?model(=|$)' }).Count -gt 0",
    `    if ($hasModel) { & $real @args } else { & $real${modelArg} @args }`,
    "  } finally {",
    "    $env:GEMINI_API_KEY = $wasKey",
    "    $env:GOOGLE_GEMINI_BASE_URL = $wasBase",
    "  }",
    "}",
  ];
}

function functionBody(
  kind: ShellKind,
  environment: ConnectEnvironment,
  model: string | null,
): string[] {
  if (kind === "fish") return fishFunction(environment, model);
  if (kind === "powershell") return powershellFunction(environment, model);
  return posixFunction(environment, model);
}

function stripBlock(text: string): { text: string; had: boolean } {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === OPEN);
  if (start < 0) return { text, had: false };
  let end = lines.findIndex((line, index) => index > start && line.trim() === CLOSE);
  if (end < 0) end = start;
  const from = start > 0 && lines[start - 1] === "" ? start - 1 : start;
  return { text: lines.filter((_, index) => index < from || index > end).join("\n"), had: true };
}

export async function hasAgyShellFunction(environment: ConnectEnvironment): Promise<boolean> {
  for (const profile of await allExistingProfiles(environment)) {
    const text = (await readTextOrNull(profile.path)) ?? "";
    if (text.split("\n").some((line) => line.trim() === OPEN)) return true;
  }
  return false;
}

async function allExistingProfiles(environment: ConnectEnvironment): Promise<ShellProfile[]> {
  const out: ShellProfile[] = [];
  for (const profile of candidateProfiles(environment)) {
    if (await exists(profile.path)) out.push(profile);
  }
  return out;
}

/** Writes the function into a marked block of every profile, backing each up once. */
export async function installAgyShellFunction(
  environment: ConnectEnvironment,
  model: string | null,
): Promise<void> {
  for (const profile of await targetProfiles(environment)) {
    const text = (await readTextOrNull(profile.path)) ?? "";
    if (environment.neolixHome !== undefined && text.length > 0) {
      const backupDir = path.join(environment.neolixHome, "agent-connect", "backups", "agy-shell");
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(path.join(backupDir, backupName(profile.path, environment)), text, "utf8");
    }
    const stripped = stripBlock(text).text;
    const block = [OPEN, ...functionBody(profile.kind, environment, model), CLOSE].join("\n");
    const body = stripped.replace(/\s+$/, "");
    await writeText(profile.path, body.length === 0 ? `${block}\n` : `${body}\n\n${block}\n`);
  }
}

/** Takes only the marked block out of every profile that has one. */
export async function removeAgyShellFunction(environment: ConnectEnvironment): Promise<void> {
  for (const profile of await allExistingProfiles(environment)) {
    const text = await readTextOrNull(profile.path);
    if (text === null) continue;
    const stripped = stripBlock(text);
    if (!stripped.had) continue;
    const next = stripped.text.replace(/\s+$/, "");
    await writeText(profile.path, next.length === 0 ? "" : `${next}\n`);
  }
}

function backupName(filePath: string, environment: ConnectEnvironment): string {
  const relative = path.relative(environment.homeDir, filePath);
  return relative.startsWith("..") ? path.basename(filePath) : relative.split(path.sep).join("_");
}
