import {
  ServerDesktopUpdateInput,
  ServerDesktopUpdateResult,
  ServerDesktopUpdateStatus,
} from "./desktopUpdate";
import {
  AccountSaveInboxRecapInput,
  SavedInboxRecap,
  ListSavedInboxRecapsInput,
  ListSavedInboxRecapsResponse,
  SavedInboxRecapIdInput,
} from "./inboxRecaps";
import { RemoteAgentCall, RemoteAgentResult } from "./remoteAgentGateway";
import {
  BrowserAutomationHostRequest,
  BrowserAutomationHostResponseInput,
  BrowserAutomationHostSubscribeInput,
} from "./browserAutomationHost";
import { RemoteAccessInput, RemoteAccessResult } from "./remotePairing";
import {
  EditorDebugStartInput,
  EditorDebugStartResult,
  EditorDebugActionInput,
  EditorDebugActionResult,
  EditorDebugPollInput,
  EditorDebugSnapshot,
} from "./editorDebug";
import { Schema } from "effect";
import {
  NEOLIX_HOST_WS_METHODS,
  NeolixAgentInstallListResult,
  NeolixAgentInstallRunInput,
  NeolixAgentInstallRunResult,
  NeolixBackupAuto,
  NeolixBackupEntry,
  NeolixBackupFile,
  NeolixCodexMoveResult,
  NeolixConversationRecording,
  NeolixExternalExport,
  NeolixExternalSessionDelete,
  NeolixExternalSessionPurge,
  NeolixExternalSessionRestore,
  NeolixExternalSessionSearch,
  NeolixExternalSessions,
  NeolixExternalTranscript,
  NeolixGithubTokenStatus,
  NeolixHostDiagnostics,
  NeolixHostFeatures,
  NeolixHostRevealResult,
  NeolixHostStatus,
  NeolixHostUpdateProgress,
  NeolixProviderDiagnostic,
  NeolixRelocateResult,
  NeolixResolvedProvider,
  NeolixSessionReads,
  NeolixSessionTerminals,
  NeolixSpeechModel,
  NeolixSyncConfig,
  NeolixSyncRemoteVersion,
  NeolixSyncStatus,
  NeolixSyncUsage,
  NeolixThirdPartyNotices,
  NeolixWebPage,
  NeolixWebPageMode,
} from "./neolixHost";
import { EditorIntelligenceInput, EditorIntelligenceResult } from "./editorIntelligence";
import * as Gateway from "./neolixGateway";
import * as AgentConnect from "./neolixAgentConnect";
import * as WorkspaceSetup from "./neolixWorkspaceSetup";
import * as AgentSkills from "./neolixAgentSkills";
import * as AppSettings from "./neolixAppSettings";
import * as ProjectIcons from "./neolixProjectIcons";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  AccountHost,
  AccountDeleteInput,
  AccountAuthenticateOtpInput,
  AccountBeginSsoInput,
  AccountBeginSsoResult,
  AccountCompleteSsoInput,
  AccountMe,
  AccountOpenVerificationUrlInput,
  AccountSendOtpInput,
  AccountSendOtpResult,
  AccountStatus,
  AccountUpdateProfileInput,
  AccountUploadAvatarInput,
} from "./account";
import { GrantResponse, ListDevicesResponse } from "./hostAuth";
import { AccountUsageSummaryInput, UsageSummary } from "./accountUsage";
import {
  AccountBillingCheckoutRequest,
  AccountBillingRedirect,
  AccountBillingStatus,
} from "./accountBilling";
import {
  AutomationCancelRunInput,
  AutomationCancelRunResult,
  AutomationArchiveRunInput,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationDeleteInput,
  AutomationGetMemoryInput,
  AutomationListInput,
  AutomationListResult,
  AutomationMarkRunReadInput,
  AutomationMemory,
  AutomationResolveProposalInput,
  AutomationResolveProposalResult,
  AutomationRunActionResult,
  AutomationRunNowInput,
  AutomationRunNowResult,
  AutomationStreamEvent,
  AutomationUpdateInput,
} from "./automation";
import {
  Todo,
  TodoCreateInput,
  TodoDeleteInput,
  TodoListResult,
  TodoStreamEvent,
  TodoUpdateInput,
} from "./todo";
import {
  ProjectAgentConfigureInput,
  ProjectAgentLinkProjectInput,
  ProjectAgentUnlinkProjectInput,
  ProjectAgentExportDocumentsInput,
  ProjectAgentExportDocumentsResult,
  ProjectAgentGetOverviewInput,
  ProjectAgentListSummariesInput,
  ProjectAgentListSummariesResult,
  ProjectAgentGoalControlInput,
  ProjectAgentListActivityInput,
  ProjectAgentListActivityResult,
  ProjectAgentListDocumentsInput,
  ProjectAgentListDocumentsResult,
  ProjectAgentListTasksInput,
  ProjectAgentListTasksResult,
  ProjectAgentOverview,
  ProjectAgentReadDocumentInput,
  ProjectAgentReadDocumentResult,
  ProjectAgentRefreshDigestInput,
  ProjectAgentStartGoalInput,
  ProjectAgentStreamEvent,
  ProjectAgentSubscribeInput,
  ProjectAgentUpdateGoalInput,
  ProjectAgentUpdateTaskInput,
  ProjectAgentWriteDocumentInput,
  ProjectAgentCreateTaskInput,
  ProjectAgentExcludeThreadInput,
  ProjectAgentBackfillInput,
  ProjectAgentDeleteGroupInput,
  ProjectAgentDeleteGroupResult,
  ProjectAgentGroupControlInput,
  ProjectAgentListThreadIndexInput,
  ProjectAgentListThreadIndexResult,
  ProjectAgentListEvidenceInput,
  ProjectAgentListEvidenceResult,
  ProjectAgentLibraryDeleteInput,
  ProjectAgentLibraryHistoryInput,
  ProjectAgentLibraryHistoryResult,
  ProjectAgentLibraryListInput,
  ProjectAgentLibraryListResult,
  ProjectAgentLibraryMkdirInput,
  ProjectAgentLibraryMutationResult,
  ProjectAgentLibraryRenameInput,
  ProjectAgentLibraryRestoreInput,
  ProjectAgentLibraryStatusInput,
  ProjectAgentLibraryStatusResult,
  ProjectAgentResolveWorkerInput,
  ProjectAgentResolveWorkerResult,
  ProjectDocumentRevision,
  ProjectGoal,
  ProjectTask,
  ProjectThreadIndexEntry,
} from "./projectAgent";
import { OpenInEditorInput } from "./editor";
import {
  ExternalMcpCreateIntegrationInput,
  ExternalMcpCreateIntegrationResult,
  ExternalMcpIntegration,
  ExternalMcpRefreshPairingInput,
  ExternalMcpRevokeIntegrationInput,
} from "./externalMcp";
import {
  McpConnector,
  McpConnectorConnectInput,
  McpConnectorConnectResult,
  McpConnectorDisconnectInput,
  McpConnectorDisconnectResult,
  McpConnectorSetup,
  McpConnectorProposal,
  McpConnectorResolveProposalInput,
  McpConnectorResolveProposalResult,
} from "./mcpConnectors";
import {
  DEVICE_WS_METHODS,
  DeviceAttachInput,
  DeviceBootInput,
  DeviceBootResult,
  DeviceDescribeUiInput,
  DeviceDescribeUiResult,
  DeviceDetachInput,
  DeviceEvent,
  DeviceInstallAppInput,
  DeviceInstallAppResult,
  DeviceKeyEventInput,
  DeviceLaunchAppInput,
  DeviceLaunchAppResult,
  DeviceListInput,
  DeviceListResult,
  DeviceOpenUrlInput,
  DevicePressButtonInput,
  DeviceScreenshotInput,
  DeviceScreenshotResult,
  DeviceStartRecordingInput,
  DeviceStartRecordingResult,
  DeviceStopRecordingInput,
  DeviceStopRecordingResult,
  DeviceShutdownInput,
  DeviceSwipeInput,
  DeviceScrollToElementInput,
  DeviceScrollToElementResult,
  DeviceTapInput,
  DeviceThreadInput,
  DeviceTypeTextInput,
  ThreadDeviceState,
} from "./device";
import {
  COMPUTER_WS_METHODS,
  ComputerActionResult,
  ComputerClickInput,
  ComputerDoubleClickInput,
  ComputerDragInput,
  ComputerEvent,
  ComputerGetScreenSizeInput,
  ComputerGetScreenSizeResult,
  ComputerGetStateInput,
  ComputerGetStatusInput,
  ComputerHotkeyInput,
  ComputerInputClickInput,
  ComputerInputKeyInput,
  ComputerInputScrollInput,
  ComputerLaunchAppInput,
  ComputerLaunchAppResult,
  ComputerListWindowsInput,
  ComputerListWindowsResult,
  ComputerMoveCursorInput,
  ComputerPerformActionInput,
  ComputerPressKeyInput,
  ComputerProvisionInput,
  ComputerProvisionResult,
  ComputerRightClickInput,
  ComputerScrollInput,
  ComputerSelectTextInput,
  ComputerSetValueInput,
  ComputerTypeTextInput,
  ComputerState,
  ComputerStatusResult,
  ComputerThreadInput,
  ComputerSetControlEnabledInput,
  ComputerControlEnabledResult,
  ThreadComputerState,
} from "./computer";
import { ComputerGetAuditHistoryInput, ComputerGetAuditHistoryResult } from "./computerAudit";
import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";
import {
  GitHubProjectProvisionInput,
  GitHubProjectProvisionProgressEvent,
  GitHubRepositorySearchInput,
  GitHubRepositorySearchResult,
} from "./githubProjectProvisioning";
import { StudioListThreadOutputsInput, StudioListThreadOutputsResult } from "./studio";
import {
  GitCheckoutInput,
  GitActionProgressEvent,
  GitBlameLineInput,
  GitBlameLineResult,
  GitReadFileAtRevInput,
  GitReadFileAtRevResult,
  GitCreateBranchInput,
  GitCreateDetachedWorktreeInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitDiscardChangesInput,
  GitMergeFromBaseInput,
  GitMergeLocallyInput,
  GitHubRepositoryInput,
  GitHubRepositoryResult,
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  GitInitInput,
  GitListBranchesInput,
  GitListCommitsInput,
  GitListRecentCommitsInput,
  GitCommitDiffInput,
  GitCommitDiffResult,
  GitListBranchesResult,
  GitListCommitsResult,
  GitListRecentCommitsResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullRequestSnapshotInput,
  GitPullRequestSnapshotResult,
  GitPullResult,
  GitReadWorkingTreeDiffInput,
  GitReadWorkingTreeDiffResult,
  GitWorkingTreeDiffStatsResult,
  GitRemoveIndexLockInput,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStageFilesInput,
  GitStageFilesResult,
  GitStashAndCheckoutInput,
  GitStashDropInput,
  GitStashInfoInput,
  GitStashInfoResult,
  GitStashListInput,
  GitStashListResult,
  GitStashPopInput,
  GitStatusInput,
  GitStatusResult,
  GitSummarizeDiffInput,
  GitSummarizeDiffResult,
  GitUnstageFilesInput,
  GitWorktreeSetupProgressEvent,
  GitUnstageFilesResult,
} from "./git";
import {
  PullRequestActionInput,
  PullRequestCommentInput,
  PullRequestActionResult,
  PullRequestDetail,
  PullRequestDetailInput,
  PullRequestDiffResult,
  PullRequestPipelineInput,
  PullRequestPipelineResult,
  PullRequestSetAutoMergeInput,
  PullRequestSetPinnedInput,
  PullRequestSetPinnedResult,
  PullRequestsUnavailableError,
} from "./pullRequests";
import {
  PullRequestAutoFixGetInput,
  PullRequestAutoFixListResult,
  PullRequestAutoFixResult,
  PullRequestAutoFixSetInput,
} from "./pullRequestAutoFix";
import {
  GitHubInboxListInput,
  GitHubInboxListResult,
  GitHubIssueCommentInput,
  GitHubIssueCommentResult,
  GitHubIssueDetail,
  GitHubIssueDetailInput,
} from "./githubInbox";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationEvent,
  OrchestrationImportThreadInput,
  OrchestrationImportThreadResult,
  OrchestrationRpcSchemas,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
} from "./orchestration";
import {
  ProviderCompactThreadInput,
  ProviderPrewarmThreadInput,
  ProviderPrewarmThreadResult,
} from "./provider";
import {
  ProviderGetComposerCapabilitiesInput,
  ProviderComposerCapabilities,
  ProviderListAgentsInput,
  ProviderListAgentsResult,
  ProviderListCommandsInput,
  ProviderListCommandsResult,
  ProviderListModelsInput,
  ProviderListModelsResult,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderSkillsCatalogInput,
  ProviderSkillsCatalogResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from "./providerDiscovery";
import * as Library from "./neolixLibrary";
import * as NeolixPlugins from "./neolixPlugins";
import * as NeolixSubagents from "./neolixSubagents";
import * as NeolixWorkspaces from "./neolixWorkspaces";
import * as NeolixAttention from "./neolixAttention";
import {
  ProjectCreateEntryInput,
  ProjectCreateLocalFilePreviewGrantInput,
  ProjectCreateLocalFilePreviewGrantResult,
  ProjectDeleteEntryInput,
  ProjectDevServerEvent,
  ProjectDiscoverScriptsInput,
  ProjectDiscoverScriptsResult,
  ProjectDuplicateEntryInput,
  ProjectEntryMutationResult,
  ProjectListDevServersResult,
  ProjectListDirectoriesInput,
  ProjectListDirectoriesResult,
  ProjectDownloadFileInput,
  ProjectDownloadFileResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectRenameEntryInput,
  ProjectFileChangeEvent,
  ProjectWatchFileInput,
  ProjectPrewarmSearchIndexInput,
  ProjectPrewarmSearchIndexResult,
  ProjectResolveWorkspaceFileReferencesInput,
  ProjectResolveWorkspaceFileReferencesResult,
  ProjectResolveOutOfRootFileReferenceInput,
  ProjectResolveOutOfRootFileReferenceResult,
  ProjectRestartDevServerInput,
  ProjectRestartDevServerResult,
  ProjectRunDevServerInput,
  ProjectRunDevServerResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ProjectSearchLocalEntriesInput,
  ProjectSearchLocalEntriesResult,
  ProjectStopDevServerInput,
  ProjectStopDevServerResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import {
  ServerConfig,
  ServerRuntimeStatus,
  ServerConfigStreamEvent,
  ServerDiagnosticsResult,
  ServerReadThreadDiagnosticsInput,
  ServerReadThreadDiagnosticsResult,
  ServerGenerateAutomationIntentInput,
  ServerGenerateAutomationIntentResult,
  ServerGenerateThreadRecapInput,
  ServerGenerateThreadRecapResult,
  ServerGetEnvironmentResult,
  ServerConsumeCodexResetCreditInput,
  ServerConsumeCodexResetCreditResult,
  ServerGetProviderUsageSnapshotInput,
  ServerGetProviderUsageSnapshotResult,
  ServerListProviderUsageInput,
  ServerListProviderUsageResult,
  ServerLifecycleStreamEvent,
  ServerGetSettingsResult,
  ServerKeepAwakeUpdatedPayload,
  ServerListLocalServersResult,
  ServerListWorktreesResult,
  ServerProviderUpdateError,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerRefreshProvidersResult,
  ServerStopLocalServerInput,
  ServerStopLocalServerResult,
  ServerUpdateSettingsInput,
  ServerUpdateSettingsResult,
  ServerEditKeybindingsInput,
  ServerEditKeybindingsResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
  ServerVoicePrewarmInput,
  ServerVoicePrewarmResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
  ServerRealtimeVoiceCapabilitiesResult,
  ServerStartRealtimeVoiceInput,
  ServerStartRealtimeVoiceResult,
  ServerStopRealtimeVoiceResult,
  ServerRealtimeVoiceAudioInput,
  ServerRealtimeVoiceAudioPlayedInput,
  ServerRealtimeVoiceEvent,
} from "./server";
import {
  TerminalAckOutputInput,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalFocusHeartbeatInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import {
  StatsGetProfileStatsInput,
  StatsGetProfileStatsResult,
  StatsGetProfileTokenStatsInput,
  StatsGetProfileTokenStatsResult,
  StatsGetRecapInput,
  StatsGetRecapResult,
} from "./stats";
import {
  HostsAddInput,
  HostsEnrollmentResult,
  HostsHostInput,
  HostsReachabilityResult,
  HostsRevokeDeviceInput,
  HostsUpdateInput,
  WS_METHODS,
} from "./ws";
import { LinkDeviceApproveRequest } from "./hostAuth";
import { EndHostSessionInput, ListHostSessionsResponse } from "./hostSessions";
import {
  HostConnection,
  HostsConnectInput,
  HostsDisconnectInput,
  ListHostConnectionsResponse,
} from "./hostConnection";
import {
  ConfirmSyncKeyPairingRequest,
  SyncKeyPairingCode,
  SyncKeyPairingRequest,
} from "./hostSecrets";
import { ListHostsResponse } from "./account";
import {
  WS_BOOTSTRAP_METHOD,
  WsBootstrapNegotiateInput,
  WsBootstrapNegotiateResult,
  WsCompatibilityError,
} from "./wsCompatibility";

/** Retry only the affected orchestration subscription from its last applied cursor. */
export const ORCHESTRATION_STREAM_OVERFLOW_CODE = "ORCHESTRATION_STREAM_OVERFLOW";

export class WsRpcError extends Schema.TaggedErrorClass<WsRpcError>()("WsRpcError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
  code: Schema.optional(Schema.String),
  retryable: Schema.optional(Schema.Boolean),
  retryAfterMs: Schema.optional(Schema.Number),
  /**
   * The values a `neolix.*` message token interpolates. The message stays
   * English for clients that do not know the token; the desktop web front end
   * translates it from the token and these values.
   */
  // COMPAT(rpcErrorParams): added in v0.15.0, remove after 2027-11-10.
  params: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
  ),
  /** Present only for the capped Sync-Key verification flow. */
  remainingAttempts: Schema.optional(Schema.Number),
}) {}

export const WsBootstrapNegotiateRpc = Rpc.make(WS_BOOTSTRAP_METHOD, {
  payload: WsBootstrapNegotiateInput,
  success: WsBootstrapNegotiateResult,
  error: WsCompatibilityError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationImportThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.importThread, {
  payload: OrchestrationImportThreadInput,
  success: OrchestrationImportThreadResult,
  error: WsRpcError,
});

export const WsOrchestrationSettleTurnDispatchRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.settleTurnDispatch,
  {
    payload: OrchestrationRpcSchemas.settleTurnDispatch.input,
    success: OrchestrationRpcSchemas.settleTurnDispatch.output,
    error: WsRpcError,
  },
);

export const WsListProjectImportsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.listProjectImports, {
  payload: OrchestrationRpcSchemas.listProjectImports.input,
  success: OrchestrationRpcSchemas.listProjectImports.output,
  error: WsRpcError,
});

export const WsLoadProjectImportHistoryRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.loadProjectImportHistory,
  {
    payload: OrchestrationRpcSchemas.loadProjectImportHistory.input,
    success: OrchestrationRpcSchemas.loadProjectImportHistory.output,
    error: WsRpcError,
  },
);

export const WsImportProjectRpc = Rpc.make(ORCHESTRATION_WS_METHODS.importProject, {
  payload: OrchestrationRpcSchemas.importProject.input,
  success: OrchestrationRpcSchemas.importProject.output,
  error: WsRpcError,
});

export const WsOrchestrationRegenerateThreadTitleRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.regenerateThreadTitle,
  {
    payload: OrchestrationRpcSchemas.regenerateThreadTitle.input,
    success: OrchestrationRpcSchemas.regenerateThreadTitle.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationRpcSchemas.getSnapshot.input,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: WsRpcError,
});

export const WsOrchestrationGetShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getShellSnapshot.input,
    success: OrchestrationRpcSchemas.getShellSnapshot.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationRepairStateRpc = Rpc.make(ORCHESTRATION_WS_METHODS.repairState, {
  payload: OrchestrationRpcSchemas.repairState.input,
  success: OrchestrationRpcSchemas.repairState.output,
  error: WsRpcError,
});

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationRpcSchemas.getTurnDiff.input,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: WsRpcError,
});

export const WsOrchestrationGetInlineVisualRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getInlineVisual,
  {
    payload: OrchestrationRpcSchemas.getInlineVisual.input,
    success: OrchestrationRpcSchemas.getInlineVisual.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationRpcSchemas.getFullThreadDiff.input,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationGetThreadDetailSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  {
    payload: OrchestrationRpcSchemas.getThreadDetailSnapshot.input,
    success: OrchestrationRpcSchemas.getThreadDetailSnapshot.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationRpcSchemas.searchThreads.input,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: WsRpcError,
});

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationRpcSchemas.replayEvents.input,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: WsRpcError,
});

export const WsOrchestrationListProviderDeliveryBlockersRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  {
    payload: OrchestrationRpcSchemas.listProviderDeliveryBlockers.input,
    success: OrchestrationRpcSchemas.listProviderDeliveryBlockers.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationReconcileProviderDeliveryRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
  {
    payload: OrchestrationRpcSchemas.reconcileProviderDelivery.input,
    success: OrchestrationRpcSchemas.reconcileProviderDelivery.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationPrepareQuitResumeRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.prepareQuitResume,
  {
    payload: OrchestrationRpcSchemas.prepareQuitResume.input,
    success: OrchestrationRpcSchemas.prepareQuitResume.output,
    error: WsRpcError,
  },
);

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationShellStreamItem,
  error: WsRpcError,
  stream: true,
});

export const WsOrchestrationUnsubscribeShellRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.unsubscribeShell,
  {
    payload: OrchestrationRpcSchemas.unsubscribeShell.input,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationThreadStreamItem,
    error: WsRpcError,
    stream: true,
  },
);

export const WsOrchestrationSubscribeDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsOrchestrationUnsubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.unsubscribeThread,
  {
    payload: OrchestrationRpcSchemas.unsubscribeThread.input,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsProjectsListDirectoriesRpc = Rpc.make(WS_METHODS.projectsListDirectories, {
  payload: ProjectListDirectoriesInput,
  success: ProjectListDirectoriesResult,
  error: WsRpcError,
});

export const WsProjectsDiscoverScriptsRpc = Rpc.make(WS_METHODS.projectsDiscoverScripts, {
  payload: ProjectDiscoverScriptsInput,
  success: ProjectDiscoverScriptsResult,
  error: WsRpcError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: WsRpcError,
});

export const WsProjectsSearchLocalEntriesRpc = Rpc.make(WS_METHODS.projectsSearchLocalEntries, {
  payload: ProjectSearchLocalEntriesInput,
  success: ProjectSearchLocalEntriesResult,
  error: WsRpcError,
});

export const WsProjectsSearchContentRpc = Rpc.make(WS_METHODS.projectsSearchContent, {
  payload: ProjectSearchContentInput,
  success: ProjectSearchContentResult,
  error: WsRpcError,
});

export const WsProjectsPrewarmSearchIndexRpc = Rpc.make(WS_METHODS.projectsPrewarmSearchIndex, {
  payload: ProjectPrewarmSearchIndexInput,
  success: ProjectPrewarmSearchIndexResult,
  error: WsRpcError,
});

export const WsEditorDebugStartRpc = Rpc.make(WS_METHODS.editorDebugStart, {
  payload: EditorDebugStartInput,
  success: EditorDebugStartResult,
  error: WsRpcError,
});
export const WsEditorDebugActionRpc = Rpc.make(WS_METHODS.editorDebugAction, {
  payload: EditorDebugActionInput,
  success: EditorDebugActionResult,
  error: WsRpcError,
});
export const WsEditorDebugPollRpc = Rpc.make(WS_METHODS.editorDebugPoll, {
  payload: EditorDebugPollInput,
  success: EditorDebugSnapshot,
  error: WsRpcError,
});

export const WsEditorIntelligenceRpc = Rpc.make(WS_METHODS.editorIntelligence, {
  payload: EditorIntelligenceInput,
  success: EditorIntelligenceResult,
  error: WsRpcError,
});

export const WsProjectsReadFileRpc = Rpc.make(WS_METHODS.projectsReadFile, {
  payload: ProjectReadFileInput,
  success: ProjectReadFileResult,
  error: WsRpcError,
});

export const WsProjectsDownloadFileRpc = Rpc.make(WS_METHODS.projectsDownloadFile, {
  payload: ProjectDownloadFileInput,
  success: ProjectDownloadFileResult,
  error: WsRpcError,
});

export const WsProjectsSubscribeFileChangeRpc = Rpc.make(WS_METHODS.projectsSubscribeFileChange, {
  payload: ProjectWatchFileInput,
  success: ProjectFileChangeEvent,
  error: WsRpcError,
  stream: true,
});

export const WsProjectsResolveWorkspaceFileReferencesRpc = Rpc.make(
  WS_METHODS.projectsResolveWorkspaceFileReferences,
  {
    payload: ProjectResolveWorkspaceFileReferencesInput,
    success: ProjectResolveWorkspaceFileReferencesResult,
    error: WsRpcError,
  },
);

export const WsProjectsResolveOutOfRootFileReferenceRpc = Rpc.make(
  WS_METHODS.projectsResolveOutOfRootFileReference,
  {
    payload: ProjectResolveOutOfRootFileReferenceInput,
    success: ProjectResolveOutOfRootFileReferenceResult,
    error: WsRpcError,
  },
);

export const WsProjectsCreateLocalFilePreviewGrantRpc = Rpc.make(
  WS_METHODS.projectsCreateLocalFilePreviewGrant,
  {
    payload: ProjectCreateLocalFilePreviewGrantInput,
    success: ProjectCreateLocalFilePreviewGrantResult,
    error: WsRpcError,
  },
);

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: WsRpcError,
});

export const WsProjectsCreateEntryRpc = Rpc.make(WS_METHODS.projectsCreateEntry, {
  payload: ProjectCreateEntryInput,
  success: ProjectEntryMutationResult,
  error: WsRpcError,
});

export const WsProjectsRenameEntryRpc = Rpc.make(WS_METHODS.projectsRenameEntry, {
  payload: ProjectRenameEntryInput,
  success: ProjectEntryMutationResult,
  error: WsRpcError,
});

export const WsProjectsDuplicateEntryRpc = Rpc.make(WS_METHODS.projectsDuplicateEntry, {
  payload: ProjectDuplicateEntryInput,
  success: ProjectEntryMutationResult,
  error: WsRpcError,
});

export const WsProjectsDeleteEntryRpc = Rpc.make(WS_METHODS.projectsDeleteEntry, {
  payload: ProjectDeleteEntryInput,
  success: ProjectEntryMutationResult,
  error: WsRpcError,
});

export const WsProjectsRunDevServerRpc = Rpc.make(WS_METHODS.projectsRunDevServer, {
  payload: ProjectRunDevServerInput,
  success: ProjectRunDevServerResult,
  error: WsRpcError,
});

export const WsProjectsStopDevServerRpc = Rpc.make(WS_METHODS.projectsStopDevServer, {
  payload: ProjectStopDevServerInput,
  success: ProjectStopDevServerResult,
  error: WsRpcError,
});

export const WsProjectsRestartDevServerRpc = Rpc.make(WS_METHODS.projectsRestartDevServer, {
  payload: ProjectRestartDevServerInput,
  success: ProjectRestartDevServerResult,
  error: WsRpcError,
});

export const WsProjectsListDevServersRpc = Rpc.make(WS_METHODS.projectsListDevServers, {
  payload: Schema.Struct({}),
  success: ProjectListDevServersResult,
  error: WsRpcError,
});

