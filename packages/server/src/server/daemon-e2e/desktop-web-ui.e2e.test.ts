import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { getAgentProviderDefinition } from "@neolix/protocol/provider-manifest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type {
  AgentLaunchContext,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  FetchCatalogOptions,
  ProviderCatalog,
} from "../agent/agent-sdk-types.js";
import {
  MockLoadTestAgentClient,
  MockLoadTestAgentSession,
} from "../agent/providers/mock-load-test-agent.js";
import { createTestNeolixDaemon, type TestNeolixDaemon } from "../test-utils/neolix-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { readDaemonInstance, stopDaemonInstance } from "../daemon-instance.js";
import { resolveWebAppPaths, webAppCandidates } from "../web-app.js";

/**
 * The real desktop web app in a real browser against an isolated daemon: the page the
 * daemon serves on its own port, the browser's `/rpc` transport, and the mock provider.
 *
 * It lives beside the other daemon e2e suites because that is where the harness already
 * is — `createTestNeolixDaemon` gives each case a temp home, a free port, the real web
 * app, and a daemon it can stop and start again on the same port.
 */

const webAppPaths = await resolveWebAppPaths(webAppCandidates({ env: process.env }));
if (webAppPaths === null) {
  throw new Error(
    "The daemon web app build is missing. Run `npm run build:daemon-web-app` before this suite.",
  );
}

const TEST_TIMEOUT_MS = 180_000;
const HOOK_TIMEOUT_MS = 120_000;
const FAST_MODEL_ID = "ten-second-stream";
const STREAM_CLOSING_TEXT = /For now, I'll stop here so you can take a look/;
const RECONNECT_TEXT = /Reconnecting to Neox|Disconnected from Neox\./;
const SEARCH_TOKEN = "zephyrquux";
const PROMPT = `Investigate the ${SEARCH_TOKEN} anchor behavior in the conversation list`;

/**
 * The web client's `ProviderKind` has no dev ids, so the mock load-test traffic runs
 * under the `codex` driver: same daemon sessions, same streaming, no vendor account.
 * Its default stream model is five minutes; this suite pins the ten-second one.
 *
 * The base mock keeps its replayable history in memory only. A real provider's session
 * replays its own transcript on resume, and the daemon rebuilds a thread's timeline from
 * that replay; without one, a daemon restart legitimately looks like an empty thread.
 * Test double only: append the timeline events to a per-session file and stream them
 * back from `streamHistory`.
 */
class CodexMockAgentSession extends MockLoadTestAgentSession {
  override readonly provider = "codex";
  private readonly recordedEvents = new WeakSet<object>();

  constructor(options: { config: AgentSessionConfig; sessionId: string; historyFile: string }) {
    super({ config: options.config, sessionId: options.sessionId });
    this.historyFile = options.historyFile;
  }

  private readonly historyFile: string;

  override subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    return super.subscribe((event) => {
      if (!this.recordedEvents.has(event)) {
        this.recordedEvents.add(event);
        if (event.type === "timeline") {
          try {
            appendFileSync(this.historyFile, `${JSON.stringify(event)}\n`);
          } catch {
            // A failed test-double write must not fail the agent stream.
          }
        }
      }
      callback(event);
    });
  }

  override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    let raw = "";
    try {
      raw = await readFile(this.historyFile, "utf8");
    } catch {
      raw = "";
    }
    let replayed = 0;
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const event = JSON.parse(line) as AgentStreamEvent;
        if (event.type !== "timeline") continue;
        replayed += 1;
        yield event;
      } catch {
        // A partial last line is not history.
      }
    }
    if (replayed === 0) {
      yield* super.streamHistory();
    }
  }
}

class CodexMockAgentClient extends MockLoadTestAgentClient {
  override readonly provider = "codex";

  constructor(private readonly historyDir: string) {
    super();
    mkdirSync(historyDir, { recursive: true });
  }

  private historyFile(sessionId: string): string {
    return path.join(this.historyDir, `${sessionId}.jsonl`);
  }

  override async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    // The codex driver's own default model is a real vendor id the mock does not know;
    // unknown ids fall back to its five-minute stream. Pin the short one instead.
    const sessionId = randomUUID();
    return new CodexMockAgentSession({
      config: { ...config, model: FAST_MODEL_ID },
      sessionId,
      historyFile: this.historyFile(sessionId),
    });
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    return new CodexMockAgentSession({
      config: {
        cwd: metadata.cwd ?? overrides?.cwd ?? process.cwd(),
        ...metadata,
        ...overrides,
        provider: "codex",
        model: FAST_MODEL_ID,
      },
      sessionId: handle.sessionId,
      historyFile: this.historyFile(handle.sessionId),
    });
  }

  override async fetchCatalog(options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const catalog = await super.fetchCatalog(options);
    return {
      models: catalog.models.map(asCodexModel),
      modes: getAgentProviderDefinition("codex").modes,
    };
  }
}

