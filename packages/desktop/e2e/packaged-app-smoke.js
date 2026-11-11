const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");
const { extractFile } = require("@electron/asar");
const { WebSocket } = require("ws");
const assert = require("node:assert/strict");

const EXECUTABLE_NAME = "Neox";
const SMOKE_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;
const TERMINAL_CAPTURE_ATTEMPTS = 20;
const TERMINAL_CAPTURE_INTERVAL_MS = 500;
const REQUIRED_DESKTOP_BRIDGE_KEYS = [
  "platform",
  "invoke",
  "getPendingOpenProject",
  "events",
  "window",
  "dialog",
  "notification",
  "opener",
  "editor",
  "webUtils",
  "menu",
  "browser",
];

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function assertBuiltinPluginsStarted(listen) {
  const { DaemonClient } = await import("@neolix/client/internal/daemon-client");
  const { builtinPlugins } =
    await import("../../server/dist/server/server/plugins/builtin/index.js");
  const client = new DaemonClient({
    url: `ws://${listen}/ws`,
    clientId: "packaged-builtin-smoke",
    webSocketFactory: (url, options) =>
      new WebSocket(url, options?.protocols, { headers: options?.headers }),
  });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    assert.deepEqual(
      catalog.map(({ id }) => id).sort(),
      [...builtinPlugins].sort(),
      "Every built-in plugin must start in the packaged desktop daemon",
    );
  } finally {
    await client.close();
  }
}

function assertExecutable(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist: ${filePath}`);
  }
  if (process.platform !== "win32") {
    fs.accessSync(filePath, fs.constants.X_OK);
  }
}

function getExecutablePath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
  }

  if (process.platform === "win32") {
    return path.join(appPath, `${EXECUTABLE_NAME}.exe`);
  }

  return path.join(appPath, EXECUTABLE_NAME);
}

function getCliShimPath(appPath) {
  if (process.platform === "darwin") {
    return path.join(appPath, "Contents", "Resources", "bin", "neolix");
  }

  if (process.platform === "win32") {
    return path.join(appPath, "resources", "bin", "neolix.cmd");
  }

  return path.join(appPath, "resources", "bin", "neolix");
}

function getMacMainExecutablePath(appPath) {
  return path.join(appPath, "Contents", "MacOS", EXECUTABLE_NAME);
}

function getLaunchCommand(executablePath, args) {
  if (process.platform !== "linux") {
    return {
      command: executablePath,
      args,
    };
  }

  return {
    command: "xvfb-run",
    args: ["-a", "--server-args=-screen 0 1280x800x24", executablePath, ...args],
  };
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellQuoteCliArg(value) {
  if (process.platform === "win32") {
    return `"${String(value).replace(/"/g, '""')}"`;
  }

  return shellQuote(String(value));
}

function getTerminalHookSmokeCommand(marker) {
  if (process.platform === "win32") {
    const script = [
      "& $env:NEOLIX_HOOK_CLI hooks codex Stop",
      "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
      `Write-Output '${marker}'`,
    ].join("; ");
    const encodedScript = Buffer.from(script, "utf16le").toString("base64");
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodedScript}`;
  }

  return `"$NEOLIX_HOOK_CLI" hooks codex Stop && echo ${marker}`;
}

function getShellCommand(script) {
  if (process.platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", script],
    };
  }

  return {
    command: "/bin/sh",
    args: ["-lc", script],
  };
}

function createDefaultDaemonEnv(extraEnv) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("NEOLIX_")),
    ),
    ...extraEnv,
  };
}

function createIsolatedDesktopEnv({ home, listen, userData, cdpPort }) {
  return {
    ...createDefaultDaemonEnv({ HOME: home, USERPROFILE: home }),
    NEOLIX_HOME: home,
    NEOLIX_LISTEN: listen,
    NEOLIX_ELECTRON_USER_DATA_DIR: userData,
    NEOLIX_ELECTRON_FLAGS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${cdpPort}`,
    // Chromium's own startup log goes to stderr, so a launch that stalls before the
    // app writes anything still shows how far the browser process got.
    ELECTRON_ENABLE_LOGGING: "1",
    // main.ts appends every require and startup phase here (diagnostics/startup-trace.ts).
    NEOLIX_DESKTOP_STARTUP_TRACE: startupTracePath(userData),
  };
}

