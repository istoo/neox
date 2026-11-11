import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginIdSchema } from "@neolix/protocol/messages";
import { hasMynaWindow, readMynaWindow, writeMynaClient, type MynaWindow } from "./myna-page.js";

const NEOLIX_MANIFEST = "neox-plugin.json";
const ADAPTER_ENTRY = "index.server.ts";
const CLIENT_ENTRY = "index.client.tsx";
const ENTRY_CANDIDATES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"];
/** Neolix plugin modules must live in client/, server/, or shared/; myna packages live anywhere. */
const VENDOR_DIR = "server/myna";
const VENDOR_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".json"]);
const VENDOR_MAX_FILES = 2000;
const VENDOR_MAX_BYTES = 20 * 1024 * 1024;

/** myna manifest keys whose runtime Neolix has no equivalent for yet. */
const UNSUPPORTED_CONTRIBUTIONS = [
  "middleware",
  "gateway",
  "agent",
  "hooks",
  "provider",
  "search",
] as const;

interface MynaPackageJson {
  name?: string;
  description?: string;
  main?: string;
  exports?: unknown;
  magpie?: Record<string, unknown>;
}

export interface MynaPackage {
  directory: string;
  name: string;
  pluginId: string;
  /** The host entry, or null for a package that only adds a page or panels. */
  entry: string | null;
  /** The entry's path relative to the package, with forward slashes. */
  entryPath: string | null;
  /** myna's window contributions, already filtered to the ones Neolix can render. */
  window: MynaWindow;
  unsupported: string[];
}

async function isFile(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null);
  return info?.isFile() ?? false;
}

function packageString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = packageString(entry);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const key of ["import", "default", "require", "node"]) {
      const found = packageString(Reflect.get(value, key));
      if (found) return found;
    }
  }
  return null;
}

/** myna's own entry order: exports["./server"], main, exports["."], then index files. */
async function resolveEntry(
  packageJson: MynaPackageJson,
  directory: string,
): Promise<string | null> {
  const exportsField =
    packageJson.exports && typeof packageJson.exports === "object" ? packageJson.exports : null;
  const candidates = [
    exportsField ? packageString(Reflect.get(exportsField, "./server")) : null,
    packageJson.main ?? null,
    exportsField
      ? packageString(Reflect.get(exportsField, "."))
      : packageString(packageJson.exports),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(directory, candidate);
    if (isInside(directory, resolved) && (await isFile(resolved))) return resolved;
  }
  for (const candidate of ENTRY_CANDIDATES) {
    const resolved = path.join(directory, candidate);
    if (await isFile(resolved)) return resolved;
  }
  return null;
}

function isInside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function derivePluginId(name: string | undefined, directory: string): string {
  const base = (name?.split("/").pop() || path.basename(directory))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const withLetter = /^[a-z]/.test(base) ? base : `plugin-${base || "myna"}`;
  return PluginIdSchema.parse(withLetter);
}

function unsupportedKeys(magpie: Record<string, unknown>): string[] {
  return UNSUPPORTED_CONTRIBUTIONS.filter(
    (key) => Reflect.get(magpie, key) !== undefined && Reflect.get(magpie, key) !== null,
  );
}

/**
 * A myna (OpenCode-style) plugin package: a `package.json` with a `magpie` block, no Neolix
 * manifest, and an executable entry. Null for anything else, so ordinary packages keep the
 * normal "manifest is missing" error.
 */
export async function readMynaPackage(directory: string): Promise<MynaPackage | null> {
  if (await isFile(path.join(directory, NEOLIX_MANIFEST))) return null;
  const raw = await readFile(path.join(directory, "package.json"), "utf8").catch(() => null);
  if (!raw) return null;
  let packageJson: MynaPackageJson;
  try {
    packageJson = JSON.parse(raw) as MynaPackageJson;
  } catch {
    return null;
  }
  const magpie = packageJson.magpie;
  if (!magpie || typeof magpie !== "object" || Array.isArray(magpie)) return null;
  const entry = await resolveEntry(packageJson, directory);
  const window = await readMynaWindow(directory, magpie);
  if (!entry && !hasMynaWindow(window)) return null;
  const name = packageJson.name ?? path.basename(directory);
  return {
    directory,
    name,
    pluginId: derivePluginId(packageJson.name, directory),
    entry,
    entryPath: entry === null ? null : path.relative(directory, entry).split(path.sep).join("/"),
    window,
    unsupported: unsupportedKeys(magpie),
  };
}

