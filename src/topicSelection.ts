import { pickTopicDefaultRelPath } from "./editorContent.js";

export interface TopicSlugEntry {
  slug: string;
}

export interface TopicFileRef {
  relPath: string;
}

export interface TopicSelectionDetail {
  slug: string;
  masterFile: string | null;
  derivatives: TopicFileRef[];
  assets: TopicFileRef[];
}

export function resolveSelectedTopicSlug(
  topics: TopicSlugEntry[],
  currentTopicSlug: string | null
): string | null {
  if (topics.length === 0) return null;
  if (currentTopicSlug && topics.some((topic) => topic.slug === currentTopicSlug)) {
    return currentTopicSlug;
  }
  return topics[0].slug;
}

export function topicContainsRelPath(
  topic: TopicSelectionDetail,
  relPath: string | null
): boolean {
  if (!relPath) return false;
  if (topic.masterFile === relPath) return true;
  if (topic.derivatives.some((entry) => entry.relPath === relPath)) return true;
  if (topic.assets.some((entry) => entry.relPath === relPath)) return true;
  return false;
}

export function resolveSelectedRelPath(
  topic: TopicSelectionDetail | null,
  currentRelPath: string | null
): string | null {
  if (!topic) return null;
  if (topicContainsRelPath(topic, currentRelPath)) return currentRelPath;
  return pickTopicDefaultRelPath(topic);
}