function startupTracePath(userData) {
  return path.join(userData, "startup-trace.log");
}

function configureIsolatedDaemonHome(home, listen) {
  fs.writeFileSync(
    path.join(home, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        daemon: {
          listen,
          relay: { enabled: false },
          mcp: { enabled: false, injectIntoAgents: false },
        },
      },
      null,
      2,
    )}\n`,
  );
}

function reserveLocalTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a TCP port for smoke test")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForFile(filePath, label) {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const contents = fs.readFileSync(filePath, "utf8");
      if (contents.trim().length > 0) {
        return contents;
      }
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}: ${filePath}`);
}

async function waitForChildPids(parentPid) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const childPids = listChildPids(parentPid);
    if (childPids.length > 0) {
      return childPids;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for daemon worker child of supervisor PID ${parentPid}`);
}

function listChildPids(parentPid) {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ps failed while listing child processes: ${result.stderr.trim()}`);
  }

  const children = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pidText, ppidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    if (Number.isInteger(pid) && ppid === parentPid) {
      children.push(pid);
    }
  }
  return children;
}

function listDarwinTextExecutables(pid) {
  const result = spawnSync("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `lsof failed while inspecting PID ${pid}: ${
        result.stderr.trim() || result.stdout.trim() || "<empty>"
      }`,
    );
  }

  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
}

function assertDarwinProcessDoesNotUseMainAppExecutable({ appPath, pid, label }) {
  const mainExecutablePath = getMacMainExecutablePath(appPath);
  assertExecutable(mainExecutablePath, "Packaged app executable");

  const textExecutables = listDarwinTextExecutables(pid);
  if (textExecutables.includes(mainExecutablePath)) {
    throw new Error(
      `${label} PID ${pid} launched through the main app executable ${mainExecutablePath}.\nText executables:\n${textExecutables.join(
        "\n",
      )}`,
    );
  }
}

function readIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

// electron-log writes to the platform log folder for the app name, not under userData:
// HOME is the isolated daemon home here, but Windows resolves %APPDATA% itself.
function desktopLogCandidates(userData, daemonHome) {
  return [
    path.join(userData, "logs", "main.log"),
    path.join(daemonHome, "Library", "Logs", EXECUTABLE_NAME, "main.log"),
    path.join(daemonHome, ".config", EXECUTABLE_NAME, "logs", "main.log"),
    ...(process.env.APPDATA
      ? [path.join(process.env.APPDATA, EXECUTABLE_NAME, "logs", "main.log")]
      : []),
  ];
}

function collectLogFiles(root, depth = 4) {
  if (depth < 0 || !fs.existsSync(root)) {
    return [];
  }
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectLogFiles(entryPath, depth - 1));
    } else if (entry.name.endsWith(".log")) {
      found.push(entryPath);
    }
  }
  return found;
}

// A Windows launch that never opens its debugging port leaves no stdout and no log in
// the usual places, so record what the app process spawned (a child stuck in a
// synchronous call shows up here) and every log file it wrote anywhere.
function describeWindowsLaunch(rootPid, userData, daemonHome) {
  const listing = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
  );
  let tree = `<process listing failed: ${listing.error ?? listing.stderr}>`;
  try {
    const processes = JSON.parse(listing.stdout);
    const descendants = new Set([rootPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const proc of processes) {
        if (descendants.has(proc.ParentProcessId) && !descendants.has(proc.ProcessId)) {
          descendants.add(proc.ProcessId);
          grew = true;
        }
      }
    }
    // Other app processes are listed too: one left by the CLI cold start would hold the
    // single-instance lock this launch waits on.
    tree = processes
      .filter((proc) => descendants.has(proc.ProcessId) || proc.Name === `${EXECUTABLE_NAME}.exe`)
      .map(
        (proc) => `${proc.ProcessId} <- ${proc.ParentProcessId} ${proc.Name}: ${proc.CommandLine}`,
      )
      .join("\n");
  } catch {
    // Keep the failure message above.
  }

  const logRoots = [
    userData,
    daemonHome,
    ...[process.env.APPDATA, process.env.LOCALAPPDATA]
      .filter(Boolean)
      .map((dir) => path.join(dir, EXECUTABLE_NAME)),
  ];
  const logs = logRoots.flatMap((root) => collectLogFiles(root));
  // The startup trace's last lines locate a hang; keep enough of it to see the phases.
  const logText = logs
    .map((file) => `--- ${file}\n${fs.readFileSync(file, "utf8").slice(-12_000)}`)
    .join("\n");
  return `App process tree:\n${tree || "<empty>"}\n\nLog files:\n${logText || "<none>"}`;
}

function formatLogs({ stdout, stderr, userData, daemonHome }) {
  const desktopLog = desktopLogCandidates(userData, daemonHome)
    .map((candidate) => readIfExists(candidate))
    .find((contents) => contents?.trim());
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  return [
    `App stdout:\n${stdout.join("").trim() || "<empty>"}`,
    `App stderr:\n${stderr.join("").trim() || "<empty>"}`,
    `Desktop log:\n${desktopLog?.trim() || "<missing>"}`,
    `Daemon log:\n${daemonLog?.trim() || "<missing>"}`,
  ].join("\n\n");
}

async function writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome, error }) {
  const artifactDir = process.env.NEOLIX_DESKTOP_SMOKE_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, error ? "failure.txt" : "success.txt"),
    `${error instanceof Error ? (error.stack ?? error.message) : String(error ?? "Packaged desktop smoke passed")}\n\n${formatLogs(
      {
        stdout,
        stderr,
        userData,
        daemonHome,
      },
    )}\n`,
  );

  const desktopLog = readIfExists(path.join(userData, "logs", "main.log"));
  if (desktopLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "desktop-main.log"), desktopLog);
  }
  const daemonLog = readIfExists(path.join(daemonHome, "daemon.log"));
  if (daemonLog !== null) {
    fs.writeFileSync(path.join(artifactDir, "daemon.log"), daemonLog);
  }

  if (page) {
    const renderer = await page
      .evaluate(() => ({
        url: window.location.href,
        title: document.title,
        rootChildCount: document.querySelector("#root")?.childElementCount ?? 0,
        rootText: document.querySelector("#root")?.textContent?.trim().slice(0, 2_000) ?? "",
        bridgeKeys:
          typeof window.neolixDesktop === "object" && window.neolixDesktop !== null
            ? Object.keys(window.neolixDesktop)
            : [],
      }))
      .catch((evaluationError) => ({ evaluationError: String(evaluationError) }));
    fs.writeFileSync(
      path.join(artifactDir, "renderer.json"),
      `${JSON.stringify(renderer, null, 2)}\n`,
    );
    await page
      .screenshot({ path: path.join(artifactDir, "renderer.png"), fullPage: true })
      .catch(() => undefined);
  }
}

function isRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function terminateChild(child, signal = "SIGTERM") {
  if (!isRunning(child)) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }

  child.kill(signal);
}

function waitForChildExit(child, timeoutMs = EXIT_TIMEOUT_MS) {
  if (!isRunning(child)) {
    return Promise.resolve(true);
  }

  let onExit;
  const exitPromise = new Promise((resolve) => {
    onExit = () => resolve(true);
    child.once("exit", onExit);
  });

  return Promise.race([exitPromise, delay(timeoutMs, false)]).finally(() => {
    child.off("exit", onExit);
  });
}

function releaseChildHandles(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

async function removeTempDir(tempDir) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 4) {
        console.warn(`Packaged desktop smoke: failed to remove temp dir ${tempDir}: ${error}`);
        return;
      }
      await delay(250);
    }
  }
}

function remainingTime(deadline) {
  return Math.max(1, deadline - Date.now());
}

async function connectToPackagedApp({
  child,
  cdpPort,
  stdout,
  stderr,
  userData,
  daemonHome,
  deadline,
}) {
  let lastError = null;

  while (Date.now() < deadline) {
    if (!isRunning(child)) {
      throw new Error(
        `Packaged app exited before opening its debugging endpoint (code ${child.exitCode}, signal ${
          child.signalCode ?? "none"
        }).\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
      );
    }

    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }

  const windowsLaunch =
    process.platform === "win32"
      ? `\n\n${describeWindowsLaunch(child.pid, userData, daemonHome)}`
      : "";
  throw new Error(
    `Timed out connecting to the packaged app over CDP: ${lastError}.\n${formatLogs({
      stdout,
      stderr,
      userData,
      daemonHome,
    })}${windowsLaunch}`,
  );
}

