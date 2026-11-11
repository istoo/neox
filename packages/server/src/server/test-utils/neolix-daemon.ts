import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";

import pino from "pino";
import {
  createNeolixDaemon,
  type NeolixDaemonConfig,
  type NeolixOpenAIConfig,
  type NeolixSpeechConfig,
} from "../bootstrap.js";
import type { AgentClient, AgentProvider } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import type { PushNotificationSender } from "../push/index.js";
import type { AgentProfile } from "@neolix/protocol/messages";

interface TestNeolixDaemonOptions {
  daemonVersion?: string;
  desktopManaged?: boolean;
  downloadTokenTtlMs?: number;
  corsAllowedOrigins?: string[];
  listen?: string;
  listenPort?: number;
  logger?: Parameters<typeof createNeolixDaemon>[1];
  mcpEnabled?: boolean;
  mcpDebug?: boolean;
  isDev?: boolean;
  // Off by default: a test daemon must never leave a relay on the machine.
  codexRelayOnShutdown?: boolean;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  relayRequireProtectedSecurity?: boolean;
  daemonStatusRpcCapability?: boolean;
  relayConfigCapability?: boolean;
  agentClients?: Partial<Record<AgentProvider, AgentClient>>;
  providerOverrides?: NeolixDaemonConfig["providerOverrides"];
  neolixHomeRoot?: string;
  staticDir?: string;
  cleanup?: boolean;
  openai?: NeolixOpenAIConfig;
  // localModelsDir defaults to the local provider's modelsDir, then to a dir under neolixHome.
  speech?: Omit<NeolixSpeechConfig, "localModelsDir"> & { localModelsDir?: string };
  voiceLlmProvider?: NeolixDaemonConfig["voiceLlmProvider"];
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  auth?: NeolixDaemonConfig["auth"];
  pushNotificationSender?: PushNotificationSender;
  serviceProxy?: NeolixDaemonConfig["serviceProxy"];
  webUi?: NeolixDaemonConfig["webUi"];
  trustedProxies?: NeolixDaemonConfig["trustedProxies"];
  agentProfiles?: AgentProfile[];
  autoArchiveAfterMerge?: boolean;
  resumeOnStartup?: boolean;
  resumePrompt?: string;
  pluginsEnabled?: NeolixDaemonConfig["pluginsEnabled"];
  builtinPlugins?: BuiltinPluginLoader;
  plugins?: NeolixDaemonConfig["plugins"];
}

export interface TestNeolixDaemon {
  config: NeolixDaemonConfig;
  daemon: Awaited<ReturnType<typeof createNeolixDaemon>>;
  port: number;
  neolixHome: string;
  staticDir: string;
  close: () => Promise<void>;
}

const TEST_DAEMON_START_TIMEOUT_MS = 20_000;

async function startDaemonWithTimeout(
  daemon: Awaited<ReturnType<typeof createNeolixDaemon>>,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `Timed out starting test daemon after ${timeoutMs}ms`,
      ) as Error & { code?: string };
      timeoutError.code = "TEST_DAEMON_START_TIMEOUT";
      reject(timeoutError);
    }, timeoutMs);

    daemon.start().then(
      () => {
        clearTimeout(timeoutHandle);
        resolve();
        return;
      },
      (error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      },
    );
  });
}

export async function createTestNeolixDaemon(
  options: TestNeolixDaemonOptions = {},
): Promise<TestNeolixDaemon> {
  const maxAttempts = 8;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const { config, neolixHomeRoot, neolixHome, staticDir, createdDirs } =
      await prepareTestDaemonConfig(options);
    const logger = options.logger ?? pino({ level: "silent" });
    const daemon = await createNeolixDaemon(config, logger, {
      builtinPlugins: options.builtinPlugins ?? new BuiltinPluginLoader(undefined, []),
      serverFeatureOverrides: {
        daemonStatusRpc: options.daemonStatusRpcCapability,
        relayConfig: options.relayConfigCapability,
      },
    });
    try {
      await startDaemonWithTimeout(daemon, TEST_DAEMON_START_TIMEOUT_MS);
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Test daemon did not expose a bound TCP listen target");
      }

      const close = async (): Promise<void> => {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        if (options.cleanup ?? true) {
          await new Promise((r) => setTimeout(r, 50));
          await removeDirs([neolixHomeRoot, staticDir]);
        }
      };

      return {
        config,
        daemon,
        port: listenTarget.port,
        neolixHome,
        staticDir,
        close,
      };
    } catch (error) {
      lastError = error;
      await daemon.stop().catch(() => undefined);
      // A failed attempt removes only what it created: a caller-supplied home keeps its serverId.
      await removeDirs(createdDirs);

      if (
        (!isAddressInUseError(error) && !isStartupTimeoutError(error)) ||
        attempt === maxAttempts - 1
      ) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("Failed to start test daemon");
}

