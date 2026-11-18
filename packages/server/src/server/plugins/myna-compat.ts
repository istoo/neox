import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PluginIdSchema } from "@neolix/protocol/messages";
import {
  hasMynaWindow,
  readMynaWindow,
  renderPageReadCode,
  writeMynaWebAssets,
  type MynaWindow,
} from "./myna-page.js";

const NEOLIX_MANIFEST = "neox-plugin.json";
const ADAPTER_ENTRY = "index.server.ts";
const ENTRY_CANDIDATES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.cjs"];
/** Neolix plugin modules must live in client/, server/, or shared/; myna packages live anywhere. */
const VENDOR_DIR = "server/myna";
const VENDOR_FILE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
]);
const VENDOR_MAX_FILES = 2000;
const VENDOR_MAX_BYTES = 20 * 1024 * 1024;
/** What a moejs gateway module may be, as myna compiles it. */
const MIDDLEWARE_EXTENSIONS = /\.(?:js|mjs|cjs|ts)$/i;
/** Bun runs TypeScript directly; myna accepts these for request hooks. */
const HOOKS_EXTENSIONS = /\.(?:js|mjs|cjs|ts|mts|cts)$/i;
const AGENT_EXTENSIONS = /\.(?:js|mjs|cjs|ts)$/i;

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
  /** The moejs gateway module (`magpie.middleware`, or its `magpie.gateway` alias). */
  middlewarePath: string | null;
  /** The Bun asynchronous request hooks module (`magpie.hooks`). */
  hooksPath: string | null;
  /** The agent wiring module (`magpie.agent`). */
  agentPath: string | null;
  /** The package's options editor defaults (`magpie.options`). */
  options: Record<string, unknown>;
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