// The main window loads the desktop web UI from its local bridge
// (main.ts createWindow, desktopWebBaseUrl); the origin is only known once
// the bridge logs it. neolix://app/ is the bundled-app fallback.
const DESKTOP_WEB_BRIDGE_READY = /desktop web bridge ready at (http:\/\/127\.0\.0\.1:\d+)/;

async function waitForPackagedAppPage(browser, stdout, deadline) {
  while (Date.now() < deadline) {
    const bridgeOrigin = stdout.join("").match(DESKTOP_WEB_BRIDGE_READY)?.[1];
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => {
        const url = candidate.url();
        return (
          url.startsWith("neolix://app/") ||
          (bridgeOrigin !== undefined && url.startsWith(`${bridgeOrigin}/`))
        );
      });
    if (page) {
      return page;
    }
    await delay(250);
  }
  throw new Error(
    "Timed out waiting for the packaged app renderer (desktop web bridge or neolix://app/)",
  );
}

async function assertPackagedRendererLoaded(page, deadline) {
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#root");
      return root instanceof HTMLElement && root.childElementCount > 0;
    },
    undefined,
    { timeout: remainingTime(deadline) },
  );

  const bridgeKeys = await page.evaluate(() =>
    typeof window.neolixDesktop === "object" && window.neolixDesktop !== null
      ? Object.keys(window.neolixDesktop)
      : [],
  );
  const missingBridgeKeys = REQUIRED_DESKTOP_BRIDGE_KEYS.filter((key) => !bridgeKeys.includes(key));
  if (missingBridgeKeys.length > 0) {
    throw new Error(
      `Packaged renderer is missing desktop preload bridge keys: ${missingBridgeKeys.join(", ")}. Present keys: ${bridgeKeys.join(", ") || "<none>"}`,
    );
  }
}

