import { invoke } from "@tauri-apps/api/tauri";
import type {
  BootstrapResponse,
  DerivativeState,
  MasterStatus,
  TopicDetail,
  TopicSummary,
  WatcherStatus,
  WorkspaceEntry
} from "./types";

async function safeInvoke<T>(cmd: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, payload);
}

export async function bootstrapWorkspace(rootPath: string): Promise<BootstrapResponse> {
  return safeInvoke("bootstrap_workspace", { rootPath });
}

export async function listWorkspaces(parentRootPath: string): Promise<WorkspaceEntry[]> {
  return safeInvoke("list_workspaces", { parentRootPath });
}

export async function createWorkspace(parentRootPath: string, workspaceName: string): Promise<WorkspaceEntry> {
  return safeInvoke("create_workspace", { parentRootPath, workspaceName });
}

export async function updateWorkspace(
  workspaceSlug: string,
  workspacePath: string,
  title: string,
  channels: string[]
): Promise<WorkspaceEntry> {
  return safeInvoke("update_workspace", { workspaceSlug, workspacePath, title, channels });
}

export async function addWorkspaceKnowledgeFiles(workspacePath: string, sourcePaths: string[]): Promise<string[]> {
  return safeInvoke("add_workspace_knowledge_files", { workspacePath, sourcePaths });
}

export async function startWatcher(): Promise<WatcherStatus> {
  return safeInvoke("start_watcher");
}

export async function getWatcherStatus(): Promise<WatcherStatus> {
  return safeInvoke("get_watcher_status");
}

export async function listTopics(): Promise<TopicSummary[]> {
  return safeInvoke("list_topics");
}

export async function getTopicDetail(topicSlug: string): Promise<TopicDetail> {
  return safeInvoke("get_topic_detail", { topicSlug });
}

export async function readTextFile(path: string): Promise<string> {
  return safeInvoke("read_text_file", { path });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  return safeInvoke("write_text_file", { path, content });
}

export async function getDerivativeState(topicSlug: string, relPath: string): Promise<DerivativeState> {
  return safeInvoke("get_derivative_state", { topicSlug, relPath });
}

export async function setDerivativeDeployState(
  topicSlug: string,
  relPath: string,
  status: string,
  notes: string,
  deployedChannels: string[]
): Promise<void> {
  return safeInvoke("set_derivative_deploy_state", { topicSlug, relPath, status, notes, deployedChannels });
}

export async function openInFinder(path: string): Promise<void> {
  return safeInvoke("open_in_finder", { path });
}

export async function openFileExternally(path: string): Promise<void> {
  return safeInvoke("open_file_externally", { path });
}

export async function createTopic(
  topicName: string,
  masterSourcePath: string | null,
  assetSourcePaths: string[]
): Promise<TopicDetail> {
  return safeInvoke("create_topic", {
    topicName,
    masterSourcePath,
    assetSourcePaths: assetSourcePaths.length ? assetSourcePaths : null
  });
}

export async function deleteTopic(topicSlug: string): Promise<void> {
  return safeInvoke("delete_topic", { topicSlug });
}

export async function setTopicTags(topicSlug: string, tags: string[]): Promise<void> {
  return safeInvoke("set_topic_tags", { topicSlug, tags });
}

export async function setTopicMasterFile(topicSlug: string, sourcePath: string): Promise<void> {
  return safeInvoke("set_topic_master_file", { topicSlug, sourcePath });
}

export async function setTopicMasterStatus(topicSlug: string, status: MasterStatus): Promise<void> {
  return safeInvoke("set_topic_master_status", { topicSlug, status });
}

export async function addTopicFiles(topicSlug: string, sourcePaths: string[], targetDir: string): Promise<string[]> {
  return safeInvoke("add_topic_files", {
    topicSlug,
    sourcePaths: sourcePaths.length ? sourcePaths : null,
    targetDir
  });
}

export async function replaceTopicFile(topicSlug: string, relPath: string, sourcePath: string): Promise<void> {
  return safeInvoke("replace_topic_file", { topicSlug, relPath, sourcePath });
}

export async function renameTopicFile(topicSlug: string, relPath: string, newRelPath: string): Promise<string> {
  return safeInvoke("rename_topic_file", { topicSlug, relPath, newRelPath });
}

export async function deleteTopicFile(topicSlug: string, relPath: string): Promise<void> {
  return safeInvoke("delete_topic_file", { topicSlug, relPath });
}

export async function deleteTopicMaster(topicSlug: string): Promise<number> {
  return safeInvoke("delete_topic_master", {
    topicSlug,
    confirmToken: "delete-master-and-derivatives"
  });
}
