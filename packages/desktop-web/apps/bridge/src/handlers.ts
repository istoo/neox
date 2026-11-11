import * as os from "node:os";
import * as path from "node:path";
import { Effect, Queue, Stream } from "effect";

import type { BridgeModel } from "./model.ts";
import type { AnyHandler } from "./stubs.ts";
import { WS_METHODS } from "@synara/contracts";
import type { ProviderKind, ServerListProviderUsageInput } from "@synara/contracts";
import {
  environmentDescriptor,
  runtimeStatus,
  serverConfig,
  serverSettings,
} from "./serverInfo.ts";
import { ProviderDirectory } from "./providers.ts";
import { composerCapabilities, listCommands, listModels, listSkills } from "./providerRpc.ts";
import type { CommandDiscoveryInput } from "./providerRpc.ts";
import { getProviderUsageSnapshot, listProviderUsage } from "./usageRpc.ts";
import { searchThreads } from "./searchRpc.ts";
import { CommandDispatcher } from "./commands.ts";
import { ServerState } from "./serverState.ts";
import {
  daemonPatchForSettingsPatch,
  localProviderSettingsPatch,
  touchesProviderSettings,
} from "./providerConfig.ts";
import { KeybindingsState } from "./keybindingsState.ts";
import { makeTerminalHandlers } from "./terminalRpc.ts";
import { makeFileHandlers } from "./filesRpc.ts";
import { makeGitHandlers } from "./gitRpc.ts";
import { makeAutomationHandlers } from "./automationsRpc.ts";
import { makeDevServerHandlers } from "./devServersRpc.ts";
import { makeVoiceHandlers } from "./voiceRpc.ts";
import { makeImportHandlers } from "./importRpc.ts";
import { makePairingHandlers } from "./pairingRpc.ts";
import { makeHostHandlers } from "./hostRpc.ts";
import { makePluginHandlers } from "./pluginsRpc.ts";
import { makePullRequestHandlers } from "./pullRequestsRpc.ts";
import { makeSubagentHandlers } from "./subagentsRpc.ts";
import { makeWorkspaceHandlers } from "./workspacesRpc.ts";
import { makeLibraryHandlers } from "./libraryRpc.ts";
import { makeGatewayHandlers } from "./gatewayRpc.ts";
import { projectProvisionFromGitHubHandler } from "./projectsRpc.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { ProjectPins } from "./projectPins.ts";

/** Turns a model subscription (listener in, unsubscribe out) into an RPC stream. */
function fromSubscription<A>(subscribe: (emit: (item: A) => void) => () => void): Stream.Stream<A> {
  return Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => subscribe((item) => Queue.offerUnsafe(queue, item))),
      (unsubscribe) => Effect.sync(unsubscribe),
    ),
  );
}