async function waitForRendererStartedDaemon({
  page,
  daemonHome,
  listen,
  stdout,
  stderr,
  userData,
  deadline,
}) {
  let lastStatus = null;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      lastStatus = await page.evaluate(() => window.neolixDesktop.invoke("desktop_daemon_status"));
      if (
        lastStatus?.status === "running" &&
        lastStatus.desktopManaged === true &&
        typeof lastStatus.pid === "number" &&
        typeof lastStatus.serverId === "string" &&
        lastStatus.serverId.length > 0 &&
        lastStatus.listen === listen &&
        path.resolve(lastStatus.home) === path.resolve(daemonHome)
      ) {
        return lastStatus;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }

  throw new Error(
    `Packaged renderer did not start its desktop-managed daemon. Last status: ${JSON.stringify(lastStatus)}. Last error: ${lastError}.\n${formatLogs({ stdout, stderr, userData, daemonHome })}`,
  );
}

function runShellCommand({ script, env, label }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const shell = getShellCommand(script);
    const child = spawn(shell.command, shell.args, {
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: process.platform === "win32",
    });
    const stdout = [];
    const stderr = [];

    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      releaseChildHandles(child);
      callback(value);
    };

    const timer = setTimeout(() => {
      terminateChild(child);
      finish(
        reject,
        new Error(
          `${label} timed out.\nStdout:\n${stdout.join("").trim() || "<empty>"}\n\nStderr:\n${
            stderr.join("").trim() || "<empty>"
          }`,
        ),
      );
    }, SMOKE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
    child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        finish(resolve, {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
        });
        return;
      }

      finish(
        reject,
        new Error(
          `${label} failed (code ${code}, signal ${signal ?? "none"}).\nStdout:\n${
            stdout.join("").trim() || "<empty>"
          }\n\nStderr:\n${stderr.join("").trim() || "<empty>"}`,
        ),
      );
    });
  });
}

function getCliShimScript(cliShimPath, args) {
  const commandArgs = args.map(shellQuoteCliArg).join(" ");
  if (process.platform === "win32") {
    return `call "${cliShimPath}" ${commandArgs}`;
  }

  return `${shellQuote(cliShimPath)} ${commandArgs}`;
}

async function runCliShimCommand({ appPath, env, args, label }) {
  const cliShimPath = getCliShimPath(appPath);
  assertExecutable(cliShimPath, "Bundled CLI shim");

  return await runShellCommand({
    script: getCliShimScript(cliShimPath, args),
    env,
    label,
  });
}