function optionsDefaults(magpie: Record<string, unknown>): Record<string, unknown> {
  const raw = Reflect.get(magpie, "options");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

/**
 * The module a myna manifest key names, inside the package. myna treats a
 * missing file as a plugin that will not load; the converter says so while the
 * source is still being installed.
 */
async function declaredModule(
  directory: string,
  magpie: Record<string, unknown>,
  key: string,
  extensions: RegExp,
): Promise<string | null> {
  const raw = Reflect.get(magpie, key);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const resolved = path.resolve(directory, raw.trim());
  if (!isInside(directory, resolved)) {
    throw new Error(`myna ${key} leaves the package: ${raw}`);
  }
  if (!(await isFile(resolved))) {
    throw new Error(`myna ${key} names a missing file: ${raw}`);
  }
  if (!extensions.test(resolved)) {
    throw new Error(`myna ${key} names a file Neolix cannot load: ${raw}`);
  }
  return resolved;
}

/** myna prefers `magpie.middleware` and falls back to its `magpie.gateway` alias. */
async function declaredMiddleware(
  directory: string,
  magpie: Record<string, unknown>,
): Promise<string | null> {
  return (
    (await declaredModule(directory, magpie, "middleware", MIDDLEWARE_EXTENSIONS)) ??
    (await declaredModule(directory, magpie, "gateway", MIDDLEWARE_EXTENSIONS))
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
  const middlewarePath = await declaredMiddleware(directory, magpie);
  const hooksPath = await declaredModule(directory, magpie, "hooks", HOOKS_EXTENSIONS);
  const agentPath = await declaredModule(directory, magpie, "agent", AGENT_EXTENSIONS);
  if (!entry && !hasMynaWindow(window) && !middlewarePath && !hooksPath && !agentPath) {
    return null;
  }
  const name = packageJson.name ?? path.basename(directory);
  return {
    directory,
    name,
    pluginId: derivePluginId(packageJson.name, directory),
    entry,
    entryPath: entry === null ? null : path.relative(directory, entry).split(path.sep).join("/"),
    window,
    middlewarePath,
    hooksPath,
    agentPath,
    options: optionsDefaults(magpie),
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
async function vendorSources(myna: MynaPackage): Promise<string | null> {
  const entryPath = myna.entryPath;
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
  return entryPath === null ? null : `./${VENDOR_DIR}/${entryPath}`;
}

/** Where a vendored module is imported from, inside the Neolix-owned directory. */
function vendoredSpecifier(myna: MynaPackage, absolute: string): string {
  const relative = path.relative(myna.directory, absolute).split(path.sep).join("/");
  return `./${VENDOR_DIR}/${relative}`;
}

function renderAdapter(
  myna: MynaPackage,
  entrySpecifier: string | null,
  middlewareSpecifier: string | null,
  hooksSpecifier: string | null,
  agentSpecifier: string | null,
): string {
  const hasEntry = entrySpecifier !== null;
  const hasGateway = middlewareSpecifier !== null || hooksSpecifier !== null;
  const hasAgent = agentSpecifier !== null;
  const pageRead =
    hasMynaWindow(myna.window) && myna.window.reads.length > 0
      ? renderPageReadCode(myna.window.reads)
      : "";
  const imports = [
    `import { defineSettings${pageRead === "" ? "" : ", defineRpc"} } from "@neolix/plugin";`,
    `import type { PluginServerContext } from "@neolix/plugin/server";`,
    `import { z } from "zod";`,
  ];
  if (hasEntry) {
    imports.push(`import { defineAgentTool } from "@neolix/plugin/server";`);
    imports.push(`import { openCodeSubscriptionProvider } from "@neolix/plugin/server/opencode";`);
    imports.push(`import * as mynaEntry from ${JSON.stringify(entrySpecifier)};`);
  }
  if (middlewareSpecifier !== null) {
    imports.push(`import * as mynaMiddleware from ${JSON.stringify(middlewareSpecifier)};`);
  }
  if (hooksSpecifier !== null) {
    imports.push(`import * as mynaHooks from ${JSON.stringify(hooksSpecifier)};`);
  }
  if (agentSpecifier !== null) {
    imports.push(`import * as mynaAgent from ${JSON.stringify(agentSpecifier)};`);
  }
  return `// Generated by Neox's myna plugin converter. It is overwritten on every update.
${imports.join("\n")}

const PACKAGE = ${JSON.stringify(myna.name)};
const DEFAULTS: Record<string, unknown> = ${JSON.stringify(myna.options)};
const OPTIONS = defineSettings({
  id: "options",
  scope: "host",
  version: 1,
  schema: z.record(z.string(), z.json()),
});
${pageRead}
let optionsHandle: any = null;
let accountsHandle: any = null;

function isObject(value: any): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function optionsNow() {
  let values: any = {};
  try {
    const state = await optionsHandle.read();
    if (state.status === "ready" && isObject(state.values)) values = state.values;
  } catch {}
  return { ...DEFAULTS, ...values };
}

function mynaInput(options: Record<string, any>) {
  const host = {
    option: (key: string) => options[key],
    options: () => ({ ...options }),
    async load() { return undefined; },
    async usage() { return undefined; },
    async account() { return undefined; },
  };
  return {
    client: {
      auth: {
        async get(input: any) {
          return accountsHandle === null ? null : accountsHandle.read(input.path.id);
        },
        async set(input: any) {
          if (accountsHandle !== null) await accountsHandle.write(input.path.id, input.body);
        },
      },
    },
    app: { log() {} },
    $: undefined,
    directory: process.cwd(),
    worktree: process.cwd(),
    magpie: host,
    myna: host,
    owl: host,
  };
}

function pick(module: any, name: string): any {
  if (module == null) return undefined;
  if (typeof module[name] === "function") return module[name];
  if (isObject(module.default) && typeof module.default[name] === "function") {
    return module.default[name];
  }
  return undefined;
}

function pickValue(module: any, name: string): any {
  if (module == null) return undefined;
  if (module[name] !== undefined) return module[name];
  if (isObject(module.default)) return module.default[name];
  return undefined;
}
${hasEntry ? renderAdapterEntry(myna) : ""}${hasGateway ? renderAdapterGateway(hooksSpecifier !== null, middlewareSpecifier !== null) : ""}${hasAgent ? renderAdapterAgent() : ""}
export default async function contribute(server: PluginServerContext) {
  optionsHandle = server.registerSettings(OPTIONS);
  accountsHandle = server.accounts;${
    pageRead === ""
      ? ""
      : `
  server.handle(PAGE_READ, (input, context) =>
    pageRead(context.neolix, input.name, input.params ?? {}),
  );`
  }${hasEntry ? "\n  await contributeEntry(server);" : ""}${
    hasGateway ? "\n  contributeGateway(server);" : ""
  }${hasAgent ? "\n  contributeAgent(server);" : ""}
  return () => {};
}
`;
}

/** The entry's tool, search, subscription-provider and config hooks. */
function renderAdapterEntry(myna: MynaPackage): string {
  return `
const PREFIX = ${JSON.stringify(toolPrefix(myna.pluginId))};
const SUPPORTED_ENTRY_HOOKS = new Set([
  "tool",
  "search",
  "auth",
  "provider",
  "config",
  "chat.headers",
]);
let entryHooksPromise: Promise<any[]> | null = null;

async function entryHooks(): Promise<any[]> {
  entryHooksPromise ??= (async () => {
    const options = await optionsNow();
    const input = mynaInput(options);
    const hooks: any[] = [];
    for (const exported of Object.values(mynaEntry)) {
      if (typeof exported !== "function") continue;
      const contributed = await (exported as any)(input, options);
      if (!isObject(contributed)) continue;
      const unknown = Object.keys(contributed).filter(
        (key) => !SUPPORTED_ENTRY_HOOKS.has(key),
      );
      if (unknown.length > 0) {
        throw new Error(
          "myna plugin " + PACKAGE + " contributes " + unknown.join(", ") + ", which Neox cannot run",
        );
      }
      hooks.push(contributed);
    }
    const authIds = new Set<string>();
    for (const hook of hooks) {
      if (isObject(hook.auth) && typeof hook.auth.provider === "string" && hook.auth.provider) {
        authIds.add(hook.auth.provider);
      }
    }
    const orphan = hooks
      .flatMap((hook) =>
        isObject(hook.provider) && typeof hook.provider.id === "string" && hook.provider.id
          ? [hook.provider.id]
          : [],
      )
      .filter((id: string) => !authIds.has(id));
    if (orphan.length > 0) {
      throw new Error(
        "myna plugin " + PACKAGE + " adds models to " + orphan.join(", ") +
          " without signing in to it; Neox cannot change a provider the plugin does not own",
      );
    }
    if (authIds.size === 0 && hooks.some((hook) => typeof hook.config === "function")) {
      throw new Error(
        "myna plugin " + PACKAGE + " changes Neox's built-in provider configuration, which Neox cannot run",
      );
    }
    return hooks;
  })();
  return entryHooksPromise;
}

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
  return definitions;
}

let definitions = null;

async function loadTools() {
  definitions ??= entryHooks().then((hooks) => {
    const table = {};
    for (const hook of hooks) {
      if (isObject(hook.tool)) Object.assign(table, hook.tool);
    }
    return toDefinitions(table);
  });
  return definitions;
}

/** The entry's search hook, as the gateway's plugin search vendors. */
async function contributeSearch(server: PluginServerContext) {
  const hooks = await entryHooks();
  const table = new Map<string, any>();
  for (const hook of hooks) {
    if (!isObject(hook.search)) continue;
    for (const [id, definition] of Object.entries(hook.search)) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) continue;
      if (isObject(definition) && typeof definition.execute === "function") {
        table.set(id, definition);
      }
    }
  }
  for (const [id, definition] of table) {
    server.registerSearchApi({
      id,
      name: typeof definition.name === "string" && definition.name ? definition.name : id,
      ...(typeof definition.keysURL === "string" && /^https?:\\/\\//.test(definition.keysURL)
        ? { keysURL: definition.keysURL }
        : {}),
      ...(definition.keyOptional === true ? { keyOptional: true } : {}),
      ...(definition.url === true ? { needURL: true } : {}),
      async execute(request: any) {
        const output = await definition.execute(
          { query: request.query, count: 6, key: request.key, url: request.url },
          {
            directory: process.cwd(),
            worktree: process.cwd(),
            abort: AbortSignal.timeout(60_000),
          },
        );
        const pages = Array.isArray(output)
          ? output
          : isObject(output) && Array.isArray(output.results)
            ? output.results
            : [];
        return pages
          .filter(
            (page: any) =>
              isObject(page) &&
              typeof page.title === "string" &&
              typeof page.url === "string",
          )
          .map((page: any) => ({
            title: page.title,
            url: page.url,
            text: typeof page.text === "string" ? page.text : "",
            ...(typeof page.age === "string" ? { age: page.age } : {}),
          }));
      },
    });
  }
}

function protocolOfProvider(config: any, id: string): string {
  const provider = isObject(config) && isObject(config.provider) ? config.provider[id] : undefined;
  const npm = isObject(provider) ? String(provider.npm ?? "") : "";
  if (npm.includes("anthropic")) return "anthropic";
  if (npm.includes("google") || npm.includes("gemini")) return "gemini";
  return "openai";
}

function authMethodsOf(auth: any): any[] {
  return (Array.isArray(auth.methods) ? auth.methods : []).map((method: any) => {
    if (!isObject(method)) return method;
    if (method.type !== "api" || typeof method.authorize === "function") return method;
    const prompts = Array.isArray(method.prompts) ? [...method.prompts] : [];
    if (!prompts.some((prompt: any) => isObject(prompt) && prompt.key === "key")) {
      prompts.push({
        type: "text",
        key: "key",
        message:
          typeof method.label === "string" && method.label ? method.label : "API key",
      });
    }
    return {
      ...method,
      prompts,
      async authorize(inputs: Record<string, string>) {
        const metadata = Object.fromEntries(
          Object.entries(inputs).filter(([key]) => key !== "key"),
        );
        return {
          type: "success",
          key: inputs.key,
          ...(Object.keys(metadata).length === 0 ? {} : { metadata }),
        };
      },
    };
  });
}

/** The entry's auth/provider hooks, as the gateway's subscription providers. */
async function contributeProviders(server: PluginServerContext) {
  const hooks = await entryHooks();
  const auths = new Map<string, any>();
  for (const hook of hooks) {
    if (isObject(hook.auth) && typeof hook.auth.provider === "string" && hook.auth.provider) {
      auths.set(hook.auth.provider, hook.auth);
    }
  }
  if (auths.size === 0) return;
  const config: any = {};
  for (const hook of hooks) {
    if (typeof hook.config !== "function") continue;
    try {
      await hook.config(config);
    } catch {}
  }
  const modelsHooks = new Map<string, any>();
  for (const hook of hooks) {
    if (isObject(hook.provider) && typeof hook.provider.id === "string" && hook.provider.id) {
      modelsHooks.set(hook.provider.id, hook.provider);
    }
  }
  for (const [id, auth] of auths) {
    const providerHook = modelsHooks.get(id);
    const configured = isObject(config) && isObject(config.provider) ? config.provider[id] : undefined;
    const label =
      isObject(configured) && typeof configured.name === "string" && configured.name
        ? configured.name
        : typeof auth.name === "string" && auth.name
          ? auth.name
          : id;
    // myna hands a models hook the provider's info object, not its config entry.
    if (!isObject(config.provider)) config.provider = {};
    const providerInfo: any = isObject(configured) ? { ...configured } : {};
    providerInfo.id = id;
    providerInfo.name = label;
    if (!isObject(providerInfo.models)) providerInfo.models = {};
    config.provider[id] = providerInfo;
    const registration = await openCodeSubscriptionProvider({
      accounts: server.accounts,
      id,
      label,
      protocol: protocolOfProvider(config, id) as any,
      plugin: async () => ({
        config(target: any) {
          Object.assign(target, structuredClone(config));
        },
        auth: { ...auth, methods: authMethodsOf(auth) },
        ...(providerHook === undefined || typeof providerHook.models !== "function"
          ? {}
          : {
              provider: {
                id,
                models(given: any, input: any) {
                  const next = providerHook.models(providerInfo, input);
                  return next === undefined ? providerInfo.models : next;
                },
              },
            }),
      }),
    });
    server.registerSubscriptionProvider(registration);
  }
}

/** The entry's chat.headers hooks, as headers added to one outgoing request. */
async function contributeChatHeaders(server: PluginServerContext) {
  const hooks = await entryHooks();
  const functions = hooks
    .map((hook) => hook["chat.headers"])
    .filter((contributed) => typeof contributed === "function");
  if (functions.length === 0) return;
  server.registerGatewayMiddleware({
    id: "chat-headers",
    async onHeaders(input: any) {
      const model = { id: input.model, name: input.model, providerID: input.providerId };
      const provider = {
        source: "custom",
        info: { id: input.providerId, name: input.providerId, models: {} },
        options: {},
      };
      const message = {
        id: "",
        sessionID: "",
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: input.providerId, modelID: input.model },
      };
      const headers: Record<string, string> = {};
      for (const fn of functions) {
        const output: any = { headers: {} };
        try {
          await fn({ sessionID: "", agent: "build", model, provider, message }, output);
        } catch {}
        if (!isObject(output.headers)) continue;
        for (const [name, value] of Object.entries(output.headers)) {
          if (typeof value === "string") headers[name] = value;
        }
      }
      return { headers };
    },
  });
}

/** Loads the entry once at start, then registers what it contributes. */
async function contributeEntry(server: PluginServerContext) {
  await entryHooks();
  await contributeProviders(server);
  await contributeSearch(server);
  await contributeChatHeaders(server);
  server.addHook("agent.open.before", async ({ request }: any) => {
    if (request.purpose === "history") return;
    const tools = await loadTools();
    if (tools.length === 0) return;
    return { ...request, tools: [...request.tools, ...tools] };
  });
}
`;
}

/** The gateway modules: myna's synchronous middleware and its Bun request hooks. */
function renderAdapterGateway(hasHooks: boolean, hasMiddleware: boolean): string {
  const middlewareValues = hasMiddleware
    ? `
const middlewareOnRequest = pick(mynaMiddleware, "onRequest");
const middlewareOnProvider = pick(mynaMiddleware, "onProvider");
const middlewareOnAccount = pick(mynaMiddleware, "onAccount");
const middlewareOnEvent = pick(mynaMiddleware, "onEvent");
const middlewareOnResponse = pick(mynaMiddleware, "onResponse");
const usageHook = pick(mynaMiddleware, "onUsage");
const eventNames = pickValue(mynaMiddleware, "events");
const strategyTable = pickValue(mynaMiddleware, "strategies");
`
    : "";
  const hookValues = hasHooks
    ? `
const hookOnRequest = pick(mynaHooks, "onRequest");
const hookOnResponse = pick(mynaHooks, "onResponse");
`
    : "";
  const hookRegistration = hasHooks
    ? `
  if (hookOnRequest || hookOnResponse) {
    server.registerGatewayMiddleware({
      id: "hooks",
      ...(hookOnRequest === undefined
        ? {}
        : {
            async onRequest(input: any) {
              const before = input.body;
              const result = await hookOnRequest(
                JSON.parse(JSON.stringify(before)),
                asyncHookCtx(input, await optionsNow(), {}),
              );
              if (!isObject(result)) return undefined;
              for (const key of [
                "tools",
                "tool_choice",
                "function_call",
                "functions",
                "toolConfig",
                "model",
                "stream",
              ]) {
                if (JSON.stringify(result[key]) !== JSON.stringify(before[key])) return undefined;
              }
              if (
                JSON.stringify(result.config?.tools) !== JSON.stringify(before.config?.tools) ||
                JSON.stringify(result.config?.toolConfig) !==
                  JSON.stringify(before.config?.toolConfig)
              ) {
                return undefined;
              }
              return { body: result };
            },
          }),
      ...(hookOnResponse === undefined
        ? {}
        : {
            async onResponse(input: any) {
              if (typeof input.body !== "string" || input.body === "") return undefined;
              let reply: any;
              try {
                reply = JSON.parse(input.body);
              } catch {
                return undefined;
              }
              if (!isObject(reply)) return undefined;
              await hookOnResponse(
                reply,
                asyncHookCtx(input, await optionsNow(), {
                  success: input.status >= 200 && input.status < 400,
                }),
              );
              return undefined;
            },
          }),
    });
  }
`
    : "";
  const middlewareRegistration = hasMiddleware
    ? `
  if (
    middlewareOnRequest ||
    middlewareOnProvider ||
    middlewareOnAccount ||
    middlewareOnEvent ||
    middlewareOnResponse
  ) {
    server.registerGatewayMiddleware({
      id: "middleware",
      ...(middlewareOnRequest === undefined
        ? {}
        : {
            async onRequest(input: any) {
              let rejected: any = null;
              const ctx = middlewareCtx(input, await optionsNow(), {
                reject(status: any, message: any) {
                  rejected ??= {
                    ...(typeof status === "number" ? { status } : {}),
                    ...(typeof message === "string" ? { message } : {}),
                  };
                },
              });
              const result = await middlewareOnRequest(input.body, ctx);
              if (rejected !== null) return { reject: rejected };
              return isObject(result) ? { body: result } : undefined;
            },
          }),
      ...(middlewareOnProvider === undefined
        ? {}
        : {
            async onProvider(input: any) {
              const ctx = middlewareCtx(input, await optionsNow(), {
                provider: providerContext(input),
              });
              const result = await middlewareOnProvider(input.body, ctx);
              return isObject(result) ? { body: result } : undefined;
            },
          }),
      ...(middlewareOnAccount === undefined
        ? {}
        : {
            async onAccount(input: any) {
              const account = accountContext(input);
              const result = await middlewareOnAccount(
                account,
                middlewareCtx(input, await optionsNow(), { account }),
              );
              return isObject(result) && result.skip === true ? { skip: true } : undefined;
            },
          }),
      ...(middlewareOnEvent === undefined
        ? {}
        : {
            async onEvent(input: any) {
              if (!wantsEvent(eventNames, input.event)) return undefined;
              const ctx = middlewareCtx(input, await optionsNow(), {
                ...(input.accountId ? { account: accountContext(input) } : {}),
              });
              const result = await middlewareOnEvent(input.event, ctx);
              if (result === null) return { event: null };
              return isObject(result) ? { event: result } : undefined;
            },
          }),
      ...(middlewareOnResponse === undefined
        ? {}
        : {
            async onResponse(input: any) {
              if (typeof input.body !== "string" || input.body === "") return undefined;
              let parsed: any;
              try {
                parsed = JSON.parse(input.body);
              } catch {
                return undefined;
              }
              if (!isObject(parsed)) return undefined;
              const ctx = middlewareCtx(input, await optionsNow(), {
                status: input.status,
                ...(input.accountId ? { account: accountContext(input) } : {}),
              });
              const result = await middlewareOnResponse(parsed, ctx);
              return isObject(result) ? { body: JSON.stringify(result) } : undefined;
            },
          }),
    });
  }
  if (isObject(strategyTable)) {
    for (const [name, entry] of Object.entries(strategyTable)) {
      const order =
        typeof entry === "function"
          ? entry
          : isObject(entry) && typeof entry.order === "function"
            ? entry.order
            : undefined;
      if (order === undefined) continue;
      server.registerRoutingStrategy({
        id: name,
        async order(input: any) {
          return order(input.pool, input.seats, await optionsNow());
        },
      });
    }
  }
  if (typeof usageHook === "function") {
    server.registerGatewayUsageObserver({
      id: "usage",
      async onUsage(row: any) {
        await usageHook(usageRow(row), await optionsNow());
      },
    });
  }
`
    : "";
  return `${middlewareValues}${hookValues}
function middlewareCtx(input: any, options: any, extra: any) {
  return {
    protocol: input.protocol,
    model: input.model,
    stream: isObject(input.body) && input.body.stream === true,
    options,
    state: input.state ?? {},
    reject() {},
    ...extra,
  };
}

function asyncHookCtx(input: any, options: any, extra: any) {
  return {
    protocol: input.protocol,
    model: input.model,
    stream: isObject(input.body) && input.body.stream === true,
    options,
    state: input.state ?? {},
    signal: AbortSignal.timeout(250),
    report() {},
    ...extra,
  };
}

function providerContext(input: any) {
  return {
    id: input.providerId,
    name: input.providerId,
    ...(typeof input.accountId === "string" && input.accountId !== ""
      ? { account: input.accountId }
      : {}),
    model: input.model,
  };
}

function accountContext(input: any) {
  return {
    ref: input.accountId,
    provider: input.providerId,
    name: input.accountId,
    kind: "",
    model: input.model,
  };
}

function wantsEvent(names: any, event: any): boolean {
  if (!Array.isArray(names)) return true;
  const type = isObject(event) && typeof event.type === "string" ? event.type : "";
  return names.includes(type);
}

function usageRow(row: any): any {
  const output: any = {
    time: typeof row.time === "string" ? Date.parse(row.time) || 0 : 0,
    provider: row.provider,
    model: row.model,
    requested: row.requested,
    status: row.status,
    input: row.inputTokens,
    output: row.outputTokens,
    ms: row.durationMs,
    tries: row.attempts,
    cost: row.priced === false ? null : row.costUsd,
  };
  if (typeof row.account === "string") output.providerAccount = row.account;
  for (const key of ["operation", "agent", "errType", "kind"]) {
    if (row[key] !== undefined) output[key] = row[key];
  }
  if (row.rejected !== undefined) output.rejected = row.rejected;
  return output;
}

function contributeGateway(server: PluginServerContext) {${hookRegistration}${middlewareRegistration}}
`;
}

/** The `magpie.agent` module as a Neox agent integration. */
function renderAdapterAgent(): string {
  return `
const agentDescriptor = isObject(mynaAgent.agent)
  ? mynaAgent.agent
  : isObject(mynaAgent.default) && isObject(mynaAgent.default.agent)
    ? mynaAgent.default.agent
    : null;
const agentConnect = pick(mynaAgent, "connect");

function agentFormatOf(descriptor: any): "json" | "yaml" | "env" | undefined {
  if (descriptor.format === "json" || descriptor.format === "yaml" || descriptor.format === "env") {
    return descriptor.format;
  }
  const config = typeof descriptor.config === "string" ? descriptor.config.toLowerCase() : "";
  const base = config.split("/").pop() ?? "";
  if (base.startsWith(".env")) return "env";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "yaml";
  if (base.endsWith(".json") || base.endsWith(".jsonc")) return "json";
  return undefined;
}

function contributeAgent(server: PluginServerContext) {
  const descriptor = agentDescriptor;
  if (!isObject(descriptor)) {
    throw new Error("myna plugin " + PACKAGE + " has no agent object");
  }
  const id = typeof descriptor.id === "string" ? descriptor.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) {
    throw new Error("myna plugin " + PACKAGE + " has an invalid agent.id: " + id);
  }
  const config = typeof descriptor.config === "string" ? descriptor.config.trim() : "";
  if (config === "") throw new Error("myna plugin " + PACKAGE + " names no agent.config");
  const modelPath = typeof descriptor.model === "string" ? descriptor.model.trim() : "";
  if (modelPath === "" && agentConnect === undefined) {
    throw new Error("myna plugin " + PACKAGE + " names no agent.model and has no connect");
  }
  const prefix = typeof descriptor.prefix === "string" ? descriptor.prefix : "";
  const format = agentFormatOf(descriptor);
  server.registerAgentIntegration({
    id,
    label:
      typeof descriptor.name === "string" && descriptor.name.trim() ? descriptor.name.trim() : id,
    config,
    ...(format === undefined ? {} : { format }),
    ...(prefix === "" && modelPath !== "" ? { model: modelPath } : {}),
    async connect(input) {
      const mynaWiring: any = {
        gateway: { url: input.gateway.v1, v1: input.gateway.v1, key: input.gateway.key },
        models: input.models.map((entry: string) => ({
          id: entry,
          name: entry,
          context: 0,
          output: 0,
          images: false,
          efforts: [],
        })),
        agent: { id, config },
      };
      if (modelPath !== "") {
        mynaWiring.model = {
          id: input.model,
          name: input.model,
          context: 0,
          output: 0,
          images: false,
          efforts: [],
        };
      }
      const output = agentConnect === undefined ? {} : await agentConnect(mynaWiring);
      const settings: Record<string, any> = isObject(output) ? { ...output } : {};
      if (modelPath !== "") delete settings[modelPath];
      if (modelPath !== "" && prefix !== "") settings[modelPath] = prefix + input.model;
      return settings;
    },
  });
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
  const hasRuntime =
    myna.entry !== null ||
    myna.middlewarePath !== null ||
    myna.hooksPath !== null ||
    myna.agentPath !== null;
  if (
    (hasRuntime || hasMynaWindow(myna.window)) &&
    (await isFile(path.join(directory, ADAPTER_ENTRY)))
  ) {
    throw new Error(
      `myna plugin "${myna.name}" already has ${ADAPTER_ENTRY}; Neox cannot add its converter entry`,
    );
  }
  const windowAssets = hasMynaWindow(myna.window)
    ? await writeMynaWebAssets(directory, myna.window, myna.pluginId, myna.name)
    : null;
  const hasWindowContributions =
    windowAssets !== null && windowAssets.views.length > 0 ? windowAssets.contributions : null;
  await writeFile(
    path.join(directory, NEOLIX_MANIFEST),
    `${JSON.stringify(
      {
        id: myna.pluginId,
        name: myna.name,
        description: `Converted myna plugin: ${myna.name}`,
        requirements: { neolix: ">=0.15.0" },
        ...(hasWindowContributions ? { contributions: hasWindowContributions } : {}),
        ...(windowAssets && windowAssets.views.length > 0
          ? { web: { views: windowAssets.views } }
          : {}),
      },
      null,
      2,
    )}\n`,
  );
  if (hasRuntime || hasMynaWindow(myna.window)) {
    const entrySpecifier = hasRuntime ? await vendorSources(myna) : null;
    const middlewareSpecifier =
      myna.middlewarePath === null ? null : vendoredSpecifier(myna, myna.middlewarePath);
    const hooksSpecifier = myna.hooksPath === null ? null : vendoredSpecifier(myna, myna.hooksPath);
    const agentSpecifier = myna.agentPath === null ? null : vendoredSpecifier(myna, myna.agentPath);
    await writeFile(
      path.join(directory, ADAPTER_ENTRY),
      renderAdapter(myna, entrySpecifier, middlewareSpecifier, hooksSpecifier, agentSpecifier),
    );
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
    `"${myna.name}" is a myna plugin. Neox can convert its tools, search, providers, gateway middleware, agent wiring and pages only for npm or git sources, where it writes the adapter into a managed copy; install it from npm or port it to a Neox plugin.`,
  );
}