export const WsSubscribeProjectDevServerEventsRpc = Rpc.make(
  WS_METHODS.subscribeProjectDevServerEvents,
  {
    payload: Schema.Struct({}),
    success: ProjectDevServerEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsProjectsProvisionFromGitHubRpc = Rpc.make(WS_METHODS.projectsProvisionFromGitHub, {
  payload: GitHubProjectProvisionInput,
  success: GitHubProjectProvisionProgressEvent,
  error: WsRpcError,
  stream: true,
});

export const WsProjectsSearchGitHubRepositoriesRpc = Rpc.make(
  WS_METHODS.projectsSearchGitHubRepositories,
  {
    payload: GitHubRepositorySearchInput,
    success: GitHubRepositorySearchResult,
    error: WsRpcError,
  },
);

export const WsStudioListThreadOutputsRpc = Rpc.make(WS_METHODS.studioListThreadOutputs, {
  payload: StudioListThreadOutputsInput,
  success: StudioListThreadOutputsResult,
  error: WsRpcError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: WsRpcError,
});

// ── Device pane ──────────────────────────────────────────────────────
// Grouped separately from WsFeatureRpcGroup: the device engine is macOS-only,
// so the server merges this group in only where a backend can exist.

export const WsDeviceListRpc = Rpc.make(DEVICE_WS_METHODS.list, {
  payload: DeviceListInput,
  success: DeviceListResult,
  error: WsRpcError,
});

export const WsDeviceBootRpc = Rpc.make(DEVICE_WS_METHODS.boot, {
  payload: DeviceBootInput,
  success: DeviceBootResult,
  error: WsRpcError,
});

export const WsDeviceShutdownRpc = Rpc.make(DEVICE_WS_METHODS.shutdown, {
  payload: DeviceShutdownInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDeviceAttachRpc = Rpc.make(DEVICE_WS_METHODS.attach, {
  payload: DeviceAttachInput,
  success: ThreadDeviceState,
  error: WsRpcError,
});

export const WsDeviceDetachRpc = Rpc.make(DEVICE_WS_METHODS.detach, {
  payload: DeviceDetachInput,
  success: ThreadDeviceState,
  error: WsRpcError,
});

export const WsDeviceGetThreadStateRpc = Rpc.make(DEVICE_WS_METHODS.getThreadState, {
  payload: DeviceThreadInput,
  success: ThreadDeviceState,
  error: WsRpcError,
});

export const WsDeviceTapRpc = Rpc.make(DEVICE_WS_METHODS.tap, {
  payload: DeviceTapInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDeviceSwipeRpc = Rpc.make(DEVICE_WS_METHODS.swipe, {
  payload: DeviceSwipeInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDeviceTypeTextRpc = Rpc.make(DEVICE_WS_METHODS.typeText, {
  payload: DeviceTypeTextInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDeviceKeyEventRpc = Rpc.make(DEVICE_WS_METHODS.keyEvent, {
  payload: DeviceKeyEventInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDevicePressButtonRpc = Rpc.make(DEVICE_WS_METHODS.pressButton, {
  payload: DevicePressButtonInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDeviceInstallAppRpc = Rpc.make(DEVICE_WS_METHODS.installApp, {
  payload: DeviceInstallAppInput,
  success: DeviceInstallAppResult,
  error: WsRpcError,
});

export const WsDeviceLaunchAppRpc = Rpc.make(DEVICE_WS_METHODS.launchApp, {
  payload: DeviceLaunchAppInput,
  success: DeviceLaunchAppResult,
  error: WsRpcError,
});

export const WsDeviceOpenUrlRpc = Rpc.make(DEVICE_WS_METHODS.openUrl, {
  payload: DeviceOpenUrlInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsDeviceScreenshotRpc = Rpc.make(DEVICE_WS_METHODS.screenshot, {
  payload: DeviceScreenshotInput,
  success: DeviceScreenshotResult,
  error: WsRpcError,
});

export const WsDeviceStartRecordingRpc = Rpc.make(DEVICE_WS_METHODS.startRecording, {
  payload: DeviceStartRecordingInput,
  success: DeviceStartRecordingResult,
  error: WsRpcError,
});

export const WsDeviceStopRecordingRpc = Rpc.make(DEVICE_WS_METHODS.stopRecording, {
  payload: DeviceStopRecordingInput,
  success: DeviceStopRecordingResult,
  error: WsRpcError,
});

export const WsDeviceDescribeUiRpc = Rpc.make(DEVICE_WS_METHODS.describeUi, {
  payload: DeviceDescribeUiInput,
  success: DeviceDescribeUiResult,
  error: WsRpcError,
});

export const WsDeviceScrollToElementRpc = Rpc.make(DEVICE_WS_METHODS.scrollToElement, {
  payload: DeviceScrollToElementInput,
  success: DeviceScrollToElementResult,
  error: WsRpcError,
});

export const WsSubscribeDeviceEventsRpc = Rpc.make(DEVICE_WS_METHODS.subscribeEvents, {
  payload: Schema.Struct({}),
  success: DeviceEvent,
  error: WsRpcError,
  stream: true,
});

export const WsDeviceRpcGroup = RpcGroup.make(
  WsDeviceListRpc,
  WsDeviceBootRpc,
  WsDeviceShutdownRpc,
  WsDeviceAttachRpc,
  WsDeviceDetachRpc,
  WsDeviceGetThreadStateRpc,
  WsDeviceTapRpc,
  WsDeviceSwipeRpc,
  WsDeviceTypeTextRpc,
  WsDeviceKeyEventRpc,
  WsDevicePressButtonRpc,
  WsDeviceInstallAppRpc,
  WsDeviceLaunchAppRpc,
  WsDeviceOpenUrlRpc,
  WsDeviceScreenshotRpc,
  WsDeviceStartRecordingRpc,
  WsDeviceStopRecordingRpc,
  WsDeviceDescribeUiRpc,
  WsDeviceScrollToElementRpc,
  WsSubscribeDeviceEventsRpc,
);

// ── Computer control ────────────────────────────────────────────────
// Two callers, two gates. The agent reaches these methods through the MCP
// gateway only, gated on the session's `computer:control` capability lease;
// the human pane reaches them through its own authenticated WebSocket with no
// turn attached and no gateway in between. The group is kept separate so both
// admission rules stay visible next to the contract they guard.

export const WsComputerGetStatusRpc = Rpc.make(COMPUTER_WS_METHODS.getStatus, {
  payload: ComputerGetStatusInput,
  success: ComputerStatusResult,
  error: WsRpcError,
});

export const WsComputerGetAuditHistoryRpc = Rpc.make(COMPUTER_WS_METHODS.getAuditHistory, {
  payload: ComputerGetAuditHistoryInput,
  success: ComputerGetAuditHistoryResult,
  error: WsRpcError,
});

export const WsComputerProvisionRpc = Rpc.make(COMPUTER_WS_METHODS.provision, {
  payload: ComputerProvisionInput,
  success: ComputerProvisionResult,
  error: WsRpcError,
});

export const WsComputerListWindowsRpc = Rpc.make(COMPUTER_WS_METHODS.listWindows, {
  payload: ComputerListWindowsInput,
  success: ComputerListWindowsResult,
  error: WsRpcError,
});

export const WsComputerGetStateRpc = Rpc.make(COMPUTER_WS_METHODS.getState, {
  payload: ComputerGetStateInput,
  success: ComputerState,
  error: WsRpcError,
});

export const WsComputerGetScreenSizeRpc = Rpc.make(COMPUTER_WS_METHODS.getScreenSize, {
  payload: ComputerGetScreenSizeInput,
  success: ComputerGetScreenSizeResult,
  error: WsRpcError,
});

export const WsComputerLaunchAppRpc = Rpc.make(COMPUTER_WS_METHODS.launchApp, {
  payload: ComputerLaunchAppInput,
  success: ComputerLaunchAppResult,
  error: WsRpcError,
});

export const WsComputerClickRpc = Rpc.make(COMPUTER_WS_METHODS.click, {
  payload: ComputerClickInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerDoubleClickRpc = Rpc.make(COMPUTER_WS_METHODS.doubleClick, {
  payload: ComputerDoubleClickInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerRightClickRpc = Rpc.make(COMPUTER_WS_METHODS.rightClick, {
  payload: ComputerRightClickInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerMoveCursorRpc = Rpc.make(COMPUTER_WS_METHODS.moveCursor, {
  payload: ComputerMoveCursorInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerDragRpc = Rpc.make(COMPUTER_WS_METHODS.drag, {
  payload: ComputerDragInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerScrollRpc = Rpc.make(COMPUTER_WS_METHODS.scroll, {
  payload: ComputerScrollInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerTypeTextRpc = Rpc.make(COMPUTER_WS_METHODS.typeText, {
  payload: ComputerTypeTextInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerPressKeyRpc = Rpc.make(COMPUTER_WS_METHODS.pressKey, {
  payload: ComputerPressKeyInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerHotkeyRpc = Rpc.make(COMPUTER_WS_METHODS.hotkey, {
  payload: ComputerHotkeyInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerSetValueRpc = Rpc.make(COMPUTER_WS_METHODS.setValue, {
  payload: ComputerSetValueInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerPerformActionRpc = Rpc.make(COMPUTER_WS_METHODS.performAction, {
  payload: ComputerPerformActionInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerSelectTextRpc = Rpc.make(COMPUTER_WS_METHODS.selectText, {
  payload: ComputerSelectTextInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerSetControlEnabledRpc = Rpc.make(COMPUTER_WS_METHODS.setControlEnabled, {
  payload: ComputerSetControlEnabledInput,
  success: ComputerControlEnabledResult,
  error: WsRpcError,
});

export const WsComputerGetThreadStateRpc = Rpc.make(COMPUTER_WS_METHODS.getThreadState, {
  payload: ComputerThreadInput,
  success: ThreadComputerState,
  error: WsRpcError,
});

export const WsComputerInputClickRpc = Rpc.make(COMPUTER_WS_METHODS.inputClick, {
  payload: ComputerInputClickInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerInputScrollRpc = Rpc.make(COMPUTER_WS_METHODS.inputScroll, {
  payload: ComputerInputScrollInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsComputerInputKeyRpc = Rpc.make(COMPUTER_WS_METHODS.inputKey, {
  payload: ComputerInputKeyInput,
  success: ComputerActionResult,
  error: WsRpcError,
});

export const WsSubscribeComputerEventsRpc = Rpc.make(COMPUTER_WS_METHODS.subscribeEvents, {
  payload: Schema.Struct({}),
  success: ComputerEvent,
  error: WsRpcError,
  stream: true,
});

/** Platform-neutral computer control and perception surface. */
export const WsComputerRpcGroup = RpcGroup.make(
  WsComputerGetStatusRpc,
  WsComputerGetAuditHistoryRpc,
  WsComputerProvisionRpc,
  WsComputerListWindowsRpc,
  WsComputerGetStateRpc,
  WsComputerGetScreenSizeRpc,
  WsComputerLaunchAppRpc,
  WsComputerClickRpc,
  WsComputerDoubleClickRpc,
  WsComputerRightClickRpc,
  WsComputerMoveCursorRpc,
  WsComputerDragRpc,
  WsComputerScrollRpc,
  WsComputerTypeTextRpc,
  WsComputerPressKeyRpc,
  WsComputerHotkeyRpc,
  WsComputerSetValueRpc,
  WsComputerPerformActionRpc,
  WsComputerSelectTextRpc,
  WsComputerGetThreadStateRpc,
  WsComputerSetControlEnabledRpc,
  WsComputerInputClickRpc,
  WsComputerInputScrollRpc,
  WsComputerInputKeyRpc,
  WsSubscribeComputerEventsRpc,
);

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStatusRpc = Rpc.make(WS_METHODS.gitStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: WsRpcError,
});

export const WsGitGithubRepositoryRpc = Rpc.make(WS_METHODS.gitGithubRepository, {
  payload: GitHubRepositoryInput,
  success: GitHubRepositoryResult,
  error: WsRpcError,
});

export const WsGitReadWorkingTreeDiffRpc = Rpc.make(WS_METHODS.gitReadWorkingTreeDiff, {
  payload: GitReadWorkingTreeDiffInput,
  success: GitReadWorkingTreeDiffResult,
  error: WsRpcError,
});

export const WsGitBlameLineRpc = Rpc.make(WS_METHODS.gitBlameLine, {
  payload: GitBlameLineInput,
  success: GitBlameLineResult,
  error: WsRpcError,
});

export const WsGitReadFileAtRevRpc = Rpc.make(WS_METHODS.gitReadFileAtRev, {
  payload: GitReadFileAtRevInput,
  success: GitReadFileAtRevResult,
  error: WsRpcError,
});

export const WsGitWorkingTreeDiffStatsRpc = Rpc.make(WS_METHODS.gitWorkingTreeDiffStats, {
  payload: GitReadWorkingTreeDiffInput,
  success: GitWorkingTreeDiffStatsResult,
  error: WsRpcError,
});

export const WsGitSummarizeDiffRpc = Rpc.make(WS_METHODS.gitSummarizeDiff, {
  payload: GitSummarizeDiffInput,
  success: GitSummarizeDiffResult,
  error: WsRpcError,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: WsRpcError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: WsRpcError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: WsRpcError,
});

export const WsGitPullRequestSnapshotRpc = Rpc.make(WS_METHODS.gitPullRequestSnapshot, {
  payload: GitPullRequestSnapshotInput,
  success: GitPullRequestSnapshotResult,
  error: WsRpcError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: WsRpcError,
});

const PullRequestsRpcError = Schema.Union([PullRequestsUnavailableError, WsRpcError]);

export const WsGitHubInboxListRpc = Rpc.make(WS_METHODS.githubInboxList, {
  payload: GitHubInboxListInput,
  success: GitHubInboxListResult,
  error: PullRequestsRpcError,
});

export const WsGitHubInboxIssueDetailRpc = Rpc.make(WS_METHODS.githubInboxIssueDetail, {
  payload: GitHubIssueDetailInput,
  success: GitHubIssueDetail,
  error: PullRequestsRpcError,
});

export const WsGitHubInboxIssueCommentRpc = Rpc.make(WS_METHODS.githubInboxIssueComment, {
  payload: GitHubIssueCommentInput,
  success: GitHubIssueCommentResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsDetailRpc = Rpc.make(WS_METHODS.pullRequestsDetail, {
  payload: PullRequestDetailInput,
  success: PullRequestDetail,
  error: PullRequestsRpcError,
});

export const WsPullRequestsPipelineRpc = Rpc.make(WS_METHODS.pullRequestsPipeline, {
  payload: PullRequestPipelineInput,
  success: PullRequestPipelineResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsDiffRpc = Rpc.make(WS_METHODS.pullRequestsDiff, {
  payload: PullRequestDetailInput,
  success: PullRequestDiffResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsActionRpc = Rpc.make(WS_METHODS.pullRequestsAction, {
  payload: PullRequestActionInput,
  success: PullRequestActionResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsSetAutoMergeRpc = Rpc.make(WS_METHODS.pullRequestsSetAutoMerge, {
  payload: PullRequestSetAutoMergeInput,
  success: PullRequestActionResult,
  error: PullRequestsRpcError,
});

// Comments reuse the action acknowledgment shape: the mutation is confirmed independently of
// the follow-up detail refetch that surfaces the new comment.
export const WsPullRequestsCommentRpc = Rpc.make(WS_METHODS.pullRequestsComment, {
  payload: PullRequestCommentInput,
  success: PullRequestActionResult,
  error: PullRequestsRpcError,
});

export const WsPullRequestsSetPinnedRpc = Rpc.make(WS_METHODS.pullRequestsSetPinned, {
  payload: PullRequestSetPinnedInput,
  success: PullRequestSetPinnedResult,
  error: WsRpcError,
});

export const WsPullRequestsGetAutoFixRpc = Rpc.make(WS_METHODS.pullRequestsGetAutoFix, {
  payload: PullRequestAutoFixGetInput,
  success: PullRequestAutoFixListResult,
  error: WsRpcError,
});

export const WsPullRequestsSetAutoFixRpc = Rpc.make(WS_METHODS.pullRequestsSetAutoFix, {
  payload: PullRequestAutoFixSetInput,
  success: PullRequestAutoFixResult,
  error: WsRpcError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: WsRpcError,
});

export const WsGitListRecentCommitsRpc = Rpc.make(WS_METHODS.gitListRecentCommits, {
  payload: GitListRecentCommitsInput,
  success: GitListRecentCommitsResult,
  error: WsRpcError,
});

export const WsGitListCommitsRpc = Rpc.make(WS_METHODS.gitListCommits, {
  payload: GitListCommitsInput,
  success: GitListCommitsResult,
  error: WsRpcError,
});

export const WsGitCommitDiffRpc = Rpc.make(WS_METHODS.gitCommitDiff, {
  payload: GitCommitDiffInput,
  success: GitCommitDiffResult,
  error: WsRpcError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: WsRpcError,
});

// Streams setup phases (branch → worktree → copy-changes) so the UI can show
// real progress; the terminal `completed` event carries the created worktree.
export const WsGitCreateDetachedWorktreeRpc = Rpc.make(WS_METHODS.gitCreateDetachedWorktree, {
  payload: GitCreateDetachedWorktreeInput,
  success: GitWorktreeSetupProgressEvent,
  error: WsRpcError,
  stream: true,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStashAndCheckoutRpc = Rpc.make(WS_METHODS.gitStashAndCheckout, {
  payload: GitStashAndCheckoutInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStashDropRpc = Rpc.make(WS_METHODS.gitStashDrop, {
  payload: GitStashDropInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStashInfoRpc = Rpc.make(WS_METHODS.gitStashInfo, {
  payload: GitStashInfoInput,
  success: GitStashInfoResult,
  error: WsRpcError,
});

export const WsGitStashListRpc = Rpc.make(WS_METHODS.gitStashList, {
  payload: GitStashListInput,
  success: GitStashListResult,
  error: WsRpcError,
});

export const WsGitStashPopRpc = Rpc.make(WS_METHODS.gitStashPop, {
  payload: GitStashPopInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitRemoveIndexLockRpc = Rpc.make(WS_METHODS.gitRemoveIndexLock, {
  payload: GitRemoveIndexLockInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitStageFilesRpc = Rpc.make(WS_METHODS.gitStageFiles, {
  payload: GitStageFilesInput,
  success: GitStageFilesResult,
  error: WsRpcError,
});

export const WsGitUnstageFilesRpc = Rpc.make(WS_METHODS.gitUnstageFiles, {
  payload: GitUnstageFilesInput,
  success: GitUnstageFilesResult,
  error: WsRpcError,
});

export const WsGitDiscardChangesRpc = Rpc.make(WS_METHODS.gitDiscardChanges, {
  payload: GitDiscardChangesInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitMergeLocallyRpc = Rpc.make(WS_METHODS.gitMergeLocally, {
  payload: GitMergeLocallyInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitMergeFromBaseRpc = Rpc.make(WS_METHODS.gitMergeFromBase, {
  payload: GitMergeFromBaseInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsGitHandoffThreadRpc = Rpc.make(WS_METHODS.gitHandoffThread, {
  payload: GitHandoffThreadInput,
  success: GitHandoffThreadResult,
  error: WsRpcError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: WsRpcError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalAckOutputRpc = Rpc.make(WS_METHODS.terminalAckOutput, {
  payload: TerminalAckOutputInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: WsRpcError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsTerminalFocusHeartbeatRpc = Rpc.make(WS_METHODS.terminalFocusHeartbeat, {
  payload: TerminalFocusHeartbeatInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  error: WsRpcError,
  stream: true,
});

export const WsServerGetRuntimeStatusRpc = Rpc.make(WS_METHODS.serverGetRuntimeStatus, {
  payload: Schema.Struct({}),
  success: ServerRuntimeStatus,
  error: WsRpcError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: WsRpcError,
});

export const WsServerGetEnvironmentRpc = Rpc.make(WS_METHODS.serverGetEnvironment, {
  payload: Schema.Struct({}),
  success: ServerGetEnvironmentResult,
  error: WsRpcError,
});

export const WsServerDesktopUpdateStatusRpc = Rpc.make(WS_METHODS.serverDesktopUpdateStatus, {
  payload: Schema.Struct({}),
  success: ServerDesktopUpdateStatus,
  error: WsRpcError,
});

export const WsServerDesktopUpdateRpc = Rpc.make(WS_METHODS.serverDesktopUpdate, {
  payload: ServerDesktopUpdateInput,
  success: ServerDesktopUpdateResult,
  error: WsRpcError,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerGetSettingsResult,
  error: WsRpcError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: ServerUpdateSettingsInput,
  success: ServerUpdateSettingsResult,
  error: WsRpcError,
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerRefreshProvidersResult,
  error: WsRpcError,
});

export const WsServerUpdateProviderRpc = Rpc.make(WS_METHODS.serverUpdateProvider, {
  payload: ServerProviderUpdateInput,
  success: ServerProviderUpdateResult,
  error: ServerProviderUpdateError,
});

export const WsServerListExternalMcpIntegrationsRpc = Rpc.make(
  WS_METHODS.serverListExternalMcpIntegrations,
  {
    payload: Schema.Struct({}),
    success: Schema.Array(ExternalMcpIntegration),
    error: WsRpcError,
  },
);

export const WsServerCreateExternalMcpIntegrationRpc = Rpc.make(
  WS_METHODS.serverCreateExternalMcpIntegration,
  {
    payload: ExternalMcpCreateIntegrationInput,
    success: ExternalMcpCreateIntegrationResult,
    error: WsRpcError,
  },
);

export const WsServerRevokeExternalMcpIntegrationRpc = Rpc.make(
  WS_METHODS.serverRevokeExternalMcpIntegration,
  {
    payload: ExternalMcpRevokeIntegrationInput,
    success: Schema.Struct({ revoked: Schema.Boolean }),
    error: WsRpcError,
  },
);

export const WsServerRefreshExternalMcpPairingRpc = Rpc.make(
  WS_METHODS.serverRefreshExternalMcpPairing,
  {
    payload: ExternalMcpRefreshPairingInput,
    success: ExternalMcpCreateIntegrationResult,
    error: WsRpcError,
  },
);

export const WsServerListMcpConnectorsRpc = Rpc.make(WS_METHODS.serverListMcpConnectors, {
  payload: Schema.Struct({}),
  success: Schema.Array(McpConnector),
  error: WsRpcError,
});

export const WsServerListMcpConnectorProposalsRpc = Rpc.make(
  WS_METHODS.serverListMcpConnectorProposals,
  {
    payload: Schema.Struct({}),
    success: Schema.Array(McpConnectorProposal),
    error: WsRpcError,
  },
);
export const WsServerResolveMcpConnectorProposalRpc = Rpc.make(
  WS_METHODS.serverResolveMcpConnectorProposal,
  {
    payload: McpConnectorResolveProposalInput,
    success: McpConnectorResolveProposalResult,
    error: WsRpcError,
  },
);

export const WsServerConnectMcpConnectorRpc = Rpc.make(WS_METHODS.serverConnectMcpConnector, {
  payload: McpConnectorConnectInput,
  success: McpConnectorConnectResult,
  error: WsRpcError,
});

export const WsServerDisconnectMcpConnectorRpc = Rpc.make(WS_METHODS.serverDisconnectMcpConnector, {
  payload: McpConnectorDisconnectInput,
  success: McpConnectorDisconnectResult,
  error: WsRpcError,
});

export const WsServerGetMcpConnectorSetupRpc = Rpc.make(WS_METHODS.serverGetMcpConnectorSetup, {
  payload: Schema.Struct({}),
  success: McpConnectorSetup,
  error: WsRpcError,
});

export const WsServerListWorktreesRpc = Rpc.make(WS_METHODS.serverListWorktrees, {
  payload: Schema.Struct({}),
  success: ServerListWorktreesResult,
  error: WsRpcError,
});

export const WsServerListLocalServersRpc = Rpc.make(WS_METHODS.serverListLocalServers, {
  payload: Schema.Struct({}),
  success: ServerListLocalServersResult,
  error: WsRpcError,
});

export const WsServerStopLocalServerRpc = Rpc.make(WS_METHODS.serverStopLocalServer, {
  payload: ServerStopLocalServerInput,
  success: ServerStopLocalServerResult,
  error: WsRpcError,
});

export const WsServerGetProviderUsageSnapshotRpc = Rpc.make(
  WS_METHODS.serverGetProviderUsageSnapshot,
  {
    payload: ServerGetProviderUsageSnapshotInput,
    success: ServerGetProviderUsageSnapshotResult,
    error: WsRpcError,
  },
);

export const WsServerListProviderUsageRpc = Rpc.make(WS_METHODS.serverListProviderUsage, {
  payload: ServerListProviderUsageInput,
  success: ServerListProviderUsageResult,
  error: WsRpcError,
});

export const WsServerConsumeCodexResetCreditRpc = Rpc.make(
  WS_METHODS.serverConsumeCodexResetCredit,
  {
    payload: ServerConsumeCodexResetCreditInput,
    success: ServerConsumeCodexResetCreditResult,
    error: WsRpcError,
  },
);

export const WsStatsGetProfileStatsRpc = Rpc.make(WS_METHODS.statsGetProfileStats, {
  payload: StatsGetProfileStatsInput,
  success: StatsGetProfileStatsResult,
  error: WsRpcError,
});

export const WsStatsGetProfileTokenStatsRpc = Rpc.make(WS_METHODS.statsGetProfileTokenStats, {
  payload: StatsGetProfileTokenStatsInput,
  success: StatsGetProfileTokenStatsResult,
  error: WsRpcError,
});

export const WsStatsGetRecapRpc = Rpc.make(WS_METHODS.statsGetRecap, {
  payload: StatsGetRecapInput,
  success: StatsGetRecapResult,
  error: WsRpcError,
});

export const WsServerGetDiagnosticsRpc = Rpc.make(WS_METHODS.serverGetDiagnostics, {
  payload: Schema.Struct({}),
  success: ServerDiagnosticsResult,
  error: WsRpcError,
});

export const WsServerReadThreadDiagnosticsRpc = Rpc.make(WS_METHODS.serverReadThreadDiagnostics, {
  payload: ServerReadThreadDiagnosticsInput,
  success: ServerReadThreadDiagnosticsResult,
  error: WsRpcError,
});

export const WsServerPrewarmVoiceRpc = Rpc.make(WS_METHODS.serverPrewarmVoice, {
  payload: ServerVoicePrewarmInput,
  success: ServerVoicePrewarmResult,
  error: WsRpcError,
});

export const WsServerTranscribeVoiceRpc = Rpc.make(WS_METHODS.serverTranscribeVoice, {
  payload: ServerVoiceTranscriptionInput,
  success: ServerVoiceTranscriptionResult,
  error: WsRpcError,
});

export const WsServerGenerateThreadRecapRpc = Rpc.make(WS_METHODS.serverGenerateThreadRecap, {
  payload: ServerGenerateThreadRecapInput,
  success: ServerGenerateThreadRecapResult,
  error: WsRpcError,
});

export const WsServerGenerateAutomationIntentRpc = Rpc.make(
  WS_METHODS.serverGenerateAutomationIntent,
  {
    payload: ServerGenerateAutomationIntentInput,
    success: ServerGenerateAutomationIntentResult,
    error: WsRpcError,
  },
);

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: WsRpcError,
});

export const WsServerEditKeybindingsRpc = Rpc.make(WS_METHODS.serverEditKeybindings, {
  payload: ServerEditKeybindingsInput,
  success: ServerEditKeybindingsResult,
  error: WsRpcError,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerProviderStatusesRpc = Rpc.make(
  WS_METHODS.subscribeServerProviderStatuses,
  {
    payload: Schema.Struct({}),
    success: ServerRefreshProvidersResult,
    error: WsRpcError,
    stream: true,
  },
);

export const WsSubscribeServerSettingsRpc = Rpc.make(WS_METHODS.subscribeServerSettings, {
  payload: Schema.Struct({}),
  success: Schema.Struct({ settings: ServerGetSettingsResult }),
  error: WsRpcError,
  stream: true,
});

export const WsSubscribeServerKeepAwakeRpc = Rpc.make(WS_METHODS.subscribeServerKeepAwake, {
  payload: Schema.Struct({}),
  success: ServerKeepAwakeUpdatedPayload,
  error: WsRpcError,
  stream: true,
});

export const WsProviderGetComposerCapabilitiesRpc = Rpc.make(
  WS_METHODS.providerGetComposerCapabilities,
  {
    payload: ProviderGetComposerCapabilitiesInput,
    success: ProviderComposerCapabilities,
    error: WsRpcError,
  },
);

export const WsProviderCompactThreadRpc = Rpc.make(WS_METHODS.providerCompactThread, {
  payload: ProviderCompactThreadInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsProviderPrewarmThreadRpc = Rpc.make(WS_METHODS.providerPrewarmThread, {
  payload: ProviderPrewarmThreadInput,
  success: ProviderPrewarmThreadResult,
  error: WsRpcError,
});

export const WsProviderListCommandsRpc = Rpc.make(WS_METHODS.providerListCommands, {
  payload: ProviderListCommandsInput,
  success: ProviderListCommandsResult,
  error: WsRpcError,
});

export const WsProviderListSkillsRpc = Rpc.make(WS_METHODS.providerListSkills, {
  payload: ProviderListSkillsInput,
  success: ProviderListSkillsResult,
  error: WsRpcError,
});

export const WsProviderListSkillsCatalogRpc = Rpc.make(WS_METHODS.providerListSkillsCatalog, {
  payload: ProviderSkillsCatalogInput,
  success: ProviderSkillsCatalogResult,
  error: WsRpcError,
});

export const WsProviderListPluginsRpc = Rpc.make(WS_METHODS.providerListPlugins, {
  payload: ProviderListPluginsInput,
  success: ProviderListPluginsResult,
  error: WsRpcError,
});

export const WsProviderReadPluginRpc = Rpc.make(WS_METHODS.providerReadPlugin, {
  payload: ProviderReadPluginInput,
  success: ProviderReadPluginResult,
  error: WsRpcError,
});

export const WsProviderListModelsRpc = Rpc.make(WS_METHODS.providerListModels, {
  payload: ProviderListModelsInput,
  success: ProviderListModelsResult,
  error: WsRpcError,
});

export const WsProviderListAgentsRpc = Rpc.make(WS_METHODS.providerListAgents, {
  payload: ProviderListAgentsInput,
  success: ProviderListAgentsResult,
  error: WsRpcError,
});

export const WsAccountStatusRpc = Rpc.make(WS_METHODS.accountStatus, {
  payload: Schema.Struct({}),
  success: AccountStatus,
  error: WsRpcError,
});

export const WsAccountBillingStatusRpc = Rpc.make(WS_METHODS.accountBillingStatus, {
  payload: Schema.Struct({}),
  success: AccountBillingStatus,
  error: WsRpcError,
});
export const WsAccountBillingCheckoutRpc = Rpc.make(WS_METHODS.accountBillingCheckout, {
  payload: AccountBillingCheckoutRequest,
  success: AccountBillingRedirect,
  error: WsRpcError,
});
export const WsAccountBillingPortalRpc = Rpc.make(WS_METHODS.accountBillingPortal, {
  payload: Schema.Struct({}),
  success: AccountBillingRedirect,
  error: WsRpcError,
});

/**
 * Asks WorkOS to email the caller a 6-digit sign-in code. Deliberately
 * answers the same shape whether or not the address has an account.
 */
export const WsAccountSendOtpRpc = Rpc.make(WS_METHODS.accountSendOtp, {
  payload: AccountSendOtpInput,
  success: AccountSendOtpResult,
  error: WsRpcError,
});

/**
 * In-app OTP sign-in — redeems the emailed 6-digit code. The payload is a
 * credential, so it must never be logged by transport-level request tracing;
 * see the note on {@link OtpAuthenticateRequest}.
 */
export const WsAccountAuthenticateOtpRpc = Rpc.make(WS_METHODS.accountAuthenticateOtp, {
  payload: AccountAuthenticateOtpInput,
  success: AccountStatus,
  error: WsRpcError,
});

/**
 * In-app email verification — redeems the emailed 6-digit code plus the
 * pending token from an `email_verification_required` refusal. The payload is
 * a bearer-ish secret pair, so it takes the same no-logging rule as the OTP
 * RPC above.
 */
export const WsAccountBeginSsoRpc = Rpc.make(WS_METHODS.accountBeginSso, {
  payload: AccountBeginSsoInput,
  success: AccountBeginSsoResult,
  error: WsRpcError,
});

/**
 * Long-running by design: the server waits on the loopback browser callback
 * for as long as the attempt lives. Clients must not impose their usual RPC
 * timeout on it.
 */
export const WsAccountCompleteSsoRpc = Rpc.make(WS_METHODS.accountCompleteSso, {
  payload: AccountCompleteSsoInput,
  success: AccountStatus,
  error: WsRpcError,
});

export const WsAccountCancelSsoRpc = Rpc.make(WS_METHODS.accountCancelSso, {
  payload: AccountCompleteSsoInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsAccountUsageSummaryRpc = Rpc.make(WS_METHODS.accountUsageSummary, {
  payload: AccountUsageSummaryInput,
  success: UsageSummary,
  error: WsRpcError,
});

export const WsAccountSaveInboxRecapRpc = Rpc.make(WS_METHODS.accountSaveInboxRecap, {
  payload: AccountSaveInboxRecapInput,
  success: SavedInboxRecap,
  error: WsRpcError,
});
export const WsAccountListInboxRecapsRpc = Rpc.make(WS_METHODS.accountListInboxRecaps, {
  payload: ListSavedInboxRecapsInput,
  success: ListSavedInboxRecapsResponse,
  error: WsRpcError,
});
export const WsAccountDeleteInboxRecapRpc = Rpc.make(WS_METHODS.accountDeleteInboxRecap, {
  payload: SavedInboxRecapIdInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsAccountUpdateProfileRpc = Rpc.make(WS_METHODS.accountUpdateProfile, {
  payload: AccountUpdateProfileInput,
  success: AccountMe,
  error: WsRpcError,
});

export const WsAccountUploadAvatarRpc = Rpc.make(WS_METHODS.accountUploadAvatar, {
  payload: AccountUploadAvatarInput,
  success: AccountMe,
  error: WsRpcError,
});

export const WsAccountDeleteAvatarRpc = Rpc.make(WS_METHODS.accountDeleteAvatar, {
  payload: Schema.Struct({}),
  success: AccountMe,
  error: WsRpcError,
});

export const WsAccountDeleteRpc = Rpc.make(WS_METHODS.accountDelete, {
  payload: AccountDeleteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsAccountSignOutRpc = Rpc.make(WS_METHODS.accountSignOut, {
  payload: Schema.Struct({}),
  success: Schema.Void,
  error: WsRpcError,
});

export const WsAccountOpenVerificationUrlRpc = Rpc.make(WS_METHODS.accountOpenVerificationUrl, {
  payload: AccountOpenVerificationUrlInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsListRpc = Rpc.make(WS_METHODS.hostsList, {
  payload: Schema.Struct({}),
  success: ListHostsResponse,
  error: WsRpcError,
});

export const WsHostsAddRpc = Rpc.make(WS_METHODS.hostsAdd, {
  payload: HostsAddInput,
  success: AccountHost,
  error: WsRpcError,
});

export const WsHostsUpdateRpc = Rpc.make(WS_METHODS.hostsUpdate, {
  payload: HostsUpdateInput,
  success: AccountHost,
  error: WsRpcError,
});

export const WsHostsDeleteRpc = Rpc.make(WS_METHODS.hostsDelete, {
  payload: HostsHostInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsListDevicesRpc = Rpc.make(WS_METHODS.hostsListDevices, {
  payload: Schema.Struct({}),
  success: ListDevicesResponse,
  error: WsRpcError,
});

export const WsHostsRevokeDeviceRpc = Rpc.make(WS_METHODS.hostsRevokeDevice, {
  payload: HostsRevokeDeviceInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsApproveDeviceLinkRpc = Rpc.make(WS_METHODS.hostsApproveDeviceLink, {
  payload: LinkDeviceApproveRequest,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsRequestGrantRpc = Rpc.make(WS_METHODS.hostsRequestGrant, {
  payload: HostsHostInput,
  success: GrantResponse,
  error: WsRpcError,
});

export const WsHostsEnrollmentRpc = Rpc.make(WS_METHODS.hostsEnrollment, {
  payload: Schema.Struct({}),
  success: HostsEnrollmentResult,
  error: WsRpcError,
});

export const WsHostsUnlinkLocalHostRpc = Rpc.make(WS_METHODS.hostsUnlinkLocalHost, {
  payload: Schema.Struct({}),
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsListSessionsRpc = Rpc.make(WS_METHODS.hostsListSessions, {
  payload: Schema.Struct({}),
  success: ListHostSessionsResponse,
  error: WsRpcError,
});

export const WsHostsEndSessionRpc = Rpc.make(WS_METHODS.hostsEndSession, {
  payload: EndHostSessionInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsBeginSyncKeyPairingRpc = Rpc.make(WS_METHODS.hostsBeginSyncKeyPairing, {
  payload: Schema.Struct({}),
  success: SyncKeyPairingRequest,
  error: WsRpcError,
});

export const WsHostsOfferSyncKeyRpc = Rpc.make(WS_METHODS.hostsOfferSyncKey, {
  payload: SyncKeyPairingRequest,
  success: SyncKeyPairingCode,
  error: WsRpcError,
});

export const WsHostsReceiveSyncKeyRpc = Rpc.make(WS_METHODS.hostsReceiveSyncKey, {
  payload: Schema.Struct({}),
  success: SyncKeyPairingCode,
  error: WsRpcError,
});

export const WsHostsConfirmSyncKeyRpc = Rpc.make(WS_METHODS.hostsConfirmSyncKey, {
  payload: ConfirmSyncKeyPairingRequest,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsRemoteAccessRpc = Rpc.make(WS_METHODS.hostsRemoteAccess, {
  payload: RemoteAccessInput,
  success: RemoteAccessResult,
  error: WsRpcError,
});

export const WsHostsConnectRpc = Rpc.make(WS_METHODS.hostsConnect, {
  payload: HostsConnectInput,
  success: HostConnection,
  error: WsRpcError,
});

export const WsHostsDisconnectRpc = Rpc.make(WS_METHODS.hostsDisconnect, {
  payload: HostsDisconnectInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsHostsListConnectionsRpc = Rpc.make(WS_METHODS.hostsListConnections, {
  payload: Schema.Struct({}),
  success: ListHostConnectionsResponse,
  error: WsRpcError,
});

export const WsHostsCheckReachabilityRpc = Rpc.make(WS_METHODS.hostsCheckReachability, {
  payload: HostsHostInput,
  success: HostsReachabilityResult,
  error: WsRpcError,
});

export const WsAutomationListRpc = Rpc.make(WS_METHODS.automationList, {
  payload: AutomationListInput,
  success: AutomationListResult,
  error: WsRpcError,
});

export const WsAutomationGetMemoryRpc = Rpc.make(WS_METHODS.automationGetMemory, {
  payload: AutomationGetMemoryInput,
  success: Schema.NullOr(AutomationMemory),
  error: WsRpcError,
});

export const WsAutomationCreateRpc = Rpc.make(WS_METHODS.automationCreate, {
  payload: AutomationCreateInput,
  success: AutomationDefinition,
  error: WsRpcError,
});

export const WsAutomationUpdateRpc = Rpc.make(WS_METHODS.automationUpdate, {
  payload: AutomationUpdateInput,
  success: AutomationDefinition,
  error: WsRpcError,
});

export const WsAutomationDeleteRpc = Rpc.make(WS_METHODS.automationDelete, {
  payload: AutomationDeleteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsAutomationRunNowRpc = Rpc.make(WS_METHODS.automationRunNow, {
  payload: AutomationRunNowInput,
  success: AutomationRunNowResult,
  error: WsRpcError,
});

export const WsAutomationCancelRunRpc = Rpc.make(WS_METHODS.automationCancelRun, {
  payload: AutomationCancelRunInput,
  success: AutomationCancelRunResult,
  error: WsRpcError,
});

export const WsAutomationMarkRunReadRpc = Rpc.make(WS_METHODS.automationMarkRunRead, {
  payload: AutomationMarkRunReadInput,
  success: AutomationRunActionResult,
  error: WsRpcError,
});

export const WsAutomationArchiveRunRpc = Rpc.make(WS_METHODS.automationArchiveRun, {
  payload: AutomationArchiveRunInput,
  success: AutomationRunActionResult,
  error: WsRpcError,
});

export const WsAutomationResolveProposalRpc = Rpc.make(WS_METHODS.automationResolveProposal, {
  payload: AutomationResolveProposalInput,
  success: AutomationResolveProposalResult,
  error: WsRpcError,
});

export const WsSubscribeAutomationEventsRpc = Rpc.make(WS_METHODS.subscribeAutomationEvents, {
  payload: Schema.Struct({}),
  success: AutomationStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsTodoListRpc = Rpc.make(WS_METHODS.todoList, {
  payload: Schema.Struct({}),
  success: TodoListResult,
  error: WsRpcError,
});

export const WsTodoCreateRpc = Rpc.make(WS_METHODS.todoCreate, {
  payload: TodoCreateInput,
  success: Todo,
  error: WsRpcError,
});

export const WsTodoUpdateRpc = Rpc.make(WS_METHODS.todoUpdate, {
  payload: TodoUpdateInput,
  success: Todo,
  error: WsRpcError,
});

export const WsTodoDeleteRpc = Rpc.make(WS_METHODS.todoDelete, {
  payload: TodoDeleteInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsSubscribeTodoEventsRpc = Rpc.make(WS_METHODS.subscribeTodoEvents, {
  payload: Schema.Struct({}),
  success: TodoStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsProjectAgentGetOverviewRpc = Rpc.make(WS_METHODS.projectAgentGetOverview, {
  payload: ProjectAgentGetOverviewInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentListSummariesRpc = Rpc.make(WS_METHODS.projectAgentListSummaries, {
  payload: ProjectAgentListSummariesInput,
  success: ProjectAgentListSummariesResult,
  error: WsRpcError,
});
export const WsProjectAgentConfigureRpc = Rpc.make(WS_METHODS.projectAgentConfigure, {
  payload: ProjectAgentConfigureInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentLinkProjectRpc = Rpc.make(WS_METHODS.projectAgentLinkProject, {
  payload: ProjectAgentLinkProjectInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentUnlinkProjectRpc = Rpc.make(WS_METHODS.projectAgentUnlinkProject, {
  payload: ProjectAgentUnlinkProjectInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentPauseGroupRpc = Rpc.make(WS_METHODS.projectAgentPauseGroup, {
  payload: ProjectAgentGroupControlInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentResumeGroupRpc = Rpc.make(WS_METHODS.projectAgentResumeGroup, {
  payload: ProjectAgentGroupControlInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentArchiveGroupRpc = Rpc.make(WS_METHODS.projectAgentArchiveGroup, {
  payload: ProjectAgentGroupControlInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentUnarchiveGroupRpc = Rpc.make(WS_METHODS.projectAgentUnarchiveGroup, {
  payload: ProjectAgentGroupControlInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentRestartCoordinatorRpc = Rpc.make(
  WS_METHODS.projectAgentRestartCoordinator,
  {
    payload: ProjectAgentGroupControlInput,
    success: ProjectAgentOverview,
    error: WsRpcError,
  },
);
export const WsProjectAgentDeleteGroupRpc = Rpc.make(WS_METHODS.projectAgentDeleteGroup, {
  payload: ProjectAgentDeleteGroupInput,
  success: ProjectAgentDeleteGroupResult,
  error: WsRpcError,
});
export const WsProjectAgentStartGoalRpc = Rpc.make(WS_METHODS.projectAgentStartGoal, {
  payload: ProjectAgentStartGoalInput,
  success: ProjectGoal,
  error: WsRpcError,
});
export const WsProjectAgentUpdateGoalRpc = Rpc.make(WS_METHODS.projectAgentUpdateGoal, {
  payload: ProjectAgentUpdateGoalInput,
  success: ProjectGoal,
  error: WsRpcError,
});
export const WsProjectAgentPauseGoalRpc = Rpc.make(WS_METHODS.projectAgentPauseGoal, {
  payload: ProjectAgentGoalControlInput,
  success: ProjectGoal,
  error: WsRpcError,
});
export const WsProjectAgentResumeGoalRpc = Rpc.make(WS_METHODS.projectAgentResumeGoal, {
  payload: ProjectAgentGoalControlInput,
  success: ProjectGoal,
  error: WsRpcError,
});
export const WsProjectAgentStopGoalRpc = Rpc.make(WS_METHODS.projectAgentStopGoal, {
  payload: ProjectAgentGoalControlInput,
  success: ProjectGoal,
  error: WsRpcError,
});
export const WsProjectAgentListTasksRpc = Rpc.make(WS_METHODS.projectAgentListTasks, {
  payload: ProjectAgentListTasksInput,
  success: ProjectAgentListTasksResult,
  error: WsRpcError,
});
export const WsProjectAgentUpdateTaskRpc = Rpc.make(WS_METHODS.projectAgentUpdateTask, {
  payload: ProjectAgentUpdateTaskInput,
  success: ProjectTask,
  error: WsRpcError,
});
export const WsProjectAgentCreateTaskRpc = Rpc.make(WS_METHODS.projectAgentCreateTask, {
  payload: ProjectAgentCreateTaskInput,
  success: ProjectTask,
  error: WsRpcError,
});
export const WsProjectAgentListEvidenceRpc = Rpc.make(WS_METHODS.projectAgentListEvidence, {
  payload: ProjectAgentListEvidenceInput,
  success: ProjectAgentListEvidenceResult,
  error: WsRpcError,
});
export const WsProjectAgentListThreadIndexRpc = Rpc.make(WS_METHODS.projectAgentListThreadIndex, {
  payload: ProjectAgentListThreadIndexInput,
  success: ProjectAgentListThreadIndexResult,
  error: WsRpcError,
});
export const WsProjectAgentExcludeThreadRpc = Rpc.make(WS_METHODS.projectAgentExcludeThread, {
  payload: ProjectAgentExcludeThreadInput,
  success: ProjectThreadIndexEntry,
  error: WsRpcError,
});
export const WsProjectAgentBackfillSummariesRpc = Rpc.make(
  WS_METHODS.projectAgentBackfillSummaries,
  {
    payload: ProjectAgentBackfillInput,
    success: ProjectAgentOverview,
    error: WsRpcError,
  },
);
export const WsProjectAgentListActivityRpc = Rpc.make(WS_METHODS.projectAgentListActivity, {
  payload: ProjectAgentListActivityInput,
  success: ProjectAgentListActivityResult,
  error: WsRpcError,
});
export const WsProjectAgentListDocumentsRpc = Rpc.make(WS_METHODS.projectAgentListDocuments, {
  payload: ProjectAgentListDocumentsInput,
  success: ProjectAgentListDocumentsResult,
  error: WsRpcError,
});
export const WsProjectAgentReadDocumentRpc = Rpc.make(WS_METHODS.projectAgentReadDocument, {
  payload: ProjectAgentReadDocumentInput,
  success: ProjectAgentReadDocumentResult,
  error: WsRpcError,
});
export const WsProjectAgentWriteDocumentRpc = Rpc.make(WS_METHODS.projectAgentWriteDocument, {
  payload: ProjectAgentWriteDocumentInput,
  success: ProjectDocumentRevision,
  error: WsRpcError,
});
export const WsProjectAgentExportDocumentsRpc = Rpc.make(WS_METHODS.projectAgentExportDocuments, {
  payload: ProjectAgentExportDocumentsInput,
  success: ProjectAgentExportDocumentsResult,
  error: WsRpcError,
});
export const WsProjectAgentRefreshDigestRpc = Rpc.make(WS_METHODS.projectAgentRefreshDigest, {
  payload: ProjectAgentRefreshDigestInput,
  success: ProjectAgentOverview,
  error: WsRpcError,
});
export const WsProjectAgentLibraryListRpc = Rpc.make(WS_METHODS.projectAgentLibraryList, {
  payload: ProjectAgentLibraryListInput,
  success: ProjectAgentLibraryListResult,
  error: WsRpcError,
});
export const WsProjectAgentLibraryMkdirRpc = Rpc.make(WS_METHODS.projectAgentLibraryMkdir, {
  payload: ProjectAgentLibraryMkdirInput,
  success: ProjectAgentLibraryMutationResult,
  error: WsRpcError,
});
export const WsProjectAgentLibraryRenameRpc = Rpc.make(WS_METHODS.projectAgentLibraryRename, {
  payload: ProjectAgentLibraryRenameInput,
  success: ProjectAgentLibraryMutationResult,
  error: WsRpcError,
});
export const WsProjectAgentLibraryDeleteRpc = Rpc.make(WS_METHODS.projectAgentLibraryDelete, {
  payload: ProjectAgentLibraryDeleteInput,
  success: ProjectAgentLibraryMutationResult,
  error: WsRpcError,
});
export const WsProjectAgentLibraryHistoryRpc = Rpc.make(WS_METHODS.projectAgentLibraryHistory, {
  payload: ProjectAgentLibraryHistoryInput,
  success: ProjectAgentLibraryHistoryResult,
  error: WsRpcError,
});
export const WsProjectAgentLibraryRestoreRpc = Rpc.make(WS_METHODS.projectAgentLibraryRestore, {
  payload: ProjectAgentLibraryRestoreInput,
  success: ProjectAgentLibraryMutationResult,
  error: WsRpcError,
});
export const WsProjectAgentLibraryStatusRpc = Rpc.make(WS_METHODS.projectAgentLibraryStatus, {
  payload: ProjectAgentLibraryStatusInput,
  success: ProjectAgentLibraryStatusResult,
  error: WsRpcError,
});
export const WsProjectAgentResolveWorkerRpc = Rpc.make(WS_METHODS.projectAgentResolveWorker, {
  payload: ProjectAgentResolveWorkerInput,
  success: ProjectAgentResolveWorkerResult,
  error: WsRpcError,
});
export const WsSubscribeProjectAgentEventsRpc = Rpc.make(WS_METHODS.subscribeProjectAgentEvents, {
  payload: ProjectAgentSubscribeInput,
  success: ProjectAgentStreamEvent,
  error: WsRpcError,
  stream: true,
});

export const WsBootstrapRpcGroup = RpcGroup.make(WsBootstrapNegotiateRpc);

export const WsAgentGatewayCallRpc = Rpc.make(WS_METHODS.agentGatewayCall, {
  payload: RemoteAgentCall,
  success: RemoteAgentResult,
  error: WsRpcError,
});

// Keep declaration emission bounded by referencing each RPC instead of expanding every schema.
export type WsFeatureRpc =
  | typeof WsAgentGatewayCallRpc
  | typeof WsOrchestrationDispatchCommandRpc
  | typeof WsOrchestrationSettleTurnDispatchRpc
  | typeof WsOrchestrationImportThreadRpc
  | typeof WsListProjectImportsRpc
  | typeof WsImportProjectRpc
  | typeof WsLoadProjectImportHistoryRpc
  | typeof WsOrchestrationRegenerateThreadTitleRpc
  | typeof WsOrchestrationGetSnapshotRpc
  | typeof WsOrchestrationGetShellSnapshotRpc
  | typeof WsOrchestrationGetThreadDetailSnapshotRpc
  | typeof WsOrchestrationSearchThreadsRpc
  | typeof WsOrchestrationRepairStateRpc
  | typeof WsOrchestrationGetTurnDiffRpc
  | typeof WsOrchestrationGetInlineVisualRpc
  | typeof WsOrchestrationGetFullThreadDiffRpc
  | typeof WsOrchestrationReplayEventsRpc
  | typeof WsOrchestrationListProviderDeliveryBlockersRpc
  | typeof WsOrchestrationReconcileProviderDeliveryRpc
  | typeof WsOrchestrationPrepareQuitResumeRpc
  | typeof WsOrchestrationSubscribeShellRpc
  | typeof WsOrchestrationUnsubscribeShellRpc
  | typeof WsOrchestrationSubscribeThreadRpc
  | typeof WsOrchestrationUnsubscribeThreadRpc
  | typeof WsOrchestrationSubscribeDomainEventsRpc
  | typeof WsProjectsDiscoverScriptsRpc
  | typeof WsProjectsListDirectoriesRpc
  | typeof WsProjectsSearchEntriesRpc
  | typeof WsProjectsSearchLocalEntriesRpc
  | typeof WsProjectsSearchContentRpc
  | typeof WsProjectsPrewarmSearchIndexRpc
  | typeof WsEditorIntelligenceRpc
  | typeof WsEditorDebugStartRpc
  | typeof WsEditorDebugActionRpc
  | typeof WsEditorDebugPollRpc
  | typeof WsProjectsReadFileRpc
  | typeof WsProjectsSubscribeFileChangeRpc
  | typeof WsProjectsResolveWorkspaceFileReferencesRpc
  | typeof WsProjectsResolveOutOfRootFileReferenceRpc
  | typeof WsProjectsCreateLocalFilePreviewGrantRpc
  | typeof WsProjectsWriteFileRpc
  | typeof WsProjectsRunDevServerRpc
  | typeof WsProjectsStopDevServerRpc
  | typeof WsProjectsRestartDevServerRpc
  | typeof WsProjectsListDevServersRpc
  | typeof WsSubscribeProjectDevServerEventsRpc
  | typeof WsProjectsProvisionFromGitHubRpc
  | typeof WsProjectsSearchGitHubRepositoriesRpc
  | typeof WsStudioListThreadOutputsRpc
  | typeof WsFilesystemBrowseRpc
  | typeof WsShellOpenInEditorRpc
  | typeof WsGitGithubRepositoryRpc
  | typeof WsGitStatusRpc
  | typeof WsGitReadWorkingTreeDiffRpc
  | typeof WsGitBlameLineRpc
  | typeof WsGitReadFileAtRevRpc
  | typeof WsGitWorkingTreeDiffStatsRpc
  | typeof WsGitSummarizeDiffRpc
  | typeof WsGitPullRpc
  | typeof WsGitRunStackedActionRpc
  | typeof WsGitResolvePullRequestRpc
  | typeof WsGitPullRequestSnapshotRpc
  | typeof WsGitPreparePullRequestThreadRpc
  | typeof WsGitHubInboxListRpc
  | typeof WsGitHubInboxIssueDetailRpc
  | typeof WsGitHubInboxIssueCommentRpc
  | typeof WsPullRequestsDetailRpc
  | typeof WsPullRequestsPipelineRpc
  | typeof WsPullRequestsDiffRpc
  | typeof WsPullRequestsActionRpc
  | typeof WsPullRequestsSetAutoMergeRpc
  | typeof WsPullRequestsCommentRpc
  | typeof WsPullRequestsSetPinnedRpc
  | typeof WsPullRequestsGetAutoFixRpc
  | typeof WsPullRequestsSetAutoFixRpc
  | typeof WsGitListBranchesRpc
  | typeof WsGitListRecentCommitsRpc
  | typeof WsGitListCommitsRpc
  | typeof WsGitCommitDiffRpc
  | typeof WsGitCreateWorktreeRpc
  | typeof WsGitCreateDetachedWorktreeRpc
  | typeof WsGitRemoveWorktreeRpc
  | typeof WsGitCreateBranchRpc
  | typeof WsGitCheckoutRpc
  | typeof WsGitStashAndCheckoutRpc
  | typeof WsGitStashDropRpc
  | typeof WsGitStashInfoRpc
  | typeof WsGitStashListRpc
  | typeof WsGitStashPopRpc
  | typeof WsGitRemoveIndexLockRpc
  | typeof WsGitInitRpc
  | typeof WsGitStageFilesRpc
  | typeof WsGitUnstageFilesRpc
  | typeof WsGitDiscardChangesRpc
  | typeof WsGitMergeLocallyRpc
  | typeof WsGitMergeFromBaseRpc
  | typeof WsGitHandoffThreadRpc
  | typeof WsTerminalOpenRpc
  | typeof WsTerminalWriteRpc
  | typeof WsTerminalAckOutputRpc
  | typeof WsTerminalResizeRpc
  | typeof WsTerminalClearRpc
  | typeof WsTerminalRestartRpc
  | typeof WsTerminalCloseRpc
  | typeof WsTerminalFocusHeartbeatRpc
  | typeof WsSubscribeTerminalEventsRpc
  | typeof WsServerGetRuntimeStatusRpc
  | typeof WsServerGetConfigRpc
  | typeof WsServerGetEnvironmentRpc
  | typeof WsServerDesktopUpdateStatusRpc
  | typeof WsServerDesktopUpdateRpc
  | typeof WsServerGetSettingsRpc
  | typeof WsServerUpdateSettingsRpc
  | typeof WsServerRefreshProvidersRpc
  | typeof WsServerUpdateProviderRpc
  | typeof WsServerListExternalMcpIntegrationsRpc
  | typeof WsServerCreateExternalMcpIntegrationRpc
  | typeof WsServerRevokeExternalMcpIntegrationRpc
  | typeof WsServerRefreshExternalMcpPairingRpc
  | typeof WsServerListMcpConnectorsRpc
  | typeof WsServerListMcpConnectorProposalsRpc
  | typeof WsServerResolveMcpConnectorProposalRpc
  | typeof WsServerConnectMcpConnectorRpc
  | typeof WsServerDisconnectMcpConnectorRpc
  | typeof WsServerGetMcpConnectorSetupRpc
  | typeof WsServerListWorktreesRpc
  | typeof WsServerListLocalServersRpc
  | typeof WsServerStopLocalServerRpc
  | typeof WsServerGetProviderUsageSnapshotRpc
  | typeof WsServerListProviderUsageRpc
  | typeof WsServerConsumeCodexResetCreditRpc
  | typeof WsStatsGetProfileStatsRpc
  | typeof WsStatsGetProfileTokenStatsRpc
  | typeof WsStatsGetRecapRpc
  | typeof WsServerGetDiagnosticsRpc
  | typeof WsServerReadThreadDiagnosticsRpc
  | typeof WsServerPrewarmVoiceRpc
  | typeof WsServerTranscribeVoiceRpc
  | typeof WsServerGenerateThreadRecapRpc
  | typeof WsServerGenerateAutomationIntentRpc
  | typeof WsServerUpsertKeybindingRpc
  | typeof WsServerEditKeybindingsRpc
  | typeof WsSubscribeServerLifecycleRpc
  | typeof WsSubscribeServerConfigRpc
  | typeof WsSubscribeServerProviderStatusesRpc
  | typeof WsSubscribeServerKeepAwakeRpc
  | typeof WsSubscribeServerSettingsRpc
  | typeof WsProviderGetComposerCapabilitiesRpc
  | typeof WsProviderCompactThreadRpc
  | typeof WsProviderPrewarmThreadRpc
  | typeof WsProviderListCommandsRpc
  | typeof WsProviderListSkillsRpc
  | typeof WsProviderListSkillsCatalogRpc
  | typeof WsProviderListPluginsRpc
  | typeof WsProviderReadPluginRpc
  | typeof WsProviderListModelsRpc
  | typeof WsProviderListAgentsRpc
  | typeof WsAccountStatusRpc
  | typeof WsAccountBillingStatusRpc
  | typeof WsAccountBillingCheckoutRpc
  | typeof WsAccountBillingPortalRpc
  | typeof WsAccountSendOtpRpc
  | typeof WsAccountAuthenticateOtpRpc
  | typeof WsAccountBeginSsoRpc
  | typeof WsAccountCompleteSsoRpc
  | typeof WsAccountCancelSsoRpc
  | typeof WsAccountUsageSummaryRpc
  | typeof WsAccountSaveInboxRecapRpc
  | typeof WsAccountListInboxRecapsRpc
  | typeof WsAccountDeleteInboxRecapRpc
  | typeof WsAccountUpdateProfileRpc
  | typeof WsAccountUploadAvatarRpc
  | typeof WsAccountDeleteAvatarRpc
  | typeof WsAccountDeleteRpc
  | typeof WsAccountSignOutRpc
  | typeof WsAccountOpenVerificationUrlRpc
  | typeof WsHostsListRpc
  | typeof WsHostsAddRpc
  | typeof WsHostsUpdateRpc
  | typeof WsHostsDeleteRpc
  | typeof WsHostsListDevicesRpc
  | typeof WsHostsRevokeDeviceRpc
  | typeof WsHostsApproveDeviceLinkRpc
  | typeof WsHostsRequestGrantRpc
  | typeof WsHostsEnrollmentRpc
  | typeof WsHostsUnlinkLocalHostRpc
  | typeof WsHostsListSessionsRpc
  | typeof WsHostsEndSessionRpc
  | typeof WsHostsBeginSyncKeyPairingRpc
  | typeof WsHostsOfferSyncKeyRpc
  | typeof WsHostsReceiveSyncKeyRpc
  | typeof WsHostsConfirmSyncKeyRpc
  | typeof WsHostsRemoteAccessRpc
  | typeof WsHostsConnectRpc
  | typeof WsHostsDisconnectRpc
  | typeof WsHostsListConnectionsRpc
  | typeof WsHostsCheckReachabilityRpc
  | typeof WsAutomationListRpc
  | typeof WsAutomationGetMemoryRpc
  | typeof WsAutomationCreateRpc
  | typeof WsAutomationUpdateRpc
  | typeof WsAutomationDeleteRpc
  | typeof WsAutomationRunNowRpc
  | typeof WsAutomationCancelRunRpc
  | typeof WsAutomationMarkRunReadRpc
  | typeof WsAutomationArchiveRunRpc
  | typeof WsAutomationResolveProposalRpc
  | typeof WsSubscribeAutomationEventsRpc
  | typeof WsTodoListRpc
  | typeof WsTodoCreateRpc
  | typeof WsTodoUpdateRpc
  | typeof WsTodoDeleteRpc
  | typeof WsSubscribeTodoEventsRpc;

// Partition construction while the explicit union bounds the exported declaration.
const wsOrchestrationRpcGroup = RpcGroup.make(
  WsAgentGatewayCallRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationSettleTurnDispatchRpc,
  WsOrchestrationImportThreadRpc,
  WsListProjectImportsRpc,
  WsImportProjectRpc,
  WsLoadProjectImportHistoryRpc,
  WsOrchestrationRegenerateThreadTitleRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetShellSnapshotRpc,
  WsOrchestrationGetThreadDetailSnapshotRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationRepairStateRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetInlineVisualRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationListProviderDeliveryBlockersRpc,
  WsOrchestrationReconcileProviderDeliveryRpc,
  WsOrchestrationPrepareQuitResumeRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationUnsubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
  WsOrchestrationUnsubscribeThreadRpc,
  WsOrchestrationSubscribeDomainEventsRpc,
);

const wsApplicationRpcGroup = RpcGroup.make(
  WsProjectsDiscoverScriptsRpc,
  WsProjectsListDirectoriesRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsSearchLocalEntriesRpc,
  WsProjectsSearchContentRpc,
  WsProjectsPrewarmSearchIndexRpc,
  WsEditorIntelligenceRpc,
  WsEditorDebugStartRpc,
  WsEditorDebugActionRpc,
  WsEditorDebugPollRpc,
  WsProjectsReadFileRpc,
  WsProjectsSubscribeFileChangeRpc,
  WsProjectsResolveWorkspaceFileReferencesRpc,
  WsProjectsResolveOutOfRootFileReferenceRpc,
  WsProjectsCreateLocalFilePreviewGrantRpc,
  WsProjectsWriteFileRpc,
  WsProjectsRunDevServerRpc,
  WsProjectsStopDevServerRpc,
  WsProjectsRestartDevServerRpc,
  WsProjectsListDevServersRpc,
  WsSubscribeProjectDevServerEventsRpc,
  WsProjectsProvisionFromGitHubRpc,
  WsProjectsSearchGitHubRepositoriesRpc,
  WsStudioListThreadOutputsRpc,
  WsFilesystemBrowseRpc,
  WsShellOpenInEditorRpc,
  WsGitGithubRepositoryRpc,
  WsGitStatusRpc,
  WsGitReadWorkingTreeDiffRpc,
  WsGitBlameLineRpc,
  WsGitReadFileAtRevRpc,
  WsGitWorkingTreeDiffStatsRpc,
  WsGitSummarizeDiffRpc,
  WsGitPullRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPullRequestSnapshotRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitHubInboxListRpc,
  WsGitHubInboxIssueDetailRpc,
  WsGitHubInboxIssueCommentRpc,
  WsPullRequestsDetailRpc,
  WsPullRequestsPipelineRpc,
  WsPullRequestsDiffRpc,
  WsPullRequestsActionRpc,
  WsPullRequestsSetAutoMergeRpc,
  WsPullRequestsCommentRpc,
  WsPullRequestsSetPinnedRpc,
  WsPullRequestsGetAutoFixRpc,
  WsPullRequestsSetAutoFixRpc,
  WsGitListBranchesRpc,
  WsGitListRecentCommitsRpc,
  WsGitListCommitsRpc,
  WsGitCommitDiffRpc,
  WsGitCreateWorktreeRpc,
  WsGitCreateDetachedWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitStashAndCheckoutRpc,
  WsGitStashDropRpc,
  WsGitStashInfoRpc,
  WsGitStashListRpc,
  WsGitStashPopRpc,
  WsGitRemoveIndexLockRpc,
  WsGitInitRpc,
  WsGitStageFilesRpc,
  WsGitUnstageFilesRpc,
  WsGitDiscardChangesRpc,
  WsGitMergeLocallyRpc,
  WsGitMergeFromBaseRpc,
  WsGitHandoffThreadRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalAckOutputRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsTerminalFocusHeartbeatRpc,
  WsSubscribeTerminalEventsRpc,
  WsServerGetRuntimeStatusRpc,
  WsServerGetConfigRpc,
  WsServerGetEnvironmentRpc,
  WsServerDesktopUpdateStatusRpc,
  WsServerDesktopUpdateRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpdateProviderRpc,
  WsServerListExternalMcpIntegrationsRpc,
  WsServerCreateExternalMcpIntegrationRpc,
  WsServerRevokeExternalMcpIntegrationRpc,
  WsServerRefreshExternalMcpPairingRpc,
  WsServerListMcpConnectorsRpc,
  WsServerListMcpConnectorProposalsRpc,
  WsServerResolveMcpConnectorProposalRpc,
  WsServerConnectMcpConnectorRpc,
  WsServerDisconnectMcpConnectorRpc,
  WsServerGetMcpConnectorSetupRpc,
  WsServerListWorktreesRpc,
  WsServerListLocalServersRpc,
  WsServerStopLocalServerRpc,
  WsServerGetProviderUsageSnapshotRpc,
  WsServerListProviderUsageRpc,
  WsServerConsumeCodexResetCreditRpc,
  WsStatsGetProfileStatsRpc,
  WsStatsGetProfileTokenStatsRpc,
  WsStatsGetRecapRpc,
  WsServerGetDiagnosticsRpc,
  WsServerReadThreadDiagnosticsRpc,
  WsServerPrewarmVoiceRpc,
  WsServerTranscribeVoiceRpc,
  WsServerGenerateThreadRecapRpc,
  WsServerGenerateAutomationIntentRpc,
  WsServerUpsertKeybindingRpc,
  WsServerEditKeybindingsRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerProviderStatusesRpc,
  WsSubscribeServerKeepAwakeRpc,
  WsSubscribeServerSettingsRpc,
  WsProviderGetComposerCapabilitiesRpc,
  WsProviderCompactThreadRpc,
  WsProviderPrewarmThreadRpc,
  WsProviderListCommandsRpc,
  WsProviderListSkillsRpc,
  WsProviderListSkillsCatalogRpc,
  WsProviderListPluginsRpc,
  WsProviderReadPluginRpc,
  WsProviderListModelsRpc,
  WsProviderListAgentsRpc,
  WsAccountStatusRpc,
  WsAccountBillingStatusRpc,
  WsAccountBillingCheckoutRpc,
  WsAccountBillingPortalRpc,
  WsAccountSendOtpRpc,
  WsAccountAuthenticateOtpRpc,
  WsAccountBeginSsoRpc,
  WsAccountCompleteSsoRpc,
  WsAccountCancelSsoRpc,
  WsAccountUsageSummaryRpc,
  WsAccountSaveInboxRecapRpc,
  WsAccountListInboxRecapsRpc,
  WsAccountDeleteInboxRecapRpc,
  WsAccountUpdateProfileRpc,
  WsAccountUploadAvatarRpc,
  WsAccountDeleteAvatarRpc,
  WsAccountDeleteRpc,
  WsAccountSignOutRpc,
  WsAccountOpenVerificationUrlRpc,
  WsHostsListRpc,
  WsHostsAddRpc,
  WsHostsUpdateRpc,
  WsHostsDeleteRpc,
  WsHostsListDevicesRpc,
  WsHostsRevokeDeviceRpc,
  WsHostsApproveDeviceLinkRpc,
  WsHostsRequestGrantRpc,
  WsHostsEnrollmentRpc,
  WsHostsUnlinkLocalHostRpc,
  WsHostsListSessionsRpc,
  WsHostsEndSessionRpc,
  WsHostsBeginSyncKeyPairingRpc,
  WsHostsOfferSyncKeyRpc,
  WsHostsReceiveSyncKeyRpc,
  WsHostsConfirmSyncKeyRpc,
  WsHostsRemoteAccessRpc,
  WsHostsConnectRpc,
  WsHostsDisconnectRpc,
  WsHostsListConnectionsRpc,
  WsHostsCheckReachabilityRpc,
  WsAutomationListRpc,
  WsAutomationGetMemoryRpc,
  WsAutomationCreateRpc,
  WsAutomationUpdateRpc,
  WsAutomationDeleteRpc,
  WsAutomationRunNowRpc,
  WsAutomationCancelRunRpc,
  WsAutomationMarkRunReadRpc,
  WsAutomationArchiveRunRpc,
  WsAutomationResolveProposalRpc,
  WsSubscribeAutomationEventsRpc,
  WsTodoListRpc,
  WsTodoCreateRpc,
  WsTodoUpdateRpc,
  WsTodoDeleteRpc,
  WsSubscribeTodoEventsRpc,
);

export const WsFeatureRpcGroup: RpcGroup.RpcGroup<WsFeatureRpc> =
  wsOrchestrationRpcGroup.merge(wsApplicationRpcGroup);

// Project-agent RPCs live in a satellite group: folding them into
// WsFeatureRpcGroup pushes its inferred type past the declaration emit limit.
export const WsProjectAgentRpcGroup = RpcGroup.make(
  WsProjectAgentGetOverviewRpc,
  WsProjectAgentListSummariesRpc,
  WsProjectAgentConfigureRpc,
  WsProjectAgentLinkProjectRpc,
  WsProjectAgentUnlinkProjectRpc,
  WsProjectAgentPauseGroupRpc,
  WsProjectAgentResumeGroupRpc,
  WsProjectAgentArchiveGroupRpc,
  WsProjectAgentUnarchiveGroupRpc,
  WsProjectAgentRestartCoordinatorRpc,
  WsProjectAgentDeleteGroupRpc,
  WsProjectAgentStartGoalRpc,
  WsProjectAgentUpdateGoalRpc,
  WsProjectAgentPauseGoalRpc,
  WsProjectAgentResumeGoalRpc,
  WsProjectAgentStopGoalRpc,
  WsProjectAgentListTasksRpc,
  WsProjectAgentUpdateTaskRpc,
  WsProjectAgentCreateTaskRpc,
  WsProjectAgentListEvidenceRpc,
  WsProjectAgentListThreadIndexRpc,
  WsProjectAgentExcludeThreadRpc,
  WsProjectAgentBackfillSummariesRpc,
  WsProjectAgentListActivityRpc,
  WsProjectAgentListDocumentsRpc,
  WsProjectAgentReadDocumentRpc,
  WsProjectAgentWriteDocumentRpc,
  WsProjectAgentExportDocumentsRpc,
  WsProjectAgentRefreshDigestRpc,
  WsProjectAgentLibraryListRpc,
  WsProjectAgentLibraryMkdirRpc,
  WsProjectAgentLibraryRenameRpc,
  WsProjectAgentLibraryDeleteRpc,
  WsProjectAgentLibraryHistoryRpc,
  WsProjectAgentLibraryRestoreRpc,
  WsProjectAgentLibraryStatusRpc,
  WsProjectAgentResolveWorkerRpc,
  WsSubscribeProjectAgentEventsRpc,
);

// Neolix Library RPCs live in their own satellite group for the same declaration-emit reason as
// project-agent RPCs. Consumers merge `NeolixLibraryRpcGroup` into the feature group.
export const WsNeolixLibraryGetRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.get, {
  payload: Library.LibraryEmptyInput,
  success: Library.LibrarySnapshotResult,
  error: WsRpcError,
});

export const WsNeolixLibrarySyncRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.sync, {
  payload: Library.LibraryEmptyInput,
  success: Library.LibraryMutationResult,
  error: WsRpcError,
});

export const WsNeolixLibrarySaveInstructionsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.saveInstructions,
  {
    payload: Library.LibrarySaveInstructionsInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySaveMcpServerRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.saveMcpServer,
  {
    payload: Library.LibrarySaveMcpServerInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryRemoveMcpServerRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.removeMcpServer,
  {
    payload: Library.LibraryMcpNameInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetMcpAgentsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setMcpAgents,
  {
    payload: Library.LibraryMcpSetAgentsInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryCheckMcpServerRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.checkMcpServer,
  {
    payload: Library.LibraryMcpNameInput,
    success: Library.LibraryMcpHealthResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetMcpHubRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.setMcpHub, {
  payload: Library.LibraryMcpHubInput,
  success: Library.LibraryMutationResult,
  error: WsRpcError,
});

export const WsNeolixLibrarySetMcpLocalRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setMcpLocal,
  {
    payload: Library.LibraryMcpLocalInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetMcpRouterRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setMcpRouter,
  {
    payload: Library.LibraryMcpRouterInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySignInMcpServerRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.signInMcpServer,
  {
    payload: Library.LibraryMcpNameInput,
    success: Library.LibraryMcpSignInResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryMcpSignInStatusRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.mcpSignInStatus,
  {
    payload: Library.LibraryIdInput,
    success: Library.LibraryMcpSignInStatusResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryCancelMcpSignInRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.cancelMcpSignIn,
  {
    payload: Library.LibraryIdInput,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySignOutMcpServerRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.signOutMcpServer,
  {
    payload: Library.LibraryMcpNameInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryImportSkillRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.importSkill,
  {
    payload: Library.LibrarySkillImportInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryFindSkillsRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.findSkills, {
  payload: Library.LibrarySkillSourceInput,
  success: Library.LibrarySkillFindResult,
  error: WsRpcError,
});

export const WsNeolixLibraryInstallSkillsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.installSkills,
  {
    payload: Library.LibrarySkillInstallInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetSkillOptionsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setSkillOptions,
  {
    payload: Library.LibrarySkillOptionsInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetSkillNoteRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setSkillNote,
  {
    payload: Library.LibrarySkillNoteInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryCheckSkillUpdatesRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.checkSkillUpdates,
  {
    payload: Library.LibraryEmptyInput,
    success: Library.LibrarySkillCheckResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryUpdateSkillsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.updateSkills,
  {
    payload: Library.LibrarySkillUpdateInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryRemoveSkillRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.removeSkill,
  {
    payload: Library.LibrarySkillNameInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetSkillAgentsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setSkillAgents,
  {
    payload: Library.LibrarySkillSetAgentsInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetSkillHereRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setSkillHere,
  {
    payload: Library.LibrarySkillHereInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryHandOverSkillsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.handOverSkills,
  {
    payload: Library.LibrarySkillHandOverInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryHandBackSkillRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.handBackSkill,
  {
    payload: Library.LibrarySkillNameInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySettleSkillRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.settleSkill,
  {
    payload: Library.LibrarySkillSettleInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySearchMarketRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.searchMarket,
  {
    payload: Library.LibraryMarketSearchInput,
    success: Library.LibraryMarketServersResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryInstallMarketServerRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.installMarketServer,
  {
    payload: Library.LibraryMarketInstallInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySearchSkillMarketRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.searchSkillMarket,
  {
    payload: Library.LibraryMarketSearchInput,
    success: Library.LibrarySkillMarketResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySaveHookRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.saveHook, {
  payload: Library.LibrarySaveHookInput,
  success: Library.LibraryMutationResult,
  error: WsRpcError,
});

export const WsNeolixLibraryRemoveHookRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.removeHook, {
  payload: Library.LibrarySkillNameInput,
  success: Library.LibraryMutationResult,
  error: WsRpcError,
});

export const WsNeolixLibrarySetHookAgentsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setHookAgents,
  {
    payload: Library.LibrarySkillSetAgentsInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySaveSubagentRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.saveSubagent,
  {
    payload: Library.LibrarySaveSubagentInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryRemoveSubagentRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.removeSubagent,
  {
    payload: Library.LibrarySkillNameInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetSubagentAgentsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setSubagentAgents,
  {
    payload: Library.LibrarySkillSetAgentsInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryGetRtkRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.getRtk, {
  payload: Library.LibraryEmptyInput,
  success: Library.LibraryRtkResult,
  error: WsRpcError,
});

export const WsNeolixLibrarySetRtkRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.setRtk, {
  payload: Library.LibraryRtkSetInput,
  success: Library.LibraryRtkResult,
  error: WsRpcError,
});

export const WsNeolixLibraryRunRtkRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.runRtk, {
  payload: Library.LibraryRtkRunInput,
  success: Library.LibraryRtkRunResult,
  error: WsRpcError,
});

export const WsNeolixLibraryGetRtkGainRpc = Rpc.make(Library.NEOLIX_LIBRARY_WS_METHODS.getRtkGain, {
  payload: Library.LibraryEmptyInput,
  success: Library.LibraryRtkGainResult,
  error: WsRpcError,
});

export const WsNeolixLibraryGetDiscoverRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.getDiscover,
  {
    payload: Library.LibraryEmptyInput,
    success: Library.LibraryDiscoverResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryImportDiscoveredRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.importDiscovered,
  {
    payload: Library.LibraryDiscoverSelectionInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryRemoveDiscoveredRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.removeDiscovered,
  {
    payload: Library.LibraryDiscoverSelectionInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryGetMynaLibraryRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.getMynaLibrary,
  {
    payload: Library.LibraryEmptyInput,
    success: Library.LibraryMynaResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryImportMynaLibraryRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.importMynaLibrary,
  {
    payload: Library.LibraryDiscoverSelectionInput,
    success: Library.LibraryMutationResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryListBackupsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.listBackups,
  {
    payload: Library.LibraryEmptyInput,
    success: Library.LibraryBackupsResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryRestoreBackupRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.restoreBackup,
  {
    payload: Library.LibraryBackupRestoreInput,
    success: Library.LibraryRestoreResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibraryGetNeolixToolsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.getNeolixTools,
  {
    payload: Library.LibraryNeolixToolsInput,
    success: Library.LibraryNeolixToolsResult,
    error: WsRpcError,
  },
);

export const WsNeolixLibrarySetNeolixToolsRpc = Rpc.make(
  Library.NEOLIX_LIBRARY_WS_METHODS.setNeolixTools,
  {
    payload: Library.LibrarySetNeolixToolsInput,
    success: Library.LibraryNeolixToolsResult,
    error: WsRpcError,
  },
);

export const NeolixLibraryRpcGroup = RpcGroup.make(
  WsNeolixLibraryGetRpc,
  WsNeolixLibrarySyncRpc,
  WsNeolixLibrarySaveInstructionsRpc,
  WsNeolixLibrarySaveMcpServerRpc,
  WsNeolixLibraryRemoveMcpServerRpc,
  WsNeolixLibrarySetMcpAgentsRpc,
  WsNeolixLibraryCheckMcpServerRpc,
  WsNeolixLibrarySetMcpHubRpc,
  WsNeolixLibrarySetMcpLocalRpc,
  WsNeolixLibrarySetMcpRouterRpc,
  WsNeolixLibrarySignInMcpServerRpc,
  WsNeolixLibraryMcpSignInStatusRpc,
  WsNeolixLibraryCancelMcpSignInRpc,
  WsNeolixLibrarySignOutMcpServerRpc,
  WsNeolixLibraryImportSkillRpc,
  WsNeolixLibraryFindSkillsRpc,
  WsNeolixLibraryInstallSkillsRpc,
  WsNeolixLibrarySetSkillOptionsRpc,
  WsNeolixLibrarySetSkillNoteRpc,
  WsNeolixLibraryCheckSkillUpdatesRpc,
  WsNeolixLibraryUpdateSkillsRpc,
  WsNeolixLibraryRemoveSkillRpc,
  WsNeolixLibrarySetSkillAgentsRpc,
  WsNeolixLibrarySetSkillHereRpc,
  WsNeolixLibraryHandOverSkillsRpc,
  WsNeolixLibraryHandBackSkillRpc,
  WsNeolixLibrarySettleSkillRpc,
  WsNeolixLibrarySearchMarketRpc,
  WsNeolixLibraryInstallMarketServerRpc,
  WsNeolixLibrarySearchSkillMarketRpc,
  WsNeolixLibrarySaveHookRpc,
  WsNeolixLibraryRemoveHookRpc,
  WsNeolixLibrarySetHookAgentsRpc,
  WsNeolixLibrarySaveSubagentRpc,
  WsNeolixLibraryRemoveSubagentRpc,
  WsNeolixLibrarySetSubagentAgentsRpc,
  WsNeolixLibraryGetRtkRpc,
  WsNeolixLibrarySetRtkRpc,
  WsNeolixLibraryRunRtkRpc,
  WsNeolixLibraryGetRtkGainRpc,
  WsNeolixLibraryGetDiscoverRpc,
  WsNeolixLibraryImportDiscoveredRpc,
  WsNeolixLibraryRemoveDiscoveredRpc,
  WsNeolixLibraryGetMynaLibraryRpc,
  WsNeolixLibraryImportMynaLibraryRpc,
  WsNeolixLibraryListBackupsRpc,
  WsNeolixLibraryRestoreBackupRpc,
  WsNeolixLibraryGetNeolixToolsRpc,
  WsNeolixLibrarySetNeolixToolsRpc,
);

// ── Neolix host settings ────────────────────────────────────────────
// The bridge's own host surface (daemon config/lifecycle, speech models, provider sessions,
// sync/backup, gateway config). A satellite group like WsProjectAgentRpcGroup: only the bridge
// and the desktop-web transport merge it, so WsFeatureRpc keeps its downstream-sized union.

const neolixHostPayload = Schema.Struct({});

export const WsNeolixHostGetFeaturesRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getFeatures, {
  payload: neolixHostPayload,
  success: NeolixHostFeatures,
  error: WsRpcError,
});

/**
 * Re-announces the host's feature flags whenever its `server_info` arrives again. A bridged
 * host can restart while the bridge's own session survives, so the front end cannot wait for
 * its socket to reopen before refetching the flags.
 */
export const WsNeolixHostSubscribeFeaturesRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.subscribeFeatures, {
  payload: neolixHostPayload,
  success: NeolixHostFeatures,
  error: WsRpcError,
  stream: true,
});

export const WsNeolixHostGetConfigRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getConfig, {
  payload: neolixHostPayload,
  success: Schema.Struct({ config: Schema.Json }),
  error: WsRpcError,
});

export const WsNeolixHostPatchConfigRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.patchConfig, {
  payload: Schema.Struct({ patch: Schema.Json }),
  success: Schema.Struct({ config: Schema.Json }),
  error: WsRpcError,
});

export const WsNeolixHostGetStatusRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getStatus, {
  payload: neolixHostPayload,
  success: NeolixHostStatus,
  error: WsRpcError,
});

export const WsNeolixHostListSessionTerminalsRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.listSessionTerminals,
  {
    payload: neolixHostPayload,
    success: NeolixSessionTerminals,
    error: WsRpcError,
  },
);

export const WsNeolixHostRestartRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.restart, {
  payload: Schema.Struct({ killTerminals: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({ requestId: Schema.String }),
  error: WsRpcError,
});

export const WsNeolixHostUpdateRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.update, {
  payload: neolixHostPayload,
  success: Schema.Struct({
    success: Schema.Boolean,
    error: Schema.NullOr(Schema.String),
    newVersion: Schema.NullOr(Schema.String),
  }),
  error: WsRpcError,
});

/**
 * Forwards the daemon's `daemon.update.progress` events while an update runs, so the
 * settings panel can name the phase instead of showing a single indefinite "updating".
 */
export const WsNeolixHostSubscribeUpdateProgressRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.subscribeUpdateProgress,
  {
    payload: neolixHostPayload,
    success: NeolixHostUpdateProgress,
    error: WsRpcError,
    stream: true,
  },
);

export const WsNeolixHostGetDiagnosticsRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getDiagnostics, {
  payload: neolixHostPayload,
  success: NeolixHostDiagnostics,
  error: WsRpcError,
});

export const WsNeolixHostGetProviderDiagnosticRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.getProviderDiagnostic,
  {
    payload: Schema.Struct({
      provider: Schema.String,
      instanceId: Schema.optional(Schema.String),
    }),
    success: NeolixProviderDiagnostic,
    error: WsRpcError,
  },
);

export const WsNeolixHostRevealPathRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.revealPath, {
  payload: Schema.Struct({ target: Schema.Literals(["config", "log"]) }),
  success: NeolixHostRevealResult,
  error: WsRpcError,
});

export const WsNeolixHostListSpeechModelsRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.listSpeechModels, {
  payload: neolixHostPayload,
  success: Schema.Struct({ models: Schema.Array(NeolixSpeechModel) }),
  error: WsRpcError,
});

export const WsNeolixHostDownloadSpeechModelRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.downloadSpeechModel,
  {
    payload: Schema.Struct({ modelId: Schema.String }),
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsNeolixHostDeleteSpeechModelRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.deleteSpeechModel, {
  payload: Schema.Struct({ modelId: Schema.String }),
  success: Schema.Void,
  error: WsRpcError,
});

export const WsNeolixHostGetSessionReadsRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getSessionReads, {
  payload: neolixHostPayload,
  success: Schema.Struct({ reads: Schema.NullOr(NeolixSessionReads) }),
  error: WsRpcError,
});

export const WsNeolixHostSetSessionReadsRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.setSessionReads, {
  payload: Schema.Struct({
    all: Schema.optional(Schema.Boolean),
    agents: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  }),
  success: Schema.Struct({ reads: Schema.NullOr(NeolixSessionReads) }),
  error: WsRpcError,
});

export const WsNeolixHostListExternalSessionsRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.listExternalSessions,
  {
    payload: Schema.Struct({ agent: Schema.optional(Schema.String) }),
    success: NeolixExternalSessions,
    error: WsRpcError,
  },
);

export const WsNeolixHostSearchExternalSessionsRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.searchExternalSessions,
  {
    payload: Schema.Struct({ agent: Schema.String, query: Schema.String }),
    success: NeolixExternalSessionSearch,
    error: WsRpcError,
  },
);

export const WsNeolixHostOpenSessionInTerminalRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.openSessionInTerminal,
  {
    payload: Schema.Struct({ agent: Schema.String, id: Schema.String }),
    success: Schema.Struct({ error: Schema.NullOr(Schema.String) }),
    error: WsRpcError,
  },
);

export const WsNeolixHostDeleteExternalSessionsRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.deleteExternalSessions,
  {
    payload: Schema.Struct({ agent: Schema.String, ids: Schema.Array(Schema.String) }),
    success: NeolixExternalSessionDelete,
    error: WsRpcError,
  },
);

export const WsNeolixHostRestoreExternalSessionRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.restoreExternalSession,
  {
    payload: Schema.Struct({ key: Schema.String }),
    success: NeolixExternalSessionRestore,
    error: WsRpcError,
  },
);

export const WsNeolixHostPurgeExternalSessionsRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.purgeExternalSessions,
  {
    payload: Schema.Struct({
      keys: Schema.optional(Schema.Array(Schema.String)),
      all: Schema.optional(Schema.Boolean),
    }),
    success: NeolixExternalSessionPurge,
    error: WsRpcError,
  },
);

export const WsNeolixHostGetExternalSessionTranscriptRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.getExternalSessionTranscript,
  {
    payload: Schema.Struct({
      agent: Schema.String,
      id: Schema.String,
      offset: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
    success: NeolixExternalTranscript,
    error: WsRpcError,
  },
);

export const WsNeolixHostExportExternalSessionRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.exportExternalSession,
  {
    payload: Schema.Struct({ agent: Schema.String, id: Schema.String }),
    success: NeolixExternalExport,
    error: WsRpcError,
  },
);

export const WsNeolixHostResumeExternalSessionRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.resumeExternalSession,
  {
    payload: Schema.Struct({
      providerId: Schema.String,
      providerHandleId: Schema.String,
      cwd: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({ agentId: Schema.String }),
    error: WsRpcError,
  },
);

export const WsNeolixHostMoveExternalCodexProviderRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.moveExternalCodexProvider,
  {
    payload: Schema.Struct({
      moves: Schema.Array(Schema.Struct({ id: Schema.String, to: Schema.String })),
    }),
    success: NeolixCodexMoveResult,
    error: WsRpcError,
  },
);

export const WsNeolixHostRelocateClaudeProjectRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.relocateClaudeProject,
  {
    payload: Schema.Struct({
      from: Schema.String,
      to: Schema.String,
      token: Schema.optional(Schema.String),
    }),
    success: NeolixRelocateResult,
    error: WsRpcError,
  },
);

export const WsNeolixHostSetConversationRecordingRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.setConversationRecording,
  {
    payload: Schema.Struct({
      on: Schema.optional(Schema.Boolean),
      clear: Schema.optional(Schema.Boolean),
    }),
    success: NeolixConversationRecording,
    error: WsRpcError,
  },
);

export const WsNeolixHostResolveProviderRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.resolveProvider, {
  payload: Schema.Struct({
    provider: Schema.String,
    instanceId: Schema.optional(Schema.String),
  }),
  success: NeolixResolvedProvider,
  error: WsRpcError,
});

const neolixSyncStatusSuccess = Schema.Struct({
  status: Schema.optional(NeolixSyncStatus),
  error: Schema.optional(Schema.String),
});

export const WsNeolixHostGetSyncConfigRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getSyncConfig, {
  payload: neolixHostPayload,
  success: Schema.Struct({ config: NeolixSyncConfig }),
  error: WsRpcError,
});

export const WsNeolixHostSetSyncConfigRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.setSyncConfig, {
  payload: Schema.Struct({ config: Schema.Json }),
  success: Schema.Struct({
    config: Schema.optional(NeolixSyncConfig),
    error: Schema.optional(Schema.String),
  }),
  error: WsRpcError,
});

export const WsNeolixHostGetSyncStatusRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getSyncStatus, {
  payload: neolixHostPayload,
  success: Schema.Struct({ status: NeolixSyncStatus }),
  error: WsRpcError,
});

/** Every computer's shared usage, by day, as the Usage page draws it. */
export const WsNeolixHostGetSyncUsageRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getSyncUsage, {
  payload: neolixHostPayload,
  success: NeolixSyncUsage,
  error: WsRpcError,
});

export const WsNeolixHostListSyncRemoteRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.listSyncRemote, {
  payload: neolixHostPayload,
  success: Schema.Struct({
    versions: Schema.Array(NeolixSyncRemoteVersion),
    error: Schema.optional(Schema.String),
  }),
  error: WsRpcError,
});

export const WsNeolixHostRunSyncRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.runSync, {
  payload: neolixHostPayload,
  success: neolixSyncStatusSuccess,
  error: WsRpcError,
});

export const WsNeolixHostRestoreSyncRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.restoreSync, {
  payload: neolixHostPayload,
  success: neolixSyncStatusSuccess,
  error: WsRpcError,
});

export const WsNeolixHostUndoSyncRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.undoSync, {
  payload: neolixHostPayload,
  success: neolixSyncStatusSuccess,
  error: WsRpcError,
});

export const WsNeolixHostUploadSyncRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.uploadSync, {
  payload: neolixHostPayload,
  success: neolixSyncStatusSuccess,
  error: WsRpcError,
});

export const WsNeolixHostFollowSyncRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.followSync, {
  payload: neolixHostPayload,
  success: neolixSyncStatusSuccess,
  error: WsRpcError,
});

export const WsNeolixHostDismissSyncNoticeRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.dismissSyncNotice, {
  payload: neolixHostPayload,
  success: Schema.Struct({ error: Schema.optional(Schema.String) }),
  error: WsRpcError,
});

export const WsNeolixHostListBackupsRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.listBackups, {
  payload: neolixHostPayload,
  success: Schema.Struct({ backups: Schema.Array(NeolixBackupEntry) }),
  error: WsRpcError,
});

export const WsNeolixHostGetBackupAutoRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getBackupAuto, {
  payload: neolixHostPayload,
  success: Schema.Struct({ config: NeolixBackupAuto }),
  error: WsRpcError,
});

export const WsNeolixHostSetBackupAutoRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.setBackupAuto, {
  payload: Schema.Struct({ config: NeolixBackupAuto }),
  success: Schema.Struct({ config: Schema.optional(NeolixBackupAuto) }),
  error: WsRpcError,
});

export const WsNeolixHostExportBackupRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.exportBackup, {
  payload: Schema.Struct({
    passphrase: Schema.optional(Schema.String),
    signIns: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    backup: Schema.optional(NeolixBackupEntry),
    error: Schema.optional(Schema.String),
  }),
  error: WsRpcError,
});

export const WsNeolixHostRestoreBackupRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.restoreBackup, {
  payload: Schema.Struct({
    name: Schema.String,
    passphrase: Schema.optional(Schema.String),
    keys: Schema.optional(Schema.Boolean),
    signIns: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    parts: Schema.optional(Schema.Array(Schema.String)),
    saved: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
  error: WsRpcError,
});

export const WsNeolixHostImportBackupRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.importBackup, {
  payload: Schema.Struct({
    fileName: Schema.String,
    mimeType: Schema.String,
    bytesBase64: Schema.String,
    passphrase: Schema.optional(Schema.String),
    signIns: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    parts: Schema.optional(Schema.Array(Schema.String)),
    saved: Schema.optional(Schema.String),
    error: Schema.optional(Schema.String),
  }),
  error: WsRpcError,
});

export const WsNeolixHostDownloadBackupRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.downloadBackup, {
  payload: Schema.Struct({ name: Schema.String }),
  success: NeolixBackupFile,
  error: WsRpcError,
});

export const WsNeolixHostDeleteBackupRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.deleteBackup, {
  payload: Schema.Struct({ name: Schema.String }),
  success: Schema.Struct({ error: Schema.optional(Schema.String) }),
  error: WsRpcError,
});

export const WsNeolixHostRevealBackupsRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.revealBackups, {
  payload: neolixHostPayload,
  success: Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) }),
  error: WsRpcError,
});

export const WsNeolixHostGetWebPageRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.getWebPage, {
  payload: neolixHostPayload,
  success: Schema.Struct({ page: NeolixWebPage }),
  error: WsRpcError,
});

export const WsNeolixHostSetWebPageRpc = Rpc.make(NEOLIX_HOST_WS_METHODS.setWebPage, {
  payload: Schema.Struct({
    mode: Schema.optional(NeolixWebPageMode),
    port: Schema.optional(Schema.Number),
    newKey: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    page: Schema.NullOr(NeolixWebPage),
    error: Schema.optional(Schema.String),
  }),
  error: WsRpcError,
});

export const WsNeolixHostGetThirdPartyNoticesRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.getThirdPartyNotices,
  {
    payload: neolixHostPayload,
    success: NeolixThirdPartyNotices,
    error: WsRpcError,
  },
);

export const WsNeolixHostGetLibraryGithubTokenRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.getLibraryGithubToken,
  {
    payload: neolixHostPayload,
    success: NeolixGithubTokenStatus,
    error: WsRpcError,
  },
);

export const WsNeolixHostSetLibraryGithubTokenRpc = Rpc.make(
  NEOLIX_HOST_WS_METHODS.setLibraryGithubToken,
  {
    payload: Schema.Struct({ token: Schema.String }),
    success: Schema.Struct({ configured: Schema.Boolean }),
    error: WsRpcError,
  },
);

export const WsNeolixHostRpcGroup = RpcGroup.make(
  WsNeolixHostGetFeaturesRpc,
  WsNeolixHostSubscribeFeaturesRpc,
  WsNeolixHostGetConfigRpc,
  WsNeolixHostPatchConfigRpc,
  WsNeolixHostGetStatusRpc,
  WsNeolixHostListSessionTerminalsRpc,
  WsNeolixHostRestartRpc,
  WsNeolixHostUpdateRpc,
  WsNeolixHostSubscribeUpdateProgressRpc,
  WsNeolixHostGetDiagnosticsRpc,
  WsNeolixHostGetProviderDiagnosticRpc,
  WsNeolixHostRevealPathRpc,
  WsNeolixHostListSpeechModelsRpc,
  WsNeolixHostDownloadSpeechModelRpc,
  WsNeolixHostDeleteSpeechModelRpc,
  WsNeolixHostGetSessionReadsRpc,
  WsNeolixHostSetSessionReadsRpc,
  WsNeolixHostListExternalSessionsRpc,
  WsNeolixHostSearchExternalSessionsRpc,
  WsNeolixHostOpenSessionInTerminalRpc,
  WsNeolixHostDeleteExternalSessionsRpc,
  WsNeolixHostRestoreExternalSessionRpc,
  WsNeolixHostPurgeExternalSessionsRpc,
  WsNeolixHostGetExternalSessionTranscriptRpc,
  WsNeolixHostExportExternalSessionRpc,
  WsNeolixHostResumeExternalSessionRpc,
  WsNeolixHostMoveExternalCodexProviderRpc,
  WsNeolixHostRelocateClaudeProjectRpc,
  WsNeolixHostSetConversationRecordingRpc,
  WsNeolixHostResolveProviderRpc,
  WsNeolixHostGetSyncConfigRpc,
  WsNeolixHostSetSyncConfigRpc,
  WsNeolixHostGetSyncStatusRpc,
  WsNeolixHostGetSyncUsageRpc,
  WsNeolixHostListSyncRemoteRpc,
  WsNeolixHostRunSyncRpc,
  WsNeolixHostRestoreSyncRpc,
  WsNeolixHostUndoSyncRpc,
  WsNeolixHostUploadSyncRpc,
  WsNeolixHostFollowSyncRpc,
  WsNeolixHostDismissSyncNoticeRpc,
  WsNeolixHostListBackupsRpc,
  WsNeolixHostGetBackupAutoRpc,
  WsNeolixHostSetBackupAutoRpc,
  WsNeolixHostExportBackupRpc,
  WsNeolixHostRestoreBackupRpc,
  WsNeolixHostImportBackupRpc,
  WsNeolixHostDownloadBackupRpc,
  WsNeolixHostDeleteBackupRpc,
  WsNeolixHostRevealBackupsRpc,
  WsNeolixHostGetWebPageRpc,
  WsNeolixHostSetWebPageRpc,
  WsNeolixHostGetThirdPartyNoticesRpc,
  WsNeolixHostGetLibraryGithubTokenRpc,
  WsNeolixHostSetLibraryGithubTokenRpc,
);

// Neolix plugin, subagent and workspace RPCs. They mirror daemon message families that the
// Synara contracts do not model; keeping them in one satellite group avoids the declaration-emit
// limit the main feature group already runs into.
export const WsNeolixPluginsListRpc = Rpc.make(WS_METHODS.neolixPluginsList, {
  payload: NeolixPlugins.NeolixPluginsListInput,
  success: NeolixPlugins.NeolixPluginsListResult,
  error: WsRpcError,
});

export const WsNeolixPluginsBuiltinRpc = Rpc.make(WS_METHODS.neolixPluginsBuiltin, {
  payload: NeolixPlugins.NeolixPluginsListInput,
  success: NeolixPlugins.NeolixPluginsBuiltinResult,
  error: WsRpcError,
});

export const WsNeolixPluginsMarketRpc = Rpc.make(WS_METHODS.neolixPluginsMarket, {
  payload: NeolixPlugins.NeolixPluginsListInput,
  success: NeolixPlugins.NeolixPluginsMarketResult,
  error: WsRpcError,
});

export const WsNeolixPluginsSearchMarketRpc = Rpc.make(WS_METHODS.neolixPluginsSearchMarket, {
  payload: NeolixPlugins.NeolixPluginsSearchMarketInput,
  success: NeolixPlugins.NeolixPluginsSearchMarketResult,
  error: WsRpcError,
});

export const WsNeolixPluginsInstallRpc = Rpc.make(WS_METHODS.neolixPluginsInstall, {
  payload: NeolixPlugins.NeolixPluginsInstallInput,
  success: NeolixPlugins.NeolixPluginActionResult,
  error: WsRpcError,
});

export const WsNeolixPluginsReloadRpc = Rpc.make(WS_METHODS.neolixPluginsReload, {
  payload: NeolixPlugins.NeolixPluginsIdInput,
  success: NeolixPlugins.NeolixPluginActionResult,
  error: WsRpcError,
});

export const WsNeolixPluginsEnableRpc = Rpc.make(WS_METHODS.neolixPluginsEnable, {
  payload: NeolixPlugins.NeolixPluginsIdInput,
  success: NeolixPlugins.NeolixPluginActionResult,
  error: WsRpcError,
});

export const WsNeolixPluginsDisableRpc = Rpc.make(WS_METHODS.neolixPluginsDisable, {
  payload: NeolixPlugins.NeolixPluginsIdInput,
  success: NeolixPlugins.NeolixPluginActionResult,
  error: WsRpcError,
});

export const WsNeolixPluginsRemoveRpc = Rpc.make(WS_METHODS.neolixPluginsRemove, {
  payload: NeolixPlugins.NeolixPluginsIdInput,
  success: NeolixPlugins.NeolixPluginsRemoveResult,
  error: WsRpcError,
});

export const WsNeolixPluginsLogsRpc = Rpc.make(WS_METHODS.neolixPluginsLogs, {
  payload: NeolixPlugins.NeolixPluginsIdInput,
  success: Schema.Struct({ entries: Schema.Array(NeolixPlugins.NeolixPluginLogEntry) }),
  error: WsRpcError,
});

export const WsNeolixPluginsInvokeRpc = Rpc.make(WS_METHODS.neolixPluginsInvoke, {
  payload: NeolixPlugins.NeolixPluginsInvokeInput,
  success: NeolixPlugins.NeolixPluginsInvokeResult,
  error: WsRpcError,
});

export const WsNeolixPluginsSettingsReadRpc = Rpc.make(WS_METHODS.neolixPluginsSettingsRead, {
  payload: NeolixPlugins.NeolixPluginSettingsReadInput,
  success: NeolixPlugins.NeolixPluginSettingsReadResult,
  error: WsRpcError,
});

export const WsNeolixPluginsSettingsWriteRpc = Rpc.make(WS_METHODS.neolixPluginsSettingsWrite, {
  payload: NeolixPlugins.NeolixPluginSettingsWriteInput,
  success: NeolixPlugins.NeolixPluginSettingsWriteResult,
  error: WsRpcError,
});

export const WsNeolixPluginsSettingsResetRpc = Rpc.make(WS_METHODS.neolixPluginsSettingsReset, {
  payload: NeolixPlugins.NeolixPluginSettingsResetInput,
  success: NeolixPlugins.NeolixPluginSettingsWriteResult,
  error: WsRpcError,
});

export const WsNeolixPluginsWebAssetRpc = Rpc.make(WS_METHODS.neolixPluginsWebAsset, {
  payload: NeolixPlugins.NeolixPluginsWebAssetInput,
  success: NeolixPlugins.NeolixPluginsWebAssetResult,
  error: WsRpcError,
});

export const WsNeolixPluginsReadmeRpc = Rpc.make(WS_METHODS.neolixPluginsReadme, {
  payload: NeolixPlugins.NeolixPluginsReadmeInput,
  success: NeolixPlugins.NeolixPluginsReadmeResult,
  error: WsRpcError,
});

export const WsNeolixProvidersInstallsRpc = Rpc.make(WS_METHODS.neolixProvidersInstalls, {
  payload: Schema.Struct({}),
  success: NeolixAgentInstallListResult,
  error: WsRpcError,
});

export const WsNeolixProvidersRunInstallRpc = Rpc.make(WS_METHODS.neolixProvidersRunInstall, {
  payload: NeolixAgentInstallRunInput,
  success: NeolixAgentInstallRunResult,
  error: WsRpcError,
});

export const WsNeolixSubagentsListRpc = Rpc.make(WS_METHODS.neolixSubagentsList, {
  payload: NeolixSubagents.NeolixSubagentsListInput,
  success: NeolixSubagents.NeolixSubagentsListResult,
  error: WsRpcError,
});

export const WsNeolixSubagentsTimelineRpc = Rpc.make(WS_METHODS.neolixSubagentsTimeline, {
  payload: NeolixSubagents.NeolixSubagentTimelineInput,
  success: NeolixSubagents.NeolixSubagentTimelineResult,
  error: WsRpcError,
});

export const WsNeolixSubagentsDetachRpc = Rpc.make(WS_METHODS.neolixSubagentsDetach, {
  payload: NeolixSubagents.NeolixSubagentDetachInput,
  success: NeolixSubagents.NeolixSubagentDetachResult,
  error: WsRpcError,
});

export const WsNeolixAttentionClearAgentRpc = Rpc.make(WS_METHODS.neolixAttentionClearAgent, {
  payload: NeolixAttention.NeolixAgentAttentionClearInput,
  success: NeolixAttention.NeolixAttentionClearResult,
  error: WsRpcError,
});

export const WsNeolixAttentionClearWorkspaceRpc = Rpc.make(
  WS_METHODS.neolixAttentionClearWorkspace,
  {
    payload: NeolixAttention.NeolixWorkspaceAttentionClearInput,
    success: NeolixAttention.NeolixAttentionClearResult,
    error: WsRpcError,
  },
);

export const WsNeolixWorkspacesListRpc = Rpc.make(WS_METHODS.neolixWorkspacesList, {
  payload: NeolixWorkspaces.NeolixWorkspacesListInput,
  success: NeolixWorkspaces.NeolixWorkspacesListResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesLabelsRpc = Rpc.make(WS_METHODS.neolixWorkspacesLabels, {
  payload: NeolixWorkspaces.NeolixWorkspacesListInput,
  success: NeolixWorkspaces.NeolixWorkspaceLabelsResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesSetPinnedRpc = Rpc.make(WS_METHODS.neolixWorkspacesSetPinned, {
  payload: NeolixWorkspaces.NeolixWorkspaceSetPinnedInput,
  success: NeolixWorkspaces.NeolixWorkspaceSetPinnedResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesSetTitleRpc = Rpc.make(WS_METHODS.neolixWorkspacesSetTitle, {
  payload: NeolixWorkspaces.NeolixWorkspaceSetTitleInput,
  success: NeolixWorkspaces.NeolixWorkspaceSetTitleResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesSetLabelRpc = Rpc.make(WS_METHODS.neolixWorkspacesSetLabel, {
  payload: NeolixWorkspaces.NeolixWorkspaceSetLabelInput,
  success: NeolixWorkspaces.NeolixWorkspaceSetLabelResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesMarkUnreadRpc = Rpc.make(WS_METHODS.neolixWorkspacesMarkUnread, {
  payload: NeolixWorkspaces.NeolixWorkspaceMarkUnreadInput,
  success: NeolixWorkspaces.NeolixWorkspaceMarkUnreadResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesUpdateLabelRpc = Rpc.make(WS_METHODS.neolixWorkspacesUpdateLabel, {
  payload: NeolixWorkspaces.NeolixWorkspaceUpdateLabelInput,
  success: NeolixWorkspaces.NeolixWorkspaceUpdateLabelResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesDeleteLabelRpc = Rpc.make(WS_METHODS.neolixWorkspacesDeleteLabel, {
  payload: NeolixWorkspaces.NeolixWorkspaceDeleteLabelInput,
  success: NeolixWorkspaces.NeolixWorkspaceLabelDeleteResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesInspectLabelDeleteRpc = Rpc.make(
  WS_METHODS.neolixWorkspacesInspectLabelDelete,
  {
    payload: NeolixWorkspaces.NeolixWorkspaceInspectLabelDeleteInput,
    success: NeolixWorkspaces.NeolixWorkspaceLabelDeleteResult,
    error: WsRpcError,
  },
);

export const WsNeolixWorkspacesArchiveRpc = Rpc.make(WS_METHODS.neolixWorkspacesArchive, {
  payload: NeolixWorkspaces.NeolixWorkspaceArchiveInput,
  success: NeolixWorkspaces.NeolixWorkspaceArchiveResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesInspectRecoveryRpc = Rpc.make(
  WS_METHODS.neolixWorkspacesInspectRecovery,
  {
    payload: NeolixWorkspaces.NeolixWorkspaceRecoveryInput,
    success: NeolixWorkspaces.NeolixWorkspaceRecoveryResult,
    error: WsRpcError,
  },
);

export const WsNeolixWorkspacesRestoreRpc = Rpc.make(WS_METHODS.neolixWorkspacesRestore, {
  payload: NeolixWorkspaces.NeolixWorkspaceRecoveryInput,
  success: NeolixWorkspaces.NeolixWorkspaceRestoreResult,
  error: WsRpcError,
});

export const WsNeolixWorkspacesListArchivedRpc = Rpc.make(WS_METHODS.neolixWorkspacesListArchived, {
  payload: NeolixWorkspaces.NeolixArchivedWorkspacesListInput,
  success: NeolixWorkspaces.NeolixArchivedWorkspacesListResult,
  error: WsRpcError,
});

export const NeolixManagementRpcGroup = RpcGroup.make(
  WsNeolixPluginsListRpc,
  WsNeolixPluginsBuiltinRpc,
  WsNeolixPluginsMarketRpc,
  WsNeolixPluginsSearchMarketRpc,
  WsNeolixPluginsInstallRpc,
  WsNeolixPluginsReloadRpc,
  WsNeolixPluginsEnableRpc,
  WsNeolixPluginsDisableRpc,
  WsNeolixPluginsRemoveRpc,
  WsNeolixPluginsLogsRpc,
  WsNeolixPluginsInvokeRpc,
  WsNeolixPluginsSettingsReadRpc,
  WsNeolixPluginsSettingsWriteRpc,
  WsNeolixPluginsSettingsResetRpc,
  WsNeolixPluginsWebAssetRpc,
  WsNeolixPluginsReadmeRpc,
  WsNeolixProvidersInstallsRpc,
  WsNeolixProvidersRunInstallRpc,
  WsNeolixSubagentsListRpc,
  WsNeolixSubagentsTimelineRpc,
  WsNeolixSubagentsDetachRpc,
  WsNeolixAttentionClearAgentRpc,
  WsNeolixAttentionClearWorkspaceRpc,
  WsNeolixWorkspacesListRpc,
  WsNeolixWorkspacesLabelsRpc,
  WsNeolixWorkspacesSetPinnedRpc,
  WsNeolixWorkspacesSetTitleRpc,
  WsNeolixWorkspacesSetLabelRpc,
  WsNeolixWorkspacesMarkUnreadRpc,
  WsNeolixWorkspacesUpdateLabelRpc,
  WsNeolixWorkspacesDeleteLabelRpc,
  WsNeolixWorkspacesInspectLabelDeleteRpc,
  WsNeolixWorkspacesArchiveRpc,
  WsNeolixWorkspacesInspectRecoveryRpc,
  WsNeolixWorkspacesRestoreRpc,
  WsNeolixWorkspacesListArchivedRpc,
);

// ── Neolix model gateway ───────────────────────────────────────────────────
// Settings → Model gateway. Every method forwards to a Neolix daemon
// `gateway.*` request; documents the bridge does not reshape are `Schema.Json`
// so fields a newer daemon adds survive the round trip.

const gatewayJsonSuccess = { success: Schema.Json, error: WsRpcError };

export const WsNeolixGatewayGetConfigRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getConfig, {
  payload: Gateway.GatewayEmptyInput,
  success: Gateway.GatewayConfigResult,
  error: WsRpcError,
});

export const WsNeolixGatewayPresetsRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.presets, {
  payload: Gateway.GatewayEmptyInput,
  success: Gateway.GatewayPresetsResult,
  error: WsRpcError,
});

export const WsNeolixGatewaySetConfigRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.setConfig, {
  payload: Gateway.GatewayConfigInput,
  success: Gateway.GatewayConfigResult,
  error: WsRpcError,
});

export const WsNeolixGatewayGetStatusRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getStatus, {
  payload: Gateway.GatewayEmptyInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayGetUsageRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getUsage, {
  payload: Gateway.GatewayUsageInput,
  success: Gateway.GatewayUsageResult,
  error: WsRpcError,
});

export const WsNeolixGatewayGetQuotaRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getQuota, {
  payload: Gateway.GatewayQuotaInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayResetQuotaRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.resetQuota, {
  payload: Gateway.GatewayResetQuotaInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayWarmAccountRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.warmAccount,
  {
    payload: Gateway.GatewayWarmInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySetWarmAtRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.setWarmAt, {
  payload: Gateway.GatewayWarmAtInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewaySetAccountWarmAtRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.setAccountWarmAt,
  {
    payload: Gateway.GatewayAccountWarmAtInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayRoutingHistoryRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.getRoutingHistory,
  {
    payload: Gateway.GatewayDayInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayTraceRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getTrace, {
  payload: Gateway.GatewayEmptyInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayArchiveRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getArchive, {
  payload: Gateway.GatewayArchiveInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayPromptTextRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.promptText, {
  payload: Gateway.GatewayPromptTextInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayPromptReplyRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.promptReply,
  {
    payload: Gateway.GatewayReplyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayRouteEventsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.getRouteEvents,
  {
    payload: Gateway.GatewayAfterInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayPricingRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.getPricing, {
  payload: Gateway.GatewayPricingInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayProviderModelsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.providerModels,
  {
    payload: Gateway.GatewayProbeInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayProviderTestModelRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.providerTestModel,
  {
    payload: Gateway.GatewayTestModelInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayProviderDetectRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.providerDetect,
  {
    payload: Gateway.GatewayDetectInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayProviderPreviewImportRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.providerPreviewImport,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayProviderBalanceRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.providerBalance,
  {
    payload: Gateway.GatewayProbeInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayProviderUpstreamStatusRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.providerUpstreamStatus,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayRefreshCatalogRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.refreshCatalog,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingSummaryRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingSummary,
  {
    payload: Gateway.GatewayDaysInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingRecordsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingRecords,
  {
    payload: Gateway.GatewayRecordsInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingRecordRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingRecord,
  {
    payload: Gateway.GatewayKeyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingPreviewRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingPreview,
  {
    payload: Gateway.GatewayPreviewInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingClearRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingClear,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingLocalModelStatusRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelStatus,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingLocalModelDownloadRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelDownload,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingLocalModelCancelRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelCancel,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayMaskingLocalModelRemoveRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.maskingLocalModelRemove,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayOidcRulesRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.oidcRules, {
  payload: Gateway.GatewayEmptyInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayOidcSaveRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.oidcSave, {
  payload: Gateway.GatewayOidcSaveInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayOidcRemoveRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.oidcRemove, {
  payload: Gateway.GatewayIdInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayCheckinStatusRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.checkinStatus,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCheckinRunRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.checkinRun, {
  payload: Gateway.GatewayCheckinRunInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayCheckinSwitchRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.checkinSwitch,
  {
    payload: Gateway.GatewayCheckinSwitchInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCheckinAccountRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.checkinAccount,
  {
    payload: Gateway.GatewayCheckinAccountInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySearchQuotaRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.searchQuota,
  {
    payload: Gateway.GatewaySearchQuotaInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayClaudeModeRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.claudeMode, {
  payload: Gateway.GatewayEmptyInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayHeldListRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.heldList, {
  payload: Gateway.GatewayEmptyInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayHeldReadRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.heldRead, {
  payload: Gateway.GatewayNameInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayHeldRevealRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.heldReveal, {
  payload: Gateway.GatewayOptionalNameInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayTuneGetRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.tuneGet, {
  payload: Gateway.GatewayTuneGetInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayTuneApplyRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.tuneApply, {
  payload: Gateway.GatewayTuneApplyInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewayTuneUndoRpc = Rpc.make(Gateway.NEOLIX_GATEWAY_WS_METHODS.tuneUndo, {
  payload: Gateway.GatewayTuneUndoInput,
  ...gatewayJsonSuccess,
});

export const WsNeolixGatewaySubscriptionAccountsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.subscriptionAccounts,
  {
    payload: Gateway.GatewaySubscriptionListInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySubscriptionImportRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.subscriptionImport,
  {
    payload: Gateway.GatewaySubscriptionImportInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySubscriptionAddRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.subscriptionAdd,
  {
    payload: Gateway.GatewaySubscriptionAddInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySubscriptionSwitchRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.subscriptionSwitch,
  {
    payload: Gateway.GatewaySubscriptionAccountInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySubscriptionRemoveRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.subscriptionRemove,
  {
    payload: Gateway.GatewaySubscriptionAccountInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCodexStatusRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.codexStatus,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCodexAccountsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.codexAccounts,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCodexAccountSetRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.codexAccountSet,
  {
    payload: Gateway.GatewayCodexAccountSetInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCodexAccountArrangeRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.codexAccountArrange,
  {
    payload: Gateway.GatewayCodexArrangeInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCodexAccountImportRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.codexAccountImport,
  {
    payload: Gateway.GatewayCodexImportInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayCodexAccountRemoveRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.codexAccountRemove,
  {
    payload: Gateway.GatewayIdInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayPluginSubscriptionsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptions,
  {
    payload: Gateway.GatewayEmptyInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayPluginSubscriptionModelsRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionModels,
  {
    payload: Gateway.GatewayPluginModelsInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayPluginSubscriptionSignInRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionSignIn,
  {
    payload: Gateway.GatewayPluginSignInInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewayPluginSubscriptionSignInPollRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.pluginSubscriptionSignInPoll,
  {
    payload: Gateway.GatewayPluginPollInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySignInStartRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.signInStart,
  {
    payload: Gateway.GatewaySignInStartInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySignInStatusRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.signInStatus,
  {
    payload: Gateway.GatewayIdInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySignInCancelRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.signInCancel,
  {
    payload: Gateway.GatewayIdInput,
    ...gatewayJsonSuccess,
  },
);

export const WsNeolixGatewaySignInCallbackRpc = Rpc.make(
  Gateway.NEOLIX_GATEWAY_WS_METHODS.signInCallback,
  {
    payload: Gateway.GatewaySignInCallbackInput,
    ...gatewayJsonSuccess,
  },
);

export const NeolixGatewayRpcGroup = RpcGroup.make(
  WsNeolixGatewayGetConfigRpc,
  WsNeolixGatewayPresetsRpc,
  WsNeolixGatewaySetConfigRpc,
  WsNeolixGatewayGetStatusRpc,
  WsNeolixGatewayGetUsageRpc,
  WsNeolixGatewayGetQuotaRpc,
  WsNeolixGatewayResetQuotaRpc,
  WsNeolixGatewayWarmAccountRpc,
  WsNeolixGatewaySetWarmAtRpc,
  WsNeolixGatewaySetAccountWarmAtRpc,
  WsNeolixGatewayRoutingHistoryRpc,
  WsNeolixGatewayTraceRpc,
  WsNeolixGatewayArchiveRpc,
  WsNeolixGatewayPromptTextRpc,
  WsNeolixGatewayPromptReplyRpc,
  WsNeolixGatewayRouteEventsRpc,
  WsNeolixGatewayPricingRpc,
  WsNeolixGatewayProviderModelsRpc,
  WsNeolixGatewayProviderTestModelRpc,
  WsNeolixGatewayProviderDetectRpc,
  WsNeolixGatewayProviderPreviewImportRpc,
  WsNeolixGatewayProviderBalanceRpc,
  WsNeolixGatewayProviderUpstreamStatusRpc,
  WsNeolixGatewayRefreshCatalogRpc,
  WsNeolixGatewayMaskingSummaryRpc,
  WsNeolixGatewayMaskingRecordsRpc,
  WsNeolixGatewayMaskingRecordRpc,
  WsNeolixGatewayMaskingPreviewRpc,
  WsNeolixGatewayMaskingClearRpc,
  WsNeolixGatewayMaskingLocalModelStatusRpc,
  WsNeolixGatewayMaskingLocalModelDownloadRpc,
  WsNeolixGatewayMaskingLocalModelCancelRpc,
  WsNeolixGatewayMaskingLocalModelRemoveRpc,
  WsNeolixGatewayOidcRulesRpc,
  WsNeolixGatewayOidcSaveRpc,
  WsNeolixGatewayOidcRemoveRpc,
  WsNeolixGatewayCheckinStatusRpc,
  WsNeolixGatewayCheckinRunRpc,
  WsNeolixGatewayCheckinSwitchRpc,
  WsNeolixGatewayCheckinAccountRpc,
  WsNeolixGatewaySearchQuotaRpc,
  WsNeolixGatewayClaudeModeRpc,
  WsNeolixGatewayHeldListRpc,
  WsNeolixGatewayHeldReadRpc,
  WsNeolixGatewayHeldRevealRpc,
  WsNeolixGatewayTuneGetRpc,
  WsNeolixGatewayTuneApplyRpc,
  WsNeolixGatewayTuneUndoRpc,
  WsNeolixGatewaySubscriptionAccountsRpc,
  WsNeolixGatewaySubscriptionImportRpc,
  WsNeolixGatewaySubscriptionAddRpc,
  WsNeolixGatewaySubscriptionSwitchRpc,
  WsNeolixGatewaySubscriptionRemoveRpc,
  WsNeolixGatewayCodexStatusRpc,
  WsNeolixGatewayCodexAccountsRpc,
  WsNeolixGatewayCodexAccountSetRpc,
  WsNeolixGatewayCodexAccountArrangeRpc,
  WsNeolixGatewayCodexAccountImportRpc,
  WsNeolixGatewayCodexAccountRemoveRpc,
  WsNeolixGatewayPluginSubscriptionsRpc,
  WsNeolixGatewayPluginSubscriptionModelsRpc,
  WsNeolixGatewayPluginSubscriptionSignInRpc,
  WsNeolixGatewayPluginSubscriptionSignInPollRpc,
  WsNeolixGatewaySignInStartRpc,
  WsNeolixGatewaySignInStatusRpc,
  WsNeolixGatewaySignInCancelRpc,
  WsNeolixGatewaySignInCallbackRpc,
);

// ── Agent Connect ──────────────────────────────────────────────────────────
// Settings › Agents › Agent Connect. Each method forwards to the daemon's
// `agent.connect.*` request; every write answers with the new snapshot, so the
// web reads that instead of subscribing to changes.

export const WsNeolixAgentConnectGetRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.get,
  {
    payload: AgentConnect.AgentConnectEmptyInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectSetRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.set,
  {
    payload: AgentConnect.AgentConnectSetInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectProfileListRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.profileList,
  {
    payload: AgentConnect.AgentConnectEmptyInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectProfileSaveRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.profileSave,
  {
    payload: AgentConnect.AgentConnectNameInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectProfileApplyRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.profileApply,
  {
    payload: AgentConnect.AgentConnectNameInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectProfileDeleteRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.profileDelete,
  {
    payload: AgentConnect.AgentConnectNameInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectProfileRenameRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.profileRename,
  {
    payload: AgentConnect.AgentConnectRenameInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectLayoutSetRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.layoutSet,
  {
    payload: AgentConnect.AgentConnectLayoutInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectModelsSetRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.modelsSet,
  {
    payload: AgentConnect.AgentConnectModelsInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectShellSetRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.shellSet,
  {
    payload: AgentConnect.AgentConnectShellInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const WsNeolixAgentConnectStaleRestartRpc = Rpc.make(
  AgentConnect.NEOLIX_AGENT_CONNECT_WS_METHODS.staleRestart,
  {
    payload: AgentConnect.AgentConnectStaleRestartInput,
    success: AgentConnect.AgentConnectResult,
    error: WsRpcError,
  },
);

export const NeolixAgentConnectRpcGroup = RpcGroup.make(
  WsNeolixAgentConnectGetRpc,
  WsNeolixAgentConnectSetRpc,
  WsNeolixAgentConnectProfileListRpc,
  WsNeolixAgentConnectProfileSaveRpc,
  WsNeolixAgentConnectProfileApplyRpc,
  WsNeolixAgentConnectProfileDeleteRpc,
  WsNeolixAgentConnectProfileRenameRpc,
  WsNeolixAgentConnectLayoutSetRpc,
  WsNeolixAgentConnectModelsSetRpc,
  WsNeolixAgentConnectShellSetRpc,
  WsNeolixAgentConnectStaleRestartRpc,
);

// ── Bundled (orchestration) skills ─────────────────────────────────────────
// Settings › Host. Each method forwards to the daemon's `agent.skills.*`
// request; every write answers with the resulting status, so the web replaces
// its cache instead of re-reading.

export const WsNeolixAgentSkillsGetRpc = Rpc.make(AgentSkills.NEOLIX_AGENT_SKILLS_WS_METHODS.get, {
  payload: AgentSkills.AgentSkillsEmptyInput,
  success: AgentSkills.AgentSkillsStatus,
  error: WsRpcError,
});

export const WsNeolixAgentSkillsReconcileRpc = Rpc.make(
  AgentSkills.NEOLIX_AGENT_SKILLS_WS_METHODS.reconcile,
  {
    payload: AgentSkills.AgentSkillsEmptyInput,
    success: AgentSkills.AgentSkillsStatus,
    error: WsRpcError,
  },
);

export const WsNeolixAgentSkillsUninstallRpc = Rpc.make(
  AgentSkills.NEOLIX_AGENT_SKILLS_WS_METHODS.uninstall,
  {
    payload: AgentSkills.AgentSkillsEmptyInput,
    success: AgentSkills.AgentSkillsStatus,
    error: WsRpcError,
  },
);

export const WsNeolixAgentSkillsSaveSelectionRpc = Rpc.make(
  AgentSkills.NEOLIX_AGENT_SKILLS_WS_METHODS.saveSelection,
  {
    payload: AgentSkills.AgentSkillsSaveInput,
    success: AgentSkills.AgentSkillsSaveResult,
    error: WsRpcError,
  },
);

export const NeolixAgentSkillsRpcGroup = RpcGroup.make(
  WsNeolixAgentSkillsGetRpc,
  WsNeolixAgentSkillsReconcileRpc,
  WsNeolixAgentSkillsUninstallRpc,
  WsNeolixAgentSkillsSaveSelectionRpc,
);

// ── Worktree setup observation ─────────────────────────────────────────────
// One stream per workspace: the bridge subscribes to the daemon's owned setup
// subscription and republishes each snapshot. `run` restarts setup (and, on a
// blocked workspace, clears the automation block first).

export const WsNeolixWorkspaceSetupSubscribeRpc = Rpc.make(
  WS_METHODS.neolixWorkspaceSetupSubscribe,
  {
    payload: WorkspaceSetup.WorkspaceSetupSubscribeInput,
    success: WorkspaceSetup.WorkspaceSetupEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const WsNeolixWorkspaceSetupRunRpc = Rpc.make(WS_METHODS.neolixWorkspaceSetupRun, {
  payload: WorkspaceSetup.WorkspaceSetupRunInput,
  success: WorkspaceSetup.WorkspaceSetupRunResult,
  error: WsRpcError,
});

export const NeolixWorkspaceSetupRpcGroup = RpcGroup.make(
  WsNeolixWorkspaceSetupSubscribeRpc,
  WsNeolixWorkspaceSetupRunRpc,
);

// ── Project icons ──────────────────────────────────────────────────────────
// The daemon owns automatic discovery and the custom upload. `request` is the
// pre-custom-icon lookup for older hosts; `get` also reports whether the host
// accepts uploads, so the edit sheet can hide the field instead of failing.

export const WsNeolixProjectIconsGetRpc = Rpc.make(
  ProjectIcons.NEOLIX_PROJECT_ICON_WS_METHODS.get,
  {
    payload: ProjectIcons.ProjectIconGetInput,
    success: ProjectIcons.ProjectIconGetResult,
    error: WsRpcError,
  },
);

export const WsNeolixProjectIconsRequestRpc = Rpc.make(
  ProjectIcons.NEOLIX_PROJECT_ICON_WS_METHODS.request,
  {
    payload: ProjectIcons.ProjectIconRequestInput,
    success: ProjectIcons.ProjectIconRequestResult,
    error: WsRpcError,
  },
);

export const WsNeolixProjectIconsSetRpc = Rpc.make(
  ProjectIcons.NEOLIX_PROJECT_ICON_WS_METHODS.set,
  {
    payload: ProjectIcons.ProjectIconSetInput,
    success: ProjectIcons.ProjectIconSetResult,
    error: WsRpcError,
  },
);

export const NeolixProjectIconsRpcGroup = RpcGroup.make(
  WsNeolixProjectIconsGetRpc,
  WsNeolixProjectIconsRequestRpc,
  WsNeolixProjectIconsSetRpc,
);

// ── App settings sync ──────────────────────────────────────────────────────
// The daemon keeps the app's settings where other computers can reach them.
// `get` also reports the keys the CLI patched while the app was closed;
// `subscribe` pushes edits made elsewhere so the app applies them live.

export const WsNeolixAppSettingsGetRpc = Rpc.make(AppSettings.NEOLIX_APP_SETTINGS_WS_METHODS.get, {
  payload: Schema.Struct({}),
  success: AppSettings.AppSettingsGetResult,
  error: WsRpcError,
});

export const WsNeolixAppSettingsExportRpc = Rpc.make(
  AppSettings.NEOLIX_APP_SETTINGS_WS_METHODS.export,
  {
    payload: AppSettings.AppSettingsExportInput,
    success: AppSettings.AppSettingsExportResult,
    error: WsRpcError,
  },
);

export const WsNeolixAppSettingsSubscribeRpc = Rpc.make(
  AppSettings.NEOLIX_APP_SETTINGS_WS_METHODS.subscribe,
  {
    payload: Schema.Struct({}),
    success: AppSettings.AppSettingsApplyEvent,
    error: WsRpcError,
    stream: true,
  },
);

export const NeolixAppSettingsRpcGroup = RpcGroup.make(
  WsNeolixAppSettingsGetRpc,
  WsNeolixAppSettingsExportRpc,
  WsNeolixAppSettingsSubscribeRpc,
);

// ── Realtime voice ─────────────────────────────────────────────────────────
// The daemon owns capture processing, turn detection and TTS. Upstream audio is one unary call
// per 100 ms PCM chunk; downstream events (audio, speech state, transcripts) ride one stream so
// playback can acknowledge each chunk and barge-in can drop queued audio immediately.

export const WsServerVoiceCapabilitiesRpc = Rpc.make(WS_METHODS.serverVoiceCapabilities, {
  payload: Schema.Struct({}),
  success: ServerRealtimeVoiceCapabilitiesResult,
  error: WsRpcError,
});

export const WsServerStartRealtimeVoiceRpc = Rpc.make(WS_METHODS.serverStartRealtimeVoice, {
  payload: ServerStartRealtimeVoiceInput,
  success: ServerStartRealtimeVoiceResult,
  error: WsRpcError,
});

export const WsServerStopRealtimeVoiceRpc = Rpc.make(WS_METHODS.serverStopRealtimeVoice, {
  payload: Schema.Struct({}),
  success: ServerStopRealtimeVoiceResult,
  error: WsRpcError,
});

export const WsServerRealtimeVoiceAudioRpc = Rpc.make(WS_METHODS.serverRealtimeVoiceAudio, {
  payload: ServerRealtimeVoiceAudioInput,
  success: Schema.Void,
  error: WsRpcError,
});

export const WsServerRealtimeVoiceAudioPlayedRpc = Rpc.make(
  WS_METHODS.serverRealtimeVoiceAudioPlayed,
  {
    payload: ServerRealtimeVoiceAudioPlayedInput,
    success: Schema.Void,
    error: WsRpcError,
  },
);

export const WsSubscribeServerRealtimeVoiceRpc = Rpc.make(WS_METHODS.subscribeServerRealtimeVoice, {
  payload: Schema.Struct({}),
  success: ServerRealtimeVoiceEvent,
  error: WsRpcError,
  stream: true,
});

export const WsRealtimeVoiceRpcGroup = RpcGroup.make(
  WsServerVoiceCapabilitiesRpc,
  WsServerStartRealtimeVoiceRpc,
  WsServerStopRealtimeVoiceRpc,
  WsServerRealtimeVoiceAudioRpc,
  WsServerRealtimeVoiceAudioPlayedRpc,
  WsSubscribeServerRealtimeVoiceRpc,
);

// Explorer write RPCs are a satellite group for the same declaration-emit reason as
// WsProjectAgentRpcGroup: the bridge implements them with the daemon's fs.entry API,
// and the web transport merges the group into its feature client.
export const WsProjectFileRpcGroup = RpcGroup.make(
  WsProjectsCreateEntryRpc,
  WsProjectsRenameEntryRpc,
  WsProjectsDuplicateEntryRpc,
  WsProjectsDeleteEntryRpc,
  WsProjectsDownloadFileRpc,
);

// ── Browser automation host ────────────────────────────────────────────────
// The bridge is the daemon's browser host, but the webviews live in the renderer. A page
// holds the subscribe stream open while it can execute; the bridge registers the daemon
// host only while at least one such stream is connected. Results come back unary because
// the stream is server→client only.

export const WsBrowserAutomationSubscribeRpc = Rpc.make(WS_METHODS.browserAutomationSubscribe, {
  payload: BrowserAutomationHostSubscribeInput,
  success: BrowserAutomationHostRequest,
  error: WsRpcError,
  stream: true,
});

export const WsBrowserAutomationRespondRpc = Rpc.make(WS_METHODS.browserAutomationRespond, {
  payload: BrowserAutomationHostResponseInput,
  success: Schema.Boolean,
  error: WsRpcError,
});

export const WsBrowserAutomationRpcGroup = RpcGroup.make(
  WsBrowserAutomationSubscribeRpc,
  WsBrowserAutomationRespondRpc,
);
