// FILE: neolixLibraryClient.ts
// Purpose: Typed RPC client for the bridge's `neolix.library.*` methods. The
//   settings panels use the same WebSocket transport as `wsNativeApi`.
// Layer: Web transport adapter

import {
  NEOLIX_LIBRARY_WS_METHODS,
  type LibraryBackupsResult,
  type LibraryDiscoverResult,
  type LibraryDiscoverSelectionInput,
  type LibraryIdInput,
  type LibraryMarketInstallInput,
  type LibraryMarketSearchInput,
  type LibraryMarketServersResult,
  type LibraryMcpHealthResult,
  type LibraryMcpHubInput,
  type LibraryMcpLocalInput,
  type LibraryMcpNameInput,
  type LibraryMcpRouterInput,
  type LibraryMcpSetAgentsInput,
  type LibraryMcpSignInResult,
  type LibraryMcpSignInStatusResult,
  type LibraryMutationResult,
  type LibraryMynaResult,
  type LibraryNeolixToolsResult,
  type LibraryRestoreResult,
  type LibraryRtkGainResult,
  type LibraryRtkResult,
  type LibraryRtkRunInput,
  type LibraryRtkRunResult,
  type LibraryRtkSetInput,
  type LibrarySaveHookInput,
  type LibrarySaveInstructionsInput,
  type LibrarySaveMcpServerInput,
  type LibrarySaveSubagentInput,
  type LibrarySetNeolixToolsInput,
  type LibrarySkillCheckResult,
  type LibrarySkillFindResult,
  type LibrarySkillHereInput,
  type LibrarySkillHandOverInput,
  type LibrarySkillImportInput,
  type LibrarySkillInstallInput,
  type LibrarySkillMarketResult,
  type LibrarySkillNameInput,
  type LibrarySkillNoteInput,
  type LibrarySkillOptionsInput,
  type LibrarySkillSetAgentsInput,
  type LibrarySkillSettleInput,
  type LibrarySkillSourceInput,
  type LibrarySkillUpdateInput,
  type LibrarySnapshotResult,
} from "@synara/contracts";
import { getConnectionClients } from "~/lib/hosts/connectionClients";

function request<T>(method: string, payload?: unknown): Promise<T> {
  return getConnectionClients().execution.request<T>(method, payload ?? {});
}

