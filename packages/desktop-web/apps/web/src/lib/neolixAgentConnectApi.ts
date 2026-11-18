// FILE: neolixAgentConnectApi.ts
// Purpose: Typed calls into the bridge's `neolix.agentConnect.*` surface. The
//          bridge forwards each call to the Neox daemon's `agent.connect.*`
//          requests, so these wrappers stay thin and shape-free.
// Layer: Web transport adapter

import {
  NEOLIX_AGENT_CONNECT_WS_METHODS,
  type AgentConnectLayoutInput,
  type AgentConnectModelsInput,
  type AgentConnectRenameInput,
  type AgentConnectResult,
  type AgentConnectSetInput,
  type AgentConnectShellInput,
  type AgentConnectStaleRestartInput,
} from "@synara/contracts";

import { getConnectionClients } from "~/lib/hosts/connectionClients";

function request<T>(method: string, payload?: unknown): Promise<T> {
  // Optional fields the form left empty are `undefined`; the RPC codec rejects
  // them on a struct field, so send the JSON form the daemon would receive.
  const body = payload === undefined ? {} : JSON.parse(JSON.stringify(payload));
  return getConnectionClients().execution.request<T>(method, body);
}

export const neolixAgentConnectApi = {
  get: () => request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.get),
  set: (input: AgentConnectSetInput) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.set, input),
  listProfiles: () => request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.profileList),
  saveProfile: (name: string) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.profileSave, { name }),
  applyProfile: (name: string) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.profileApply, { name }),
  deleteProfile: (name: string) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.profileDelete, { name }),
  renameProfile: (input: AgentConnectRenameInput) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.profileRename, input),
  setLayout: (input: AgentConnectLayoutInput) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.layoutSet, input),
  setModels: (input: AgentConnectModelsInput) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.modelsSet, input),
  setShell: (input: AgentConnectShellInput) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.shellSet, input),
  restartStale: (input: AgentConnectStaleRestartInput) =>
    request<AgentConnectResult>(NEOLIX_AGENT_CONNECT_WS_METHODS.staleRestart, input),
};