async function runCliShimJsonCommand({ appPath, env, args, label }) {
  const result = await runCliShimCommand({
    appPath,
    env,
    args: [...args, "--json"],
    label,
  });
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${label} produced empty JSON output`);
  }

  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`${label} produced invalid JSON: ${output}`, { cause: error });
  }
}

async function smokeCliShim({ appPath, env }) {
  console.log("Packaged desktop smoke: running bundled CLI shim daemon status");
  const result = await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "status"],
    label: "Bundled CLI shim daemon status",
  });
  assertCleanDaemonStatusOutput(`${result.stdout}\n${result.stderr}`);
}

async function smokeColdCliDaemonStart({ appPath }) {
  const home = createTempDir("neolix-smoke-cli-daemon-home-");
  const pidPath = path.join(home, "neolix.pid");
  const port = await reserveLocalTcpPort();
  const listen = `127.0.0.1:${port}`;
  const env = createDefaultDaemonEnv({ HOME: home, USERPROFILE: home });
  configureIsolatedDaemonHome(home, listen);

  try {
    console.log("Packaged desktop smoke: cold-starting daemon through bundled CLI shim");
    await runCliShimCommand({
      appPath,
      env,
      args: ["daemon", "start", "--home", home],
      label: "Bundled CLI shim cold daemon start",
    });

    const pidInfo = JSON.parse(await waitForFile(pidPath, "cold CLI daemon pid file"));
    if (!pidInfo || typeof pidInfo.pid !== "number") {
      throw new Error(`Cold CLI daemon wrote invalid pid file: ${JSON.stringify(pidInfo)}`);
    }

    if (process.platform === "darwin") {
      assertDarwinProcessDoesNotUseMainAppExecutable({
        appPath,
        pid: pidInfo.pid,
        label: "Cold CLI daemon supervisor",
      });
      const childPids = await waitForChildPids(pidInfo.pid);
      for (const childPid of childPids) {
        assertDarwinProcessDoesNotUseMainAppExecutable({
          appPath,
          pid: childPid,
          label: "Cold CLI daemon worker",
        });
      }
    }
  } finally {
    if (fs.existsSync(pidPath)) {
      await runCliShimCommand({
        appPath,
        env,
        args: ["daemon", "stop", "--home", home, "--force"],
        label: "Bundled CLI shim cold daemon stop",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to stop cold CLI daemon: ${error}`);
      });
    }
    await removeTempDir(home);
  }
}

function assertCleanDaemonStatusOutput(output) {
  const failureNeedles = [
    "Get-CimInstance",
    "Get-Process :",
    "Cannot bind parameter",
    "wmic failed",
  ];
  const failure = failureNeedles.find((needle) => output.includes(needle));
  if (failure) {
    throw new Error(`Bundled CLI shim daemon status included process lookup failure: ${failure}`);
  }
}

async function smokeCliTerminal({ appPath, env }) {
  const cwd = createTempDir("neolix-smoke-terminal-cwd-");
  const marker = `neolix-packaged-terminal-smoke-${Date.now()}`;
  const name = `packaged-smoke-${process.pid}-${Date.now()}`;
  let terminalId = null;

  try {
    console.log("Packaged desktop smoke: creating terminal through bundled CLI shim");
    const created = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "create", "--cwd", cwd, "--name", name],
      label: "Bundled CLI shim terminal create",
    });
    if (!created || typeof created.id !== "string" || created.id.length === 0) {
      throw new Error(`Terminal create returned unexpected payload: ${JSON.stringify(created)}`);
    }
    terminalId = created.id;

    const terminals = await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "ls", "--all"],
      label: "Bundled CLI shim terminal ls",
    });
    if (!Array.isArray(terminals) || !terminals.some((terminal) => terminal.id === terminalId)) {
      throw new Error(`Terminal ${terminalId} was not listed after create`);
    }

    await runCliShimJsonCommand({
      appPath,
      env,
      args: ["terminal", "send-keys", terminalId, getTerminalHookSmokeCommand(marker), "Enter"],
      label: "Bundled CLI shim terminal hook command",
    });

    for (let attempt = 1; attempt <= TERMINAL_CAPTURE_ATTEMPTS; attempt += 1) {
      const capture = await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "capture", terminalId, "--scrollback"],
        label: "Bundled CLI shim terminal capture",
      });
      const lines = Array.isArray(capture?.lines) ? capture.lines : [];
      if (lines.join("\n").includes(marker)) {
        console.log("Packaged desktop smoke: terminal hook command completed");
        return;
      }

      if (attempt < TERMINAL_CAPTURE_ATTEMPTS) {
        await delay(TERMINAL_CAPTURE_INTERVAL_MS);
      }
    }

    throw new Error(`Timed out waiting for terminal capture marker ${marker}`);
  } finally {
    if (terminalId) {
      await runCliShimJsonCommand({
        appPath,
        env,
        args: ["terminal", "kill", terminalId],
        label: "Bundled CLI shim terminal kill",
      }).catch((error) => {
        console.warn(`Packaged desktop smoke: failed to kill terminal ${terminalId}: ${error}`);
      });
    }
    await removeTempDir(cwd);
  }
}