function toolPrefix(pluginId: string): string {
  return pluginId.replace(/-/g, "_");
}

/**
 * Copies the package's source files into `server/myna/` so the adapter's import stays inside a
 * Neolix-owned module directory. Relative imports keep working; node_modules, media, and the
 * adapter's own files are left out.
 */
async function vendorSources(myna: MynaPackage): Promise<string> {
  const entryPath = myna.entryPath;
  if (entryPath === null) throw new Error(`myna plugin "${myna.name}" has no host entry`);
  const target = path.join(myna.directory, VENDOR_DIR);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  let files = 0;
  let bytes = 0;

  async function copyTree(relativeDirectory: string): Promise<void> {
    const entries = await readdir(path.join(myna.directory, relativeDirectory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        if (relative === VENDOR_DIR) continue;
        await copyTree(relative);
        continue;
      }
      if (!entry.isFile()) continue;
      if (relative === ADAPTER_ENTRY || relative === NEOLIX_MANIFEST) continue;
      if (!VENDOR_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const source = path.join(myna.directory, relative);
      const info = await stat(source);
      files += 1;
      bytes += info.size;
      if (files > VENDOR_MAX_FILES || bytes > VENDOR_MAX_BYTES) {
        throw new Error(
          `myna plugin "${myna.name}" has too many source files to convert (limit ${VENDOR_MAX_FILES} files / 20 MB)`,
        );
      }
      const destination = path.join(target, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
  }

  await copyTree("");
  return `./${VENDOR_DIR}/${entryPath}`;
}

function renderAdapter(myna: MynaPackage, entrySpecifier: string, withOptions: boolean): string {
  return `// Generated by Neox's myna plugin converter. It is overwritten on every update.
import {
  defineAgentTool,
  type AgentToolDefinition,
  type AgentToolResult,
  type PluginServerContext,
} from "@neolix/plugin/server";
import { defineSettings } from "@neolix/plugin";
import { z } from "zod";
import * as mynaEntry from ${JSON.stringify(entrySpecifier)};

const PACKAGE = ${JSON.stringify(myna.name)};${
    withOptions
      ? `\nconst OPTIONS = defineSettings({
  id: "options",
  scope: "host",
  version: 1,
  schema: z.record(z.string(), z.json()),
});`
      : ""
  }
const PREFIX = ${JSON.stringify(toolPrefix(myna.pluginId))};
const MYNA_INPUT = {
  client: {},
  app: { log() {} },
  $: undefined,
  directory: process.cwd(),
  worktree: process.cwd(),
  myna: {
    option() { return undefined; },
    options() { return undefined; },
    async load() { return undefined; },
    async usage() { return undefined; },
    async account() { return undefined; },
  },
};
const SUPPORTED_HOOKS = new Set(["tool"]);

function normalizeName(raw) {
  const cleaned = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const name = \`\${PREFIX}_\${cleaned || "tool"}\`;
  return name.slice(0, 64);
}

function toResult(value) {
  if (typeof value === "string") return { text: value };
  if (value === undefined || value === null) return { text: "" };
  try {
    return { text: JSON.stringify(value), structuredContent: value };
  } catch {
    return { text: String(value) };
  }
}

function toolInput(schema) {
  const fromJSONSchema = z.fromJSONSchema;
  if (typeof fromJSONSchema !== "function") {
    throw new Error("This host's zod cannot convert JSON Schema tool arguments");
  }
  return fromJSONSchema(schema ?? { type: "object", properties: {} });
}

async function collectToolTable() {
  const contributed = {};
  for (const exported of Object.values(mynaEntry)) {
    if (typeof exported !== "function") continue;
    const hooks = await exported(MYNA_INPUT);
    if (!hooks || typeof hooks !== "object") continue;
    Object.assign(contributed, hooks);
  }
  const unsupported = Object.keys(contributed).filter((key) => !SUPPORTED_HOOKS.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      \`myna plugin \${PACKAGE} contributes \${unsupported.join(", ")}, which Neox cannot run yet\`,
    );
  }
  const table = contributed.tool;
  if (!table || typeof table !== "object") {
    throw new Error(\`myna plugin \${PACKAGE} contributed no tools\`);
  }
  return table;
}

function toDefinitions(table) {
  const definitions = [];
  const names = new Set();
  for (const [rawName, rawTool] of Object.entries(table)) {
    if (!rawTool || typeof rawTool !== "object") continue;
    const tool = rawTool;
    if (typeof tool.execute !== "function") continue;
    const name = normalizeName(rawName);
    if (names.has(name)) continue;
    names.add(name);
    const description =
      typeof tool.description === "string" && tool.description ? tool.description : rawName;
    definitions.push(
      defineAgentTool({
        name,
        description,
        input: toolInput(tool.args),
        async execute(args) {
          try {
            return toResult(await tool.execute(args));
          } catch (error) {
            return {
              text: error instanceof Error ? error.message : String(error),
              isError: true,
            };
          }
        },
      }),
    );
  }
  if (definitions.length === 0) throw new Error(\`myna plugin \${PACKAGE} contributed no tools\`);
  return definitions;
}

let definitions = null;

function loadTools() {
  definitions ??= collectToolTable().then(toDefinitions);
  return definitions;
}

export default function contribute(server: PluginServerContext) {
  ${withOptions ? "server.registerSettings(OPTIONS);" : ""}
  server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose === "history") return;
    return { ...request, tools: [...request.tools, ...(await loadTools())] };
  });
  return () => {};
}
`;
}

/** The server entry of a page-only package: the options the page bridge reads and writes. */
function renderSettingsEntry(): string {
  return `// Generated by Neox's myna plugin converter. It is overwritten on every update.
import { defineSettings } from "@neolix/plugin";
import type { PluginServerContext } from "@neolix/plugin/server";
import { z } from "zod";

const OPTIONS = defineSettings({
  id: "options",
  scope: "host",
  version: 1,
  schema: z.record(z.string(), z.json()),
});

export default function contribute(server: PluginServerContext) {
  server.registerSettings(OPTIONS);
  return () => {};
}
`;
}

export interface MynaConversion {
  pluginId: string;
  name: string;
}

/**
 * Writes the Neolix manifest and adapter entry into a staged myna package. Returns null when the
 * directory is not a convertible myna package. Contributions Neolix cannot run are rejected here,
 * by name, so an install never half-works silently.
 */
export async function convertMynaPackage(directory: string): Promise<MynaConversion | null> {
  const myna = await readMynaPackage(directory);
  if (!myna) return null;
  if (myna.unsupported.length > 0) {
    throw new Error(
      `myna plugin "${myna.name}" contributes ${myna.unsupported.join(", ")}, which Neox does not support yet. Tools, pages, panels and row actions can be converted.`,
    );
  }
  if (
    (myna.entry !== null || hasMynaWindow(myna.window)) &&
    (await isFile(path.join(directory, ADAPTER_ENTRY)))
  ) {
    throw new Error(
      `myna plugin "${myna.name}" already has ${ADAPTER_ENTRY}; Neox cannot add its converter entry`,
    );
  }
  if (hasMynaWindow(myna.window) && (await isFile(path.join(directory, CLIENT_ENTRY)))) {
    throw new Error(
      `myna plugin "${myna.name}" already has ${CLIENT_ENTRY}; Neox cannot add its converter entry`,
    );
  }
  await writeFile(
    path.join(directory, NEOLIX_MANIFEST),
    `${JSON.stringify(
      {
        id: myna.pluginId,
        name: myna.name,
        description: `Converted myna plugin: ${myna.name}`,
        requirements: { neolix: ">=0.15.0" },
      },
      null,
      2,
    )}\n`,
  );
  if (myna.entry !== null) {
    const entrySpecifier = await vendorSources(myna);
    await writeFile(
      path.join(directory, ADAPTER_ENTRY),
      renderAdapter(myna, entrySpecifier, hasMynaWindow(myna.window)),
    );
  } else if (hasMynaWindow(myna.window)) {
    await writeFile(path.join(directory, ADAPTER_ENTRY), renderSettingsEntry());
  }
  if (hasMynaWindow(myna.window)) {
    await writeMynaClient(directory, myna.window, myna.pluginId);
  }
  return { pluginId: myna.pluginId, name: myna.name };
}

/**
 * Local directory sources are installed in place, so Neolix cannot write a converter into them.
 * Say why instead of failing later with "manifest is missing".
 */
export async function assertDirectoryMynaSupport(directory: string): Promise<void> {
  const myna = await readMynaPackage(directory);
  if (!myna) return;
  throw new Error(
    `"${myna.name}" is a myna plugin. Neox can convert its tools, pages, panels and row actions only for npm or git sources, where it writes the adapter into a managed copy; install it from npm or port it to a Neox plugin.`,
  );
}
