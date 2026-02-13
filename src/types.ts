export type DerivativeStatus = "New" | "Review" | "Ready" | "Deployed";
export type TopicStatus = "Needs Review" | "Ready" | "Deployed";

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
  folder_path: string;
  last_modified: number;
  last_agent_write: number;
  topic_status: TopicStatus;
  tags: string[];
  review_count: number;
}

export interface DerivativeEntry {
  rel_path: string;
  title: string;
  kind: string;
  status: DerivativeStatus;
  deployed_count: number;
  modified_at: number;
}

export interface AssetEntry {
  rel_path: string;
  abs_path: string;
  modified_at: number;
  is_image: boolean;
}

export interface TopicDetail {
  slug: string;
  title: string;
  folder_path: string;
  last_modified: number;
  last_agent_write: number;
  topic_status: TopicStatus;
  tags: string[];
  master_file: string | null;
  derivatives: DerivativeEntry[];
  assets: AssetEntry[];
  deployments: Record<string, DeploymentEntry[]>;
}

export interface DeploymentEntry {
  destination: string;
  date: string;
  url?: string | null;
  notes?: string | null;
  created_at: string;
}

export interface DerivativeState {
  status: DerivativeStatus;
  reviewed: boolean;
  notes: string;
  deployments: DeploymentEntry[];
}

export type GlobalFilter = "all" | "needs_review" | "ready_not_deployed" | "klaviyo_30d";
