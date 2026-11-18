// Neox Agent Connect → Synara settings RPCs (`neolix.agentConnect.*`).
//
// Each handler forwards one-to-one to the daemon's `agent.connect.*` request.
// The bridge adds no policy: the agent's own config, the profiles and the
// gateway are the daemon's. Every write answers with the new snapshot, so the
// front end replaces its cache instead of re-reading.
import { NEOLIX_AGENT_CONNECT_WS_METHODS } from "@synara/contracts";

import type { BridgeModel } from "./model.ts";
import { fromPromise } from "./rpcErrors.ts";
import type { AnyHandler } from "./stubs.ts";

function result(payload: { snapshot: unknown }): { snapshot: unknown } {
  return { snapshot: payload.snapshot };
}

export function makeAgentConnectHandlers(model: BridgeModel): Record<string, AnyHandler> {
  const client = model.client;

  return {
    [NEOLIX_AGENT_CONNECT_WS_METHODS.get]: () =>
      fromPromise("neolix.agentConnect.get", async () => result(await client.getAgentConnect())),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.set]: (payload) =>
      fromPromise("neolix.agentConnect.set", async () => {
        const input = payload as {
          provider: string;
          connected: boolean;
          model?: string;
          field?: string;
          value?: string;
        };
        return result(
          await client.setAgentConnect({
            provider: input.provider,
            connected: input.connected,
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.field === undefined
              ? {}
              : {
                  field: input.field,
                  ...(input.value === undefined ? {} : { value: input.value }),
                }),
          }),
        );
      }),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.profileList]: () =>
      fromPromise("neolix.agentConnect.profile.list", async () =>
        result(await client.listAgentConnectProfiles()),
      ),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.profileSave]: (payload) =>
      fromPromise("neolix.agentConnect.profile.save", async () =>
        result(await client.saveAgentConnectProfile((payload as { name: string }).name)),
      ),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.profileApply]: (payload) =>
      fromPromise("neolix.agentConnect.profile.apply", async () =>
        result(await client.applyAgentConnectProfile((payload as { name: string }).name)),
      ),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.profileDelete]: (payload) =>
      fromPromise("neolix.agentConnect.profile.delete", async () =>
        result(await client.deleteAgentConnectProfile((payload as { name: string }).name)),
      ),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.profileRename]: (payload) =>
      fromPromise("neolix.agentConnect.profile.rename", async () => {
        const input = payload as { name: string; to: string };
        return result(await client.renameAgentConnectProfile(input.name, input.to));
      }),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.layoutSet]: (payload) =>
      fromPromise("neolix.agentConnect.layout.set", async () => {
        const input = payload as { order: string[]; hidden: string[] };
        return result(await client.setAgentConnectLayout(input));
      }),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.modelsSet]: (payload) =>
      fromPromise("neolix.agentConnect.models.set", async () => {
        const input = payload as { provider: string; hidden: string[] };
        return result(await client.setAgentConnectModels(input));
      }),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.shellSet]: (payload) =>
      fromPromise("neolix.agentConnect.shell.set", async () => {
        const input = payload as { provider: string; enabled: boolean };
        return result(await client.setAgentConnectShell(input));
      }),

    [NEOLIX_AGENT_CONNECT_WS_METHODS.staleRestart]: (payload) =>
      fromPromise("neolix.agentConnect.stale.restart", async () => {
        const input = payload as { provider: string; kind: "app" | "ide" | "daemon" | "cli" };
        return result(await client.restartAgentConnectStale(input));
      }),
  };
}