export function makeHandlers(
  model: BridgeModel,
  options: {
    readonly environmentId: string;
    readonly home: string;
    readonly log: (line: string) => void;
    /** Human name of the host these handlers speak to (the controller or a remote). */
    readonly label?: string;
    /** HTTP origin that serves this host's `/api/files/download` route, when reachable. */
    readonly daemonHttpBase?: string;
    /** Bridge-local project pins for this host; already loaded before handlers are built. */
    readonly projectPins: ProjectPins;
  },
): Record<string, AnyHandler> {
  const directory = new ProviderDirectory();
  const commands = new CommandDispatcher(
    model,
    directory,
    options.log,
    undefined,
    options.projectPins,
  );
  const keybindings = new KeybindingsState({
    file: path.join(options.home, "desktop-web", "keybindings.json"),
    log: options.log,
  });
  const readConfig = async () =>
    serverConfig(model.client, directory, os.homedir(), {
      path: keybindings.path,
      resolved: await keybindings.resolved(),
      issues: keybindings.issues(),
    });
  const state = new ServerState({
    config: readConfig,
    baseSettings: () => serverSettings(model.client, directory),
    settingsFile: path.join(options.home, "desktop-web", "settings.json"),
    applyProviderSettings: async (patch) => {
      // A `providers` patch replaces the whole env map for that provider; read the current
      // entries so clearing one field keeps the others.
      const current = await model.client
        .getDaemonConfig()
        .then((result) => result.config.providers as Record<string, unknown>)
        .catch(() => undefined);
      const daemonPatch = daemonPatchForSettingsPatch(patch, current);
      if (!daemonPatch) return;
      await model.client.patchDaemonConfig(daemonPatch as never);
    },
    localSettingsPatch: localProviderSettingsPatch,
    cwd: os.homedir(),
    ...(model.homeDir ? { homeDir: model.homeDir } : {}),
    log: options.log,
  });
  /** Draft threads have no Neox agent yet, so discovery runs against their model selection. */
  const discoveryInput = (payload: unknown): CommandDiscoveryInput => {
    const input = payload as CommandDiscoveryInput;
    const draft =
      input.threadId && !model.entry(input.threadId) ? model.draft(input.threadId) : undefined;
    return {
      ...input,
      threadIsAgent: Boolean(input.threadId && model.entry(input.threadId)),
      ...(draft
        ? {
            selection: draft.modelSelection as CommandDiscoveryInput["selection"],
            interactionMode: draft.interactionMode,
          }
        : {}),
    };
  };
  return {
    ...makeTerminalHandlers(model),
    ...makeFileHandlers(model),
    ...makeGitHandlers(model),
    ...makePluginHandlers(model),
    ...makePullRequestHandlers(model),
    ...makeSubagentHandlers(model),
    ...makeWorkspaceHandlers(model),
    ...makeLibraryHandlers(model),
    ...makeGatewayHandlers(model),
    ...makeAutomationHandlers(model),
    ...makeDevServerHandlers(model),
    ...makeVoiceHandlers(model),
    ...makeImportHandlers(model),
    ...makePairingHandlers(model, {
      environmentId: options.environmentId,
      label: options.label,
    }),
    ...makeHostHandlers(model, { daemonHttpBase: options.daemonHttpBase, directory }),
    [WS_METHODS.serverGetEnvironment]: () =>
      Effect.succeed(environmentDescriptor(options.environmentId, { label: options.label })),
    [WS_METHODS.serverGetConfig]: () => fromPromise("server.getConfig", readConfig),
    [WS_METHODS.serverGetSettings]: () => fromPromise("server.getSettings", () => state.settings()),
    [WS_METHODS.serverUpdateSettings]: (payload) =>
      fromPromise("server.updateSettings", async () => {
        const patch = payload as Record<string, unknown>;
        const settings = await state.updateSettings(patch);
        // A provider-entry change alters availability; refresh it so the directory that
        // resolves instances to daemon providers sees the new entries before the next turn.
        if (touchesProviderSettings(patch)) {
          await state
            .refreshProviders()
            .catch((error) => options.log(`provider refresh failed: ${String(error)}`));
        }
        return settings;
      }),
    [WS_METHODS.serverRefreshProviders]: () =>
      fromPromise("server.refreshProviders", () => state.refreshProviders()),
    [WS_METHODS.serverUpsertKeybinding]: (payload) =>
      fromPromise("server.upsertKeybinding", async () => {
        const result = await keybindings.upsert(
          payload as Parameters<KeybindingsState["upsert"]>[0],
        );
        // The write already succeeded; a provider re-read failing must not report it as lost.
        await state
          .refreshConfig()
          .catch((error) => options.log(`config refresh failed: ${String(error)}`));
        return result;
      }),
    [WS_METHODS.serverEditKeybindings]: (payload) =>
      fromPromise("server.editKeybindings", async () => {
        const result = await keybindings.edit(payload as Parameters<KeybindingsState["edit"]>[0]);
        await state
          .refreshConfig()
          .catch((error) => options.log(`config refresh failed: ${String(error)}`));
        return result;
      }),
    [WS_METHODS.subscribeServerSettings]: () =>
      fromSubscription((emit) => state.subscribeSettings(emit)),
    [WS_METHODS.subscribeServerConfig]: () =>
      fromSubscription((emit) => state.subscribeConfig(emit)),
    [WS_METHODS.subscribeServerProviderStatuses]: () =>
      fromSubscription((emit) => state.subscribeProviderStatuses(emit)),
    [WS_METHODS.subscribeServerLifecycle]: () =>
      Stream.concat(Stream.fromIterable(state.lifecycle()), Stream.never),
    [WS_METHODS.subscribeServerKeepAwake]: () =>
      Stream.concat(Stream.fromEffect(Effect.promise(() => state.keepAwake())), Stream.never),
    "orchestration.replayEvents": () => Effect.succeed([]),
    [WS_METHODS.serverGetRuntimeStatus]: () => Effect.succeed(runtimeStatus()),
    [WS_METHODS.providerListModels]: (payload) =>
      fromPromise("provider.listModels", () =>
        listModels(model.client, directory, payload as { provider: string; instanceId?: string }),
      ),
    [WS_METHODS.providerGetComposerCapabilities]: (payload) =>
      Effect.succeed(composerCapabilities((payload as { provider: string }).provider)),
    [WS_METHODS.providerListCommands]: (payload) =>
      fromPromise("provider.listCommands", () =>
        listCommands(model.client, directory, discoveryInput(payload)),
      ),
    [WS_METHODS.providerListSkills]: (payload) =>
      fromPromise("provider.listSkills", () =>
        listSkills(model.client, directory, discoveryInput(payload)),
      ),
    [WS_METHODS.serverListProviderUsage]: (payload) =>
      fromPromise("server.listProviderUsage", () =>
        listProviderUsage(model.client, payload as ServerListProviderUsageInput),
      ),
    [WS_METHODS.serverGetProviderUsageSnapshot]: (payload) =>
      fromPromise("server.getProviderUsageSnapshot", () =>
        getProviderUsageSnapshot(model.client, payload as { provider: ProviderKind }),
      ),
    "orchestration.searchThreads": (payload) =>
      fromPromise("orchestration.searchThreads", () =>
        searchThreads(model, model.client, payload as { query: string; limit?: number }),
      ),
    [WS_METHODS.providerListAgents]: () => Effect.succeed({ agents: [] }),
    "orchestration.getShellSnapshot": () => Effect.sync(() => model.shellSnapshot()),
    "orchestration.subscribeShell": () => fromSubscription((emit) => model.subscribeShell(emit)),
    "orchestration.unsubscribeShell": () => Effect.void,
    "orchestration.getThreadDetailSnapshot": (payload) =>
      fromPromise("getThreadDetailSnapshot", () =>
        model.threadDetail((payload as { threadId: string }).threadId),
      ),
    "orchestration.subscribeThread": (payload) =>
      fromSubscription((emit) =>
        model.subscribeThread((payload as { threadId: string }).threadId, emit),
      ),
    "orchestration.unsubscribeThread": () => Effect.void,
    "orchestration.dispatchCommand": (payload) =>
      fromPromise("dispatchCommand", async () => {
        const command = payload as Parameters<CommandDispatcher["dispatch"]>[0];
        const startedAt = Date.now();
        try {
          const receipt = await commands.dispatch(command);
          options.log(
            `command ${command.type} ${command.threadId ?? ""} ok in ${Date.now() - startedAt}ms`,
          );
          return receipt;
        } catch (error) {
          options.log(
            `command ${command.type} ${command.threadId ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      }),
    "orchestration.settleTurnDispatch": (payload) =>
      Effect.sync(() =>
        commands.settleTurn(
          String((payload as { command: { commandId: string } }).command.commandId),
        ),
      ),
    [WS_METHODS.projectsProvisionFromGitHub]: projectProvisionFromGitHubHandler(model),
  };
}
