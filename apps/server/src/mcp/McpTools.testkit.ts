import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { EditDocumentService } from "../edit/EditDocumentService.ts";
import { EngineService } from "../engine/EngineService.ts";
import { ExportService } from "../export/ExportService.ts";
import { TranscriptService } from "../transcript/TranscriptService.ts";
import { AudioTrackService } from "../edit/AudioTrackService.ts";
import { ClipPlacementService } from "../edit/ClipPlacementService.ts";
import { CaptionTrackService } from "../edit/CaptionTrackService.ts";
import { ZoomService } from "../edit/ZoomService.ts";
import { SilenceCutService } from "../edit/SilenceCutService.ts";
import { MediaLibraryService } from "../media/MediaLibraryService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { PreviewAutomationBroker } from "./PreviewAutomationBroker.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PeerForwarding } from "../peer/PeerForwarding.ts";
import { PeerLinkRequests } from "../peer/PeerLinkRequests.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { RemoteDelegation } from "../peer/RemoteDelegation.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { DocumentText } from "../provider/DocumentText.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";

/** Every tool handler's service, mocked: registering and listing tools never calls them. */
export const toolHandlerServices = Layer.mergeAll(
  Layer.mock(DeviceService)({}),
  Layer.mock(DocumentText)({}),
  Layer.mock(EditDocumentService)({}),
  Layer.mock(EngineService)({}),
  Layer.mock(ExportService)({}),
  Layer.mock(TranscriptService)({}),
  Layer.mock(SilenceCutService)({}),
  Layer.mock(CaptionTrackService)({}),
  Layer.mock(AudioTrackService)({}),
  Layer.mock(ClipPlacementService)({}),
  Layer.mock(ZoomService)({}),
  Layer.mock(MediaLibraryService)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PeerForwarding)({}),
  Layer.mock(PeerLinkRequests)({}),
  Layer.mock(PeerLinks)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectCloneTracker)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(RemoteDelegation)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-tools-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(NodeServices.layer));