function asCodexModel(model: AgentModelDefinition): AgentModelDefinition {
  return { ...model, provider: "codex", isDefault: model.id === FAST_MODEL_ID };
}

const DISABLED_PROVIDERS = [
  "claude",
  "copilot",
  "opencode",
  "pi",
  "omp",
  "mock",
  "mock-slow",
] as const;

const PROVIDER_OVERRIDES = Object.fromEntries(
  DISABLED_PROVIDERS.map((provider) => [provider, { enabled: false }]),
);

interface StartedDaemon {
  readonly daemon: TestNeolixDaemon;
  readonly baseUrl: string;
  readonly port: number;
  readonly homeRoot: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected a TCP address"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function removeDirectory(directory: string): Promise<void> {
  return rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function startDaemon(
  options: {
    homeRoot?: string;
    port?: number;
    webUi?: boolean;
    /** Another copy of the bridge bundle; a fresh module instance gets a fresh server id. */
    bundlePath?: string;
  } = {},
): Promise<StartedDaemon> {
  const homeRoot =
    options.homeRoot ?? (await mkdtemp(path.join(os.tmpdir(), "neolix-desktop-web-e2e-")));
  const port = options.port ?? (await freePort());
  const daemon = await createTestNeolixDaemon({
    neolixHomeRoot: homeRoot,
    listenPort: port,
    isDev: true,
    mcpEnabled: false,
    cleanup: false,
    webApp: [
      options.bundlePath === undefined
        ? webAppPaths!
        : { bundlePath: options.bundlePath, distDir: webAppPaths!.distDir },
    ],
    ...(options.webUi ? { webUi: { enabled: true, distDir: webAppPaths!.distDir } } : {}),
    agentClients: {
      codex: new CodexMockAgentClient(path.join(homeRoot, ".neox", "mock-agent-history")),
    },
    providerOverrides: PROVIDER_OVERRIDES,
  });
  return { daemon, baseUrl: `http://127.0.0.1:${port}`, port, homeRoot };
}

/**
 * Stops first and removes second: `daemon.stop()` resolves once the daemon's writers are
 * gone, so the removal never races an open file (the ENOTEMPTY failure mode).
 */
async function stopDaemon(started: StartedDaemon, options: { keepHome?: boolean } = {}) {
  await started.daemon.close();
  await removeDirectory(started.daemon.staticDir);
  if (options.keepHome !== true) {
    await removeDirectory(started.homeRoot);
  }
}

const SERVER_ROOT = path.resolve(import.meta.dirname, "../../..");
const SUPERVISOR_ENTRY = path.join(SERVER_ROOT, "scripts/supervisor-entrypoint.ts");

interface SupervisorHarness {
  readonly homeRoot: string;
  readonly port: number;
  readonly supervisor: ChildProcess;
  readonly output: () => string;
}

const supervisorHarnesses: SupervisorHarness[] = [];

afterEach(async () => {
  for (const harness of supervisorHarnesses.splice(0)) {
    await stopDaemonInstance(harness.homeRoot, {
      force: true,
      timeoutMs: 15_000,
    }).catch(() => undefined);
    const pid = harness.supervisor.pid;
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await removeDirectory(harness.homeRoot);
  }
});

/**
 * A real supervisor process, the way the app runs a daemon: `settings restart` is
 * answered by the worker exiting and the supervisor spawning a replacement, which an
 * in-process test daemon cannot exercise (its pid never changes).
 */
async function startSupervisorDaemon(): Promise<SupervisorHarness> {
  const homeRoot = await mkdtemp(path.join(os.tmpdir(), "neolix-e2e-supervisor-"));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("NEOLIX_")),
    ),
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    NEOLIX_HOME: homeRoot,
    NEOLIX_LISTEN: `127.0.0.1:${port}`,
    NEOLIX_RELAY_ENABLED: "false",
    NEOLIX_NODE_INSPECT: "0",
    NEOLIX_LOCAL_SPEECH_AUTO_DOWNLOAD: "0",
    NEOLIX_DICTATION_ENABLED: "0",
    NEOLIX_VOICE_MODE_ENABLED: "0",
    CI: "true",
  };
  let output = "";
  const supervisor = spawn(
    process.execPath,
    ["--import", "tsx", SUPERVISOR_ENTRY, "--dev", "--no-relay", "--no-mcp"],
    { cwd: SERVER_ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  supervisor.stdout?.on("data", (chunk) => (output = (output + String(chunk)).slice(-20_000)));
  supervisor.stderr?.on("data", (chunk) => (output = (output + String(chunk)).slice(-20_000)));
  const harness: SupervisorHarness = { homeRoot, port, supervisor, output: () => output };
  supervisorHarnesses.push(harness);
  await waitForWebApp(`http://127.0.0.1:${port}`);
  await expect
    .poll(async () => (await readDaemonInstance(homeRoot))?.pid ?? null, {
      timeout: 60_000,
      interval: 200,
    })
    .not.toBeNull();
  return harness;
}

/** Pollable form: a worker mid-restart answers nothing at all. */
async function daemonWorkerPidOrNull(harness: SupervisorHarness): Promise<number | null> {
  try {
    return await daemonWorkerPid(harness);
  } catch {
    return null;
  }
}

/** The pid `daemon.get_status` reports: the worker the supervisor replaces on restart. */
async function daemonWorkerPid(harness: SupervisorHarness): Promise<number> {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${harness.port}/ws`,
    connectTimeoutMs: 5_000,
  });
  try {
    await client.connect();
    return (await client.getDaemonStatus()).pid;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForWebApp(baseUrl: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await fetch(`${baseUrl}/`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 30_000, interval: 100 },
    )
    .toBe(200);
}

async function openContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: "UTC",
  });
  return { context, page: await context.newPage() };
}

function watchConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function completeOnboarding(page: Page): Promise<void> {
  const skipIntro = page.getByRole("button", { name: "Skip intro", exact: true });
  await skipIntro.waitFor({ state: "visible", timeout: 45_000 });
  await skipIntro.click();
  // The dialog keeps a fading backdrop in the DOM; the shell is not interactive until
  // that portal is gone.
  await page
    .locator('[data-slot="dialog-backdrop"]')
    .first()
    .waitFor({ state: "hidden", timeout: 15_000 });
  await page.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 30_000 });
}

interface GitProject {
  readonly directory: string;
  readonly name: string;
}

async function createGitProject(): Promise<GitProject> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "neolix-e2e-project-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Neolix E2E"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "e2e@neolix.test"], { cwd: directory });
  await writeFile(path.join(directory, "README.md"), "# E2E project\n");
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: directory });
  return { directory, name: path.basename(directory) };
}

/** The Activity feed is the default surface; project rows live in the classic one. */
async function showClassicSidebar(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: "Switch to classic view", exact: true })
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("button", { name: "Switch to classic view", exact: true }).click();
}

async function createProjectInApp(page: Page, project: GitProject): Promise<void> {
  // The Projects section's toolbar (expand, display options, Add project) is revealed
  // on hover; the label must be hovered before its buttons accept pointer events.
  const projectsHeader = page.getByText("Projects", { exact: true }).first();
  await projectsHeader.waitFor({ state: "visible", timeout: 15_000 });
  await projectsHeader.hover();
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Create project" }).last();
  await dialog.waitFor({ state: "visible", timeout: 20_000 });
  const pathInput = dialog.getByRole("textbox", { name: "Project folder path", exact: true });
  const nameInput = dialog.getByRole("textbox", { name: "Project name", exact: true });
  // The dialog seeds its form (clearing `path` and focusing the name field) in an effect
  // that runs after the popup first paints. Filling before that lands lets the seed wipe the
  // typed path, so submit then reports "Choose a source folder" and the dialog never closes.
  // Its own focus move is the readiness signal; assert the values stuck before clicking.
  await expect
    .poll(() => nameInput.evaluate((element) => element === document.activeElement), {
      timeout: 15_000,
    })
    .toBe(true);
  await pathInput.fill(project.directory);
  await nameInput.fill(project.name);
  expect(await pathInput.inputValue()).toBe(project.directory);
  expect(await nameInput.inputValue()).toBe(project.name);
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 60_000 });
  // Creation opens a draft thread on the project, ready for the first message.
  await page.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 45_000 });
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const editor = page.getByTestId("composer-editor");
  await editor.click();
  await editor.fill(prompt);
  const send = page.locator('button[aria-label="Send message"]').first();
  await send.waitFor({ state: "visible", timeout: 30_000 });
  await expect.poll(() => send.isEnabled(), { timeout: 30_000 }).toBe(true);
  await send.click();
}

async function expectStreamedReply(page: Page, prompt: string): Promise<void> {
  const userRow = page.locator('[data-message-role="user"]').filter({ hasText: prompt }).first();
  await userRow.waitFor({ state: "visible", timeout: 30_000 });

  const assistant = page.locator('[data-message-role="assistant"]').last();
  await assistant.waitFor({ state: "visible", timeout: 30_000 });
  await expect
    .poll(async () => (await assistant.innerText()).trim().length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  // The reply grows while it streams; the final sentence and the Send button returning
  // are the user-visible end of the turn.
  const firstLength = (await assistant.innerText()).trim().length;
  await expect
    .poll(async () => (await assistant.innerText()).trim().length, { timeout: 20_000 })
    .toBeGreaterThan(firstLength);
  await page.getByText(STREAM_CLOSING_TEXT).first().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  // The stop control exists only while the turn runs; its removal is the turn's
  // user-visible end, whatever follow-up controls replace it.
  await page
    .locator('button[aria-label="Stop generation"]')
    .first()
    .waitFor({ state: "hidden", timeout: 60_000 });
}

/** The persisted assistant segment differs by where the synthetic turn settled. */
async function expectPersistedAssistantMessage(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (await page.locator('[data-message-role="assistant"]').allInnerTexts()).some(
          (text) => text.trim().length > 0,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function expectUserMessage(page: Page, text: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await page.locator('[data-message-role="user"]').allInnerTexts()).some((value) =>
          value.includes(text),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

function hasRpcSocket(sockets: string[]): boolean {
  return sockets.some((url) => url.includes("/rpc"));
}

/**
 * The transcript virtualizes its rows and a thread opens at its tail, so the request
 * that started the turn is not mounted until the list is scrolled to its oldest row.
 */
async function scrollTimelineToStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    const row = document.querySelector("[data-timeline-row-kind]");
    if (!row) return;
    for (let node = row.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 100) {
        node.scrollTop = 0;
        return;
      }
    }
  });
}

async function expectPersistedThread(
  page: Page,
  input: { prompt: string; threadUrl: string },
): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("composer-editor").waitFor({ state: "visible", timeout: 45_000 });
  await scrollTimelineToStart(page);
  await expectUserMessage(page, input.prompt);
  await expectPersistedAssistantMessage(page);
  expect(new URL(page.url()).pathname).toBe(new URL(input.threadUrl).pathname);
}

interface IsolatedSessionRoots {
  readonly codexHome: string;
  readonly root: string;
  restore(): void;
}

/**
 * Points every external-session reader at empty temp folders for the duration of a test:
 * the daemon resolves these roots from `process.env` when a client session is created.
 * Without it the import catalog would read this machine's real `~/.codex` and `~/.claude`.
 */
async function isolateExternalSessionRoots(prefix: string): Promise<IsolatedSessionRoots> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const codexHome = path.join(root, "codex");
  const overrides: Record<string, string> = {
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    PI_CODING_AGENT_DIR: path.join(root, "pi", "agent"),
    PI_CODING_AGENT_SESSION_DIR: path.join(root, "pi", "sessions"),
    XDG_DATA_HOME: path.join(root, "data"),
    AGY_DIR: path.join(root, "agy"),
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
    await mkdir(value, { recursive: true });
  }
  return {
    codexHome,
    root,
    restore() {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

async function readWebPageSettings(
  homeRoot: string,
): Promise<{ mode: string; port: number; key: string }> {
  const raw = JSON.parse(await readFile(path.join(homeRoot, ".neox", "web-page.json"), "utf8")) as {
    mode?: string;
    port?: number;
    key?: string;
  };
  return {
    mode: raw.mode ?? "off",
    port: typeof raw.port === "number" ? raw.port : 0,
    key: typeof raw.key === "string" ? raw.key : "",
  };
}

describe("desktop web UI against a real daemon", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await browser?.close();
  });

  test(
    "first run completes onboarding into the shell with a live RPC connection and no console errors",
    async () => {
      const started = await startDaemon();
      const { context, page } = await openContext(browser);
      const errors = watchConsoleErrors(page);
      const sockets: string[] = [];
      page.on("websocket", (socket) => sockets.push(socket.url()));

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });

        await page.getByRole("button", { name: "Get started" }).waitFor({
          state: "visible",
          timeout: 45_000,
        });
        await expect.poll(() => hasRpcSocket(sockets), { timeout: 20_000 }).toBe(true);

        await completeOnboarding(page);
        await page.getByTestId("composer-editor").waitFor({ state: "visible" });
        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await stopDaemon(started);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "creates a project, streams a mock reply, and keeps the thread after a reload",
    async () => {
      const project = await createGitProject();
      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await showClassicSidebar(page);

        await createProjectInApp(page, project);
        const threadUrl = page.url();
        await sendPrompt(page, PROMPT);
        await expectStreamedReply(page, PROMPT);

        await page.getByText(project.name, { exact: true }).first().waitFor({
          state: "visible",
          timeout: 15_000,
        });
        await expectPersistedThread(page, { prompt: PROMPT, threadUrl });
      } finally {
        await context.close();
        await stopDaemon(started);
        await removeDirectory(project.directory);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reconnects by itself after the daemon restarts and keeps the open thread",
    async () => {
      const project = await createGitProject();
      const started = await startDaemon();
      const { context, page } = await openContext(browser);
      const sockets: string[] = [];
      page.on("websocket", (socket) => sockets.push(socket.url()));
      // Node caches the embedded bridge module by file URL, so an in-process restart
      // would reuse its random server id. A byte-identical copy at another path is a
      // fresh module with a fresh id, which is what a real daemon process restart gives
      // the client. Without it the client keeps resume cursors from the old journal.
      const restartBundleDir = await mkdtemp(path.join(os.tmpdir(), "neolix-e2e-bundle-"));
      const restartBundlePath = path.join(restartBundleDir, "embed.js");
      await copyFile(webAppPaths!.bundlePath, restartBundlePath);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await showClassicSidebar(page);
        await createProjectInApp(page, project);
        await sendPrompt(page, PROMPT);
        await expectStreamedReply(page, PROMPT);

        const threadUrl = page.url();
        const connectionsBefore = sockets.length;
        const negotiateId = async (base: string) => {
          const query = new URLSearchParams({
            "x-synara-protocol-epoch": "1",
            "x-synara-protocol-min-revision": "3",
            "x-synara-protocol-max-revision": "3",
            "x-synara-client-build": "e2e",
          });
          const response = await fetch(`${base}/rpc/negotiate?${query}`);
          return ((await response.json()) as { serverInstanceId: string }).serverInstanceId;
        };
        const beforeInstance = await negotiateId(started.baseUrl);
        await stopDaemon(started, { keepHome: true });

        await page.getByText(RECONNECT_TEXT).first().waitFor({
          state: "visible",
          timeout: 30_000,
        });

        const restarted = await startDaemon({
          homeRoot: started.homeRoot,
          port: started.port,
          bundlePath: restartBundlePath,
        });
        try {
          await waitForWebApp(restarted.baseUrl);
          // The harness must present the same identity boundary as a real restart,
          // or this test would pass or fail on stale client cursors instead of
          // reconnect behavior.
          expect(await negotiateId(restarted.baseUrl)).not.toBe(beforeInstance);
          await expect
            .poll(() => sockets.length, { timeout: 60_000 })
            .toBeGreaterThan(connectionsBefore);
          await page.getByText(RECONNECT_TEXT).first().waitFor({
            state: "hidden",
            timeout: 60_000,
          });
          // The reconnected transcript is virtualized at its tail; mount the request row.
          await scrollTimelineToStart(page);
          await expectUserMessage(page, PROMPT);
          await expectPersistedAssistantMessage(page);
          expect(new URL(page.url()).pathname).toBe(new URL(threadUrl).pathname);
        } finally {
          await stopDaemon(restarted);
        }
      } finally {
        await context.close();
        await removeDirectory(project.directory);
        await removeDirectory(restartBundleDir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "restarts the daemon from Settings, waits for the new pid, and the page recovers",
    async () => {
      const harness = await startSupervisorDaemon();
      const baseUrl = `http://127.0.0.1:${harness.port}`;
      const { context, page } = await openContext(browser);
      const sockets: string[] = [];
      page.on("websocket", (socket) => sockets.push(socket.url()));

      try {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);

        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        await page.getByRole("button", { name: "Host & diagnostics", exact: true }).click();
        await page.getByText("Daemon lifecycle", { exact: true }).waitFor({
          state: "visible",
          timeout: 30_000,
        });

        const beforePid = await daemonWorkerPid(harness);
        const connectionsBefore = sockets.length;

        await page.getByRole("button", { name: "Restart", exact: true }).first().click();
        const confirm = page.getByRole("alertdialog");
        await confirm.waitFor({ state: "visible", timeout: 15_000 });
        await confirm.getByRole("button", { name: "Restart", exact: true }).click();

        // The supervisor answers the restart intent by replacing the worker; the UI is
        // waiting for exactly this pid change before it reports success.
        await expect
          .poll(() => daemonWorkerPidOrNull(harness), {
            timeout: 90_000,
            interval: 250,
          })
          .not.toBe(beforePid);
        await expect
          .poll(() => sockets.length, { timeout: 60_000 })
          .toBeGreaterThan(connectionsBefore);
        await page.getByText(RECONNECT_TEXT).first().waitFor({
          state: "hidden",
          timeout: 60_000,
        });
        // The settings panel finished waiting and is interactive again.
        await expect
          .poll(
            () => page.getByRole("button", { name: "Restart", exact: true }).first().isEnabled(),
            { timeout: 60_000 },
          )
          .toBe(true);
        await page.getByText("Daemon lifecycle", { exact: true }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
      } catch (error) {
        throw new Error(`${String(error)}\nSupervisor output:\n${harness.output()}`, {
          cause: error,
        });
      } finally {
        await context.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "opens the main settings sections without console errors",
    async () => {
      const started = await startDaemon();
      const { context, page } = await openContext(browser);
      const errors = watchConsoleErrors(page);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);

        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        await page.getByText("Core defaults", { exact: true }).waitFor({ timeout: 30_000 });

        await page.getByRole("button", { name: "Host & diagnostics", exact: true }).click();
        await page.getByText("Daemon", { exact: true }).first().waitFor({ timeout: 30_000 });

        await page.getByRole("button", { name: "Models", exact: true }).click();
        await page.getByRole("navigation", { name: "Models", exact: true }).waitFor({
          timeout: 30_000,
        });
        await page.getByRole("button", { name: "Overview", exact: true }).waitFor();

        await page.getByRole("button", { name: "Usage & quota", exact: true }).click();
        await page.getByText("Provider usage", { exact: true }).first().waitFor({
          timeout: 30_000,
        });

        await page.getByRole("button", { name: "Skills & extensions", exact: true }).click();
        await page.locator('[data-settings-tab="plugins"]').click();
        await page.getByRole("button", { name: /^Built-in/ }).click();
        await page.getByText("Built-in features", { exact: true }).waitFor({ timeout: 30_000 });

        expect(errors).toEqual([]);
      } finally {
        await context.close();
        await stopDaemon(started);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "turning the Usage built-in feature off hides its settings page",
    async () => {
      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);

        await page.getByRole("button", { name: "Settings", exact: true }).first().click();
        const usagePage = page.getByRole("button", { name: "Usage & quota", exact: true });
        await usagePage.waitFor({ state: "visible", timeout: 30_000 });

        await page.getByRole("button", { name: "Skills & extensions", exact: true }).click();
        await page.locator('[data-settings-tab="plugins"]').click();
        await page.getByRole("button", { name: /^Built-in/ }).click();
        await page.getByText("Built-in features", { exact: true }).waitFor({ timeout: 30_000 });

        const usageSwitch = page.getByRole("switch", { name: "Usage", exact: true });
        await usageSwitch.waitFor({ state: "visible", timeout: 15_000 });
        await usageSwitch.click();
        await expect
          .poll(() => usageSwitch.getAttribute("aria-checked"), { timeout: 15_000 })
          .toBe("false");
        await expect
          .poll(() => page.getByRole("button", { name: "Usage & quota", exact: true }).count(), {
            timeout: 15_000,
          })
          .toBe(0);
      } finally {
        await context.close();
        await stopDaemon(started);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "lists sessions in History and searches their messages",
    async () => {
      const project = await createGitProject();
      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await showClassicSidebar(page);
        await createProjectInApp(page, project);
        await sendPrompt(page, PROMPT);
        await expectStreamedReply(page, PROMPT);

        await page.goto(`${started.baseUrl}/history`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "History", exact: true }).waitFor({
          timeout: 30_000,
        });
        const search = page.getByRole("searchbox", { name: "Search sessions", exact: true });
        await search.waitFor({ state: "visible", timeout: 15_000 });
        const historyPanel = page.locator('div.max-w-4xl:has(input[type="search"])').first();

        await expect
          .poll(() => historyPanel.getByRole("button").filter({ hasText: project.name }).count(), {
            timeout: 30_000,
          })
          .toBeGreaterThan(0);

        await search.fill("no-such-session-token");
        await historyPanel.getByText("No sessions match", { exact: true }).waitFor({
          state: "visible",
          timeout: 15_000,
        });

        await search.fill(SEARCH_TOKEN);
        await expect
          .poll(() => historyPanel.getByRole("button").filter({ hasText: project.name }).count(), {
            timeout: 15_000,
          })
          .toBeGreaterThan(0);
        await expect
          .poll(() => historyPanel.getByText("No sessions match", { exact: true }).count())
          .toBe(0);
      } finally {
        await context.close();
        await stopDaemon(started);
        await removeDirectory(project.directory);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "serves Browser access locally with the key and refuses a keyless request",
    async () => {
      const pagePort = await freePort();
      const homeRoot = await mkdtemp(path.join(os.tmpdir(), "neolix-browser-access-e2e-"));
      await mkdir(path.join(homeRoot, ".neox"), { recursive: true });
      await writeFile(
        path.join(homeRoot, ".neox", "web-page.json"),
        `${JSON.stringify({ mode: "off", port: pagePort, key: "" })}\n`,
      );
      const started = await startDaemon({ homeRoot, webUi: true });
      const { context, page } = await openContext(browser);
      let keyedContext: BrowserContext | null = null;
      let keylessContext: BrowserContext | null = null;

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);

        await page.goto(`${started.baseUrl}/settings?section=network`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByText("Browser access", { exact: true }).waitFor({ timeout: 30_000 });
        await page.getByRole("radio", { name: "This computer", exact: true }).click();

        await expect
          .poll(async () => (await readWebPageSettings(homeRoot)).mode, { timeout: 30_000 })
          .toBe("local");
        const settings = await readWebPageSettings(homeRoot);
        expect(settings.key.length).toBeGreaterThanOrEqual(16);

        await expect
          .poll(
            async () => {
              try {
                return (await fetch(`http://127.0.0.1:${settings.port}/`, { redirect: "manual" }))
                  .status;
              } catch {
                return 0;
              }
            },
            { timeout: 30_000, interval: 100 },
          )
          .toBe(401);

        keyedContext = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: "en-US",
          timezoneId: "UTC",
        });
        const keyedPage = await keyedContext.newPage();
        const keyedResponse = await keyedPage.goto(
          `http://127.0.0.1:${settings.port}/?k=${encodeURIComponent(settings.key)}`,
          { waitUntil: "domcontentloaded" },
        );
        expect(keyedResponse?.status()).toBe(200);
        expect(new URL(keyedPage.url()).search).toBe("");
        // This daemon already finished onboarding above; the keyed browser lands in
        // the same usable shell rather than a second first-run tour.
        await keyedPage.getByTestId("composer-editor").waitFor({
          state: "visible",
          timeout: 45_000,
        });

        keylessContext = await browser.newContext({
          viewport: { width: 1440, height: 900 },
          locale: "en-US",
          timezoneId: "UTC",
        });
        const keylessPage = await keylessContext.newPage();
        const refused = await keylessPage.goto(`http://127.0.0.1:${settings.port}/`, {
          waitUntil: "domcontentloaded",
        });
        expect(refused?.status()).toBe(401);
        await keylessPage.getByText(/This page needs the key/).waitFor({
          state: "visible",
          timeout: 15_000,
        });
      } finally {
        await keyedContext?.close();
        await keylessContext?.close();
        await context.close();
        await stopDaemon(started);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "imports a constructed Codex session from an isolated CODEX_HOME",
    async () => {
      const project = await createGitProject();
      const roots = await isolateExternalSessionRoots("neolix-codex-import-e2e-");
      const sessionId = randomUUID();
      const sessionDir = path.join(roots.codexHome, "sessions", "2026", "11", "16");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        path.join(sessionDir, `rollout-2026-11-16T00-00-00-${sessionId}.jsonl`),
        [
          JSON.stringify({
            timestamp: "2026-11-16T00:00:00.000Z",
            type: "session_meta",
            payload: { id: sessionId, cwd: project.directory },
          }),
          JSON.stringify({
            timestamp: "2026-11-16T00:00:01.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Imported codex prompt" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-11-16T00:00:02.000Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Imported codex answer" }],
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await page.goto(`${started.baseUrl}/history`, { waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "History", exact: true }).waitFor({
          timeout: 30_000,
        });

        const openImportDialog = async () => {
          await page.getByRole("button", { name: "Import projects", exact: true }).click();
          const dialog = page.getByRole("dialog").filter({ hasText: "Import projects" }).last();
          await dialog.waitFor({ state: "visible", timeout: 20_000 });
          return dialog;
        };

        let dialog = await openImportDialog();
        await dialog.getByRole("button", { name: "Find projects", exact: true }).click();
        await dialog.getByText(project.directory, { exact: true }).waitFor({
          state: "visible",
          timeout: 30_000,
        });
        await dialog.getByRole("button", { name: "Import selected", exact: true }).click();
        await dialog
          .getByText(/imported or already present/)
          .first()
          .waitFor({
            state: "visible",
            timeout: 60_000,
          });
        // The turn reads "1 imported or already present": the bridge's `importProject` ran the
        // daemon import, not a no-op.
        await expect
          .poll(() => dialog.getByText(/^1 imported or already present/).count(), {
            timeout: 15_000,
          })
          .toBe(1);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden", timeout: 15_000 });

        // Reload and rescan: this catalog comes from `fetchAgents`, so the imported agent must
        // exist on disk under the same provider handle for the thread to show as already present.
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.getByRole("heading", { name: "History", exact: true }).waitFor({
          timeout: 30_000,
        });
        dialog = await openImportDialog();
        await dialog.getByRole("button", { name: "Find projects", exact: true }).click();
        const card = dialog.getByRole("button", {
          name: `Conversations in ${project.name}`,
          exact: true,
        });
        await card.waitFor({ state: "visible", timeout: 30_000 });
        await card.click();
        await dialog
          .getByText("Already present", { exact: true })
          .first()
          .waitFor({ state: "visible", timeout: 30_000 });
        await dialog.getByText("Imported codex prompt", { exact: true }).first().waitFor({
          state: "visible",
          timeout: 15_000,
        });
      } finally {
        await context.close();
        await stopDaemon(started);
        roots.restore();
        await removeDirectory(roots.root);
        await removeDirectory(project.directory);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "renders a provider question option's preview",
    async () => {
      const project = await createGitProject();
      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await showClassicSidebar(page);
        await createProjectInApp(page, project);
        await sendPrompt(page, "emit synthetic questions");

        const firstQuestion = page.getByText("Which surface should this apply to?", {
          exact: true,
        });
        await firstQuestion.waitFor({ state: "visible", timeout: 45_000 });
        const form = firstQuestion.locator("xpath=../..");
        await form.getByRole("button", { name: /App/ }).click();

        // Single-select answers auto-advance to the rollout question, whose second option
        // carries a system-prompt preview from the provider.
        await page.getByText("Which rollout should we use?", { exact: true }).waitFor({
          state: "visible",
          timeout: 15_000,
        });
        await page.getByText("Behind feature flag", { exact: true }).waitFor({
          state: "visible",
          timeout: 15_000,
        });
        await page.getByText('if (flags.enabled("new-surface")) {').waitFor({
          state: "visible",
          timeout: 15_000,
        });
        await page.getByText("LAST PREVIEW LINE").waitFor({
          state: "visible",
          timeout: 15_000,
        });
      } finally {
        await context.close();
        await stopDaemon(started);
        await removeDirectory(project.directory);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "answers with a provider-defined approval action",
    async () => {
      const project = await createGitProject();
      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await showClassicSidebar(page);
        await createProjectInApp(page, project);
        await sendPrompt(page, "emit synthetic provider approval");

        await page.getByText("MockProviderApproval", { exact: true }).waitFor({
          state: "visible",
          timeout: 45_000,
        });
        await page.getByRole("button", { name: /Approve once/ }).waitFor({
          state: "visible",
          timeout: 15_000,
        });
        const extraAction = page.getByRole("button", { name: /Implement and resume/ });
        await extraAction.waitFor({ state: "visible", timeout: 15_000 });
        await extraAction.click();

        // The mock provider only writes this id when the resolution carried it, so the row
        // proves the provider action crossed UI → bridge → daemon → provider.
        await page
          .getByText("Provider approval resolved: implement-resume", { exact: true })
          .waitFor({
            state: "visible",
            timeout: 30_000,
          });
      } finally {
        await context.close();
        await stopDaemon(started);
        await removeDirectory(project.directory);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "saves an OpenAI provider for one speech site",
    async () => {
      const started = await startDaemon();
      const { context, page } = await openContext(browser);

      try {
        await waitForWebApp(started.baseUrl);
        await page.goto(started.baseUrl, { waitUntil: "domcontentloaded" });
        await completeOnboarding(page);
        await page.goto(`${started.baseUrl}/settings?section=voice`, {
          waitUntil: "domcontentloaded",
        });
        await page.getByText("Dictation speech-to-text", { exact: true }).waitFor({
          state: "visible",
          timeout: 30_000,
        });

        await page.getByRole("button", { name: "Edit", exact: true }).first().click();
        const dialog = page.getByRole("dialog").last();
        await dialog.waitFor({ state: "visible", timeout: 15_000 });
        await dialog.getByRole("combobox").first().selectOption("openai");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();

        await expect
          .poll(
            async () => {
              try {
                const raw = JSON.parse(
                  await readFile(path.join(started.homeRoot, ".neox", "config.json"), "utf8"),
                ) as { features?: { dictation?: { stt?: { provider?: string } } } };
                return raw.features?.dictation?.stt?.provider ?? null;
              } catch {
                return null;
              }
            },
            { timeout: 30_000 },
          )
          .toBe("openai");
        await page.getByText("OpenAI · no key", { exact: true }).waitFor({
          state: "visible",
          timeout: 15_000,
        });
      } finally {
        await context.close();
        await stopDaemon(started);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