async function stopCliDaemon({ appPath, env }) {
  console.log("Packaged desktop smoke: stopping daemon through bundled CLI shim");
  await runCliShimCommand({
    appPath,
    env,
    args: ["daemon", "stop", "--force"],
    label: "Bundled CLI shim daemon stop",
  });
}

async function exerciseSmokeWorkspace({ appPath, env, page, daemonHome }) {
  const projectPath = path.join(daemonHome, "sandbox-smoke-project");
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "Packaged Linux sandbox smoke\n");
  const workspace = await runCliShimJsonCommand({
    appPath,
    env,
    args: [
      "workspace",
      "create",
      "--isolation",
      "local",
      "--path",
      projectPath,
      "--title",
      "Sandbox smoke workspace",
    ],
    label: "Create packaged smoke workspace",
  });
  // The sandboxed renderer must stay interactive: the new-thread composer takes focus and
  // keystrokes after a reload against the daemon that now holds the workspace.
  await page.reload();
  const composer = page.locator('[data-testid="composer-editor"]').first();
  await composer.click({ timeout: SMOKE_TIMEOUT_MS });
  await page.keyboard.type("sandbox smoke");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="composer-editor"]')
        ?.textContent?.includes("sandbox smoke"),
    undefined,
    { timeout: SMOKE_TIMEOUT_MS },
  );
  console.log(
    `Packaged desktop smoke: renderer composer accepted input with workspace ${workspace.workspaceId}`,
  );
}

async function assertSandboxState({ browser, page, expectedSandbox, stdout, stderr }) {
  const diagnostics = await page.evaluate(() =>
    window.neolixDesktop.invoke("desktop_sandbox_diagnostics"),
  );
  if (diagnostics.enabled !== expectedSandbox) {
    throw new Error(
      `Unexpected sandbox decision: ${JSON.stringify(diagnostics)}; expected enabled=${expectedSandbox}`,
    );
  }
  if (!stdout.join("").includes("[desktop] app startup")) {
    throw new Error("Missing production app startup log");
  }
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const renderers = processInfo.filter((info) => info.type === "renderer");
  if (renderers.length === 0) throw new Error("No renderer process found");
  for (const renderer of renderers) {
    const status = fs.readFileSync(`/proc/${renderer.id}/status`, "utf8");
    const security = status
      .split("\n")
      .filter((line) => /^(NoNewPrivs|Seccomp|Uid|Gid):/.test(line))
      .join("; ");
    const report = `Sandbox evidence: enabled=${expectedSandbox}; ${diagnostics.reason}; renderer ${renderer.id}: ${security}`;
    console.log(report);
    stdout.push(`${report}\n`);
    if (
      expectedSandbox &&
      (!/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status))
    ) {
      throw new Error(`Renderer lacks OS sandbox: ${report}\n${stderr.join("")}`);
    }
  }
}

function assertLinuxDesktopIdentity(appPath) {
  if (process.platform === "linux") {
    assert.deepEqual(
      fs.readFileSync(path.join(appPath, "resources", "icon.png")),
      fs.readFileSync(path.join(__dirname, "..", "assets", "icon.png")),
      "Packaged Linux windows must have the Neox icon at their runtime lookup path",
    );
    const metadata = JSON.parse(
      extractFile(path.join(appPath, "resources", "app.asar"), "package.json").toString(),
    );
    if (metadata.desktopName !== `${EXECUTABLE_NAME}.desktop`) {
      throw new Error(
        `Packaged Linux desktop identity ${JSON.stringify(metadata.desktopName)} does not match ${EXECUTABLE_NAME}.desktop`,
      );
    }
  }
}