interface PreparedTestDaemonConfig {
  config: NeolixDaemonConfig;
  neolixHomeRoot: string;
  neolixHome: string;
  staticDir: string;
  createdDirs: string[];
}

async function removeDirs(dirs: string[]): Promise<void> {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })),
  );
}

async function createTempDir(prefix: string, createdDirs: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

async function prepareTestDaemonConfig(
  options: TestNeolixDaemonOptions,
): Promise<PreparedTestDaemonConfig> {
  const createdDirs: string[] = [];
  const neolixHomeRoot =
    options.neolixHomeRoot ?? (await createTempDir("neolix-home-", createdDirs));
  const neolixHome = path.join(neolixHomeRoot, ".neox");
  await mkdir(neolixHome, { recursive: true });
  const staticDir = options.staticDir ?? (await createTempDir("neolix-static-", createdDirs));
  const listenHost = options.listen ?? "127.0.0.1";
  const listenPort = options.listenPort ?? 0;
  const config: NeolixDaemonConfig = {
    listen: `${listenHost}:${listenPort}`,
    neolixHome,
    daemonVersion: options.daemonVersion,
    desktopManaged: options.desktopManaged,
    corsAllowedOrigins: options.corsAllowedOrigins ?? [],
    hostnames: true,
    mcpEnabled: options.mcpEnabled ?? true,
    staticDir,
    mcpDebug: options.mcpDebug ?? false,
    isDev: options.isDev,
    codexRelayOnShutdown: options.codexRelayOnShutdown ?? false,
    agentClients: options.agentClients ?? createTestAgentClients(),
    providerOverrides: options.providerOverrides,
    agentStoragePath: path.join(neolixHome, "agents"),
    relayEnabled: options.relayEnabled ?? false,
    relayEndpoint: options.relayEndpoint ?? "",
    relayUseTls: options.relayUseTls,
    relayPublicUseTls: options.relayPublicUseTls,
    relayRequireProtectedSecurity: options.relayRequireProtectedSecurity,
    appBaseUrl: "",
    auth: options.auth,
    pushNotificationSender: options.pushNotificationSender,
    serviceProxy: options.serviceProxy,
    webUi: options.webUi,
    trustedProxies: options.trustedProxies,
    openai: options.openai,
    speech: options.speech
      ? {
          ...options.speech,
          localModelsDir:
            options.speech.localModelsDir ??
            options.speech.local?.modelsDir ??
            path.join(neolixHome, "models", "local-speech"),
        }
      : undefined,
    voiceLlmProvider: options.voiceLlmProvider ?? null,
    voiceLlmProviderExplicit: options.voiceLlmProviderExplicit ?? false,
    voiceLlmModel: options.voiceLlmModel ?? null,
    dictationFinalTimeoutMs: options.dictationFinalTimeoutMs,
    downloadTokenTtlMs: options.downloadTokenTtlMs,
    agentProfiles: options.agentProfiles,
    autoArchiveAfterMerge: options.autoArchiveAfterMerge,
    resumeOnStartup: options.resumeOnStartup,
    resumePrompt: options.resumePrompt,
    pluginsEnabled: options.pluginsEnabled,
    plugins: options.plugins,
  };
  return { config, neolixHomeRoot, neolixHome, staticDir, createdDirs };
}

function isAddressInUseError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "EADDRINUSE";
}

function isStartupTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as { code?: string };
  return record.code === "TEST_DAEMON_START_TIMEOUT";
}