export const neolixLibraryApi = {
  get: () => request<LibrarySnapshotResult>(NEOLIX_LIBRARY_WS_METHODS.get),
  sync: () => request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.sync),
  saveInstructions: (input: LibrarySaveInstructionsInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.saveInstructions, input),
  saveMcpServer: (input: LibrarySaveMcpServerInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.saveMcpServer, input),
  removeMcpServer: (input: LibraryMcpNameInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.removeMcpServer, input),
  setMcpAgents: (input: LibraryMcpSetAgentsInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setMcpAgents, input),
  checkMcpServer: (input: LibraryMcpNameInput) =>
    request<LibraryMcpHealthResult>(NEOLIX_LIBRARY_WS_METHODS.checkMcpServer, input),
  setMcpHub: (input: LibraryMcpHubInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setMcpHub, input),
  setMcpLocal: (input: LibraryMcpLocalInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setMcpLocal, input),
  setMcpRouter: (input: LibraryMcpRouterInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setMcpRouter, input),
  signInMcpServer: (input: LibraryMcpNameInput) =>
    request<LibraryMcpSignInResult>(NEOLIX_LIBRARY_WS_METHODS.signInMcpServer, input),
  mcpSignInStatus: (input: LibraryIdInput) =>
    request<LibraryMcpSignInStatusResult>(NEOLIX_LIBRARY_WS_METHODS.mcpSignInStatus, input),
  cancelMcpSignIn: (input: LibraryIdInput) =>
    request<void>(NEOLIX_LIBRARY_WS_METHODS.cancelMcpSignIn, input),
  signOutMcpServer: (input: LibraryMcpNameInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.signOutMcpServer, input),
  importSkill: (input: LibrarySkillImportInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.importSkill, input),
  findSkills: (input: LibrarySkillSourceInput) =>
    request<LibrarySkillFindResult>(NEOLIX_LIBRARY_WS_METHODS.findSkills, input),
  installSkills: (input: LibrarySkillInstallInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.installSkills, input),
  setSkillOptions: (input: LibrarySkillOptionsInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setSkillOptions, input),
  setSkillNote: (input: LibrarySkillNoteInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setSkillNote, input),
  checkSkillUpdates: () =>
    request<LibrarySkillCheckResult>(NEOLIX_LIBRARY_WS_METHODS.checkSkillUpdates),
  updateSkills: (input: LibrarySkillUpdateInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.updateSkills, input),
  removeSkill: (input: LibrarySkillNameInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.removeSkill, input),
  setSkillAgents: (input: LibrarySkillSetAgentsInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setSkillAgents, input),
  setSkillHere: (input: LibrarySkillHereInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setSkillHere, input),
  handOverSkills: (input: LibrarySkillHandOverInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.handOverSkills, input),
  handBackSkill: (input: LibrarySkillNameInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.handBackSkill, input),
  settleSkill: (input: LibrarySkillSettleInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.settleSkill, input),
  searchMarket: (input: LibraryMarketSearchInput) =>
    request<LibraryMarketServersResult>(NEOLIX_LIBRARY_WS_METHODS.searchMarket, input),
  installMarketServer: (input: LibraryMarketInstallInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.installMarketServer, input),
  searchSkillMarket: (input: LibraryMarketSearchInput) =>
    request<LibrarySkillMarketResult>(NEOLIX_LIBRARY_WS_METHODS.searchSkillMarket, input),
  saveHook: (input: LibrarySaveHookInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.saveHook, input),
  removeHook: (input: LibrarySkillNameInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.removeHook, input),
  setHookAgents: (input: LibrarySkillSetAgentsInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setHookAgents, input),
  saveSubagent: (input: LibrarySaveSubagentInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.saveSubagent, input),
  removeSubagent: (input: LibrarySkillNameInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.removeSubagent, input),
  setSubagentAgents: (input: LibrarySkillSetAgentsInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.setSubagentAgents, input),
  getRtk: () => request<LibraryRtkResult>(NEOLIX_LIBRARY_WS_METHODS.getRtk),
  setRtk: (input: LibraryRtkSetInput) =>
    request<LibraryRtkResult>(NEOLIX_LIBRARY_WS_METHODS.setRtk, input),
  runRtk: (input: LibraryRtkRunInput) =>
    request<LibraryRtkRunResult>(NEOLIX_LIBRARY_WS_METHODS.runRtk, input),
  getRtkGain: () => request<LibraryRtkGainResult>(NEOLIX_LIBRARY_WS_METHODS.getRtkGain),
  getDiscover: () => request<LibraryDiscoverResult>(NEOLIX_LIBRARY_WS_METHODS.getDiscover),
  importDiscovered: (input: LibraryDiscoverSelectionInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.importDiscovered, input),
  removeDiscovered: (input: LibraryDiscoverSelectionInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.removeDiscovered, input),
  getMynaLibrary: () => request<LibraryMynaResult>(NEOLIX_LIBRARY_WS_METHODS.getMynaLibrary),
  importMynaLibrary: (input: LibraryDiscoverSelectionInput) =>
    request<LibraryMutationResult>(NEOLIX_LIBRARY_WS_METHODS.importMynaLibrary, input),
  listBackups: () => request<LibraryBackupsResult>(NEOLIX_LIBRARY_WS_METHODS.listBackups),
  restoreBackup: (input: { stamp: string; agent: string; file: string }) =>
    request<LibraryRestoreResult>(NEOLIX_LIBRARY_WS_METHODS.restoreBackup, input),
  getNeolixTools: () => request<LibraryNeolixToolsResult>(NEOLIX_LIBRARY_WS_METHODS.getNeolixTools),
  setNeolixTools: (input: LibrarySetNeolixToolsInput) =>
    request<LibraryNeolixToolsResult>(NEOLIX_LIBRARY_WS_METHODS.setNeolixTools, input),
};