async function smokePackagedDesktopApp({
  appPath,
  executablePath = getExecutablePath(appPath),
  launchArgs = [],
  expectedSandbox,
}) {
  assertExecutable(executablePath, "Packaged app executable");
  assertLinuxDesktopIdentity(appPath);
  await smokeColdCliDaemonStart({ appPath });

  const userData = createTempDir("neolix-smoke-user-data-");
  const daemonHome = createTempDir("neolix-smoke-daemon-home-");
  const daemonPort = await reserveLocalTcpPort();
  let cdpPort = await reserveLocalTcpPort();
  for (let attempt = 0; cdpPort === daemonPort && attempt < 10; attempt += 1) {
    cdpPort = await reserveLocalTcpPort();
  }
  if (cdpPort === daemonPort) {
    throw new Error("Failed to reserve distinct TCP ports for the daemon and CDP");
  }
  const listen = `127.0.0.1:${daemonPort}`;
  configureIsolatedDaemonHome(daemonHome, listen);
  const env = createIsolatedDesktopEnv({
    home: daemonHome,
    listen,
    userData,
    cdpPort,
  });

  const stdout = [];
  const stderr = [];
  const launch = getLaunchCommand(executablePath, launchArgs);
  console.log(`Packaged desktop smoke: launching ${launch.command} ${launch.args.join(" ")}`);
  const child = spawn(launch.command, launch.args, {
    detached: process.platform !== "win32",
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => stdout.push(chunk.toString()));
  child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
  child.once("error", (error) =>
    stderr.push(`Packaged app launch error: ${error.stack ?? error}\n`),
  );
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;

  let browser = null;
  let page = null;
  let daemonStopped = false;

  const stopDaemonForCleanup = async () => {
    if (daemonStopped) {
      return;
    }

    await stopCliDaemon({ appPath, env });
    daemonStopped = true;
  };

  try {
    browser = await connectToPackagedApp({
      child,
      cdpPort,
      stdout,
      stderr,
      userData,
      daemonHome,
      deadline,
    });
    page = await waitForPackagedAppPage(browser, stdout, deadline);
    await assertPackagedRendererLoaded(page, deadline);
    console.log("Packaged desktop smoke: real app renderer and preload bridge loaded");
    const status = await waitForRendererStartedDaemon({
      page,
      daemonHome,
      listen,
      stdout,
      stderr,
      userData,
      deadline,
    });
    console.log("Packaged desktop smoke: renderer-started desktop daemon reported running");
    await assertBuiltinPluginsStarted(listen);
    console.log("Packaged desktop smoke: every built-in plugin started");
    await smokeCliShim({ appPath, env });
    await smokeCliTerminal({ appPath, env });
    if (expectedSandbox !== undefined) {
      await assertSandboxState({ browser, page, expectedSandbox, stdout, stderr });
      await exerciseSmokeWorkspace({ appPath, env, page, daemonHome });
    }
    await writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome });
    await stopDaemonForCleanup();
    console.log(
      `Packaged desktop smoke passed: real renderer and preload loaded; renderer-started desktop daemon pid ${status.pid}, listen ${status.listen}; CLI shim daemon status and terminal smoke succeeded`,
    );
  } catch (error) {
    await writeSmokeArtifacts({ page, stdout, stderr, userData, daemonHome, error }).catch(
      (artifactError) => {
        console.warn(`Packaged desktop smoke: failed to write failure artifacts: ${artifactError}`);
      },
    );
    if (!daemonStopped) {
      try {
        await stopDaemonForCleanup();
      } catch {}
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    if (isRunning(child)) {
      terminateChild(child);
      if (!(await waitForChildExit(child))) {
        terminateChild(child, "SIGKILL");
        await waitForChildExit(child);
      }
    }
    releaseChildHandles(child);
    await removeTempDir(userData);
    await removeTempDir(daemonHome);
  }
}

module.exports = {
  smokePackagedDesktopApp,
};

if (require.main === module) {
  const appIndex = process.argv.indexOf("--app");
  const appPath = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  if (!appPath) {
    process.stderr.write("Usage: node smoke-packaged-desktop-app.js --app <Neox.app>\n");
    process.exit(2);
  }

  smokePackagedDesktopApp({ appPath }).catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
