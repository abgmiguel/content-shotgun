import { invoke } from "@tauri-apps/api/tauri";
import type {
  BootstrapResponse,
  DerivativeState,
  TopicDetail,
  TopicSummary,
  WatcherStatus
} from "./types";

async function safeInvoke<T>(cmd: string, payload?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, payload);
}

export async function bootstrapWorkspace(rootPath: string): Promise<BootstrapResponse> {
  return safeInvoke("bootstrap_workspace", { rootPath });
}

export async function startWatcher(): Promise<WatcherStatus> {
  return safeInvoke("start_watcher");
}

export async function getWatcherStatus(): Promise<WatcherStatus> {
  return safeInvoke("get_watcher_status");
}

export async function runImportScan(): Promise<number> {
  return safeInvoke("run_import_scan");
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

export async function setDerivativeReviewState(
  topicSlug: string,
  relPath: string,
  status: string,
  reviewed: boolean,
  notes: string
): Promise<void> {
  return safeInvoke("set_derivative_review_state", { topicSlug, relPath, status, reviewed, notes });
}

export async function markDerivativeDeployed(
  topicSlug: string,
  relPath: string,
  destination: string,
  date: string,
  url: string,
  notes: string
): Promise<void> {
  return safeInvoke("mark_derivative_deployed", {
    topicSlug,
    relPath,
    destination,
    date,
    url: url || null,
    notes: notes || null
  });
}

export async function openInFinder(path: string): Promise<void> {
  return safeInvoke("open_in_finder", { path });
}

export async function openFileExternally(path: string): Promise<void> {
  return safeInvoke("open_file_externally", { path });
}

export async function createTopic(
  topicName: string,
  masterFormat: string,
  masterContent: string
): Promise<TopicDetail> {
  return safeInvoke("create_topic", {
    topicName,
    masterFormat: masterFormat === "none" ? null : masterFormat,
    masterContent: masterContent || null
  });
}
