export type DerivativeStatus = "Draft" | "Revised" | "Deployed";
export type TopicStatus = "Needs Review" | "Ready" | "Deployed";
export type MasterStatus = "Draft" | "Ready";

export interface BootstrapResponse {
  root_path: string;
  inbox_path: string;
  projects_path: string;
  exports_path: string;
}

export interface WatcherStatus {
  watching: boolean;
  inbox_path: string;
  last_error: string | null;
}

export interface TopicSummary {
  slug: string;
  title: string;
  folderPath: string;
  lastModified: number;
  lastAgentWrite: number;
  topicStatus: TopicStatus;
  tags: string[];
  reviewCount: number;
}

export interface DerivativeEntry {
  relPath: string;
  title: string;
  kind: string;
  status: DerivativeStatus;
  deployedCount: number;
  deployedChannels: string[];
  modifiedAt: number;
}

export interface AssetEntry {
  relPath: string;
  absPath: string;
  modifiedAt: number;
  isImage: boolean;
  isVideo: boolean;
}

export interface TopicDetail {
  slug: string;
  title: string;
  folderPath: string;
  lastModified: number;
  lastAgentWrite: number;
  topicStatus: TopicStatus;
  tags: string[];
  masterFile: string | null;
  masterStatus: MasterStatus;
  masterModifiedAt: number | null;
  derivatives: DerivativeEntry[];
  assets: AssetEntry[];
}

export interface WorkspaceEntry {
  slug: string;
  title: string;
  path: string;
  channels: string[];
}

export interface DerivativeState {
  status: DerivativeStatus;
  notes: string;
  deployedChannels: string[];
}

export type GlobalFilter = "all" | "needs_review" | "ready_not_deployed";
