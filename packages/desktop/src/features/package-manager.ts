import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * myna's update/packaged.go: which package manager installed this binary,
 * which then has to be the one to update it. Replacing a file a package
 * owns leaves the manager's database naming an older version, and its next
 * upgrade writes over the newer file.
 */
export type PackageManager = "pacman" | "dpkg" | "rpm" | "homebrew" | "nix";

export interface Packaged {
  manager: PackageManager;
  package?: string;
}

/** The manager as its users call it. */
export function packagedName(packaged: Packaged): string {
  switch (packaged.manager) {
    case "dpkg":
      return "apt";
    case "homebrew":
      return "Homebrew";
    case "nix":
      return "Nix";
    default:
      return packaged.manager;
  }
}

/** What updates the package, "" when there is no single command (Nix). */
export function packagedCommand(packaged: Packaged): string {
  const name = packaged.package ?? "neolix";
  switch (packaged.manager) {
    case "pacman":
      // Neolix is in no distribution's own repository; a pacman package is an
      // AUR one, which pacman alone doesn't upgrade.
      return `yay -S ${name}`;
    case "dpkg":
      return `sudo apt install --only-upgrade ${name}`;
    case "rpm":
      return `sudo dnf upgrade ${name}`;
    case "homebrew":
      return `brew upgrade ${name}`;
    default:
      return "";
  }
}

/** The sentence Settings › About and the log show. */
export function packagedSentence(packaged: Packaged): string {
  let sentence = `Neox was installed with ${packagedName(packaged)}`;
  if (packaged.package) {
    sentence += ` (package ${packaged.package})`;
  }
  sentence += ", which updates it, not Neox";
  const command = packagedCommand(packaged);
  if (command) {
    sentence += `: ${command}`;
    if (packaged.manager === "pacman") {
      sentence += " (or paru, or the AUR helper it came from)";
    }
  }
  return sentence;
}

/**
 * Neox's .deb and .rpm come from its GitHub release page, not from an apt or
 * dnf repository, so their manager has no newer version to upgrade to. Such an
 * install finds updates on the release feed and offers the download instead.
 */
export function isReleaseDownloadPackage(packaged: Packaged): boolean {
  return packaged.manager === "dpkg" || packaged.manager === "rpm";
}

/** A package may own /usr (not /usr/local), /bin, /sbin and /opt. */
function isSystemPath(filePath: string): boolean {
  if (filePath.startsWith("/usr/local/")) {
    return false;
  }
  return ["/usr/", "/bin/", "/sbin/", "/opt/"].some((dir) => filePath.startsWith(dir));
}

/** On a merged /usr, /bin is /usr/bin; a package may list either. */
function aliasedPaths(filePath: string): string[] {
  const paths = [filePath];
  for (const dir of ["/bin/", "/sbin/", "/lib/"]) {
    if (filePath.startsWith(`/usr${dir}`)) {
      paths.push(filePath.slice("/usr".length));
    } else if (filePath.startsWith(dir)) {
      paths.push(`/usr${filePath}`);
    }
  }
  return paths;
}

function neolixFirst(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const aNeolix = a.startsWith("neolix");
    const bNeolix = b.startsWith("neolix");
    if (aNeolix && !bNeolix) return -1;
    if (bNeolix && !aNeolix) return 1;
    return 0;
  });
}

function listed(filePath: string, wanted: readonly string[]): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  return wanted.some((want) => lines.has(want));
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function pacmanName(directory: string, folder: string): string {
  try {
    const lines = readFileSync(path.join(directory, "desc"), "utf8").split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() === "%NAME%");
    const name = index >= 0 ? lines[index + 1]?.trim() : "";
    if (name) {
      return name;
    }
  } catch {
    // Fall through to the folder name.
  }
  const parts = folder.split("-");
  return parts.length > 2 ? parts.slice(0, -2).join("-") : folder;
}

function pacmanOwner(root: string, filePath: string): { name: string } | null {
  const directory = path.join(root, "var/lib/pacman/local");
  let folders: string[];
  try {
    folders = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const wanted = aliasedPaths(filePath).map((value) => value.replace(/^\//, ""));
  for (const folder of neolixFirst(folders)) {
    const packageDir = path.join(directory, folder);
    if (listed(path.join(packageDir, "files"), wanted)) {
      return { name: pacmanName(packageDir, folder) };
    }
  }
  return null;
}

function dpkgOwner(root: string, filePath: string): { name: string } | null {
  const directory = path.join(root, "var/lib/dpkg/info");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".list"));
  } catch {
    return null;
  }
  const wanted = aliasedPaths(filePath);
  for (const name of neolixFirst(names)) {
    if (listed(path.join(directory, name), wanted)) {
      return { name: name.replace(/\.list$/, "").split(":")[0] ?? name };
    }
  }
  return null;
}

function defaultRpmOwner(filePath: string): string | null {
  try {
    // Sync by design: the check runs once, and the service's interface is sync.
    const result = execFileSync("rpm", ["-qf", "--queryformat", "%{NAME}", filePath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const name = result.trim();
    // "file … is not owned by any package" contains spaces.
    return name === "" || name.includes(" ") ? null : name;
  } catch {
    return null;
  }
}

export interface PackagedByOptions {
  /** The system's files live under this root; tests point it at a temp dir. */
  root?: string;
  platform?: NodeJS.Platform;
  /** Reads the rpm database; a test stands in for it. */
  rpmOwner?: (filePath: string) => string | null;
}

/** Which package manager installed `exe` (symlinks resolved by the caller). */
export function packagedBy(exe: string, options: PackagedByOptions = {}): Packaged | null {
  const root = options.root ?? "/";
  const platform = options.platform ?? process.platform;
  const filePath = exe.replace(/\\/g, "/");

  const cellar = filePath.split("/Cellar/");
  if (cellar.length > 1) {
    const name = cellar[1]?.split("/")[0];
    return name ? { manager: "homebrew", package: name } : { manager: "homebrew" };
  }

  if (platform !== "linux") {
    return null;
  }
  if (filePath.startsWith("/nix/store/")) {
    return { manager: "nix" };
  }
  if (!isSystemPath(filePath)) {
    return null;
  }

  const pacman = pacmanOwner(root, filePath);
  if (pacman) {
    return { manager: "pacman", package: pacman.name };
  }
  const dpkg = dpkgOwner(root, filePath);
  if (dpkg) {
    return { manager: "dpkg", package: dpkg.name };
  }
  if (isDirectory(path.join(root, "var/lib/rpm"))) {
    const name = (options.rpmOwner ?? defaultRpmOwner)(filePath);
    if (name) {
      return { manager: "rpm", package: name };
    }
  }
  return null;
}
